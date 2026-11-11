'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { classifyGoalCandidate } = require('../scripts/goal-candidate-core.js');
const { classifyVerificationTrigger } = require('../scripts/verification-trigger-core.js');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.hooks-review-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = path.join(home, '.qoder');
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: client,
    STOP_GATE_STATE_DIR: path.join(home, 'stop'), EDIT_GUARD_STATE_DIR: path.join(home, 'edit') };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const run = (script, args = [], input) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    env, cwd: home, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 20000,
  });
  return { home, client, write, run };
}

test('quoted goal instructions and read-only stage reviews never grant goal execution', () => {
  for (const prompt of ['修复文档中“开启目标模式”的措辞', '修复文档中『开启目标模式』的措辞', '修改代码示例 `使用Goal模式` 的拼写', '解释下面的代码：\n```text\n开启目标模式\n```']) {
    assert.equal(classifyGoalCandidate(prompt).explicitGoal, false, prompt);
  }
  const review = classifyGoalCandidate('只读审查实现、测试、部署和提交方案，不要修改文件');
  assert.equal(review.readOnly, true);
  assert.equal(review.candidate, false);
  assert.equal(classifyGoalCandidate('开启“目标模式”，修复登录').explicitGoal, true);
});

test('verification explanations and explicit opt-outs do not open a selection gate', () => {
  for (const prompt of ['自适应验证是什么', '解释一下分档验证', '怎么选择验证强度', '不要选档，直接修复登录接口', '本次无需自适应验证，修复脚本即可']) {
    assert.equal(classifyVerificationTrigger(prompt).trigger, false, prompt);
  }
  assert.equal(classifyVerificationTrigger('按难度选验证').reason, 'EXPLICIT');
});

test('feedback UUIDs and repeated gate hits cannot substitute for independent tasks', t => {
  const f = fixture(t);
  f.write(path.join(f.client, 'memory/feedback-boundary.md'), '---\nname: feedback-quasar-boundary\ndescription: 专用边界判据\ntype: feedback\n---\n会话11111111-1111-1111-1111-111111111111 和22222222-2222-2222-2222-222222222222；没有独立任务或来源证据。\n');
  const at = new Date().toISOString();
  f.write(path.join(f.client, 'tmp/stop-gate/violations.log'), [1, 2, 3].map((n) => `${at}|R3|sess=session-${n}|hash=${n}|len=9`).join('\n'));
  const r = f.run('evolution-candidates.cjs', ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.candidates.some(c => c.kind === 'promote-global'), false);
  assert.equal(report.candidates.find(c => c.source === 'violation').kind, 'observe');
});

test('record scans ignore invalid envelopes and timestamps instead of promoting or crashing', t => {
  const f = fixture(t);
  const records = path.join(f.client, 'evolution/records');
  f.write(path.join(records, 'null.json'), 'null');
  f.write(path.join(records, 'array.json'), '[]');
  for (const kind of ['invalid-date', 'future-date', 'non-string-identity']) {
    for (let n = 1; n <= 3; n++) {
      f.write(path.join(records, kind + n + '.json'), {
        topic: kind, scope: 'global', type: 'observation', verified: false,
        created_at: kind === 'invalid-date' ? 'not-a-date' : kind === 'future-date' ? '2999-01-01T00:00:00Z' : new Date().toISOString(),
        evidence: { task_id: kind === 'non-string-identity' ? n : 'task-' + n, session_id: 'session-' + n, source: 'user' },
      });
    }
  }
  const r = f.run('evolution-candidates.cjs', ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.candidates.some(c => c.kind === 'promote-global'), false);
  assert.equal(report.warnings.some(w => /无效|invalid/i.test(w)), true);
});

test('evolution CLI rejects flag-shaped output values and unbounded day windows before writing', t => {
  const f = fixture(t);
  for (const args of [['--write', '--out', '--json'], ['--days', '9'.repeat(400), '--json']]) {
    const r = f.run('evolution-candidates.cjs', args);
    assert.equal(r.status, 2, JSON.stringify(args) + '\n' + r.stdout + r.stderr);
  }
  assert.equal(fs.existsSync(path.join(f.home, '--json')), false);
});

// 'temporary' 必须用**真实临时根**：C12 之后 isTempish 按前缀判临时根，
// 合法项目目录恰好叫 tmp 不再被豁免（那正是 C12 要修的保护静默失效）。
// 因此新增 'tmp-named-project' 模式，断言它**仍然**得到备份提醒。
for (const mode of ['small', 'git-covered', 'temporary', 'tmp-named-project']) {
  test('carrier checks survive backup exemptions: ' + mode, t => {
    const f = fixture(t);
    const base = mode === 'temporary' ? fs.mkdtempSync(path.join(os.tmpdir(), 'qo-hooks-temp-')) : path.join(f.home, mode === 'tmp-named-project' ? 'tmp/project' : 'project');
    const target = path.join(base, 'skills/demo/SKILL.md');
    f.write(target, mode === 'small' ? 'existing rule' : 'existing rule\n'.repeat(300));
    if (mode === 'git-covered') fs.mkdirSync(path.join(f.home, 'project/.git'), { recursive: true });
    const r = f.run('edit-guard.js', [], { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'carrier-' + mode, tool_input: { file_path: target } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /载体预检提醒/);
    if (mode === 'tmp-named-project') assert.match(r.stdout, /备份提醒/);
    else assert.doesNotMatch(r.stdout, /备份提醒/);
    if (mode === 'temporary') fs.rmSync(base, { recursive: true, force: true });
  });
}

function replayStop(f, command, result) {
  const transcript = path.join(f.home, 'turn.jsonl');
  f.write(transcript, [
    { message: { role: 'user', content: '检查工具结果' } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'run', name: 'Bash', input: { command } }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'run', content: result }] } },
    { message: { role: 'assistant', content: '结论：已核对。' } },
  ].map(value => JSON.stringify(value)).join('\n'));
  const r = f.run('stop-gate.js', [], { hook_event_name: 'Stop', session_id: 'stop-' + Math.random(), cwd: f.home, transcript_path: transcript });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('failed release results are not evidence that deployment is ready to ask', t => {
  const f = fixture(t);
  assert.doesNotMatch(replayStop(f, 'gh release create v0.0.21', { exitCode: 1, stdout: 'request failed' }), /R11-release-deploy-not-asked/);
});

test('quoted shell text does not masquerade as an executed release command', t => {
  const f = fixture(t);
  assert.doesNotMatch(replayStop(f, 'echo "example; gh release create v0.0.21"', 'example; gh release create v0.0.21'), /R11-release-deploy-not-asked/);
  assert.match(replayStop(f, 'gh release create v0.0.21', 'published'), /R11-release-deploy-not-asked/);
});

test('catalog entry detection supports quoted Node paths without treating examples or syntax checks as execution', t => {
  const f = fixture(t);
  const output = 'NEXT_ACTION: ASK_INSTALL_OR_UPDATE';
  assert.match(replayStop(f, '"C:/Program Files/nodejs/node.exe" "D:/package/scripts/pkg-catalog.cjs" search ui', output), /R10-next-action-not-asked/);
  assert.doesNotMatch(replayStop(f, 'echo "node pkg-catalog.cjs search ui"', output), /R10-next-action-not-asked/);
  assert.doesNotMatch(replayStop(f, 'node --no-warnings --check pkg-catalog.cjs; echo marker', output), /R10-next-action-not-asked/);
  assert.match(replayStop(f, '"C:/Program Files/nodejs/node.exe" "D:/package/.github/publish-release.js" v0.0.21', 'published'), /R11-release-deploy-not-asked/);
});
