#!/usr/bin/env node
// PreToolUse 守卫：拦住"一次把上下文吃掉一大块"的调用。
//
// 为什么需要它（证据，不是推测）——2026-09-19 对本项目九个会话做取证：
//   · 单条工具返回 >20KB 的共 81 条 / 3 MB：Read 整读大文件 921 KB（`收口清单.md` 一次 159 KB、
//     项目记忆文件被整读五遍 38~54 KB/次）、Bash 无上限输出 454 KB、子代理报告 382 KB、Edit 回显 849 KB；
//   · 两个超大会话（119 MB / 65.8 MB）里出现 9 次传输层掐断：
//     `Model stream timed out before response headers after 60s` ×3、`The model service rejected this request` ×4、
//     `The request could not be completed` ×2 —— 用户看到的"任务老中断"就是它。
//   因果链：上下文/单请求 payload 越大 → 服务端 60s 内发不出响应头 → harness 中止本回合。
//   所以"少往上下文里灌东西"不是风格问题，是回合能不能活下来的问题。
//
// 判据来源：hook stdin 的 JSON（`hook_event_name` / `tool_name` / `tool_input`）。
//   字段名两种都认（`tool_input` 与 `input`、`tool_name` 与 `tool`）：qoder-context 插件里两种写法都出现过，
//   认错字段的后果是"守卫永远放行"这种最坏的假绿。
// 输出契约（从应用包里读出来的权威形状）：
//   { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny'|'allow'|'ask',
//                           permissionDecisionReason, updatedInput } }
// fail-open：任何异常一律放行，绝不因为守卫自己出问题而卡住会话；但**每次判定都落台账**，
//   这样"守卫有没有真的在拦"是可核对的，而不是靠相信。
'use strict';
require('./hook-crash-guard.js').install('huge-output-guard'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = process.env.HUGE_OUTPUT_GUARD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'huge-output-guard');
const LEDGER = path.join(STATE_DIR, 'decisions.log');
const CONFIG = path.join(CLIENT_ROOT, 'huge-output-guard.json');

// 阈值：单条返回超过它就是一次上下文炸弹。40 KB ≈ 一万多 token，一次就吃掉 200k 窗口的 5%+。
const READ_BYTES = Number(process.env.HOG_READ_BYTES || 40 * 1024);
const READ_LINES = Number(process.env.HOG_READ_LINES || 600);

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    return {};
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    try {
      let r;
      while ((r = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, r)));
    } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

function ledger(action, tool, detail) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()}|${action}|${tool}|${String(detail).slice(0, 200)}\n`);
  } catch (e) {}
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}

function allowWithInput(toolInput, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
      updatedInput: toolInput,
    },
  }) + '\n');
}

// 文件体积：读不出来（不存在/无权限）就当小文件放行 —— 真不存在时 Read 自己会报错，比守卫猜错好。
function fileStats(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(p);
    let newlines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) newlines++;
    // 末行没有换行符也算一行。旧写法只数 \n：300KB 的**单行**文件（压缩 JSON、base64、
    // 一行日志）被算成 0 行 ⇒ effLines × avgBytes = 0 ⇒ 整读放行，判据被乘法吃掉
    // （2026-11-12 probe-f73-75 F73-A/E 修前红：exit 0 且 decision=allow）。
    const lines = newlines + (buf.length > 0 && buf[buf.length - 1] !== 10 ? 1 : 0);
    return { bytes: st.size, lines };
  } catch (e) {
    return null;
  }
}

// ---------- 判据 1：Read 整读大文件 ----------
// 图片口径（2026-10-27 补）：图片返回是 base64，**字节数按 4/3 膨胀**再进上下文。
// 一张 2MB 的截图 ≈ 2.7MB 文本量，比任何文本文件都更容易把回合打穿。
const IMG_BYTES = Number(process.env.HOG_IMAGE_BYTES || 1.5 * 1024 * 1024);
function checkRead(toolInput) {
  const p = toolInput.file_path || toolInput.path;
  if (!p) return null;
  if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(p))) {
    const img = fileStats(String(p));
    if (img === null || img.bytes <= IMG_BYTES) return null;
    return `整张读取 ${(img.bytes / 1048576).toFixed(1)} MB 的图片（base64 后约再放大 1/3，且已超过 ${(IMG_BYTES / 1048576).toFixed(1)} MB 阈值）：`
      + '一次就能把上下文吃掉一大块。改法：① 用截图工具的缩略/裁剪参数只截目标区域；② 先缩小或压缩成缩略图再读；'
      + `③ 需要原图细节时分块裁剪后逐块读。（阈值可用 HOG_IMAGE_BYTES 调整。）`;
  }
  const st = fileStats(String(p));
  if (st === null || st.bytes === 0) return null;
  // 显式 offset/limit 是「我知道自己在读什么」的信号，但**信号不等于体积安全**：
  // ① 实质无界的 limit 与整读等价（219KB 文件配 limit=999999 旧实现直接放行）；
  // ② limit 按**行数**限流，对单行大文件（压缩 JSON / base64 / 一行日志）等于没限——
  //    300KB 单行文件配 limit=100 或只配 offset=1，实际仍把整份 300KB 灌进上下文。
  // 旧实现在这两处**早退**，跳过了下面的字节投影（2026-11-12 probe-f80-86 F80-A~G 修前红：
  // exit 0 且 decision=allow）。现在一律先算「这一段有多少字节」，再决定放不放行。
  const rawLimit = Number(toolInput.limit);
  const hasLimit = toolInput.limit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0;
  const rawOffset = Number(toolInput.offset);
  const hasOffset = toolInput.offset !== undefined && Number.isFinite(rawOffset) && rawOffset > 0;
  const startLine = hasOffset ? Math.floor(rawOffset) : 1;
  // 只带 offset ＝「从该行一路读到 EOF」，上界是**余量**而不是整份行数。
  const remaining = Math.max(st.lines - (startLine - 1), 0);
  const effLines = hasLimit ? Math.min(rawLimit, remaining) : remaining;
  if (effLines <= 0) return null;   // offset 超出 EOF：读不到东西，别误拦
  const avgBytes = st.lines > 0 ? st.bytes / st.lines : st.bytes;
  const projected = effLines * avgBytes;
  if (effLines <= READ_LINES && projected <= READ_BYTES) return null;
  const kb = (Math.min(projected, st.bytes) / 1024).toFixed(0);
  if (hasLimit || hasOffset) {
    return `即使带了 offset/limit，这一段仍约 ${kb} KB / ${effLines} 行（平均行长 ${Math.round(avgBytes)} 字节`
      + (st.lines <= 1 ? '；整份文件只有一行，而 limit 按**行数**限流，对单行大文件等于没限' : '')
      + `），超过单条 ${(READ_BYTES / 1024).toFixed(0)} KB 的上下文预算。改法：`
      + '① 先 Grep 定位关键词，只读命中行附近；② 单行大文件按**字节**截断（`head -c 2000 文件`、`cut -c1-2000 文件`）；'
      + '③ 确实要全文就落盘分段处理，别整段进上下文。';
  }
  return `整读会把 ${kb} KB / ${effLines} 行一次性灌进上下文（本项目实测：` +
    `单条 >20KB 的返回共 81 条，最大的几条正是这类整读）。改法二选一：` +
    `① 先 Grep 定位（\`grep -n "关键词" 文件\` 或 Grep 工具）再 Read 带 offset/limit 只读那一段；` +
    `② 确实要通读就先 \`sed -n '1,200p'\` 分段读，每次不超过 200 行。` +
    `（要放行就显式带 offset/limit，且那一段的**字节数**也要在预算内——单行大文件请按字节截断。）`;
}

// ---------- 判据 2：Bash 命令会吐一屏 ----------
// 这些形态的判据是**命令文本**：有没有输出限流器，一眼可判、不会误伤（不依赖输出内容）。
const HEAD_TAIL_LIMITER = /\bhead\b|\btail\b/;
const SHORT_LC_LIMITER = /(^|\s)-[A-Za-z]*[lc][A-Za-z]*(\s|$)/;
// head/tail 的数值上界超过阈值就不算有效限流（`head -c 999999` ≈ 1MB 照样进上下文）。
// 后缀口径按 GNU coreutils：K/M/G/T 是 1024 进制，KB/MB/GB/TB 是 1000 进制，b=512、c=1、w=2。
// 旧实现只认纯数字：`head -c 5M` 被读成 **5 字节** ⇒ 放行，而语义等价的 `head -c 5000000` 却拦
// （2026-11-12 probe-f73-75 F74-C/C2/L/M 修前红）。
const COUNT_SUFFIX = {
  b: 512, c: 1, w: 2,
  k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
  kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
};
function parseCount(text) {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]{0,2})$/.exec(String(text || ''));
  if (!m) return null;
  const unit = m[2].toLowerCase();
  if (!unit) return Number(m[1]);
  const mul = COUNT_SUFFIX[unit];
  // 认不出的后缀按**无界**处理：宁可多拦一次让人改命令，也不能把 `5X` 当 5 放行——
  // 那正是这条判据被绕过的形状（fail-closed，与本守卫"拦不住就等于没有"的理由一致）。
  return mul === undefined ? Infinity : Number(m[1]) * mul;
}
function oversizedHeadTail(cmd) {
  const c = String(cmd || '');
  for (const m of c.matchAll(/\b(?:head|tail)\b([^|;&]*)/g)) {
    const seg = m[1];
    // `tail -n +K` / `tail -c +K` 是「从第 K 行/字节一路输出到末尾」，与「取 K 个」相反 ⇒ 实质无界。
    // 旧写法只覆盖 -n/--lines：`tail -c +1`、`tail --bytes=+1` 整族漏判（F74-A/B 修前红）。
    if (/(?:-[cn]\s*|--(?:bytes|lines)=?\s*)\+\s*\d+/.test(seg)) return true;
    // `-c700` 与 `-c 700` 必须同判：旧写法 `/-c\b/` 在 `-c700` 上没有词边界，
    // 于是 700 字节被当成 700 行去比 600 阈值 → 误拦（实测同一语义两种结果）。
    const isBytes = /-c(?![A-Za-z])|--bytes/.test(seg);
    // 显式上界三种写法 + 旧式 `head -999999`（无字母选项，同样是上界，旧实现整族漏判）；数值可带后缀。
    const n = /(?:-[cn]\s*|--(?:bytes|lines)=?\s*)(\d+(?:\.\d+)?[A-Za-z]{0,2})/.exec(seg)
      || /(?:^|\s)-(\d+(?:\.\d+)?[A-Za-z]{0,2})(?:\s|$)/.exec(seg);
    if (!n) continue;                       // 无显式上界＝默认 10 行，有效
    const v = parseCount(n[1]);
    if (v === null) continue;
    if (isBytes ? v > READ_BYTES : v > READ_LINES) return true;
  }
  return false;
}
const N_LIMITER = /-n\s*\d+/;    // git log -n 20 / head -n 20（head/tail 上界失效时不算有效，见 checkBash）
const PIPE_LIMITER = /\|/;
// 重定向到**文件**才算限流（输出不进上下文）。`2>&1` / `1>&2` / `2>>&1` 是 **fd 复制**：
// 输出照样进上下文，旧写法 />\s*\S/ 把它也算限流 ⇒ `node --test x 2>&1`、`git log 2>&1`
// 整族放行（2026-11-12 probe-f80-86 F86-A~F 修前红）。
// `(?![>&])` 防止把 `>>` 的第一个 `>` 单独匹配上从而绕过 `(?!&)`；`/dev/null` 是真丢弃，照常放行。
const REDIRECT_LIMITER = /\d*>{1,2}(?![>&])\s*(?!&)\S/;
const LIMITERS = [
  PIPE_LIMITER,                // 任何管道（head/tail/grep/wc/sort…）都算限流
  REDIRECT_LIMITER,            // 重定向到文件
  HEAD_TAIL_LIMITER,           // 直接 head/tail（上界有效性另行判定）
  // 短参簇里带 l 或 c 就算限流/计数：-l、-c、-rl、-lc、-rL 都要认。
  // （自测抓到过：旧写法 /-l\b/ 匹配不到 `grep -rl`，因为那三个字符是 `-`、`r`、`l`，压根没有 `-l` 子串。）
  SHORT_LC_LIMITER,
  /-m\s/,                      // grep -m 5
  /--oneline|--stat|--name-only|--porcelain|--quiet|--short|--numstat|--max-depth/,
  N_LIMITER,
  /sed\s+-n/, /awk\b/, /\bwc\b/,
];
const VERBOSE = [
  { re: /^\s*(cat|type|more|less)\s+\S/, hint: 'cat 一个大文件 ≈ 一次上下文炸弹' },
  // head/tail 带**失效上界**时同样会吐一屏（`head -c 999999` ≈ 1MB）；
  // 上界有效时由 LIMITERS 放行，不会误伤 `head -n 20`。
  { re: /\b(?:head|tail)\b/, hint: 'head/tail 的 -c/-n 上界超过阈值，等于没限流' },
  { re: /\bgit\s+(log|diff|show|blame)\b/, hint: 'git log/diff/show 不加限流就是全史/全 diff' },
  { re: /\b(grep|rg)\b/, hint: 'grep 不加 -l/-c/-m 或管道就是把所有命中铺开' },
  { re: /\bfind\b/, hint: 'find 不加 -name 过滤就是整棵目录树' },
  { re: /\bls\b[^|]*\s-R\b/, hint: 'ls -R 是递归全量' },
  { re: /\b(tree|du -a)\b/, hint: 'tree / du -a 是递归全量' },
  { re: /\b(mvn|gradle|npm|pnpm|yarn)\b/, hint: '构建/测试输出要重定向到文件，再看摘要' },
  { re: /\bnode\s+--test\b|\bbash\s+scripts\//, hint: '测试脚本输出要重定向到文件，再 grep 结论' },
  { re: /\b(journalctl|docker logs|kubectl logs)\b/, hint: '日志类命令必须带 --tail/-n' },
];
// 2026-10-27：这些形态改成"自动追加 | head -100 后执行"，而不是 deny 一次让模型重写。
// 近 7 天实测 deny 60 次，每次都要多一个来回；而它们都是**幂等的只读查询**，加限流不改变语义。
// 构建/测试命令不在此列：管道接 head 会在 100 行后 SIGPIPE，可能掐断构建。
const REWRITABLE = [
  /^\s*(cat|type|more|less)\s+\S/,
  /\bgit\s+(log|diff|show|blame)\b/,
  /\b(grep|rg)\b/,
  /\bfind\b/,
  /\bls\b[^|]*\s-R\b/,
  /\b(tree|du -a)\b/,
  /\b(journalctl|docker logs|kubectl logs)\b/,
];
function rewritable(cmd) {
  const c = String(cmd || '');
  if (/\b(mvn|gradle|npm|pnpm|yarn)\b|\bnode\s+--test\b|\bbash\s+scripts\//.test(c)) return false;
  if (/;|&&|\|\||>|<<|`|\$\(/.test(c)) return false;   // 复合/重定向/替换：改语义风险高，保持 deny
  return REWRITABLE.some((re) => re.test(c));
}
// 判据 2b：双引号包住的内联脚本里出现反引号 —— bash 会**先做命令替换**再交给解释器。
// 2026-09-21 实测两次：`node -e "...一段带 `scripts/build.sh` 的注释..."` 当场真的跑了一次全量构建，
// 另一次把替换结果（空串）写进了配置文本，让"去重判断"恒真、四份记忆其实一条都没落盘。
// 这条与输出体积无关，所以放在 LIMITERS 早退**之前**。
const INLINE_CODE = /\b(?:node|python\d*|perl|ruby|php|bash|sh|zsh|dash|ksh)\s+(?:-e|--eval|-c|--input-type=\w+)\s+"/;
// 只摘掉**带引号 heredoc 的正文**，而不是"整条命令里出现过 <<'EOF' 就豁免"。
// 旧写法按整条命令判豁免：`node -e "…`x`…" <<'EOF'` 只要顺手挂一个 heredoc 就能把豁免借走，
// 反引号照样被 bash 执行（2026-11-12 probe-f73-75 F75-A/G 修前红）。
// 返回去掉正文后的命令文本；heredoc 的起始行与结束标记行保留（豁免只针对正文）。
function stripQuotedHeredocBodies(cmd) {
  const lines = String(cmd || '').split('\n');
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /<<(-?)[ \t]*["']([A-Za-z_][A-Za-z0-9_]*)["']/.exec(lines[i]);
    if (!m) continue;
    const tag = m[2];                                    // 标签只含字母数字下划线，无需转义
    const endRe = m[1] === '-' ? new RegExp('^\\t*' + tag + '\\r?$') : new RegExp('^' + tag + '\\r?$');
    let j = i + 1;
    while (j < lines.length && !endRe.test(lines[j])) j++;
    // 没有结束标记 ⇒ 正文一直到命令末尾（bash 会报错，但守卫不能因此放行）。
    for (let k = i + 1; k < j; k++) drop.add(k);
    i = j;                                               // 跳过整段：正文里的 <<'X' 不是新的 heredoc
  }
  if (!drop.size) return String(cmd || '');
  return lines.filter((_, idx) => !drop.has(idx)).join('\n');
}
function checkInlineBacktick(cmd) {
  const outside = stripQuotedHeredocBodies(cmd);
  if (!INLINE_CODE.test(outside)) return null;
  if (!outside.includes('`')) return null;
  // 带引号的 heredoc（<<'EOF' / <<"EOF"）正文里 bash **不做命令替换**，那是安全写法本身：
  // 2026-09-21 上线当天就误伤过一次——把这条规则的说明文字写进 <<'PATCHEOF' 时被拦。
  // 现在这层豁免只覆盖正文（上面已摘掉），正文之外的反引号照拦。
  return '双引号包住的内联脚本里出现了反引号：bash 会先做命令替换，'
    + '那段文本里的 `xxx` 会被**当成命令执行**，而不是原样写进目标文件。'
    + "改法：文本走带引号的 heredoc（<<'EOF'）落成文件，脚本落成 .cjs 再跑；"
    + '或把 -e 的参数改用单引号。'
    + '理由不是洁癖：本轮实测一次误触发全量构建、一次让恒真的去重键把四条记忆全丢掉。';
}
// 最后一段管道是否真的限住了输出。`||` 是逻辑或、不是管道，不能当分隔符（前后都排除）。
function finalStageBounds(cmd) {
  const stages = String(cmd || '').split(/(?<!\|)\|(?!\|)/);
  const last = stages[stages.length - 1];
  if (oversizedHeadTail(last)) return false;      // 末段自己就是失效上界
  if (/\bwc\b/.test(last)) return true;           // 计数
  if (HEAD_TAIL_LIMITER.test(last)) return true;  // 上界有效的 head/tail（失效的已被上一行排除）
  if (SHORT_LC_LIMITER.test(last)) return true;   // grep -c / -l
  return /-m\s|--count|\bawk\b|sed\s+-n/.test(last);
}
function checkBash(toolInput) {
  const cmd = String(toolInput.command || '');
  if (!cmd.trim()) return null;
  const inline = checkInlineBacktick(cmd);
  if (inline !== null) return inline;
  const oversized = oversizedHeadTail(cmd);
  // head/tail 与 -l/-c 短选项簇只在**上界有效**时算限流：`head -c 999999` 旧实现照样放行（实测）。
  // `-n` 同理：上界失效时通用 `/-n\s*\d+/` 也不能救回放行——实测 `head -n 999999 big` 曾 allow，
  // 而语义等价的 `head --lines=999999 big` 却 deny，同一判据两种结果（C11 残留缺口）。
  const skip = new Set([HEAD_TAIL_LIMITER, SHORT_LC_LIMITER]);
  if (oversized) {
    skip.add(N_LIMITER);
    // 管道能不能救回失效上界，取决于**最后一段**是否真的限住了输出：
    // `cat big | head -n 999999` 的输出直接进上下文（救不回）；
    // `head -n 999999 big | wc -l` 的最终输出被 wc 限住（可以放行）。
    // 重定向不受此限：`> 文件` 的输出根本不进上下文。
    if (!finalStageBounds(cmd)) skip.add(PIPE_LIMITER);
  }
  if (LIMITERS.some((re) => !skip.has(re) && re.test(cmd))) return null;
  if (!oversized && (HEAD_TAIL_LIMITER.test(cmd) || SHORT_LC_LIMITER.test(cmd))) return null;
  for (const v of VERBOSE) {
    if (v.re.test(cmd)) {
      return `${v.hint}。这条命令没有任何输出限流（管道 / 重定向 / head / tail / -l / -c / -m / --oneline 都没有）。` +
        `改法：\`<命令> > /tmp/x.log 2>&1; tail -30 /tmp/x.log\`（或 \`| head -50\`、\`| grep -c 关键词\`、\`-l\`）。` +
        `理由不是洁癖：单条 >20KB 的返回在本项目测到 81 条，而大会话会被传输层按时掐断（Model stream timed out）。`;
    }
  }
  return null;
}

// ---------- 判据 3：子代理提示词没写回报上限 ----------
// 实测：Explore 子代理的回报单条 40 KB 量级，10 条就 382 KB —— 提示词里那句"600 字以内"没兜住。
// 这里用 updatedInput 直接在提示词末尾追加硬约束（改输入而不是拒绝，因为子代理本身是必要的）。
const AGENT_CAP = '\n\n【回报硬约束（由 harness 追加）】只回结论：每个问题 1~3 句，点到文件路径与行号为止；'
  + '不要贴代码块、不要复述文件内容、不要贴命令原始输出。总长超过 300 字就是失败，需要细节时我会另发一次定向查询。';
function checkAgent(toolInput) {
  const p = toolInput.prompt;
  if (typeof p !== 'string' || p.length === 0) return null;
  if (p.includes('回报硬约束（由 harness 追加）')) return null;
  toolInput.prompt = p + AGENT_CAP;
  return { rewrite: true };
}

function main() {
  if (!fs.existsSync(STATE_DIR)) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
  }
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch (e) {
    return;   // 读不到输入就放行（fail-open）
  }
  const event = payload.hook_event_name || payload.hookEventName || '';
  if (event && event !== 'PreToolUse') return;
  const tool = payload.tool_name || payload.tool || '';
  const input = payload.tool_input || payload.input || {};
  const cfg = loadConfig();
  if (cfg.disabled === true) return;

  try {
    if (tool === 'Read') {
      const reason = checkRead(input);
      if (reason) { ledger('deny', tool, reason.slice(0, 60)); return deny(reason); }
    } else if (tool === 'Bash') {
      const reason = checkBash(input);
      if (reason) {
        const mode = String(process.env.HOG_MODE || cfg.hogMode || 'rewrite').toLowerCase();
        const cmd = String(input.command || '');
        if (mode !== 'deny' && rewritable(cmd)) {
          input.command = cmd.replace(/\s+$/, '') + ' | head -100';
          ledger('rewrite', tool, cmd.slice(0, 80));
          return allowWithInput(input, '已自动追加 `| head -100` 限制输出（只读查询，语义不变）。'
            + '输出仍被截断时改用更精确的过滤条件。要恢复"拦截并让我改命令"：配置 `{"hogMode":"deny"}`。');
        }
        ledger('deny', tool, cmd.slice(0, 80) + ' :: ' + reason.slice(0, 50));
        return deny(reason);
      }
    } else if (tool === 'Agent' || tool === 'Task') {
      const r = checkAgent(input);
      if (r && r.rewrite) {
        ledger('augment', tool, String(input.description || '').slice(0, 60));
        return allowWithInput(input, '已给子代理的提示词追加"只回结论、≤300 字"的硬约束（实测子代理报告单条 40KB 量级）。');
      }
    }
    ledger('allow', tool, '');
  } catch (e) {
    ledger('error', tool, String((e && e.message) || e));
  }
}

main();
