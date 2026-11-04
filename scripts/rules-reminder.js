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
// A custom client must not depend on the host inheriting QODER_HOME. Bind only
// this hook process, before any helper computes its client-specific paths.
const clientArgs = process.argv.slice(2);
const clientFlag = clientArgs.indexOf('--client-root');
if (clientFlag >= 0) {
  const selected = clientArgs[clientFlag + 1];
  if (clientArgs.lastIndexOf('--client-root') !== clientFlag || !selected?.trim() || !path.isAbsolute(selected)) {
    process.stderr.write('RULES_REMINDER_CLIENT_ROOT_INVALID\n');
    process.exit(0);
  }
  process.env.QODER_HOME = path.resolve(selected);
}
const crypto = require('crypto');
const { clientRoot } = require('./client-root.js');
const { goalCandidateNote } = require('./goal-candidate-core.js');
const { classifyVerificationTrigger, buildTriggerNote } = require('./verification-trigger-core.js');
const CLIENT_ROOT = clientRoot();
require('./hook-crash-guard.js').install('rules-reminder'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
// 复核协议是可选增强：模块缺失或检测异常时只丢这段提示，不影响静态提醒与请求回注。
let recheck = null;
try { recheck = require('./recheck-protocol.cjs'); } catch {}
let capabilityAdvisor = null;
try { capabilityAdvisor = require('./capability-advisor.cjs'); } catch {}

// 路径从 HOME 派生，不写死用户名：否则换机器 / 换家目录直接失效，
// 而且这种"个人绝对路径"会把导出包的门禁卡住（2026-09-19 出包时被扫描拦下才发现）。
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const LOG = path.join(CLIENT_ROOT, 'scripts', 'rules-reminder.log');
const LOG_MAX_BYTES = 64 * 1024;
const LOG_KEEP_LINES = 200;
const VERIFICATION_CONFIG = path.join(CLIENT_ROOT, 'verification-trigger.json');
const VERIFICATION_LOG = path.join(CLIENT_ROOT, 'tmp', 'verification-trigger', 'decisions.log');
const VERIFICATION_LOG_MAX_BYTES = 64 * 1024;
const VERIFICATION_LOG_KEEP_LINES = 200;
const CAPABILITY_CONFIG = path.join(CLIENT_ROOT, 'capability-advisor.json');
const capabilityDeliveries = [];

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
  '10. **自进化采集**：收尾前核对本轮有无用户明确的长期偏好 / 纠正、反复出现的模式、验证过的复用经验；有证据按 self-evolution 证据门槛处理（记忆 / 规则 / 技能 / hook），无则不写日志、不为凑记录而记录；同类问题已被门禁反复拦截时优先补机制，不重复堆提示。',
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

// 自进化采集触发（2026-11-02）：只做语义初筛，不拦截、不写状态。
// 正向三族：长期要求 / 显式沉淀 / 重复纠正；元提及与引用规则原文排除。
// 单次任务约束（"不要修改文件"）不含长期词，天然不命中——不要为它加正向词。
const EVOLUTION_LONG_TERM = /(?:以后|今后|下次|从现在开始|每次|一律|永远|总是).{0,24}(?:都|要|别|不要|必须|记得|记住|用|按)/;
const EVOLUTION_EXPLICIT = /(?:记住|记一下|写进记忆|写入记忆|沉淀|固化成规则)/;
const EVOLUTION_REPEAT = /(?:你又|怎么又|说了(?:多少|几)次|重复(?:犯|出现)|还是没|一直没|每次都)/;
const EVOLUTION_META = /(?:当我说|如果我说|比如我说|这句话|这个词|举个例子).{0,24}(?:触发|处理|怎么|如何|会怎样|是否)/;
const EVOLUTION_RULE_QUOTE = /(?:规则|AGENTS|提示词|文档).{0,16}(?:说|写着|要求|规定)/;
const EVOLUTION_NOTE = '\n【自进化采集 · 本轮疑似纠正/长期偏好】检测到纠正或长期要求。收尾前按 self-evolution 证据门槛判断：用户明确长期偏好一次即可采纳；推断习惯需 ≥3 个独立任务、跨 ≥2 会话；单次任务约束只作用本轮。采纳则落到最窄载体并说明作用范围；临时要求明确说明不沉淀。';

function evolutionNote(promptText) {
  const text = typeof promptText === 'string' ? promptText.replace(/\s+/g, ' ').trim() : '';
  if (!text) return '';
  if (EVOLUTION_META.test(text) || EVOLUTION_RULE_QUOTE.test(text)) return '';
  return EVOLUTION_LONG_TERM.test(text) || EVOLUTION_EXPLICIT.test(text) || EVOLUTION_REPEAT.test(text)
    ? EVOLUTION_NOTE
    : '';
}

function toolResearchNote(promptText) {
  if (typeof promptText !== 'string') return '';
  const text = promptText.normalize('NFKC')
    .replace(/```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!text || EVOLUTION_META.test(text) || /(?:规则|AGENTS|提示词).{0,16}(?:说|写着|要求|规定)/i.test(text)) return '';
  if (/(?:不要|禁止|不许|无需|不得|不允许).{0,8}(?:联网|上网|网络搜索)|只用本地|仅离线|\b(?:offline only|no network|do not (?:browse|search online))\b/i.test(text)) return '';
  if (!/主动联网|联网(?:搜索|查证|查询)|官方(?:文档|资料|发布)|(?:最新|稳定|当前).{0,12}(?:版本|文档)|版本.{0,12}兼容|工具(?:缺口|缺失|下载)|(?:缺少|缺失|找不到).{0,12}(?:工具|依赖|命令)|下载.{0,12}(?:工具|依赖|CLI)|(?:命令|工具).{0,12}(?:找不到|不可用)|根因不明|\b(?:latest docs?|official docs?|release notes?|command not found|cannot find module|tool downloads?)\b/i.test(text)) return '';
  const research = '\n【主动联网查证】按当前联网授权先复用已有能力，技术不确定、版本敏感或工具缺口时主动查官方原文，不等反复失败；只用必要公开技术词，不外发私有源码、内网地址或凭据。核对适用版本与来源，搜索摘要不是结论。具体流程按已装 skills-router 的“主动联网与工具获取”读取。';
  if (/只读|仅(?:调研|建议|提供方案)|只(?:提供方案|给建议)|(?:不要|禁止|不许|无需|不得|不允许|不).{0,8}下载|\b(?:read.only|no downloads?|do not download)\b/i.test(text)) return research;
  return research + '\n【工具获取 · 安装先询问】先确认真实工具缺口与质量收益，再按当前写入授权下载；核对来源/许可/权限、固定版本、非系统盘路径与官方 SHA-256 或签名，下载不等于执行授权。新工具试用/安装/接入先用 AskUserQuestion 主动询问；已有明确同批批准不重复问，拒绝或取消不安装、不反复催问。长期复用获准后固定落盘，实测路径/版本/功能并更新既有资源记忆和相关技能；hook 本身不联网、不下载、不执行安装，不改变平台权限。';
}

// B05 自动选档触发（2026-11-03）：并入每轮必跑的 rules-reminder，避免再占一条 UserPromptSubmit 接线。
// 开关 ~/.qoder/verification-trigger.json {"enabled":false}；决策日志只记判定，不记请求原文。
function verificationEnabled() {
  try {
    return JSON.parse(fs.readFileSync(VERIFICATION_CONFIG, 'utf8')).enabled !== false;
  } catch {
    return true;
  }
}

function logVerificationDecision(result, promptText) {
  try {
    if (fs.existsSync(VERIFICATION_LOG) && fs.statSync(VERIFICATION_LOG).size > VERIFICATION_LOG_MAX_BYTES) {
      const kept = fs.readFileSync(VERIFICATION_LOG, 'utf8').split('\n').filter(Boolean).slice(-VERIFICATION_LOG_KEEP_LINES);
      fs.writeFileSync(VERIFICATION_LOG, kept.join('\n') + '\n');
    }
    fs.mkdirSync(path.dirname(VERIFICATION_LOG), { recursive: true });
    let sessionId = '-';
    try { sessionId = String(JSON.parse(raw).session_id || '-'); } catch {}
    fs.appendFileSync(VERIFICATION_LOG, [new Date().toISOString(), sessionId, result.reason, result.signals.join(','), promptText.length].join('|') + '\n');
  } catch {
    // 日志只用于自证与排查，不能影响注入。
  }
}

function verificationNote(promptText) {
  if (!verificationEnabled()) return '';
  const text = typeof promptText === 'string' ? promptText : '';
  const result = classifyVerificationTrigger(text);
  logVerificationDecision(result, text);
  return result.trigger
    ? buildTriggerNote(result, path.join(CLIENT_ROOT, 'scripts', 'verification-policy.cjs'))
    : '';
}

function capabilityEntry(item, catalogFile, installed) {
  const base = installed ? CLIENT_ROOT : (typeof catalogFile === 'string' ? path.dirname(catalogFile) : '');
  if (!base) return '';
  const candidates = [item.entryPath];
  if (installed && typeof item.installedPath === 'string') candidates.push(item.installedPath, path.join(item.installedPath, 'SKILL.md'));
  if (!installed && typeof item.entry?.source === 'string') {
    const source = path.resolve(base, item.entry.source);
    candidates.push(source, path.join(source, 'SKILL.md'));
  }
  for (const file of candidates) {
    if (typeof file !== 'string') continue;
    try {
      const relative = path.relative(fs.realpathSync(base), fs.realpathSync(file));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      if (fs.lstatSync(file).isFile()) return path.resolve(file);
    } catch {}
  }
  return '';
}

function capabilityClaim(item) {
  let session;
  try { session = JSON.parse(raw).session_id; } catch {}
  // A missing/malformed identity must not become a shared permanent refusal.
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) return true;
  try {
    const sessionHash = crypto.createHash('sha256').update(session).digest('hex');
    let dir = fs.realpathSync(CLIENT_ROOT);
    for (const name of ['tmp', 'capability-advisor', 'sessions', sessionHash]) {
      dir = path.join(dir, name);
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    }
    const key = crypto.createHash('sha256').update(item.id + '\0' + item.action).digest('hex');
    const file = path.join(dir, key + '.json'), lock = path.join(dir, key + '.pending');
    const identity = { schema: 1, sessionHash, capabilityId: item.id, action: item.action };
    const matches = value => value && Object.keys(identity).every(key => value[key] === identity[key]);
    const ordinaryJson = target => {
      const stat = fs.lstatSync(target);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192 ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
    };
    try { const prior = ordinaryJson(file); if (matches(prior) && prior.status === 'delivered') return false; } catch {}
    const claimId = crypto.randomUUID();
    let ownsLock = false;
    try {
      fs.writeFileSync(lock, JSON.stringify({ ...identity, claimId, at: Date.now() }), { flag: 'wx', mode: 0o600 });
      ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') return true;
      try {
        const pending = ordinaryJson(lock), age = Date.now() - pending?.at;
        if (matches(pending) && Number.isFinite(age) && age >= 0 && age < 30000) return false;
      } catch {}
      // Stale or corrupt diagnostic state cannot suppress advice forever. The
      // delivered marker still uses exclusive creation; unknown files are kept.
    }
    capabilityDeliveries.push({ file, lock, claimId, ownsLock, identity });
  } catch {}
  return true;
}

function finishCapabilityDeliveries(delivered) {
  for (const item of capabilityDeliveries) {
    if (delivered) try {
      fs.writeFileSync(item.file, JSON.stringify({ ...item.identity, status: 'delivered', at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch {}
    if (item.ownsLock) try {
      const prior = JSON.parse(fs.readFileSync(item.lock, 'utf8'));
      if (prior.claimId === item.claimId) fs.unlinkSync(item.lock);
    } catch {}
  }
}

function capabilityNote(promptText) {
  if (!capabilityAdvisor || typeof capabilityAdvisor.planCapabilities !== 'function' || !promptText.trim()) return '';
  try {
    try { if (JSON.parse(fs.readFileSync(CAPABILITY_CONFIG, 'utf8')).enabled === false) return ''; } catch {}
    // 包登记只决定包内候选；本地按需库发现不依赖它。仍未登记的包不会被当成可推荐来源。
    let catalogFile;
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'share-package.json'), 'utf8'));
      if (typeof pointer?.catalog === 'string' && pointer.catalog.trim()) {
        const candidate = path.resolve(CLIENT_ROOT, pointer.catalog);
        if (fs.existsSync(candidate)) catalogFile = candidate;
      }
    } catch {}
    const result = capabilityAdvisor.planCapabilities({ catalogFile, clientRoot: CLIENT_ROOT, prompt: promptText, phase: 'task' });
    if (result?.schema !== 1 || !Array.isArray(result.items)) return '';
    const lines = [];
    for (const item of result.items.slice(0, 3)) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || /[\x00-\x1f]/.test(item.id) || typeof item.name !== 'string') continue;
      const name = item.name.replace(/[\x00-\x1f`]/g, ' ').trim().slice(0, 100);
      if (!name) continue;
      const authorized = item.action === 'KEEP' && item.requested === true && item.authorized === true;
      const installed = authorized || ['ASK_USE', 'AUTO_USE', 'AUTO_LOAD', 'UPDATE', 'REVIEW_UPDATE'].includes(item.action);
      if (!authorized && !['ASK_USE', 'AUTO_USE', 'AUTO_LOAD', 'ASK_INSTALL', 'UPDATE', 'REVIEW_UPDATE'].includes(item.action)) continue;
      const entry = capabilityEntry(item, catalogFile, installed);
      if (!entry) continue;
      const reference = JSON.stringify(entry.replace(/\\/g, '/'));
      if (authorized) {
        const local = item.differs === true ? '当前使用已安装的本地版本，与注册包有差异；保留该版本，更新另行确认，不作为当前任务前置。' : '';
        lines.push(`- 用户本轮已明确指定 ${name}：现在读取对应入口 ${reference} 并按其适用步骤执行；无需重复询问是否使用。${local}`);
        continue;
      }
      if (item.action === 'AUTO_LOAD') {
        // 只读加载不进入永久去重台账：投递只证明提示已送达，未读取时下一轮仍须提示。
        lines.push(`- ${name}（AUTO_LOAD）：已按需发现本地技能，只读加载；现在读取入口 ${reference}，按其适用步骤执行；不得据此安装、更新、发布或扩大操作授权；投递不等于已读取。`);
        continue;
      }
      if (!capabilityClaim(item)) continue;
      if (item.action === 'AUTO_USE') {
        lines.push(`- ${name}（AUTO_USE）：已自动触发；现在读取入口 ${reference}，按其判定流程执行。可并行也须先展示计划并取得确认，未确认按顺序执行；不得自动派发 worker。`);
        continue;
      }
      const verb = item.action === 'ASK_USE' ? '使用' : item.action === 'ASK_INSTALL' ? '安装' : '更新';
      const question = item.action === 'ASK_USE' ? `是否使用 ${name} 来完成当前任务？` : `是否${verb} ${name} 用于当前任务？`;
      const qualifier = item.action === 'REVIEW_UPDATE' ? '本地已有差异，先展示并审查差异，不覆盖本地内容。' : '';
      lines.push(`- ${name}（${item.action}）：可核对入口 ${reference}。${qualifier}用 AskUserQuestion 提问：${JSON.stringify(question)}，给出“${verb} / 本次不用”选项；用户未明确选择前保留原状态。`);
    }
    return lines.length ? '\n【当前任务能力建议】\n' + lines.join('\n')
      + '\n以上是能力建议或本轮明确指名路由；自动触发只自动加载与判定，不等于派发授权；投递记录不等于用户批准。已有适用授权不重复询问，能力使用也不扩大安装、发布或生产操作权限。' : '';
  } catch (error) {
    process.stderr.write('CAPABILITY_NOTE_ERROR: ' + (error && error.message ? error.message : 'unknown') + '\n');
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
      additionalContext: REMINDER + suppressedNote() + goalCandidateNote(prompt) + evolutionNote(prompt) + toolResearchNote(prompt) + verificationNote(prompt) + recheckNoteFor(prompt) + capabilityNote(prompt) + requestEcho(prompt),
    },
  });
  process.stdout.write(payload + '\n', (error) => {
    finishCapabilityDeliveries(!error);
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
