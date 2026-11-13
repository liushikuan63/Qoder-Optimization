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
  assert.notEqual(fs.realpathSync.native(manifest.units[0].path), fs.realpathSync.native(manifest.units[1].path));
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
  const m = JSON.parse(r.stdout); assert.equal(fs.realpathSync.native(m.repo), fs.realpathSync.native(f.repo));
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

test('Git root identity uses native canonical paths when legacy realpath retains an alias', t => {
  const f = fixture(t), alias = path.join(f.base, 'repo-alias'), preload = path.join(f.base, 'legacy-realpath.cjs');
  fs.symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.put(preload, 'const fs=require("node:fs");const original=fs.realpathSync;const repo=' + JSON.stringify(fs.realpathSync(f.repo)) + ';const alias=' + JSON.stringify(alias) + ';fs.realpathSync=Object.assign(function(p,...args){const value=original(p,...args);return value===repo?alias:value;},{native:original.native});');
  const result = f.run(['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', f.out, '--approved-plan', digestPlan(validatePlan(f.plan)), '--write-opt-in'], { NODE_OPTIONS: '--require=' + JSON.stringify(preload) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.repo, fs.realpathSync.native(f.repo));
  for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
  assert.equal(f.run(['verify', '--run', path.join(f.out, 'run.json')]).status, 0);
});

test('literal uppercase ownership remains usable on all platforms', t => {
  const f = fixture(t);
  f.plan.units[0].ownedPaths = ['src/Upper.txt'];
  f.plan.units[0].readPaths = [];
  f.put(f.planFile, JSON.stringify(f.plan));
  const manifest = f.prepare();
  f.commit(manifest.units[0], 'src/Upper.txt', 'owned uppercase file');
  f.commit(manifest.units[1], 'src/b.txt', 'B result');
  const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('an unchanged per-worktree configuration remains supported', t => {
  const f = fixture(t);
  f.git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
  f.git(f.repo, ['config', '--worktree', 'parallel.fixture', 'baseline']);
  const manifest = f.prepare();
  for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
  const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const scope of ['source', 'worker']) {
  test('verification rejects a core.worktree redirect hiding dirty files: ' + scope, t => {
    const f = fixture(t);
    f.git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
    const manifest = f.prepare();
    for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
    const target = scope === 'source' ? f.repo : manifest.units[0].path;
    const alternate = path.join(f.base, 'alternate');
    fs.cpSync(path.join(target, 'src'), path.join(alternate, 'src'), { recursive: true });
    f.git(target, ['config', '--worktree', 'core.worktree', alternate]);
    f.put(path.join(target, 'src/a.txt'), 'uncommitted original bytes');
    f.put(path.join(target, 'untracked.txt'), 'retain this recovery input');
    assert.equal(f.git(target, ['status', '--porcelain']), '', 'the redirect genuinely conceals the original dirty files');
    const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stderr).code, /WORKTREE_MISMATCH|SHARED_GIT_CHANGED/);
    assert.equal(fs.readFileSync(path.join(target, 'src/a.txt'), 'utf8'), 'uncommitted original bytes');
    assert.equal(fs.existsSync(path.join(target, 'untracked.txt')), true);
  });
}

for (const mode of ['worktree-file', 'conditional-include']) {
  test('verification binds per-worktree and included configuration: ' + mode, t => {
    const f = fixture(t);
    f.git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
    const included = path.join(f.base, 'included.config');
    if (mode === 'conditional-include') {
      f.put(included, '[parallel]\n fixture = before\n');
      const common = f.git(f.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\\/g, '/');
      f.git(f.repo, ['config', 'includeIf.gitdir:' + common + '/worktrees/.path', included]);
    }
    const manifest = f.prepare();
    for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
    if (mode === 'worktree-file') f.git(manifest.units[0].path, ['config', '--worktree', 'parallel.fixture', 'after']);
    else f.put(included, '[parallel]\n fixture = after\n');
    const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stderr).code, 'SHARED_GIT_CHANGED');
  });
}

test('a configuration write during status cannot produce a clean receipt', t => {
  const f = fixture(t);
  f.git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
  const manifest = f.prepare(), unit = manifest.units[0];
  for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
  const preload = path.join(f.base, 'config-race.cjs');
  f.put(preload, 'const fs=require("node:fs"),cp=require("node:child_process"),path=require("node:path"),original=cp.spawnSync;let changed=false;cp.spawnSync=function(exe,args,options){const result=original.apply(this,arguments);if(!changed&&exe==="git"&&args.includes("status")&&path.resolve(options.cwd)===' + JSON.stringify(path.resolve(unit.path)) + '){changed=true;fs.writeFileSync(' + JSON.stringify(path.join(unit.gitDir, 'config.worktree')) + ',"[parallel]\\n fixture = late\\n");}return result;};');
  const result = f.run(['verify', '--run', path.join(f.out, 'run.json')], { NODE_OPTIONS: '--require=' + JSON.stringify(preload) });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stderr).code, 'SHARED_GIT_CHANGED');
  assert.match(fs.readFileSync(path.join(unit.gitDir, 'config.worktree'), 'utf8'), /late/);
});

test('preparation discovers conditional filters before materializing a new worker', t => {
  const f = fixture(t), marker = path.join(f.base, 'executed.txt'), filter = path.join(f.base, 'conditional-filter.cjs');
  f.put(filter, 'const fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(marker) + ',"executed\\n");process.stdout.write(fs.readFileSync(0));');
  f.put(path.join(f.repo, '.gitattributes'), '*.txt filter=conditional\n');
  f.git(f.repo, ['add', '--', '.gitattributes']); f.git(f.repo, ['commit', '-qm', 'conditional attributes']);
  const included = path.join(f.base, 'included.config');
  const command = JSON.stringify(process.execPath.replace(/\\/g, '/')) + ' ' + JSON.stringify(filter.replace(/\\/g, '/'));
  f.put(included, '[filter "conditional"]\n clean = ' + JSON.stringify(command) + '\n smudge = ' + JSON.stringify(command) + '\n required = true\n');
  const common = f.git(f.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\\/g, '/');
  f.git(f.repo, ['config', 'includeIf.gitdir:' + common + '/worktrees/.path', included]);
  // Positive control: this Git configuration really executes only after a new
  // worktree selects the conditional include, unlike source-side discovery.
  f.git(f.repo, ['worktree', 'add', '--detach', '--', path.join(f.base, 'control'), 'HEAD']);
  assert.equal(fs.existsSync(marker), true);
  fs.unlinkSync(marker);
  const manifest = f.prepare();
  assert.equal(fs.existsSync(marker), false, 'prepare must suppress the target-only filter before checkout');
  for (const u of manifest.units) {
    f.put(path.join(u.path, 'src/' + u.id.toLowerCase() + '.txt'), u.id + ' result');
    f.git(u.path, ['-c', 'filter.conditional.clean=', '-c', 'filter.conditional.required=false', 'add', '--', 'src/' + u.id.toLowerCase() + '.txt']);
    f.git(u.path, ['-c', 'filter.conditional.clean=', '-c', 'filter.conditional.required=false', 'commit', '-qm', 'worker']);
  }
  assert.equal(f.run(['verify', '--run', path.join(f.out, 'run.json')]).status, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('a newly registered worker redirect is rejected before materialization', t => {
  const f = fixture(t), alternate = path.join(f.base, 'alternate'), preload = path.join(f.base, 'registration-race.cjs');
  f.git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
  f.put(path.join(alternate, 'src/a.txt'), 'retain alternate bytes');
  f.put(preload, 'const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),original=cp.spawnSync;let changed=false;cp.spawnSync=function(exe,args,options){const result=original.apply(this,arguments);if(!changed&&exe==="git"&&args.includes("worktree")&&args.includes("add")&&result.status===0){changed=true;const target=args[args.indexOf("--")+1],dir=fs.readFileSync(path.join(target,".git"),"utf8").trim().slice(8);fs.writeFileSync(path.join(dir,"config.worktree"),' + JSON.stringify('[core]\n worktree = ' + JSON.stringify(alternate.replace(/\\/g, '/')) + '\n') + ');}return result;};');
  const result = f.run(['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', f.out, '--approved-plan', digestPlan(validatePlan(f.plan)), '--write-opt-in'], { NODE_OPTIONS: '--require=' + JSON.stringify(preload) });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(alternate, 'src/a.txt'), 'utf8'), 'retain alternate bytes');
  assert.equal(fs.existsSync(path.join(alternate, 'src/b.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'run.json'), 'utf8')).status, 'PREPARE_FAILED');
});

test('an older receipt cannot silently skip the configuration binding', t => {
  const f = fixture(t), manifest = f.prepare();
  for (const u of manifest.units) f.commit(u, 'src/' + u.id.toLowerCase() + '.txt', u.id + ' result');
  delete manifest.sourceConfigDigest;
  for (const u of manifest.units) delete u.configDigest;
  f.put(path.join(f.out, 'run.json'), JSON.stringify(manifest));
  const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stderr).code, 'CONFIG_BINDING_REQUIRED');
  for (const u of manifest.units) {
    assert.equal(fs.existsSync(u.path), true);
    assert.equal(f.git(u.path, ['rev-list', '--count', manifest.base + '..HEAD']), '1');
  }
});

for (const foreignPath of ['src/A.txt', 'src\\a.txt']) {
  test('POSIX ownership rejects a distinct Git path: ' + foreignPath, { skip: process.platform === 'win32' ? 'requires case-sensitive and backslash-literal paths' : false }, t => {
    const f = fixture(t), manifest = f.prepare();
    // Git paths always use slash separators. A backslash is a literal filename
    // on POSIX and must not gain ownership by Windows-style normalization.
    f.put(path.join(manifest.units[0].path, foreignPath), 'unowned path');
    f.git(manifest.units[0].path, ['add', '--', foreignPath]);
    f.git(manifest.units[0].path, ['commit', '-qm', 'distinct unowned path']);
    f.commit(manifest.units[1], 'src/b.txt', 'B result');
    const result = f.run(['verify', '--run', path.join(f.out, 'run.json')]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stderr).code, 'OUTSIDE_OWNERSHIP');
    assert.equal(fs.existsSync(path.join(manifest.units[0].path, foreignPath)), true);
  });
}

// —— A29：收据原子写的瞬时 EPERM/EBUSY 退避重试（2026-11-13 用户采纳候选）——
// 注入发生在真实子进程里（NODE_OPTIONS --require 换掉 fs.renameSync），不是 stub 被测函数；
// 尝试次数与失败次数落盘计数，所以「重试了几次」是可失败读数，不靠退出码猜。
function renameFault(f, code, failTimes) {
  const marker = path.join(f.base, 'rename-attempts.json'), preload = path.join(f.base, 'rename-fault.cjs');
  f.put(preload, [
    "const fs = require('node:fs'), path = require('node:path');",
    'const original = fs.renameSync, marker = ' + JSON.stringify(marker) + ', code = ' + JSON.stringify(code) + ';',
    'let left = ' + failTimes + ';',
    'fs.renameSync = function (from, to, ...rest) {',
    "  if (path.basename(String(to)) === 'run.json') {",
    '    let s = { attempts: 0, failures: 0 };',
    "    try { s = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}",
    '    s.attempts++;',
    '    const fail = left > 0;',
    '    if (fail) { left--; s.failures++; }',
    '    fs.writeFileSync(marker, JSON.stringify(s));',
    '    if (fail) { const e = new Error(code + ": operation not permitted, rename"); e.code = code; throw e; }',
    '  }',
    '  return original(from, to, ...rest);',
    '};',
  ].join('\n'));
  return { preload, read: () => JSON.parse(fs.readFileSync(marker, 'utf8')) };
}
const prepareArgs = f => ['prepare', '--plan', f.planFile, '--repo', f.repo, '--out', f.out, '--approved-plan', digestPlan(validatePlan(f.plan)), '--write-opt-in'];
const withPreload = fault => ({ NODE_OPTIONS: '--require=' + JSON.stringify(fault.preload) });

for (const code of ['EPERM', 'EBUSY']) {
  test('receipt rename survives a transient ' + code + ' and still prepares', t => {
    const f = fixture(t), fault = renameFault(f, code, 2);
    const r = f.run(prepareArgs(f), withPreload(fault));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = fault.read();
    assert.equal(s.failures, 2, JSON.stringify(s)); // 注入确实触发过，判据非空转
    const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'run.json'), 'utf8'));
    assert.equal(manifest.status, 'PREPARED');
    assert.equal(manifest.units.length, 2);
  });
}

test('persistent EPERM stays a hard failure with bounded retries', t => {
  const f = fixture(t), fault = renameFault(f, 'EPERM', 99);
  const r = f.run(prepareArgs(f), withPreload(fault));
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stderr).code, 'EPERM');
  const s = fault.read();
  // 初始收据写在 try 之外（prepare 先 writeReceipt 再进 try），失败时不会再写 PREPARE_FAILED 收据，
  // 因此这条路径的硬上限就是单次调用的 5 次尝试——不是无上限重试，也不是静默成功。
  assert.equal(s.attempts, 5, JSON.stringify(s));
  assert.equal(s.failures, 5, JSON.stringify(s));
  assert.equal(fs.existsSync(path.join(f.out, 'run.json')), false); // 绝不把失败静默当成功
});

test('unrelated rename errors are not retried', t => {
  const f = fixture(t), fault = renameFault(f, 'ENOENT', 99);
  const r = f.run(prepareArgs(f), withPreload(fault));
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stderr).code, 'ENOENT');
  const s = fault.read();
  assert.equal(s.attempts, 1, JSON.stringify(s)); // 非 EPERM/EBUSY 立即上抛：一次就够，绝不退避重试
  assert.equal(s.failures, 1, JSON.stringify(s));
});

test('without injection the receipt path is unchanged', t => {
  const f = fixture(t), fault = renameFault(f, 'EPERM', 0);
  const r = f.run(prepareArgs(f), withPreload(fault));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = fault.read();
  assert.equal(s.failures, 0, JSON.stringify(s));
  assert.ok(s.attempts >= 1, JSON.stringify(s)); // 计数非空转：真的发生过 rename
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'run.json'), 'utf8')).status, 'PREPARED');
});
