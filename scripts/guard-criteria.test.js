#!/usr/bin/env node
// T-20 / T-21 permanent regression: guard criteria granularity.
// Covers F18a (rm long options), F18b (SQL comment injection), F19 (git -C),
// C11 (unbounded limit / head -c), C12 (isTempish semantics), F20a (npm options),
// F20b (three different methods advisory). Each class has a negative control.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-guardcriteria-'));
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

function hook(script, payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ...extraEnv }
  });
  const out = r.stdout || '';
  let d = {}; try { d = JSON.parse(out); } catch (e) {}
  const d2 = d.hookSpecificOutput || {};
  return { code: r.status, blocked: d.decision === 'block' || d2.permissionDecision === 'deny', decision: d2.permissionDecision || d.decision || 'none', reason: d.reason || d2.permissionDecisionReason || '', out };
}
const bash = (command, sess) => hook('risky-match-guard.js', { session_id: sess, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, {
  RISKY_MATCH_STATE_DIR: path.join(SB, 'risky'), AUTH_LOCK_STATE_DIR: path.join(SB, 'auth'), ATTEMPT_LOCK_STATE_DIR: path.join(SB, 'attempt')
});
const sql = (q, sess) => hook('risky-match-guard.js', { session_id: sess, hook_event_name: 'PreToolUse', tool_name: 'mcp__dbhub__execute_sql_demo', tool_input: { sql: q } }, {
  RISKY_MATCH_STATE_DIR: path.join(SB, 'risky'), AUTH_LOCK_STATE_DIR: path.join(SB, 'auth'), ATTEMPT_LOCK_STATE_DIR: path.join(SB, 'attempt')
});
// pre-mark memory-first so it cannot mask verdicts (the repo's own test documents this trap)
fs.mkdirSync(path.join(SB, 'risky'), { recursive: true });
const mf = {}; for (let i = 0; i < 40; i++) mf['s' + i] = { memSeen: true, warned: {} };
fs.writeFileSync(path.join(SB, 'risky', 'memory-first.json'), JSON.stringify(mf));
let n = 0; const S = () => 's' + (n++ % 40);

// ---- F18a: rm long options must be equivalent to -rf ----
check('F18a rm --recursive --force dir/* 被拦', bash('rm --recursive --force dir/*', S()).blocked);
check('F18a 负对照 rm -rf ./build 仍放行', !bash('rm -rf ./build', S()).blocked);
check('F18a 负对照 rm file.txt 仍放行', !bash('rm file.txt', S()).blocked);
check('F18a 短选项拆分 rm -r -f dir/* 仍被拦', bash('rm -r -f dir/*', S()).blocked);

// ---- F18b: SQL comment injection ----
check('F18b DELETE /*c*/ FROM t 被拦', sql('DELETE /*c*/ FROM t', S()).blocked);
check('F18b DELETE -- c\n FROM t 被拦', sql('DELETE -- c\n FROM t', S()).blocked);
check('F18b 负对照 带 WHERE 仍放行', !sql('DELETE FROM t WHERE id=5', S()).blocked);
check('F18b 红线 TRUNCATE/DROP 仍被拦', sql('TRUNCATE TABLE t', S()).blocked && sql('DROP TABLE t', S()).blocked);

// ---- F19: git -C must not evade commit-scope ----
const REPO = path.join(SB, 'repo');
fs.mkdirSync(REPO, { recursive: true });
const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'p@example.invalid'); git('config', 'user.name', 'p');
fs.writeFileSync(path.join(REPO, 'mine.js'), 'v1\n');
git('add', 'mine.js'); git('commit', '-qm', 'base');
fs.writeFileSync(path.join(REPO, 'mine.js'), 'v2-in-flight\n');
const csEnv = { COMMIT_SCOPE_GUARD_STATE_DIR: path.join(SB, 'cs') };
const cs = (command) => hook('commit-scope-guard.js', { session_id: 'cs', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: REPO, tool_input: { command, dir_path: REPO } }, csEnv);
check('F19 git -C . commit -- 脏路径 被拦', cs('git -C . commit -m x -- mine.js').blocked);
check('F19 负对照 无 pathspec 仍放行', !cs('git commit -m x').blocked);
check('F19 负对照 git status 仍放行', !cs('git status').blocked);
check('F19 普通 git commit -- 脏路径 仍被拦', cs('git commit -m x -- mine.js').blocked);

// ---- C11: unbounded limit / head -c ----
const BIG = path.join(SB, 'big.md');
fs.writeFileSync(BIG, 'line of text for payload sizing\n'.repeat(7000));
const hogEnv = { HUGE_OUTPUT_GUARD_STATE_DIR: path.join(SB, 'hog') };
const read = (ti) => hook('huge-output-guard.js', { session_id: 'hog', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: ti }, hogEnv);
const hb = (command) => hook('huge-output-guard.js', { session_id: 'hog', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, hogEnv);
check('C11 Read limit=999999 被拦', read({ file_path: BIG, limit: 999999 }).blocked);
check('C11 负对照 Read limit=200 仍放行', !read({ file_path: BIG, offset: 1, limit: 200 }).blocked);
check('C11 正对照 无 limit 整读被拦', read({ file_path: BIG }).blocked);
check('C11 head -c 999999 被拦', hb(`head -c 999999 "${BIG}"`).blocked);
check('C11 负对照 head -n 20 仍放行', !hb(`head -n 20 "${BIG}"`).blocked);
check('C11 负对照 重定向到文件仍放行', !hb(`cat "${BIG}" > "${SB}/out.txt"`).blocked);
check('C11 负对照 管道到 wc 仍放行', !hb(`cat "${BIG}" | wc -l`).blocked);

// ---- C12: isTempish semantics ----
const egEnv = { EDIT_GUARD_STATE_DIR: path.join(SB, 'eg') };
const mk = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, name); fs.writeFileSync(p, 'x'.repeat(5000)); return p; };
// edit-guard 的夹具必须放在**非临时根**下：os.tmpdir() 里的文件会被 isTempish 正确跳过，
// 那样正对照根本不会触发（本项目已踩过两次）。
const EG_BASE = path.join('D:/qoder-release-sandbox', 'qo-guard-criteria-' + process.pid);
fs.rmSync(EG_BASE, { recursive: true, force: true });
const plainDir = path.join(EG_BASE, 'plain');
const tmpNamedDir = path.join(EG_BASE, 'proj', 'tmp');
const fPlain = mk(plainDir, 'config.json');
const fTmpNamed = mk(tmpNamedDir, 'config.json');
const fBakName = mk(plainDir, 'notes.bak.md');
const fRealBak = mk(plainDir, 'config.json.bak');
const eg = (file_path) => hook('edit-guard.js', { session_id: 'eg' + (n++), hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path } }, egEnv);
const warned = (r) => /备份|兜底|不可恢复/.test(r.reason);
check('C12 正对照 无 git 大文件覆盖会提醒', warned(eg(fPlain)));
check('C12 目录名恰为 tmp 的真实文件仍提醒', warned(eg(fTmpNamed)));
check('C12 文件名含 .bak 的真实文档仍提醒', warned(eg(fBakName)));
check('C12 负对照 真实 .bak 备份文件不提醒', !warned(eg(fRealBak)));

// ---- F20a / F20b: attempt-lock ----
process.env.ATTEMPT_LOCK_STATE_DIR = path.join(SB, 'al-core');
const A = require('./attempt-lock-core.js');
const CWD = 'D:/fixture/proj';
const failResp = { exitCode: 1, stdout: 'Tests failed' };
const post = (command) => A.postRecord({ session_id: 'al', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: CWD, tool_input: { command, dir_path: CWD }, tool_response: failResp });
A.clear('ALL');
check('F20a npm --loglevel error test 归类为 test', A.familyOf('npm --loglevel error test') === 'test');
check('F20a npm --no-fund --no-audit test 归类为 test', A.familyOf('npm --no-fund --no-audit test') === 'test');
check('F20a 负对照 npm --help 不建账', A.familyOf('npm --help') === null);
const k1 = post('npm --loglevel error test');
const k2 = post('npm test');
check('F20a 选项变体与裸命令同键', k1.key === k2.key, `${k1.key} vs ${k2.key}`);
A.clear('ALL');
const d1 = post('npm test'), d2 = post('npm run build'), d3 = post('node --test');
check('F20b 三种不同手段触发 advisory', !!d3.advisory, String(d3.advisory).slice(0, 80));
check('F20b 负对照 advisory 不硬拦', !A.preCheck({ session_id: 'al', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CWD, tool_input: { command: 'npm test', dir_path: CWD } }));
A.clear('ALL');
const same = [post('npm test'), post('npm test'), post('npm test')];
check('F20b 负对照 同命令连败仍硬拦', same[2].count === 3 && !!same[2].reason);
A.clear('ALL');
post('npm test'); post('npm test');
const okRec = A.postRecord({ session_id: 'al', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: CWD, tool_input: { command: 'npm test', dir_path: CWD }, tool_response: { exitCode: 0, stdout: 'PASS' } });
check('F20b 负对照 成功清零', okRec.count === 0 && okRec.kind === 'ok');

fs.rmSync(SB, { recursive: true, force: true });
fs.rmSync(EG_BASE, { recursive: true, force: true });
console.log(fail ? `\nguard-criteria FAIL ${fail}` : '\nguard-criteria ALL PASS');
process.exitCode = fail ? 1 : 0;