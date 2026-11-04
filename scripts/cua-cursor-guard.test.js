// Test suite for cua-cursor-guard.js. Uses a stub cursor so nothing touches the real desktop.
// Run: node cua-cursor-guard.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, 'cua-cursor-guard.js');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cuaguard-'));
const STATE = path.join(SANDBOX, 'state');
const STUB = path.join(SANDBOX, 'cursor-stub.cjs');
const CURSOR = path.join(SANDBOX, 'cursor.json');
const CFG = path.join(SANDBOX, 'cua-cursor-guard.json');

fs.writeFileSync(STUB, [
  "const fs=require('fs');",
  "const f=process.env.CUA_STUB_CURSOR;",
  "const g=()=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){return {x:0,y:0};}};",
  "if(process.argv[2]==='set'){const p=g();p.x=Number(process.argv[3]);p.y=Number(process.argv[4]);fs.writeFileSync(f,JSON.stringify(p));process.exit(0);}",
  "process.stdout.write(JSON.stringify(g()));",
].join('\n'));
fs.writeFileSync(CURSOR, JSON.stringify({ x: 1079, y: 583 }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  <- ' + extra : '')); } };
const guardSource = fs.readFileSync(GUARD, 'utf8');
ok('driver calls use argv, not a shell', /execFileSync\(DRIVER, \['call', 'get_cursor_position'\]/.test(guardSource) && /execFileSync\(DRIVER, \['call', 'move_cursor', '--args'/.test(guardSource));
ok('test stubs are explicitly gated', /CUA_GUARD_TEST_STUBS !== '1'/.test(guardSource));
ok('shell:true is confined to the gated stub helper', (guardSource.match(/shell:\s*true/g) || []).length === 1 && /function runStub[\s\S]{0,200}shell:\s*true/.test(guardSource));

function run(event, toolName, input, opts = {}) {
  const payload = { hook_event_name: event, tool_name: toolName, tool_input: input, session_id: opts.session || 's-' + Math.random().toString(36).slice(2, 8) };
  const env = Object.assign({}, process.env, {
    CUA_GUARD_STATE_DIR: STATE,
    CUA_GUARD_CONFIG: CFG,
    CUA_STUB_CURSOR: CURSOR,
    CUA_GUARD_READ_CMD: `node "${STUB}" read`,
    CUA_GUARD_WRITE_CMD: opts.writeCmd || `node "${STUB}" set %X% %Y%`,
    CUA_GUARD_TEST_STUBS: '1',
    CUA_GUARD_BIN: '',
  });
  if (opts.write2Cmd) env.CUA_GUARD_WRITE2_CMD = opts.write2Cmd;
  else delete env.CUA_GUARD_WRITE2_CMD;
  if (opts.disable === '1') env.CUA_GUARD_DISABLE = '1';
  try {
    const out = execFileSync(process.execPath, [GUARD], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 20000 });
    return { out, json: (() => { try { return JSON.parse(out); } catch (e) { return null; } })(), sid: payload.session_id };
  } catch (e) {
    return { err: String(e.stdout || e.message).slice(0, 300), sid: payload.session_id };
  }
}
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const setCua = (x, y) => fs.writeFileSync(CURSOR, JSON.stringify({ x, y }));

console.log('== sandbox: ' + SANDBOX + '\n');

// 1-3: the three measured hijack paths must be DENIED
const t1 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 10, y: 10, delivery_mode: 'foreground' });
ok('foreground click -> deny', decision(t1) === 'deny', decision(t1) + ' ' + t1.out);
ok('foreground deny reason names the hijack', /鼠标抢占|warp/.test(t1.out || ''));

const t2 = run('PreToolUse', 'mcp__cua-driver__move_cursor', { x: 600, y: 400, scope: 'desktop' });
ok('move_cursor scope=desktop -> deny', decision(t2) === 'deny', decision(t2));

const t3 = run('PreToolUse', 'mcp__cua-driver__bring_to_front', { pid: 1 });
ok('bring_to_front -> deny', decision(t3) === 'deny', decision(t3));

// 4-6: the measured-safe paths must be ALLOWED (control group: guard must not be a blanket blocker)
const t4 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, window_id: 2, element_index: 3, snapshot_id: 's1' });
ok('CONTROL element_index click -> allow', decision(t4) === 'allow', decision(t4));
const t5 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 150, y: 150, capture_id: 'c1' });
ok('CONTROL background pixel click -> allow', decision(t5) === 'allow', decision(t5));
const t6 = run('PreToolUse', 'mcp__cua-driver__scroll', { pid: 1, direction: 'down' });
ok('CONTROL scroll -> allow', decision(t6) === 'allow', decision(t6));

// 7: snapshot file written on pre
const t7 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 9, y: 9, capture_id: 'c' });
const snapFile = path.join(STATE, `${t7.sid}.json`);
ok('pre writes cursor snapshot', fs.existsSync(snapFile), snapFile);
ok('snapshot holds the pre-call position', fs.existsSync(snapFile) && JSON.parse(fs.readFileSync(snapFile, 'utf8')).before.x === 1079);

// 8: PostToolUse restores when the cursor moved
setCua(332, 327); // simulate the hijack having moved the pointer
const t8 = run('PostToolUse', 'mcp__cua-driver__click', { pid: 1, x: 9, y: 9 }, { session: t7.sid });
const afterRestore = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('post restores moved cursor', afterRestore.x === 1079 && afterRestore.y === 583, JSON.stringify(afterRestore));
ok('post reports verification', /已还原并复验/.test(t8.out || ''), (t8.out || '').slice(0, 120));

// 9: PostToolUse no-op when nothing moved (must not spam)
const t9 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 5, y: 5, capture_id: 'cc' });
setCua(1079, 583);
const t9b = run('PostToolUse', 'mcp__cua-driver__click', { pid: 1, x: 5, y: 5 }, { session: t9.sid });
const led = fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8').trim().split('\n');
ok('post with unchanged cursor logs unchanged', /unchanged/.test(led[led.length - 1]), led[led.length - 1]);
ok('post unchanged emits no context spam', !/additionalContext/.test(t9b.out || ''));

// 9b-9c: restore fallback chain (2026-10-14)：driver 写入"没落位"（模拟 stub 空写）时，必须走 user32 兜底通道再复验
const NOOP_WRITE = `node -e "process.exit(0)"`;
const tF = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 11, y: 11, capture_id: 'cf' });
setCua(332, 327); // hijack moved the pointer
const tFb = run('PostToolUse', 'mcp__cua-driver__click', { pid: 1, x: 11, y: 11 }, { session: tF.sid, writeCmd: NOOP_WRITE, write2Cmd: `node "${STUB}" set %X% %Y%` });
const afterF = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('fallback: driver misland -> stub2 lands the restore', afterF.x === 1079 && afterF.y === 583, JSON.stringify(afterF));
ok('fallback: ledger shows the two-hop chain as verified', /via=stub\+stub2\|verified/.test(fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8')), 'check decisions.log');
ok('fallback: message still reports verified restore', /已还原并复验/.test(tFb.out || ''), (tFb.out || '').slice(0, 120));

// 9c: both channels fail -> UNVERIFIED + manual-confirm context (must not silently say restored)
const tU = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 12, y: 12, capture_id: 'cu' });
setCua(2157, 637);
const tUb = run('PostToolUse', 'mcp__cua-driver__click', { pid: 1, x: 12, y: 12 }, { session: tU.sid, writeCmd: NOOP_WRITE, write2Cmd: NOOP_WRITE });
const ledU = fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8');
ok('both channels fail -> UNVERIFIED ledger', /via=stub\+stub2\|UNVERIFIED/.test(ledU), 'check decisions.log');
ok('both fail -> warns for manual confirmation', /未确认|人工确认/.test(tUb.out || ''), (tUb.out || '').slice(0, 140));
setCua(1079, 583); // reset sandbox cursor for later tests

// 9d-9k: 0.35.2 新增的批量/脚本工具（run_steps / run_script）同样不能成为后门（2026-10-14）
const tR1 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_steps', arguments: { pid: 1, delivery_mode: 'foreground', steps: [{ click: { x: 1, y: 1 } }] } });
ok('run_steps top-level foreground -> deny', decision(tR1) === 'deny', decision(tR1) + ' ' + (tR1.out || '').slice(0, 100));
const tR2 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_steps', arguments: { pid: 1, foreground_fallback: true, steps: [{ type_text: { text: 'hi' } }] } });
ok('run_steps foreground_fallback -> deny', decision(tR2) === 'deny', decision(tR2));
const tR3 = run('PreToolUse', 'mcp__cua_driver__run_steps', { pid: 1, steps: [{ tool: 'move_cursor', args: { x: 1, y: 1, scope: 'desktop' } }] });
ok('run_steps nested move_cursor scope=desktop -> deny', decision(tR3) === 'deny', decision(tR3));
const tR4 = run('PreToolUse', 'mcp__cua_driver__run_steps', { pid: 1, steps: [{ move_cursor: { x: 1, y: 1, scope: 'desktop' } }] });
ok('run_steps shorthand nested desktop warp -> deny', decision(tR4) === 'deny', decision(tR4));
const tR5 = run('PreToolUse', 'mcp__cua_driver__run_steps', { pid: 1, steps: [{ click: { x: 3, y: 3 } }, { press_key: { key: 'return' }, expect: [{ name: 'Done' }] }] });
ok('CONTROL run_steps safe steps -> allow', decision(tR5) === 'allow', decision(tR5));
const tR6 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_script', arguments: { script: 'const a = await cua.getApp("X"); await cua.call("click", {pid: 1, x: 2, y: 2, delivery_mode: "foreground"}); return 1;' } });
ok('run_script with foreground call -> deny', decision(tR6) === 'deny', decision(tR6) + ' ' + (tR6.out || '').slice(0, 100));
const tR7 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_script', arguments: { script: 'const app = await cua.getApp("Calculator"); const [d] = await app.query({role: "statictext"}); return d.value;' } });
ok('CONTROL run_script plain JS -> allow', decision(tR7) === 'allow', decision(tR7));
const tR8 = run('PreToolUse', 'mcp__cua_driver__run_script', { script: 'await cua.call("move_cursor", {x: 1, y: 1, scope: "desktop"});' });
ok('run_script with scope=desktop -> deny', decision(tR8) === 'deny', decision(tR8));
const tR9 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_steps', arguments: { pid: 1, steps: [{ click: { x: 4, y: 4 } }] } });
ok('run_steps gets a cursor snapshot too', fs.existsSync(path.join(STATE, `${tR9.sid}.json`)), 'snapshot file');
setCua(2157, 637);
const tR9b = run('PostToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__run_steps', arguments: { pid: 1, steps: [{ click: { x: 4, y: 4 } }] } }, { session: tR9.sid });
const afterR9 = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('run_steps post restores the moved cursor', afterR9.x === 1079 && afterR9.y === 583, JSON.stringify(afterR9));

// 10: non-cua tool is ignored entirely (negative control on scope)
const t10 = run('PreToolUse', 'Bash', { command: 'ls' });
ok('non-cua tool untouched', !t10.json || !t10.json.hookSpecificOutput || !decision(t10), (t10.out || '').slice(0, 80));

// 11: disabled switch
const t11 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 1, y: 1, delivery_mode: 'foreground' }, { disable: '1' });
ok('CUA_GUARD_DISABLE=1 skips everything', t11.out === '' || /continue/.test(t11.out), (t11.out || '').slice(0, 80));

// 12: escape hatch actually opens (and only for the class you open)
fs.writeFileSync(CFG, JSON.stringify({ allow_foreground: true }));
const t12 = run('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 1, y: 1, delivery_mode: 'foreground' });
ok('allow_foreground=true opens that class', decision(t12) === 'allow', decision(t12));
const t12b = run('PreToolUse', 'mcp__cua-driver__move_cursor', { x: 1, y: 1, scope: 'desktop' });
ok('other classes stay denied', decision(t12b) === 'deny', decision(t12b));
fs.writeFileSync(CFG, JSON.stringify({}));

// 13: ledger exists and has one line per decision
ok('decisions ledger written', fs.existsSync(path.join(STATE, 'decisions.log')));

// --- 14+: the shapes that ACTUALLY reach us in production (regression for the 2026-09-30 miss) ---
// MCP lazy-loading wraps every driver call in the meta tool `mcp_call`, with the qualified
// inner name in tool_input.toolName (underscored server name!) and args in tool_input.arguments.
const t14 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__move_cursor', arguments: { x: 900, y: 700, scope: 'desktop' } });
ok('LAZY mcp_call + scope=desktop -> deny', decision(t14) === 'deny', decision(t14) + ' ' + (t14.out || '').slice(0, 100));

const t15 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__click', arguments: { pid: 1, x: 5, y: 5, delivery_mode: 'foreground' } });
ok('LAZY mcp_call + foreground click -> deny', decision(t15) === 'deny', decision(t15));

const t16 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua-driver__move_cursor', arguments: { x: 1, y: 1, scope: 'desktop' } });
ok('hyphenated server name also caught', decision(t16) === 'deny', decision(t16));

const t17 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__click', arguments: { pid: 1, window_id: 2, element_index: 3, snapshot_id: 's' } });
ok('CONTROL LAZY safe element click -> allow', decision(t17) === 'allow', decision(t17));

// Non-CUA meta calls must be left completely alone (negative control: guard can't be a blanket MCP blocker)
const t18 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__browser-use__click', arguments: { x: 1, y: 1 } });
ok('CONTROL mcp_call to browser-use untouched', !decision(t18), (t18.out || '').slice(0, 90));
const t19 = run('PreToolUse', 'Bash', { command: 'ls -la /tmp' });
ok('CONTROL plain Bash untouched', !decision(t19), (t19.out || '').slice(0, 90));

// Bash that shells straight into the driver (bypasses MCP entirely) — the other half of the hole
const t20 = run('PreToolUse', 'Bash', { command: '"/x/cua-driver.exe" call move_cursor --args "{\\"x\\":900,\\"y\\":700,\\"scope\\":\\"desktop\\"}"' });
ok('CLI-routed desktop warp via Bash -> deny', decision(t20) === 'deny', decision(t20) + ' ' + (t20.out || '').slice(0, 120));
const t21 = run('PreToolUse', 'Bash', { command: 'cua-driver call bring_to_front --args {"pid":123}' });
ok('CLI-routed bring_to_front via Bash -> deny', decision(t21) === 'deny', decision(t21));
const t22 = run('PreToolUse', 'Bash', { command: 'cua-driver call get_window_state --args {"pid":1}' });
ok('CONTROL CLI-routed read-only tool untouched (not an input tool)', !decision(t22), (t22.out || '').slice(0, 90));

// --- GUI bypass: hand-rolled Win32 input instead of the driver ---
const t23 = run('PreToolUse', 'Bash', { command: 'powershell -Command "Add-Type ... SetCursorPos(10,20)"' });
ok('shell SetCursorPos bypass -> deny', decision(t23) === 'deny', decision(t23));
const t24 = run('PreToolUse', 'Bash', { command: 'node -e "robotjs.moveMouse(5,5)" ; python -c "import pyautogui; pyautogui.click(1,2)"' });
ok('pyautogui bypass -> deny', decision(t24) === 'deny', decision(t24));
const t25 = run('PreToolUse', 'Bash', { command: 'nircmd sendmouse ldown 100 100' });
ok('nircmd sendmouse -> deny', decision(t25) === 'deny', decision(t25));
// negative controls: ordinary shell work must NOT be blocked by the bypass detector
for (const [name, cmd] of [
  ['git status', 'git status'],
  ['registry read', 'powershell -Command "Get-ItemProperty HKCU:\\Environment"'],
  ['npm install', 'npm install -g something --registry=https://registry.npmmirror.com'],
]) {
  const r = run('PreToolUse', 'Bash', { command: cmd });
  ok('CONTROL shell not blocked: ' + name, !decision(r), (r.out || '').slice(0, 90));
}
fs.writeFileSync(CFG, JSON.stringify({ allow_shell_gui: true }));
const t26 = run('PreToolUse', 'Bash', { command: 'powershell -Command "SetCursorPos(1,1)"' });
ok('allow_shell_gui=true opens the bypass gate', !decision(t26) || decision(t26) !== 'deny', decision(t26));
const t27 = run('PreToolUse', 'mcp_call', { toolName: 'mcp__cua_driver__move_cursor', arguments: { x: 1, y: 1, scope: 'desktop' } });
ok('desktop warp STILL denied when only shell_gui is allowed', decision(t27) === 'deny', decision(t27));
fs.writeFileSync(CFG, JSON.stringify({}));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
