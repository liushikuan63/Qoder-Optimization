#!/usr/bin/env node
// UserPromptSubmit hook: inject the always-on discipline reminder each turn.
//
// Contract (Qoder hooks): read the event JSON from stdin, print a
// {"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}} payload to
// stdout, exit 0. Same shape the bundled better-harness reference documents and
// the polarmem0 Qoder integration uses.
//
// The reminder text is static on purpose: a stable prefix keeps the prompt cache
// warm, and a missing reminder in a turn is an obvious drift signal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
require('./hook-crash-guard.js').install('rules-reminder'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
// 复核协议是可选增强：模块缺失或检测异常时只丢这段提示，不影响静态提醒与请求回注。
let recheck = null;
try { recheck = require('./recheck-protocol.cjs'); } catch {}

// 路径从 HOME 派生，不写死用户名：否则换机器 / 换家目录直接失效，
// 而且这种"个人绝对路径"会把导出包的门禁卡住（2026-09-19 出包时被扫描拦下才发现）。
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const LOG = path.join(CLIENT_ROOT, 'scripts', 'rules-reminder.log');
const LOG_MAX_BYTES = 64 * 1024;
const LOG_KEEP_LINES = 200;

const REMINDER = [
  '【规则提醒 · 每轮生效】',
  '1. 回复用简体中文；commit / PR 说明跟随目标仓库惯例。',
  '2. 不随意停止：只推进当前获授权任务。内部技术口径自行选择合理默认值；缺少验收标准或涉及授权、安全边界才澄清。只读审阅交付报告即完成，不接手无关旧待办。执行承诺要当场落实或说明阻塞，审阅建议不等于执行承诺。**反向同样成立：同类操作连败 3 次（＝3 种不同手段，重跑同一手段不计）必须停手上报**——认证/登录类失败尤其不得重试到服务端锁定阈值（约 10 次即锁号，只能人工解锁；auth-lock-guard 已按目标硬拦），从配置文件取的凭据先校验 CRLF 再用。',
  '3. 需拍板时先弹窗给真实备选和推荐项；明确的执行选择在其范围内有效，不重复确认。沉默、取消、仅确认方案不授权写入；平台要求下一轮人工批准时必须保留。可申请扩大任务授权，但不得通过换工具、子代理或新会话绕过平台强制权限。',
  '4. 验证要能失败；未验证须说明原因。前台完成主张要有本轮真实运行、成功截图及比对证据；推送 / 部署前完整检验，本地小提交按影响面配比。',
  '5. 改已有文件前先备份；凭据 / 内网地址不入源码、日志、记忆摘要与汇报。按匹配定位的风险操作先只读预览命中范围并做负对照；生产、核心服务、破坏性与对外动作保留明确批准。',
  '6. 给出明确结论 / 判断 / 推荐；完成任务不强制造出下一步。权限阻塞只暂停受限动作，继续范围内独立工作。',
  '7. Vibecoding 两问仅用于规模大且需求或验收口径不明、又未获相应授权的任务；明确需求不弹窗。阶段检查不等于逐阶段批准，显式审批仍等待。目标模式仅在用户或系统/开发者明确要求时创建；目录里有任务包不构成实施授权。',
  '8. 过程落盘仅适用于获准写入的执行任务：队列写任务ID、责任会话及当前状态 / 下一步 / 阻塞点 / 关键入口，未建路径标待建。只读、评审待批准时零文件写入（含记忆、队列和备份）。收尾文档 / 提交 / 记忆按适用性执行，不适用记 N/A。',
  '9. 记忆**读写两头都要主动**：动手前先在记忆索引按目标查条目（地址 / 端口 / 路径 / 凭据位置 / 启动脚本 / 口径 / 已知坑），命中就照记忆做、不重新猜不重复探测，无命中或不可用再自行推理并标注「记忆无此项」，与现场冲突以现场为准并就地更新；保存时只存经核验的长期偏好和非代码可推导事实，重试、临时纠正及审阅发现不单独强制写入。领域与流程纪律按需加载，维护、安装及打包不得成为无关主任务的完成前置。',
].join('\n');

function heartbeat() {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) {
      const kept = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP_LINES);
      fs.writeFileSync(LOG, kept.join('\n') + '\n');
    }
    fs.appendFileSync(LOG, new Date().toISOString() + ' ok\n');
  } catch {
    // Logging is diagnostic only; never let it break the injection.
  }
}

let emitted = false;
let stdinEnded = false;
let timer = null;
let raw = '';
const STDIN_MAX_BYTES = 256 * 1024;

// 请求原文回注。实测缺陷（2026-09-24 会话 19586a9b）：用户正文 27 字，同回合注入的
// 技能清单 + AGENTS.md + MCP 清单约 60KB，模型把整回合判成"只有系统上下文、正文是空的"
// 并要求用户重发需求——正文其实已经在请求里（request_message_count=1 /
// skip_initial_user_message=true，且模型思考里复述出了主题）。把原文带标签放进注入块
// 末尾（离生成点最近），让这类误判无法成立。
const REQUEST_ECHO_MAX = 300;
function requestEcho(prompt) {
  const text = typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
  if (!text) {
    return '\n【本轮请求原文】hook 未取到 prompt 字段——这不代表用户没提问，需要时回看本回合的用户消息。';
  }
  const clipped = text.length > REQUEST_ECHO_MAX ? text.slice(0, REQUEST_ECHO_MAX) + '…' : text;
  return '\n【本轮请求摘要 · 可能截断，完整用户消息为准】' + clipped + '\n执行前核对完整请求中的范围、禁止项和批准条件。';
}

// 抑制提醒（2026-10-27）：stop-gate 的滑动窗会在 30 分钟内每规则至多拦 2 次，超限写
// `<规则>-SUPPRESSED` 台账后放行。不提醒的话，"这一段门禁在放行"被读成"这一段没违规"——
// 正是 2026-09-19 修过的那次静默失效的观感。每批抑制只提醒一次，靠 is-not-repeat 戳。
const SUPPRESSED_LOG = path.join(CLIENT_ROOT, 'tmp', 'stop-gate', 'violations.log');
const SUPPRESSED_STAMP = path.join(CLIENT_ROOT, 'tmp', 'stop-gate', 'suppressed-reminder.json');
const SUPPRESSED_WINDOW_MS = Number(process.env.SB_SUPPRESSED_WINDOW_MS || 30 * 60 * 1000);
function suppressedNote() {
  try {
    if (!fs.existsSync(SUPPRESSED_LOG)) return '';
    const lines = fs.readFileSync(SUPPRESSED_LOG, 'utf8').trim().split('\n').slice(-400);
    const now = Date.now();
    const hits = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 2 || !/-SUPPRESSED$/.test(parts[1])) continue;
      const at = Date.parse(parts[0]);
      if (!Number.isFinite(at) || now - at > SUPPRESSED_WINDOW_MS) continue;
      hits.push({ at, rule: parts[1].replace(/-SUPPRESSED$/, '') });
    }
    if (!hits.length) return '';
    const last = hits[hits.length - 1].at;
    let stamp = 0;
    try { stamp = JSON.parse(fs.readFileSync(SUPPRESSED_STAMP, 'utf8')).at || 0; } catch {}
    if (last <= stamp) return '';
    try {
      fs.mkdirSync(path.dirname(SUPPRESSED_STAMP), { recursive: true });
      fs.writeFileSync(SUPPRESSED_STAMP, JSON.stringify({ at: last }));
    } catch {}
    const counts = {};
    for (const h of hits) counts[h.rule] = (counts[h.rule] || 0) + 1;
    const detail = Object.keys(counts).map((k) => k + '×' + counts[k]).join('、');
    return '\n【门禁状态 · 抑制提醒】近 30 分钟有 ' + hits.length + ' 条违规因滑动窗上限被**静默放行**（'
      + detail + '）。这一段门禁在放行，不等于没有违规：同类问题现在就要改。';
  } catch {
    return '';
  }
}

function readPrompt() {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.prompt === 'string') return parsed.prompt;
    if (typeof parsed.user_prompt === 'string') return parsed.user_prompt;
  } catch {
    // 非 JSON（旧宿主 / 半截载荷）：落到"未取到"那一行。
  }
  return '';
}

// 只对明确复核请求追加；普通轮保持原有注入字节不变（模式隔离）。
function recheckNoteFor(promptText) {
  if (!recheck) return '';
  try {
    return recheck.detectRecheck(promptText).matched ? '\n' + recheck.buildRecheckNote() : '';
  } catch {
    return '';
  }
}

function emit() {
  if (emitted) return;
  emitted = true;
  if (timer) clearTimeout(timer);
  const prompt = readPrompt();
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: REMINDER + suppressedNote() + recheckNoteFor(prompt) + requestEcho(prompt),
    },
  });
  process.stdout.write(payload + '\n', () => {
    heartbeat();
    if (!stdinEnded) {
      try { process.stdin.destroy(); } catch {}
    }
  });
}

// Buffer stdin (capped) so a large event payload can neither block the host on a
// full pipe nor blow this process' memory.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (raw.length < STDIN_MAX_BYTES) raw += chunk;
});
process.stdin.on('end', () => { stdinEnded = true; emit(); });
process.stdin.on('error', () => emit());

if (process.stdin.isTTY) {
  emit();
} else {
  // Safety net if the host holds stdin open without ever closing it.
  timer = setTimeout(emit, 1500);
}
