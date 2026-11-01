#!/usr/bin/env node
// attempt-lock-guard 自测：**违规必红 + 对照必绿**
// 红：同一目标连败到阈值 → Post 当场叫停、Pre 硬拦下一次同类调用
// 绿：不同目标不串账；成功一次清零；拿不到明确信号的返回不计数；非构建/测试/部署命令不建账
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SB = path.join(os.tmpdir(), `attempt-lock-${Date.now()}`);
const STATE = path.join(SB, 'state');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 140) : ''}`); if (!ok) fail++; };
const reset = () => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(STATE, { recursive: true }); };

// 沙箱自测不许写进真机状态目录（写进去会污染真实门禁）
const REAL_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.qoder', 'tmp', 'attempt-lock');
const snapReal = () => {
  const g = (f) => { try { return fs.readFileSync(path.join(REAL_DIR, f), 'utf8'); } catch (e) { return '<absent>'; } };
  return g('state.json') + '@@' + g('decisions.log');
};
const REAL_BEFORE = snapReal();

const POST_SCRIPT = path.join(__dirname, 'attempt-lock-guard.js');
const PRE_SCRIPT = path.join(__dirname, 'risky-match-guard.js');
const RSTATE = path.join(SB, 'risky-state');
const SESS = 'altest';
try {
  fs.mkdirSync(RSTATE, { recursive: true });
  fs.writeFileSync(path.join(RSTATE, 'memory-first.json'), JSON.stringify({ [SESS]: { memSeen: true, warned: {} } }));
} catch (e) {}

const spawn = (script, payload) => {
  const r = spawnSync(process.execPath, [script], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env,
      ATTEMPT_LOCK_STATE_DIR: STATE,
      ATTEMPT_LOCK_CONFIG: path.join(SB, 'no-such-config.json'),
      RISKY_MATCH_STATE_DIR: RSTATE,
    },
  });
  let d = {};
  try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
};
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const pre = (command, extra) => spawn(PRE_SCRIPT, Object.assign({ hook_event_name: 'PreToolUse', session_id: SESS }, bash(command), extra));
const post = (command, resp, extra) => spawn(POST_SCRIPT, Object.assign({ hook_event_name: 'PostToolUse', session_id: SESS, tool_response: resp }, bash(command), extra));
const FAILOUT = 'npm ERR! code ELIFECYCLE\nBUILD FAILURE';
const OKOUT = 'BUILD SUCCESS\nTotal time: 12s';

// —— 必须拦（红）——
reset();
check('① 第 1、2 次构建失败：只记账不拦',
  !post('npm run build', FAILOUT).blocked && !post('npm run build', FAILOUT).blocked);
const third = post('npm run build', FAILOUT);
check('② 第 3 次失败当场叫停', third.blocked && /连败|连续失败/.test(third.reason), third.reason);
check('③ 已到阈值后，同类调用的 Pre 半边必须硬拦', pre('npm run build').blocked);
check('④ 不同目标不串账（同 family 不同签名）', !pre('npm run test').blocked);

// —— 必须放行（绿）——
reset();
post('npm run build', FAILOUT); post('npm run build', FAILOUT);
post('npm run build', OKOUT);              // 成功一次即清零（连续语义）
post('npm run build', FAILOUT);
check('⑤ 成功一次清零：再来两次仍是放行', !pre('npm run build').blocked);
reset();
post('npm run build', 'some unrelated output');
post('npm run build', 'some unrelated output');
post('npm run build', 'still unclear');
check('⑥ 拿不到明确信号的返回不计数', !pre('npm run build').blocked);
reset();
post('ls -la', FAILOUT);
post('ls -la', FAILOUT);
post('ls -la', FAILOUT);
check('⑦ 非构建/测试/部署命令不建账', !pre('ls -la').blocked);

// —— 人工解除 ——
reset();
post('npm run build', FAILOUT); post('npm run build', FAILOUT); post('npm run build', FAILOUT);
const cleared = spawnSync(process.execPath, [POST_SCRIPT, '--clear', 'ALL'], {
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, ATTEMPT_LOCK_STATE_DIR: STATE, ATTEMPT_LOCK_CONFIG: path.join(SB, 'no-such-config.json') },
});
check('⑧ --clear ALL 之后恢复放行', /cleared/.test(cleared.stdout) && !pre('npm run build').blocked);

// —— 复合命令的键 ——
const { keyOf, familyOf } = require('./attempt-lock-core.js');
check('⑨ 复合命令的键取真正命中的那一段',
  keyOf('build', 'cd /d/tmp 2>/dev/null; npm run build') === keyOf('build', 'npm run build', '/d/tmp'),
  keyOf('build', 'cd /d/tmp 2>/dev/null; npm run build'));

// 同一个全局 hook 会接收多个仓库；失败预算只属于实际命令目标。
reset();
const projectA = path.join(SB, 'project-a'), projectB = path.join(SB, 'project-b');
for (let i = 0; i < 3; i++) post('npm run build', FAILOUT, { cwd: projectA });
check('项目 A 连败仍拦本项目', pre('npm run build', { cwd: projectA }).blocked);
check('项目 A 连败不拦项目 B', !pre('npm run build', { cwd: projectB }).blocked);
check('tool_input.workdir 与 payload.cwd 指向同项目时共用预算',
  pre('npm run build', { tool_input: { command: 'npm run build', workdir: projectA } }).blocked);
check('tool_input.cwd 优先于 hook cwd，独立项目不串账',
  !pre('npm run build', { cwd: projectA, tool_input: { command: 'npm run build', cwd: projectB } }).blocked);

reset();
for (let i = 0; i < 3; i++) post(`cd "${projectA}"; npm run build`, FAILOUT);
check('shell cd 与工具 cwd 指向同项目时共用预算', pre('npm run build', { cwd: projectA }).blocked);
check('shell cd 到另一个项目不串账', !pre(`cd "${projectB}"; npm run build`).blocked);
check('npm --prefix 与工具 cwd 指向同项目时共用预算', pre(`npm --prefix "${projectA}" run build`).blocked);
check('npm --prefix 到另一个项目不串账', !pre(`npm --prefix "${projectB}" run build`).blocked);
check('包管理器 -C 指定同项目时共用预算', pre(`npm -C "${projectA}" run build`).blocked);

reset();
for (let i = 0; i < 3; i++) post('npm run build --workspace package-a', FAILOUT, { cwd: projectA });
check('workspace 不同不串账', !pre('npm run build --workspace package-b', { cwd: projectA }).blocked);
check('workspace 相同、无关参数变化仍累计', pre('npm --workspace=package-a run build --verbose', { cwd: projectA }).blocked);
check('workspace 相同、短参数写法仍累计', pre('npm -w package-a run build', { cwd: projectA }).blocked);
check('workspace 名称保留大小写，不与其他包串账', !pre('npm -w Package-A run build', { cwd: projectA }).blocked);
check('脚本参数中的 workspace 不改变包管理器目标',
  keyOf('build', 'npm run build -- --workspace package-a', projectA) === keyOf('build', 'npm run build', projectA));
check('带空格目录的 cd 与工具 cwd 指向相同目标',
  keyOf('build', `cd "${path.join(SB, 'project with spaces')}"; npm run build`) === keyOf('build', 'npm run build', path.join(SB, 'project with spaces')));
check('Windows cwd 斜杠与大小写别名共用预算',
  keyOf('build', 'npm run build', 'D:\\Project-A') === keyOf('build', 'npm run build', 'd:/project-a/.'));
check('POSIX 风格 cwd 仍区分不同项目',
  keyOf('build', 'npm run build', '/repo-a') !== keyOf('build', 'npm run build', '/repo-b'));
check('重复 prefix 采用最后一个值，并相对命令 cwd 解析',
  keyOf('build', 'npm --prefix a --prefix b run build', projectA) === keyOf('build', 'npm --prefix b run build', projectA));
check('workspaces=false 与根项目共用预算',
  keyOf('build', 'npm run build --workspaces=false', projectA) === keyOf('build', 'npm run build', projectA));
check('workspaces=false 与 workspaces=true 不串账',
  keyOf('build', 'npm run build --workspaces=false', projectA) !== keyOf('build', 'npm run build --workspaces=true', projectA));

// HEAD 支持的真实包装入口不能在收窄 echo/rg 误识别时丢掉。
for (const [command, family, direct] of [
  ['npx vitest run', 'test', 'vitest run'],
  ['npx --yes --package vitest@4 vitest run', 'test', 'vitest run'],
  ['npx --package=typescript -- tsc --noEmit', 'build', 'tsc --noEmit'],
  ['npm exec -- vitest run', 'test', 'vitest run'],
  ['npm exec --package=typescript -- tsc --noEmit', 'build', 'tsc --noEmit'],
  ['python -m pytest tests/', 'test', 'pytest tests/'],
  ['python3 -m pytest tests/', 'test', 'pytest tests/'],
  ['uv run pytest tests/', 'test', 'pytest tests/'],
  ['sudo systemctl restart app', 'deploy', 'systemctl restart app'],
]) {
  check(`包装命令保留实际执行分类：${command}`, familyOf(command) === family);
  check(`包装命令与直接入口共用预算：${command}`, keyOf(family, command, projectA) === keyOf(family, direct, projectA));
}
check('npx help 不消费构建或测试预算', familyOf('npx --help vitest') === null);
check('python -c 中的 pytest 文本不消费预算', familyOf('python -c "print(\'pytest\')"') === null);
check('command -v 查询不消费预算', familyOf('command -v pytest') === null);

reset();
for (let i = 0; i < 3; i++) post('echo "npm run build"', FAILOUT);
check('引用构建命令的 echo 不建账', !pre('echo "npm run build"').blocked && !pre('npm run build').blocked);
for (let i = 0; i < 3; i++) post('rg "npm run build" README.md', { exitCode: 1 });
check('搜索构建命令的 rg 不建账', !pre('rg "npm run build" README.md').blocked);

// —— 沙箱隔离 ——
check('⑩ 沙箱自测没有写进真机状态目录', snapReal() === REAL_BEFORE);

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
