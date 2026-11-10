#!/usr/bin/env node
// PreToolUse 门禁：**Windows 路径经 shell → JS/VBS 多层转义会静默丢反斜杠**（2026-10-26 重犯后机制化）。
//
// 事故形态：`node -e "... 'C:\\\\Users\\\\x\\\\f.vbs' ..."` —— bash 双引号先吃一层、
// JS 字符串再吃一层，最终 spawn 收到 `C:Usersx`（无反斜杠），进程摆出错误对话框、日志里什么都没有。
// 同类：heredoc/echo 往 .js/.vbs/.ps1 写 `C:\proj`（单反斜杠），目标语言把它当未知转义吃掉。
//
// 判据宁窄勿宽（噪声多就会被忽略）：
//   ① `node -e/--eval/-p` 负载里出现 **盘符 + 反斜杠** → 拦（正斜杠 `C:/x` 放行）
//   ② `node -e` 负载里出现 VBS 三引号 `"""` → 拦（内联生成脚本文本必然要跨层转义）
//   ③ heredoc/重定向写 .js/.cjs/.mjs/.vbs/.ps1，且内容里有**单反斜杠**盘符路径 → 拦（写对了是 `\\`）
// 放行：正斜杠路径、命令行普通参数里的 Windows 路径（`ls "C:\x"`）、正则里的 `\\d` 等。
// 关闭：~/.qoder/win-path-guard.json 写 {"disabled":true}；只提醒不拦：{"mode":"warn"}
// 台账：~/.qoder/tmp/win-path-guard/decisions.log
'use strict';
require('./hook-crash-guard.js').install('win-path-guard');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = path.join(CLIENT_ROOT, 'win-path-guard.json');
const STATE_DIR = process.env.WIN_PATH_GUARD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'win-path-guard');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}; } catch {}
if (cfg.disabled) process.exit(0);

function ledger(row) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, 'decisions.log'), `${new Date().toISOString()}|${row}\n`); } catch {}
}

const FIX =
  '改法（任选其一，都不用手搓反斜杠）：\n'
  + '  · 脚本落盘再跑：用 Write 工具写 `.cjs`，路径写 `path.join(process.env.APPDATA, "Microsoft", ...)` 或正斜杠 `C:/proj/...`，再 `node <文件>`；\n'
  + '  · 必须在 `node -e` 里用路径时：一律用正斜杠（`C:/proj/x`）——Node 在 Windows 上认正斜杠；\n'
  + '  · 要生成 VBS/JS/PS 文本（含 `"""`）：同样用 Write 落盘，别经 shell。\n'
  + '验证：写完后回读文件确认反斜杠还在（先 `node ~/.qoder/scripts/skill-load.cjs 转义` 定位 safe-text-editing 的 SKILL.md 目录，再跑其 `scripts/text-check.js <文件> --has "<片段>"`）。';

const EVAL = /\bnode(?:js)?(?:\.exe)?\b[^|;&\n]*?\s(?:-e|--eval|-p|--print)\b/;
// 盘符必须出现在**词边界**上：`description:\s` 里的 `n:\` 是正则转义，不是路径。
// 2026-10-27 实测：旧写法 `/[A-Za-z]:\\/` 把 `description:\s*` 判成盘符路径，
// 拦下了正常的内联测量脚本（含 `[\\s\\S]` 的正则）。加上前向否定环视后，
// 只有前面不是字母/数字/下划线的 `X:\` 才算盘符（`"C:\proj`、`D:\tmp`、`=C:\x`）。
const DRIVE_BACKSLASH = /(?<![A-Za-z0-9_])[A-Za-z]:\\/;
const TRIPLE_QUOTE = /(?:\\?)"(?:\\?)"(?:\\?)"/;
const SCRIPT_REDIRECT = />{1,2}\s*['"]?([^\s'"]+\.(?:js|cjs|mjs|vbs|vbsx|ps1))['"]?\s*(?:<<|\r?\n|$)|<{1,2}-?\s*['"]?\w+['"]?[\s\S]*>{1,2}\s*['"]?([^\s'"]+\.(?:js|cjs|mjs|vbs|ps1))['"]?/i;
const SINGLE_BACKSLASH_DRIVE = /(?<![A-Za-z0-9_])[A-Za-z]:\\(?![\\/])/;
const HEREDOC_OR_ECHO = /(<<-?\s*['"]?[A-Za-z0-9_]+['"]?)|(\b(?:echo|printf|cat)\b[^|;&]*>)/;

function checkBash(cmd) {
  const c = String(cmd || '');
  const isEval = EVAL.test(c);
  if (isEval && DRIVE_BACKSLASH.test(c)) {
    return '检测到 `node -e/--eval/-p` 负载里含**盘符 + 反斜杠**的 Windows 路径：'
      + 'bash 双引号先吃一层、JS 字符串再吃一层，目标进程收到的是 `C:Usersx` 这类无反斜杠路径（不报错、静默指错地方）。\n' + FIX;
  }
  if (isEval && TRIPLE_QUOTE.test(c)) {
    return '检测到 `node -e` 负载里含 VBS 三引号 `"""`：内联生成脚本文本必然跨多层引号/反斜杠转义，实测会写出坏路径。\n' + FIX;
  }
  if (SCRIPT_REDIRECT.test(c) && HEREDOC_OR_ECHO.test(c) && SINGLE_BACKSLASH_DRIVE.test(c)) {
    return '检测到经 shell（heredoc/echo/重定向）把**单反斜杠**盘符路径写进 .js/.cjs/.vbs/.ps1：'
      + '目标语言会把 `\\U`、`\\n` 这类当转义吃掉，文件里的路径在运行时是错的（写对了应是 `\\\\`，但更推荐正斜杠）。\n' + FIX;
  }
  return null;
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = input.tool_name || input.toolName || '';
const ti = input.tool_input || input.toolInput || {};
if (!/bash|shell/i.test(tool)) process.exit(0);

const verdict = checkBash(ti.command);
if (!verdict) { ledger('allow|' + tool); process.exit(0); }
ledger('block|' + tool + '|' + String(ti.command || '').slice(0, 100).replace(/\n/g, ' '));
if (cfg.mode === 'warn') {
  console.log(JSON.stringify({ decision: 'approve', reason: '[win-path-guard][warn] ' + verdict }));
  process.exit(0);
}
// 本机 hook 实测以 hookSpecificOutput.permissionDecision='deny' 为准（与 huge-output-guard 一致）；
// 只发 decision:block 会被当成普通输出 fail-open，所以两种形态一起写。
console.log(JSON.stringify({
  decision: 'block',
  reason: '[win-path-guard] ' + verdict,
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[win-path-guard] ' + verdict },
}));
process.exit(0);
