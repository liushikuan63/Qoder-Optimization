#!/usr/bin/env node
// edit-guard.js 的自测：五条"该放行"与两条"该提醒"必须分得干净——守卫最容易犯的错是噪声太多，
// 所以"不该提醒"的用例和解比"该提醒"的用例更重要。
//   node ~/.qoder/scripts/edit-guard.test.js   → 全绿退 0，任一失败退 1
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'edit-guard.js');
const NODE = process.execPath;
// 沙箱**不能建在临时目录下**：守卫会把 /tmp 与 AppData/Local/Temp 下的文件当临时文件跳过，
// 建在那里等于让所有用例都走「临时跳过」分支（实测踩到，5 条用例假红）。
const SB = path.join(require('os').homedir(), '.eg-sandbox');
let fail = 0;
const check = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' :: ' + d : ''}`); if (!ok) fail++; };

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });

function mkFile(rel, bytes) {
  const p = path.join(SB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x'.repeat(bytes));
  return p;
}

function run(payload) {
  const r = spawnSync(NODE, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, EDIT_GUARD_STATE_DIR: path.join(SB, 'state') },
  });
  let reason = null;
  try { reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch (e) {}
  return { code: r.status, out: r.stdout || '', reason };
}

const W = (file, sid = 'sess1') => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file }, session_id: sid });

// ── 该提醒 ──
const big = mkFile('norepo/config.json', 8192);
let r = run(W(big));
check('大文件 + 非 git + 已存在 → 提醒备份', !!(r.reason && r.reason.includes('备份提醒')) && r.code === 0, (r.reason || '').slice(0, 32));
check('  提醒里给出可直接粘的命令（走带裁剪的 backup-file.js）', !!(r.reason && /backup-file\.js/.test(r.reason)));
check('  且明确说明是提示不是拦截', !!(r.reason && r.reason.includes('提示不拦截')));

r = run(W(big));
check('同一会话同一文件 → 只提醒一次', !r.reason, JSON.stringify(r.reason));
r = run(W(big, 'other-session'));
check('换个会话 → 重新提醒一次', !!(r.reason && r.reason.includes('备份提醒')));

// ── 不该提醒（噪声控制，这半边更重要）──
const gitFile = mkFile('repo-under-git/data.json', 8192);
fs.mkdirSync(path.join(SB, 'repo-under-git', '.git'), { recursive: true });
check('git 仓库内（有版本库兜底）→ 静默', !run(W(gitFile)).reason);

const small = mkFile('norepo/tiny.json', 100);
check('小文件（<2KB）→ 静默', !run(W(small)).reason);

// 真临时目录（必须真的落在 /tmp 或 AppData/Local/Temp 下，才走得到"临时跳过"分支）
const tmpDir = path.join(require('os').tmpdir(), 'eg-tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const tmpFile = path.join(tmpDir, 'scratch.md');
fs.writeFileSync(tmpFile, 'x'.repeat(8192));
check('临时路径 → 静默', !run(W(tmpFile)).reason);

const bakFile = mkFile('norepo/keep.md.bak.20260101', 8192);
check('备份文件本身 → 静默', !run(W(bakFile)).reason);

const missing = path.join(SB, 'norepo', 'brand-new.md');
check('新建文件（不存在）→ 静默', !run(W(missing)).reason);

const carrierNew = path.join(SB, 'skills', 'new-skill', 'SKILL.md');
r = run(W(carrierNew, 'sess-carrier'));
check('新建技能载体 → 预检提醒', !!(r.reason && r.reason.includes('载体预检') && /carrier-preflight/.test(r.reason)));
const memoryNew = path.join(SB, '.qoder', 'memory', 'new-pref.md');
r = run(W(memoryNew, 'sess-memory'));
check('新建记忆载体 → 预检提醒（type=memory）', !!(r.reason && r.reason.includes('载体预检') && /--type memory/.test(r.reason)));
const mcpNew = path.join(SB, 'mcp', 'new-server.json');
r = run(W(mcpNew, 'sess-mcp'));
check('新建 MCP 载体 → 预检提醒（type=mcp）', !!(r.reason && r.reason.includes('载体预检') && /--type mcp/.test(r.reason)));
const plainScript = path.join(SB, 'scripts', 'utility.js');
check('普通新脚本（非 hook 名）→ 不误报', !run(W(plainScript, 'sess-plain')).reason);
const bigRule = mkFile('.qoder/rules/big-rule.md', 8192);
r = run(W(bigRule, 'sess-rule'));
check('覆盖既有载体 → 备份提醒同时带预检提醒', !!(r.reason && r.reason.includes('备份提醒') && r.reason.includes('载体预检')));

check('Edit 工具不归它管 → 静默', !run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: big }, session_id: 's3' }).reason);

// ── 异常与开关 ──
{
  const bad = spawnSync(NODE, [SCRIPT], { input: 'not json', encoding: 'utf8', timeout: 20000, env: { ...process.env, EDIT_GUARD_STATE_DIR: path.join(SB, 'state') } });
  check('非法 stdin → fail-open 静默', bad.status === 0 && (bad.stdout || '').trim() === '');
  const cfg = path.join(SB, '.qoder');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'edit-guard.json'), JSON.stringify({ disabled: true }));
  const off = spawnSync(NODE, [SCRIPT], {
    input: JSON.stringify(W(mkFile('norepo/off.json', 8192), 's9')),
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: SB, USERPROFILE: SB, EDIT_GUARD_STATE_DIR: path.join(SB, 'state') },
  });
  check('disabled=true → 静默', (off.stdout || '').trim() === '' && off.status === 0);
}

// ── 台账可核对（能否事后确认"它到底跑没跑"）──
{
  const led = path.join(SB, 'state', 'decisions.log');
  const txt = fs.existsSync(led) ? fs.readFileSync(led, 'utf8') : '';
  check('落了台账（advise + 各类 skip）', /advise/.test(txt) && /git-covered/.test(txt) && /repeat-skip/.test(txt) && /carrier-new/.test(txt), txt.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 90));
}

fs.rmSync(SB, { recursive: true, force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
