#!/usr/bin/env node
// Pre/PostToolUse 守卫：修 Cua Driver 的"鼠标抢占"——把真实光标劫持与还原做成机制，不靠提示词。
//
// 实测依据（2026-09-30，1920x1080 / scale 1.0，用 user32 GetCursorPos 交叉验证驱动读数一致）：
//   ① `move_cursor` 传 `scope:"desktop"` → 真实光标从 (1079,583) 跳到 (600,400)。
//      而该工具的顶层描述写着 "Does NOT move the real mouse cursor"——**文档自相矛盾**，
//      照描述办事的 agent 会不知不觉把用户指针 teleport 走。
//   ② `click` 传 `delivery_mode:"foreground"` → 真实光标跳到点击点 (332,327)，
//      **并且升级失败时也照样 warp**（返回 foreground_unavailable，但指针已经走了、驱动不回位）。
//      工具文档说"restoring the prior foreground afterward"——还原的是**前台窗口**，不是**光标位置**。
//   ③ 二进制里 `platform-windows/src/uia/mod.rs` 有 "UIA Invoke ... failed" 紧邻 "SetCursorPos(..) failed"，
//      且整个二进制**没有任何 cursor_restore / foreground_restore 符号** → 驱动侧不会自己还原。
//   安全路径（实测不动真实光标，别拦）：element_index 点击、x,y 默认 background 点击、scroll(WM_VSCROLL)。
//
// 动作：
//   Pre  - 输入类工具触发前**快照真实光标位置**（写状态文件，按 session 归档）；
//          命中高危参数（foreground 升级 / desktop warp / bring_to_front）时按策略 deny 或放行并登记"需还原"。
//   Post - 比对当前与快照，**位置变了就用 SetCursorPos 还原**，并记台账。
//
// 关掉：~/.qoder/cua-cursor-guard.json 写 {"disabled":true}（或 env CUA_GUARD_DISABLE=1）
// 放宽某类：同文件写 {"allow_foreground":true} / {"allow_desktop_warp":true} / {"allow_bring_to_front":true}
// 台账：~/.qoder/tmp/cua-cursor-guard/decisions.log
'use strict';
require('./hook-crash-guard.js').install('cua-cursor-guard');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
// 配置与台账落在**当前客户端侧**的目录（CN 是 ~/.qoder-cn，国际版 ~/.qoder；两侧 scripts 本就是 junction 同源）
const CFG_ROOT = process.env.QODER_CONFIG_DIR && fs.existsSync(path.dirname(process.env.QODER_CONFIG_DIR))
  ? process.env.QODER_CONFIG_DIR
  : CLIENT_ROOT;
const STATE_DIR = process.env.CUA_GUARD_STATE_DIR || path.join(CFG_ROOT, 'tmp', 'cua-cursor-guard');
const LEDGER = path.join(STATE_DIR, 'decisions.log');
const CONFIG = process.env.CUA_GUARD_CONFIG || path.join(CFG_ROOT, 'cua-cursor-guard.json');
const DRIVER = process.env.CUA_GUARD_BIN || defaultDriver();

// 会投递输入/移动指针的工具（只对这些动手，读取类不碰，避免无谓开销）
// replay_trajectory（0.37.0 复查补入）：按录制顺序重放每一轮的 tool call，等价于批量输入，
// 录制里可能含 click(foreground)/move_cursor(desktop) —— 无法静态预判，靠 Pre 快照 + Post 还原兜住。
const INPUT_TOOLS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'move_cursor', 'bring_to_front', 'set_window_frame', 'invoke_menu', 'set_value',
  'run_steps', 'run_script', 'replay_trajectory']);

function defaultDriver() {
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'),
    path.join(os.homedir(), '.cua-driver', 'packages', 'current', 'cua-driver.exe'),
  ];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  return '';
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) {
    const chunks = []; const buf = Buffer.alloc(65512);
    try { let r; while ((r = fs.readSync(0, buf, 0, buf.length, 0)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}
function cfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function ledger(fields) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LEDGER, `${new Date().toISOString()}|${fields.join('|')}\n`); } catch (e) {}
}
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function runStub(command, timeout) {
  return execFileSync(command, { shell: true, encoding: 'utf8', timeout });
}

// --- cursor read/write: driver first (fast, no compile), user32 fallback ---
// A35：负载下 stub/驱动往返会超过原来的 4s/6s 预算 ⇒ 读不到光标 ⇒ Pre 不写快照、Post 早退不还原（fail-open）。
// 窄修＝只放宽**读取**预算并加一次重试；拦截范围、deny 文案、fail-open 语义与写入预算都不动。
// 无负载时首次读取即成功 ⇒ 不触发重试、不触及预算上限，路径行为与改前一致（模式隔离由测试的读取计数守住）。
const READ_TIMEOUT_MS = Number(process.env.CUA_GUARD_READ_TIMEOUT_MS || 12000);
const PS_READ_TIMEOUT_MS = Number(process.env.CUA_GUARD_PS_READ_TIMEOUT_MS || 15000);
const READ_RETRY_GAP_MS = Number(process.env.CUA_GUARD_READ_RETRY_GAP_MS || 150);
const validPos = (p) => !!(p && Number.isFinite(p.x) && Number.isFinite(p.y));

function readViaDriverOnce() {
  if (process.env.CUA_GUARD_READ_CMD) {
    if (process.env.CUA_GUARD_TEST_STUBS !== '1') return null;
    try { return JSON.parse(runStub(process.env.CUA_GUARD_READ_CMD, READ_TIMEOUT_MS)); } catch (e) { return null; }
  }
  if (!DRIVER) return null;
  try { return JSON.parse(execFileSync(DRIVER, ['call', 'get_cursor_position'], { encoding: 'utf8', timeout: READ_TIMEOUT_MS })); } catch (e) { return null; }
}

function cursorRead() {
  let viaDriver = readViaDriverOnce();
  if (!validPos(viaDriver)) {
    // 一次重试：负载尖峰通常是瞬时的，重读一次即可拿回快照，避免整轮守卫静默失效。
    sleepSync(READ_RETRY_GAP_MS);
    viaDriver = readViaDriverOnce();
  }
  if (validPos(viaDriver)) return { x: viaDriver.x, y: viaDriver.y, via: 'driver' };
  // 测试密闭门控：仅在显式测试模式下生效，生产路径逐字节不变。
  // 没有它，stub 超时会回落到真实桌面 GetCursorPos，用例既不稳定又可能误动用户指针。
  if (process.env.CUA_GUARD_TEST_STUBS === '1' && process.env.CUA_GUARD_TEST_NO_USER32 === '1') return null;
  try {
    const ps = `Add-Type -MemberDefinition 'using System;using System.Runtime.InteropServices;public struct P{public int X;public int Y;}public static class C{[DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);}' -Name CC -Namespace Cg; $v=New-Object Cg+P; [void][Cg.CC]::GetCursorPos([ref]$v); "$($v.X),$($v.Y)"`;
    const s = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: PS_READ_TIMEOUT_MS }).trim();
    const [x, y] = s.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, via: 'user32' };
  } catch (e) {}
  return null;
}
function cursorWrite(x, y) {
  if (process.env.CUA_GUARD_WRITE_CMD) {
    if (process.env.CUA_GUARD_TEST_STUBS !== '1') return 'stub-fail';
    try { runStub(process.env.CUA_GUARD_WRITE_CMD.replace('%X%', x).replace('%Y%', y), 4000); return 'stub'; } catch (e) { return 'stub-fail'; }
  }
  if (DRIVER) {
    try {
      execFileSync(DRIVER, ['call', 'move_cursor', '--args', JSON.stringify({ x, y, scope: 'desktop' })], { encoding: 'utf8', timeout: 4000 });
      return 'driver';
    } catch (e) {}
  }
  return cursorWriteUser32(x, y);
}
// 兜底通道：driver 写入"没报错但没落位"（实测 2026-10-13 一例 UNVERIFIED）时用它补写
function cursorWriteUser32(x, y) {
  if (process.env.CUA_GUARD_WRITE2_CMD) {
    if (process.env.CUA_GUARD_TEST_STUBS !== '1') return 'stub2-fail';
    try { runStub(process.env.CUA_GUARD_WRITE2_CMD.replace('%X%', x).replace('%Y%', y), 4000); return 'stub2'; } catch (e) { return 'stub2-fail'; }
  }
  // 测试密闭门控（同上）：禁止用例回落到真实 SetCursorPos，避免误动用户指针。
  if (process.env.CUA_GUARD_TEST_STUBS === '1' && process.env.CUA_GUARD_TEST_NO_USER32 === '1') return 'test-no-user32';
  try {
    const ps = `Add-Type -MemberDefinition 'using System;using System.Runtime.InteropServices;public static class S{[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);}' -Name SS -Namespace Cs; [void][Cs.SS]::SetCursorPos(${x},${y})`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 6000 });
    return 'user32';
  } catch (e) { return 'failed'; }
}
// driver 的移动是异步落地的（daemon 往返）——写完立刻复读会误判，按小间隔复读几轮
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
function samePos(a, b) { return !!(a && b && a.x === b.x && a.y === b.y); }
function readSettled(target, tries = 3, gapMs = 120) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = cursorRead();
    if (samePos(last, target)) return last;
    if (i < tries - 1) sleepSync(gapMs);
  }
  return last;
}

// --- classification of the hijack paths (all measured, see header) ---
function classify(tool, input) {
  const i = input || {};
  if (tool === 'bring_to_front') return { risk: 'bring_to_front', why: '该工具明确"deliberately breaks the no-foreground contract"，会换前台' };
  if (tool === 'move_cursor' && String(i.scope || '').toLowerCase() === 'desktop') return { risk: 'desktop_warp', why: 'move_cursor scope=desktop 会移动真实 OS 指针（其描述却写不动真实光标）' };
  if (['click', 'double_click', 'right_click', 'drag'].includes(tool) && String(i.delivery_mode || '').toLowerCase() === 'foreground') return { risk: 'foreground', why: 'delivery_mode=foreground 走 SetForegroundWindow+SendInput，会把真实光标 warp 到点击点且不还原' };
  // 0.35.2 起的新批量/脚本工具（2026-10-14 增补）：把同款高危参数包在 steps/script 里会绕过逐工具分类，必须一起查
  if (tool === 'run_steps') {
    if (String(i.delivery_mode || '').toLowerCase() === 'foreground') return { risk: 'foreground', why: 'run_steps 顶层 delivery_mode=foreground 让全部步骤走前台（激活窗口 + 指针可能移动）' };
    if (i.foreground_fallback === true) return { risk: 'foreground', why: 'run_steps foreground_fallback=true 会对被拒步骤自动升级前台（窗口被激活 + 指针可能移动）' };
    const steps = Array.isArray(i.steps) ? i.steps : [];
    for (const st of steps) {
      if (!st || typeof st !== 'object') continue;
      let t = '', a = {};
      if (typeof st.tool === 'string') { t = st.tool; a = st.args || {}; }
      else {
        const k = Object.keys(st).find((x) => !['wait_for', 'expect', 'timeout_ms'].includes(x));
        if (k && st[k] && typeof st[k] === 'object') { t = k; a = st[k]; }
      }
      if (t === 'move_cursor' && String(a.scope || '').toLowerCase() === 'desktop') return { risk: 'desktop_warp', why: 'run_steps 里嵌了 move_cursor scope=desktop（真实指针会被 teleport）' };
      if (['click', 'double_click', 'right_click', 'drag'].includes(t) && String(a.delivery_mode || '').toLowerCase() === 'foreground') return { risk: 'foreground', why: 'run_steps 里嵌了 delivery_mode=foreground（指针 warp 且不还原）' };
    }
    return { risk: 'safe', why: 'run_steps：未含前台升级/桌面 warp 参数' };
  }
  if (tool === 'run_script') {
    const s = String(i.script || '');
    if (/delivery_mode\s*[:=]\s*['"]foreground['"]/.test(s)) return { risk: 'foreground', why: 'run_script 脚本里含 delivery_mode=foreground' };
    if (/scope\s*[:=]\s*['"]desktop['"]/.test(s)) return { risk: 'desktop_warp', why: 'run_script 脚本里含 scope=desktop' };
    if (s.includes('bring_to_front')) return { risk: 'bring_to_front', why: 'run_script 脚本里调用了 bring_to_front' };
    return { risk: 'safe', why: 'run_script：静态扫描未含高危参数' };
  }
  return { risk: 'safe', why: 'background/UIA/PostMessage 路径，实测不移动真实光标' };
}

let payload;
try { payload = JSON.parse(readStdin() || '{}'); } catch (e) { payload = {}; }
const event = payload.hook_event_name || '';
const rawTool = String(payload.tool_name || '');
const sessionId = payload.session_id || 'nosess';
const c = cfg();

// **MCP 懒加载形态**：模型调的是元工具 `mcp_call`，真正的驱动工具名在 tool_input.toolName（限定名，
// 且 server 名被规范化成下划线 `mcp__cua_driver__...`），参数在 tool_input.arguments。
// 只按 `mcp__cua-driver__*` 写 matcher / 分类器会**永远匹配不上**（2026-09-30 实测：调用照做、台账零记录）。
let toolName = rawTool;
let input = payload.tool_input || {};
if (/^mcp_call$/.test(rawTool) && input && typeof input === 'object') {
  toolName = String(input.toolName || '');
  input = (input.arguments && typeof input.arguments === 'object') ? input.arguments : {};
}
const short = toolName.includes('__') ? toolName.split('__').pop() : toolName;

// Bash / PowerShell 里直调驱动（`cua-driver call move_cursor --args {...}`）同样会抢鼠标，
// 而且完全绕开 MCP 通道——必须一并识别，否则守卫只管一半。
const shell = rawTool === 'Bash' || /bash|shell|powershell|cmd/i.test(rawTool);
const cmdText = shell ? String(input.command || '') : '';
const cliRouted = /cua-driver(?:\.exe)?["'\s]+call/i.test(cmdText);

// 从命令行里抠出被调用的驱动工具名与 --args JSON（引号包裹或裸 JSON 都出现过）
let cliTool = '', cliArgs = {};
if (cliRouted) {
  const m = cmdText.match(/call\s+["']?([a-z_][a-z0-9_]*)/i);
  cliTool = m ? m[1] : '';
  const cands = [...cmdText.matchAll(/--args\s+(?:"(\{[\s\S]*?\})"|'(\{[\s\S]*?\})'|(\{[\s\S]*?\}))/g)];
  for (const g of cands) {
    for (const piece of [g[1], g[2], g[3]]) {
      if (!piece) continue;
      try { cliArgs = JSON.parse(piece.replace(/\\"/g, '"')); break; } catch (e) {}
    }
    if (Object.keys(cliArgs).length) break;
  }
}

// GUI 直控 API：出现即说明"在用 shell 绕过驱动做桌面自动化"——会抢真实光标 / 焦点，
// 且完全脱离会话级光标隔离。上游 skill 自带的自检也是这三问（是否前台、是否动真实光标、是否绕过驱动）。
const GUI_BYPASS = /SetCursorPos|SendInput|mouse_event|keybd_event|SetForegroundWindow|AttachThreadInput|nircmd\s+(sendmouse|clickkey|smash)|pyautogui|pynput|autohotkey|\bahk\b|System\.Windows\.Forms\.Mouse/i;

if (c.disabled || process.env.CUA_GUARD_DISABLE === '1') { ledger([event, 'x', 'skipped-disabled']); out({ continue: true }); process.exit(0); }

// shell 里手搓 GUI 输入：拦下来并把该用的工具名说清楚
if (shell && GUI_BYPASS.test(cmdText) && !c.allow_shell_gui) {
  ledger(['pre', rawTool, 'gui-bypass', 'deny', cmdText.slice(0, 80)]);
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[cua-cursor-guard] 这条命令直接用 Win32/SendInput 级别的原语操作桌面（SetCursorPos / SendInput / SetForegroundWindow 一类），会搬走用户的真实光标、抢前台，而且绕开了会话级光标隔离与录制。
需要操作电脑请走 CUA 驱动：
  · 原生应用 / 桌面窗口 → mcp__cua_driver__ 系列（优先 get_window_state + element_index 送达，默认 background，不动真实光标）
  · 网页 → browser-use（CDP 通道）
  · 只有无 UI 可达性的场景（自绘 canvas / 远程桌面）才考虑前台升级，且需用户批准
确实需要这段脚本时，由用户显式放宽：<配置目录>/cua-cursor-guard.json 写 {"allow_shell_gui":true}，或直接问用户。`,
    },
  });
  process.exit(0);
}

const targetTool = cliRouted ? cliTool : short;
const targetInput = cliRouted ? cliArgs : input;
const interested = INPUT_TOOLS.has(targetTool) && (/cua/i.test(toolName) || cliRouted);
if (!interested) {
  if (process.env.CUA_GUARD_TRACE === '1') ledger([event, rawTool || 'x', 'not-cua']);
  out({ continue: true }); process.exit(0);
}

const k = classify(targetTool, targetInput);

if (event === 'PreToolUse') {
  const pos = cursorRead();
  if (pos) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, `${sessionId}.json`), JSON.stringify({ at: Date.now(), before: pos, tool: targetTool, risk: k.risk }));
    } catch (e) {}
  }
  const denyMap = { foreground: 'allow_foreground', desktop_warp: 'allow_desktop_warp', bring_to_front: 'allow_bring_to_front' };
  const denyKey = denyMap[k.risk];
  if (denyKey && !c[denyKey]) {
    ledger(['pre', targetTool, k.risk, 'deny', pos ? `${pos.x},${pos.y}` : 'unreadable']);
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[cua-cursor-guard] ${k.why}。这是"鼠标抢占"的直接来源，且驱动不会把指针还原回用户手上。
改走 background 路径：优先 element_index（先 get_window_state），或 x,y + 默认 delivery_mode=background；
指针可视化交给 agent overlay（move_cursor 用 scope=window，别用 desktop）。
确实需要前台/真指针（标题栏拖拽、RDP 之类）时，由用户显式放宽：~/.qoder/cua-cursor-guard.json 写 {"${denyKey}":true}，或直接问用户。`,
      },
    });
    process.exit(0); // deny via JSON, not exit 2 — keeps the reason readable
  }
  ledger(['pre', targetTool, k.risk, 'allow', pos ? `${pos.x},${pos.y}` : 'unreadable']);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: k.risk === 'safe' ? '' : `[cua-cursor-guard] 已放宽 ${k.risk}，光标位置已快照，Post 阶段会还原` } });
  process.exit(0);
}

if (event === 'PostToolUse') {
  const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sessionId}.json`), 'utf8')); } catch (e) { return null; } })();
  if (!st || !st.before) { ledger(['post', targetTool, 'no-snapshot']); out({ continue: true }); process.exit(0); }
  const now = cursorRead();
  if (!now) { ledger(['post', targetTool, 'cursor-unreadable']); out({ continue: true }); process.exit(0); }
  if (samePos(now, st.before)) { ledger(['post', targetTool, 'unchanged']); out({ continue: true }); process.exit(0); }
  // 还原链路（2026-10-14 加固）：driver 写入 → 沉降复读 → 未落位则 user32 兜底 → 再沉降复读；两条都失败才 UNVERIFIED
  let how = cursorWrite(st.before.x, st.before.y);
  let after = readSettled(st.before);
  if (!samePos(after, st.before)) {
    how += '+' + cursorWriteUser32(st.before.x, st.before.y);
    after = readSettled(st.before);
  }
  const ok = samePos(after, st.before);
  ledger(['post', targetTool, `restored(${st.before.x},${st.before.y})<-(${now.x},${now.y})`, `via=${how}`, ok ? 'verified' : 'UNVERIFIED']);
  out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: ok
        ? `[cua-cursor-guard] 刚才的操作把用户真实光标从 (${st.before.x},${st.before.y}) 移到了 (${now.x},${now.y})，已还原并复验。下次别用 ${k.risk} 这类路径。`
        : `[cua-cursor-guard] 光标位置被改动且**自动还原未确认**（driver 与 user32 两条路径都试过；via=${how}，读到 ${JSON.stringify(after)}）——需要人工确认用户指针是否还在原位。`,
    },
  });
  process.exit(0);
}

out({ continue: true });
process.exit(0);
