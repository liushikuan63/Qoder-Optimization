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

// A57：harness 单次调用预算。负载下守卫的「读重试(2×12s) + 写重试(2×12s) + user32 兜底(15s)」会超过
// 原来的 20s ⇒ 用例拿不到任何输出（detail=undefined），被误当成守卫判红（负载 A/B 实测到的 harness-no-response）。
// 下界由守卫源码里的预算推导（见 A57-7），不拍数字：守卫再放宽预算时那条断言会红，提醒同步 harness。
const DEFAULT_TIMEOUT = 90000;

function run(event, toolName, input, opts = {}) {
  const payload = { hook_event_name: event, tool_name: toolName, tool_input: input, session_id: opts.session || 's-' + Math.random().toString(36).slice(2, 8) };
  const env = Object.assign({}, process.env, {
    CUA_GUARD_STATE_DIR: STATE,
    CUA_GUARD_CONFIG: CFG,
    CUA_STUB_CURSOR: CURSOR,
    CUA_GUARD_READ_CMD: opts.readCmd || `node "${STUB}" read`,
    CUA_GUARD_WRITE_CMD: opts.writeCmd || `node "${STUB}" set %X% %Y%`,
    CUA_GUARD_TEST_STUBS: '1',
    CUA_GUARD_BIN: '',
  }, opts.env || {});
  if (opts.write2Cmd) env.CUA_GUARD_WRITE2_CMD = opts.write2Cmd;
  else delete env.CUA_GUARD_WRITE2_CMD;
  if (opts.disable === '1') env.CUA_GUARD_DISABLE = '1';
  try {
    const out = execFileSync(process.execPath, [GUARD], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: opts.timeout || DEFAULT_TIMEOUT });
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

// --- A35：负载下读取超预算 ⇒ 快照缺失/光标读不到 ⇒ Post 阶段 fail-open 早退不还原 ---
// 用「慢 stub」确定性复现负载机制（不靠真跑 8 个忙等进程）：读取耗时超过预算就等价于负载下的超时。
const SLOW_ALWAYS = path.join(SANDBOX, 'slow-always.cjs');
const SLOW_FIRST = path.join(SANDBOX, 'slow-first.cjs');
const FAIL_ALWAYS = path.join(SANDBOX, 'fail-always.cjs');
const COUNTED = path.join(SANDBOX, 'counted.cjs');
const DELAY = 4500;                       // > 改前 4000ms 读取预算
// 重试用例的每次读取预算：只需「小于首次延迟」即可隔离重试这一处。首版写 400ms，在现役两侧跑时
// 连重试那次都扛不住环境负载下的 node 启动开销 ⇒ 假红（stub 调用次数仍 >=2，证明不是没重试）。
// 第二版 2500ms 在 8 忙等负载下仍假红，且 reads=0 —— 连 stub 进程都没启动到写标记那一步。
// 按实测契约提到 8000ms（首次延迟同步提到 20000ms），并把「预算 < 首次延迟」写成显式断言防空转。
const FIRST_DELAY = 20000;
const RETRY_BUDGET = 8000;
fs.writeFileSync(SLOW_ALWAYS, [
  "const fs=require('fs');",
  `const d=${DELAY};const t=Date.now();while(Date.now()-t<d){}`,   // 忙等，模拟负载下的慢响应
  "process.stdout.write(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));",
].join('\n'));
fs.writeFileSync(SLOW_FIRST, [
  "const fs=require('fs');",
  "const m=process.env.CUA_STUB_MARKER;",
  "let n=0;try{n=Number(fs.readFileSync(m,'utf8'))||0;}catch(e){}",
  "n++;fs.writeFileSync(m,String(n));",
  `if(n===1){const t=Date.now();while(Date.now()-t<${FIRST_DELAY}){}}`,      // 首次超预算，之后立即返回
  "process.stdout.write(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));",
].join('\n'));
fs.writeFileSync(FAIL_ALWAYS, "process.exit(1);");
fs.writeFileSync(COUNTED, [
  "const fs=require('fs');",
  "const m=process.env.CUA_STUB_MARKER;",
  "let n=0;try{n=Number(fs.readFileSync(m,'utf8'))||0;}catch(e){}",
  "fs.writeFileSync(m,String(n+1));",
  "if(process.argv[2]==='set'){const p=JSON.parse(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));p.x=Number(process.argv[3]);p.y=Number(process.argv[4]);fs.writeFileSync(process.env.CUA_STUB_CURSOR,JSON.stringify(p));process.exit(0);}",
  "process.stdout.write(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));",
].join('\n'));

const SAFE_STEPS = { toolName: 'mcp__cua_driver__run_steps', arguments: { pid: 1, steps: [{ click: { x: 4, y: 4 } }] } };
const reads = (marker) => { try { return Number(fs.readFileSync(marker, 'utf8')) || 0; } catch (e) { return 0; } };
// 账本只看最后一行：整文件正则会匹配到前面用例留下的同名记录 ⇒ 恒真假绿（A57 必须逐轮取证）。
const lastLedger = () => { const l = fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8').trim().split('\n'); return l[l.length - 1]; };

// A57 写入侧 stub：慢写入（忙等后才落位）／首次慢写入（隔离重试）／慢且永不落位（负对照）／只数写入次数
const SLOW_WRITE = path.join(SANDBOX, 'slow-write.cjs');
const SLOW_FIRST_WRITE = path.join(SANDBOX, 'slow-first-write.cjs');
const SLOW_NOOP_WRITE = path.join(SANDBOX, 'slow-noop-write.cjs');
const COUNTED_WRITE = path.join(SANDBOX, 'counted-write.cjs');
const SET_LINES = [
  "if(process.argv[2]==='set'){const p=JSON.parse(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));p.x=Number(process.argv[3]);p.y=Number(process.argv[4]);fs.writeFileSync(process.env.CUA_STUB_CURSOR,JSON.stringify(p));process.exit(0);}",
  "process.stdout.write(fs.readFileSync(process.env.CUA_STUB_CURSOR,'utf8'));",
];
fs.writeFileSync(SLOW_WRITE, ["const fs=require('fs');", `const t=Date.now();while(Date.now()-t<${DELAY}){}`, ...SET_LINES].join('\n'));
fs.writeFileSync(SLOW_FIRST_WRITE, [
  "const fs=require('fs');",
  "const m=process.env.CUA_STUB_MARKER;",
  "let n=0;try{n=Number(fs.readFileSync(m,'utf8'))||0;}catch(e){}",
  "n++;fs.writeFileSync(m,String(n));",                    // 先记数再忙等：被超时杀掉也算一次尝试
  `if(n===1){const t=Date.now();while(Date.now()-t<${FIRST_DELAY}){}}`,
  ...SET_LINES,
].join('\n'));
fs.writeFileSync(SLOW_NOOP_WRITE, ["const fs=require('fs');", `const t=Date.now();while(Date.now()-t<${DELAY}){}`, "process.exit(0);"].join('\n'));
fs.writeFileSync(COUNTED_WRITE, [
  "const fs=require('fs');",
  "if(process.argv[2]==='set'){const m=process.env.CUA_STUB_MARKER;let n=0;try{n=Number(fs.readFileSync(m,'utf8'))||0;}catch(e){}fs.writeFileSync(m,String(n+1));}",
  ...SET_LINES,
].join('\n'));
// A35 用例全部密闭：禁止回落到真实桌面 user32（读/写都不许），否则断言不稳定且可能误动用户指针。
const run35 = (event, tool, input, opts = {}) => run(event, tool, input, Object.assign({}, opts, { env: Object.assign({ CUA_GUARD_TEST_NO_USER32: '1' }, opts.env || {}) }));
// A57 用例各自一份光标文件。实测机制（探针 a57-orphan-probe，5 PASS）：runStub 的 shell:true + timeout
// 只杀 cmd.exe，孙进程 node 会跑完并落位；argv 形式（生产 DRIVER / powershell 通道）无此问题。
// 共用一份光标文件时，上一个用例的孤儿写入会污染下一个用例 —— 首版 A57-5 负对照因此假红。
// 同理：A57-1/A57-3 的「光标已还原」可能被孤儿满足，**判据以账本 via=…|verified 为准**（它要求预算内写成功）。
const caseCursor = (tag) => path.join(SANDBOX, `cursor-${tag}.json`);
const setCase = (tag, x, y) => fs.writeFileSync(caseCursor(tag), JSON.stringify({ x, y }));
const readCase = (tag) => JSON.parse(fs.readFileSync(caseCursor(tag), 'utf8'));
const run57 = (tag, event, tool, input, opts = {}) => run35(event, tool, input, Object.assign({}, opts, { env: Object.assign({ CUA_STUB_CURSOR: caseCursor(tag) }, opts.env || {}) }));

// A35-1 预算：读取慢于改前 4000ms 预算时，快照必须仍拿到、光标必须仍还原。
setCua(1079, 583);
const a1pre = run35('PreToolUse', 'mcp_call', SAFE_STEPS, { readCmd: `node "${SLOW_ALWAYS}" read`, timeout: 90000 });
ok('A35 慢读取下仍拿到光标快照（预算够用）', fs.existsSync(path.join(STATE, `${a1pre.sid}.json`)), 'snapshot missing -> Post 会 no-snapshot 早退');
setCua(2157, 637);
run35('PostToolUse', 'mcp_call', SAFE_STEPS, { session: a1pre.sid, readCmd: `node "${SLOW_ALWAYS}" read`, timeout: 90000 });
const a1after = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('A35 慢读取下光标仍被还原（不再 fail-open 早退）', a1after.x === 1079 && a1after.y === 583, JSON.stringify(a1after));

// A35-2 重试：首次读取超预算、第二次立即成功 ⇒ 必须靠一次重试救回（隔离「重试」这一处）。
setCua(1079, 583);
const m2 = path.join(SANDBOX, 'm2.txt');
const a2pre = run35('PreToolUse', 'mcp_call', SAFE_STEPS, {
  readCmd: `node "${SLOW_FIRST}" read`, timeout: 90000,
  env: { CUA_STUB_MARKER: m2, CUA_GUARD_READ_TIMEOUT_MS: String(RETRY_BUDGET) },
});
ok('A35 首次读取超时后重试成功（快照仍在）', fs.existsSync(path.join(STATE, `${a2pre.sid}.json`)), 'snapshot missing');
setCua(2157, 637);
run35('PostToolUse', 'mcp_call', SAFE_STEPS, {
  session: a2pre.sid, readCmd: `node "${SLOW_FIRST}" read`, timeout: 90000,
  env: { CUA_STUB_MARKER: m2, CUA_GUARD_READ_TIMEOUT_MS: String(RETRY_BUDGET) },
});
const a2after = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('A35 重试路径下光标仍被还原', a2after.x === 1079 && a2after.y === 583, JSON.stringify(a2after));
ok('A35 stub 确实被调用了多次（超时+重试，非空转）', reads(m2) >= 2, 'reads=' + reads(m2));
ok('A35 重试用例非空转：每次预算 < 首次延迟（否则首次就不会超时）', RETRY_BUDGET < FIRST_DELAY, `budget=${RETRY_BUDGET} firstDelay=${FIRST_DELAY}`);

// A35-3 负对照：读取彻底失败时，fail-open 语义必须保持不变（不改成 deny、不抛错）。
setCua(1079, 583);
const a3pre = run35('PreToolUse', 'mcp_call', SAFE_STEPS, { readCmd: `node "${FAIL_ALWAYS}" read`, timeout: 30000 });
ok('A35 负对照：读取全失败仍 allow（拦截范围未被改动）', decision(a3pre) === 'allow', decision(a3pre) + ' ' + (a3pre.out || '').slice(0, 80));
setCua(2157, 637);
const a3post = run35('PostToolUse', 'mcp_call', SAFE_STEPS, { session: a3pre.sid, readCmd: `node "${FAIL_ALWAYS}" read`, timeout: 30000 });
ok('A35 负对照：无快照时 Post 仍 continue:true（fail-open 语义不变）', !!a3post.json && a3post.json.continue === true, (a3post.out || '').slice(0, 120));
const a3after = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('A35 负对照：读不到就不擅自写光标（仍是 2157,637）', a3after.x === 2157 && a3after.y === 637, JSON.stringify(a3after));

// A35-4 模式隔离：快 stub（无负载）路径的读取次数必须与改前一致 —— 不许多跑重试。
setCua(1079, 583);
const m4 = path.join(SANDBOX, 'm4.txt');
const a4pre = run35('PreToolUse', 'mcp_call', SAFE_STEPS, { readCmd: `node "${COUNTED}" read`, writeCmd: `node "${COUNTED}" set %X% %Y%`, env: { CUA_STUB_MARKER: m4 }, timeout: 30000 });
setCua(2157, 637);
run35('PostToolUse', 'mcp_call', SAFE_STEPS, { session: a4pre.sid, readCmd: `node "${COUNTED}" read`, writeCmd: `node "${COUNTED}" set %X% %Y%`, env: { CUA_STUB_MARKER: m4 }, timeout: 30000 });
const a4after = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
ok('A35 模式隔离：无负载路径仍还原成功', a4after.x === 1079 && a4after.y === 583, JSON.stringify(a4after));
// 基线 4 次是改前字节**实测值**（Pre 1 + Post 1 + readSettled 2；首版我猜 5，按实测改正并点名）。
ok('A35 模式隔离：无负载路径读取次数与改前一致（未多跑重试）', reads(m4) === 4, 'reads=' + reads(m4) + '（改前实测基线 4）');

// A35-5 负对照：预算放宽不得削弱拦截范围（慢读取下前台点击仍必须 deny）。
const a5 = run35('PreToolUse', 'mcp__cua-driver__click', { pid: 1, x: 10, y: 10, delivery_mode: 'foreground' }, { readCmd: `node "${SLOW_ALWAYS}" read`, timeout: 90000 });
ok('A35 负对照：慢读取下前台点击仍 deny（拦截范围未变）', decision(a5) === 'deny', decision(a5));

// A35-6 窄修边界：密闭门控必须双重 gated（只在测试模式生效）。
const gateHits = (guardSource.match(/CUA_GUARD_TEST_STUBS === '1' && process\.env\.CUA_GUARD_TEST_NO_USER32 === '1'/g) || []).length;
ok('A35 密闭门控双重 gated 且读写各一处（生产路径不受影响）', gateHits === 2, 'hits=' + gateHits);
// 首版用 `[^)]*` 匹配写入 stub 调用，但真实字节含 `.replace('%X%', x)` 的内层括号 ⇒ 未改动副本也判红
// （被变异探针的 control 判据抓住，已点名）。改成抽出实际预算数字再比对，红时能报出真值。
const budgetAfter = (re) => { const m = guardSource.match(re); return m ? Number(m[1]) : null; };
ok('A35 读取预算可配且默认已放宽（12000/15000）', /CUA_GUARD_READ_TIMEOUT_MS \|\| 12000/.test(guardSource) && /CUA_GUARD_PS_READ_TIMEOUT_MS \|\| 15000/.test(guardSource), 'read budgets not raised');

// --- A57：写入侧（还原/兜底）在负载下同样超预算 ⇒ 还原失败、账本 UNVERIFIED ---
// 机制与 A35 同源：写入预算写死 4000/4000/4000/6000，负载下 node/powershell 启动+往返就超了。
// 写入是「设绝对坐标」，幂等 ⇒ 超预算可安全重试一次。窄修＝只动写入预算与写入重试，读取预算不动。

// A57-1 慢写入（DELAY=4500ms > 改前 4000ms 预算）下，写入必须在预算内成功（账本 via=stub|verified）。
setCase('b1', 1079, 583);
const b1pre = run57('b1', 'PreToolUse', 'mcp_call', SAFE_STEPS, { timeout: 90000 });
setCase('b1', 2157, 637);
const b1post = run57('b1', 'PostToolUse', 'mcp_call', SAFE_STEPS, { session: b1pre.sid, writeCmd: `node "${SLOW_WRITE}" set %X% %Y%`, timeout: 90000 });
const b1after = readCase('b1');
ok('A57 慢写入下光标仍被还原', b1after.x === 1079 && b1after.y === 583, JSON.stringify(b1after));
ok('A57 慢写入在预算内成功（账本 via=stub|verified，不再 stub-fail）', /via=stub\|verified/.test(lastLedger()), lastLedger());
ok('A57 慢写入下仍报已还原并复验', /已还原并复验/.test(b1post.out || ''), (b1post.out || '').slice(0, 140));

// A57-2 写入重试：首次写入超预算、第二次立即落位 ⇒ 必须靠一次重试救回（隔离「写入重试」这一处）。
setCase('b2', 1079, 583);
const m5 = path.join(SANDBOX, 'm5.txt');
const b2pre = run57('b2', 'PreToolUse', 'mcp_call', SAFE_STEPS, { timeout: 90000 });
setCase('b2', 2157, 637);
run57('b2', 'PostToolUse', 'mcp_call', SAFE_STEPS, {
  session: b2pre.sid, writeCmd: `node "${SLOW_FIRST_WRITE}" set %X% %Y%`, timeout: 90000,
  env: { CUA_STUB_MARKER: m5, CUA_GUARD_WRITE_TIMEOUT_MS: String(RETRY_BUDGET) },
});
const b2after = readCase('b2');
ok('A57 首次写入超时后重试成功（光标还原）', b2after.x === 1079 && b2after.y === 583, JSON.stringify(b2after));
ok('A57 写入 stub 确实被调用了多次（超时+重试，非空转）', reads(m5) >= 2, 'writes=' + reads(m5));
ok('A57 重试用例非空转：每次写入预算 < 首次延迟（否则首次就不会超时）', RETRY_BUDGET < FIRST_DELAY, `budget=${RETRY_BUDGET} firstDelay=${FIRST_DELAY}`);
ok('A57 重试成功后账本 verified', /via=stub\|verified/.test(lastLedger()), lastLedger());

// A57-3 兜底通道（stub2）慢写入：driver 空写不落位时，user32 兜底通道也必须扛得住同样的负载。
setCase('b3', 1079, 583);
const b3pre = run57('b3', 'PreToolUse', 'mcp_call', SAFE_STEPS, { timeout: 90000 });
setCase('b3', 2157, 637);
run57('b3', 'PostToolUse', 'mcp_call', SAFE_STEPS, { session: b3pre.sid, writeCmd: NOOP_WRITE, write2Cmd: `node "${SLOW_WRITE}" set %X% %Y%`, timeout: 90000 });
const b3after = readCase('b3');
ok('A57 兜底通道慢写入仍能落位', b3after.x === 1079 && b3after.y === 583, JSON.stringify(b3after));
ok('A57 兜底通道在预算内成功（账本两跳 via=stub+stub2|verified）', /via=stub\+stub2\|verified/.test(lastLedger()), lastLedger());

// A57-4 负对照：写入永久失败（立即退出 1）时，重试不得把失败说成还原 —— UNVERIFIED + 人工确认必须保留。
setCase('b4', 1079, 583);
const b4pre = run57('b4', 'PreToolUse', 'mcp_call', SAFE_STEPS, { timeout: 90000 });
setCase('b4', 2157, 637);
const b4post = run57('b4', 'PostToolUse', 'mcp_call', SAFE_STEPS, { session: b4pre.sid, writeCmd: `node "${FAIL_ALWAYS}" set %X% %Y%`, write2Cmd: `node "${FAIL_ALWAYS}" set %X% %Y%`, timeout: 90000 });
const b4after = readCase('b4');
ok('A57 负对照：写入永久失败仍 UNVERIFIED', /UNVERIFIED/.test(lastLedger()), lastLedger());
ok('A57 负对照：写入永久失败仍提示人工确认', /未确认|人工确认/.test(b4post.out || ''), (b4post.out || '').slice(0, 140));
ok('A57 负对照：写不进去就不谎报落位（光标仍是 2157,637）', b4after.x === 2157 && b4after.y === 637, JSON.stringify(b4after));

// A57-5 负对照：慢且永不落位（负载形态）时同样必须 UNVERIFIED —— 放宽预算 ≠ 谎报还原。
setCase('b5', 1079, 583);
const b5pre = run57('b5', 'PreToolUse', 'mcp_call', SAFE_STEPS, { timeout: 90000 });
setCase('b5', 2157, 637);
const b5post = run57('b5', 'PostToolUse', 'mcp_call', SAFE_STEPS, {
  session: b5pre.sid, writeCmd: `node "${SLOW_NOOP_WRITE}" set %X% %Y%`, write2Cmd: `node "${SLOW_NOOP_WRITE}" set %X% %Y%`, timeout: 90000,
  env: { CUA_GUARD_WRITE_TIMEOUT_MS: '1500' },
});
ok('A57 负对照：慢且永不落位的写入仍 UNVERIFIED', /UNVERIFIED/.test(lastLedger()), lastLedger());
ok('A57 负对照：慢写入失败仍提示人工确认', /未确认|人工确认/.test(b5post.out || ''), (b5post.out || '').slice(0, 140));

// A57-6 模式隔离：无负载路径的写入次数必须与改前一致 —— 成功就不许多跑重试。
setCase('b6', 1079, 583);
const m6 = path.join(SANDBOX, 'm6.txt');
const b6pre = run57('b6', 'PreToolUse', 'mcp_call', SAFE_STEPS, { writeCmd: `node "${COUNTED_WRITE}" set %X% %Y%`, env: { CUA_STUB_MARKER: m6 }, timeout: 90000 });
setCase('b6', 2157, 637);
run57('b6', 'PostToolUse', 'mcp_call', SAFE_STEPS, { session: b6pre.sid, writeCmd: `node "${COUNTED_WRITE}" set %X% %Y%`, env: { CUA_STUB_MARKER: m6 }, timeout: 90000 });
const b6after = readCase('b6');
ok('A57 模式隔离：无负载路径仍还原成功', b6after.x === 1079 && b6after.y === 583, JSON.stringify(b6after));
ok('A57 模式隔离：无负载路径写入次数与改前一致（未多跑重试）', reads(m6) === 1, 'writes=' + reads(m6) + '（改前实测基线 1）');

// A57-7 窄修边界：读取预算必须原样未动；写入四通道预算全部走可配常量、默认已放宽、各一次重试。
const rDriver = budgetAfter(/CUA_GUARD_READ_TIMEOUT_MS \|\| (\d+)/);
const rUser32 = budgetAfter(/CUA_GUARD_PS_READ_TIMEOUT_MS \|\| (\d+)/);
ok('A57 窄修只动写入：读取预算仍是 12000/15000', rDriver === 12000 && rUser32 === 15000, `read=${rDriver} psRead=${rUser32}`);
const wRegion = guardSource.slice(guardSource.indexOf('// A57'), guardSource.indexOf('// driver 的移动是异步落地'));
ok('A57 写入预算可配且默认已放宽（12000/15000）', /CUA_GUARD_WRITE_TIMEOUT_MS \|\| 12000/.test(wRegion) && /CUA_GUARD_PS_WRITE_TIMEOUT_MS \|\| 15000/.test(wRegion), 'write budgets not raised');
ok('A57 写入四通道无写死预算（全部走常量）', wRegion.length > 0 && !/timeout:\s*\d+/.test(wRegion) && !/runStub\([\s\S]*?,\s*\d+\)/.test(wRegion), 'literal write timeout left');
const retryHits = (wRegion.match(/sleepSync\(WRITE_RETRY_GAP_MS\)/g) || []).length;
ok('A57 四条写入通道各一次重试（stub/driver/stub2/user32）', retryHits === 4, 'retryHits=' + retryHits);
// harness 预算下界由守卫预算推导：读重试 2× + 写重试 2× + user32 兜底 1×（readSettled 的完整最坏链路更大，
// 跑到那条链路的用例显式传 timeout；这里守的是负载 A/B 里实测到的 harness-no-response 形态）。
const worstChain = 2 * rDriver + 2 * budgetAfter(/CUA_GUARD_WRITE_TIMEOUT_MS \|\| (\d+)/) + budgetAfter(/CUA_GUARD_PS_WRITE_TIMEOUT_MS \|\| (\d+)/);
ok('A57 harness 默认预算覆盖「读重试+写重试+兜底」链路', Number.isFinite(worstChain) && DEFAULT_TIMEOUT >= worstChain, `default=${DEFAULT_TIMEOUT} worst=${worstChain}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
