'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { digestPlan, validatePlan } = require('../scripts/parallel-plan.cjs');
const tool = path.resolve(__dirname, '../scripts/parallel-write.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-write-'));
  const repo = path.join(base, 'repo'), out = path.join(base, 'run');
  fs.mkdirSync(repo);
  const env = { ...process.env, HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  const git = (cwd, args) => {
    const r = spawnSync('git', ['-c', 'user.name=Parallel Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout.trim();
  };
  const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  git(repo, ['init', '-q']);
  put(path.join(repo, 'src/a.txt'), 'a base\n'); put(path.join(repo, 'src/b.txt'), 'b base\n');
  git(repo, ['add', '--', 'src/a.txt', 'src/b.txt']); git(repo, ['commit', '-qm', 'base']);
  const plan = { schema: 1, taskId: 'WRITE-REVIEW', goal: 'Two isolated writers', mode: 'worktree', constraints: ['owned paths only'], units: ['A', 'B'].map(id => ({ id, kind: 'write', title: id, dependsOn: [], ownedPaths: ['src/' + id.toLowerCase() + '.txt'], readPaths: ['src/' + id.toLowerCase() + '.txt'], acceptance: ['review diff'], evidence: ['git diff'] })), resources: { sharedFiles: [], sharedServices: [], databaseWrites: false, production: false, destructive: false, credentials: false, externalSideEffects: false }, execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' }, budget: { maxWorkers: 2, maxRounds: 1 } };
  const planFile = path.join(base, 'plan.json'); put(planFile, JSON.stringify(plan));
  const run = (args, extra = {}) => spawnSync(process.execPath, [tool, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  const prepare = () => {
    const r = run(['prepare', '--plan', planFile, '--repo', repo, '--out', out, '--approved-plan', digestPlan(validatePlan(plan)), '--write-opt-in']);
    assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
  };
  const commit = (unit, file, body) => { put(path.join(unit.path, file), body); git(unit.path, ['add', '--', file]); git(unit.path, ['commit', '-qm', 'worker change']); };
  t.after(() => {
    // These fixture worktrees are owned by this test; removing their containing
    // disposable repository never touches an external checkout.
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, repo, out, env, plan, planFile, git, put, run, prepare, commit };
}

test('parallel writers get actual distinct worktrees and a mergeable committed result', t => {
  const f = fixture(t), manifest = f.prepare(), before = f.git(f.repo, ['rev-parse', 'HEAD']);
  assert.equal(manifest.units.length, 2);
  assert.notEqual(fs.realpathSync(manifest.units[0].path), fs.realpathSync(manifest.units[1].path));
  for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' changed\n');
  const r = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout); assert.equal(result.status, 'READY_FOR_REVIEW');
  assert.equal(result.units.length, 2); assert.match(result.integrationTree, /^[a-f0-9]{40,64}$/);
  assert.equal(f.git(f.repo, ['rev-parse', 'HEAD']), before);
  assert.equal(f.git(f.repo, ['status', '--porcelain']), '');
});

test('prepare requires exact plan approval and separate write opt-in before creating anything', t => {
  const f = fixture(t);
  for (const flags of [[], ['--write-opt-in'], ['--approved-plan', '0'.repeat(64), '--write-opt-in']]) {
    const r = f.run(['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', f.out, ...flags]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.equal(fs.existsSync(f.out), false);
  }
});

for (const mode of ['dirty-source', 'output-in-source']) {
  test('prepare rejects unsafe source/output: ' + mode, t => {
    const f = fixture(t);
    if (mode === 'dirty-source') f.put(path.join(f.repo, 'local.txt'), 'keep me');
    const out = mode === 'output-in-source' ? path.join(f.repo, 'run') : f.out;
    const r = f.run(['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', out, '--approved-plan', digestPlan(validatePlan(f.plan)), '--write-opt-in']);
    assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.equal(fs.existsSync(out), false);
  });
}

for (const mode of ['untracked', 'outside-commit', 'rename-outside', 'changed-source', 'changed-branch', 'shared-config', 'manifest-branch']) {
  test('verification refuses unsafe writer state without discarding it: ' + mode, t => {
    const f = fixture(t), m = f.prepare(), u = m.units[0];
    for (const unit of m.units) f.commit(unit, 'src/' + unit.id.toLowerCase() + '.txt', unit.id + ' result');
    if (mode === 'untracked') f.put(path.join(u.path, 'outside.txt'), 'preserve');
    if (mode === 'outside-commit') f.commit(u, 'outside.txt', 'preserve');
    if (mode === 'rename-outside') { f.git(u.path, ['mv', 'src/a.txt', 'outside.txt']); f.git(u.path, ['commit', '-qm', 'out of scope rename']); }
    if (mode === 'changed-source') { f.put(path.join(f.repo, 'src/a.txt'), 'source advanced'); f.git(f.repo, ['add', '--', 'src/a.txt']); f.git(f.repo, ['commit', '-qm', 'source advanced']); }
    if (mode === 'changed-branch') f.git(u.path, ['checkout', '-qb', 'unowned-branch']);
    if (mode === 'shared-config') f.git(u.path, ['config', '--local', 'parallel.fixture', 'changed']);
    if (mode === 'manifest-branch') {
      f.git(u.path, ['checkout', '-qb', 'unowned-branch']); u.branch = 'unowned-branch';
      f.put(path.join(f.out, 'run.json'), JSON.stringify(m));
    }
    const before = f.git(u.path, ['rev-parse', 'HEAD']);
    const r = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(f.git(u.path, ['rev-parse', 'HEAD']), before);
    assert.equal(fs.existsSync(u.path), true);
  });
}

test('Git environment overrides cannot redirect preparation to another repository', t => {
  const f = fixture(t), foreign = path.join(f.base, 'foreign'); fs.mkdirSync(foreign);
  f.git(foreign, ['init', '-q']);
  const r = f.run(['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', f.out, '--approved-plan', digestPlan(validatePlan(f.plan)), '--write-opt-in'], { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = JSON.parse(r.stdout); assert.equal(fs.realpathSync(m.repo), fs.realpathSync(f.repo));
  assert.equal(f.git(foreign, ['worktree', 'list', '--porcelain']).includes(f.out.replace(/\\/g, '/')), false);
});

test('preparation and verification never run Git hooks or content filters', t => {
  const f = fixture(t), marker = path.join(f.base, 'executed.txt'), filter = path.join(f.base, 'filter.cjs');
  f.put(filter, 'const fs=require("fs");fs.writeFileSync(' + JSON.stringify(marker) + ',"executed");process.stdout.write(fs.readFileSync(0));');
  f.put(path.join(f.repo, '.gitattributes'), '*.txt filter=review\n');
  f.git(f.repo, ['add', '--', '.gitattributes']); f.git(f.repo, ['commit', '-qm', 'filter attribute']);
  for (const kind of ['clean', 'smudge']) f.git(f.repo, ['config', 'filter.review.' + kind, 'node ' + JSON.stringify(filter)]);
  f.git(f.repo, ['config', 'filter.review.required', 'true']);
  const hook = path.join(f.repo, '.git/hooks/post-checkout');
  f.put(hook, '#!/bin/sh\nnode ' + JSON.stringify(filter.replace(/\\/g, '/')) + ' </dev/null\n'); fs.chmodSync(hook, 0o755);
  const file = path.join(f.repo, 'src/a.txt'); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const m = f.prepare();
  assert.equal(fs.existsSync(marker), false);
  // The test commits disable its intentionally installed filter as well.
  for (const u of m.units) {
    f.put(path.join(u.path, 'src/' + u.id.toLowerCase() + '.txt'), u.id + ' result');
    f.git(u.path, ['-c', 'filter.review.clean=', '-c', 'filter.review.required=false', 'add', '--', 'src/' + u.id.toLowerCase() + '.txt']);
    f.git(u.path, ['-c', 'filter.review.clean=', '-c', 'filter.review.required=false', 'commit', '-qm', 'worker']);
  }
  const r = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(marker), false);
});
