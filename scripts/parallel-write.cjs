#!/usr/bin/env node
'use strict';
// Prepare one independent write wave; verify commits without merging a branch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { evaluatePlan, validatePlan, digestPlan } = require('./parallel-plan.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
// The JS realpath implementation retains Windows 8.3 names (RUNNER~1);
// native realpath resolves them to the same identity returned by Git.
const realpath = file => fs.realpathSync.native(file);
const canonicalPath = p => {
  let current = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  try { current = fs.realpathSync.native(current); } catch { /* keep resolved path */ }
  return path.join(current, ...tail);
};
const samePath = (a, b) => {
  const left = canonicalPath(a), right = canonicalPath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const inside = (root, file) => {
  const rel = path.relative(canonicalPath(root), canonicalPath(file));
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });

const gitBase = ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];
function git(repo, args, options = {}) {
  // Even status can execute a configured clean/process filter. Inspect names
  // before every command, never config values, and override executable drivers.
  const config = spawnSync('git', [...gitBase, 'config', '--name-only', '--get-regexp', '^(filter\..*\.(clean|smudge|process|required)|merge\..*\.driver)$'], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
  if (config.error || ![0, 1].includes(config.status)) fail('GIT_FAILED', 'cannot inspect Git executable drivers');
  const overrides = config.stdout.split(/\r?\n/).filter(Boolean).flatMap(key => {
    if (/[\x00-\x1f]/.test(key)) fail('UNSUPPORTED_CONFIG', 'Git driver names contain control characters');
    return ['-c', key + (/\.required$/i.test(key) || /^merge\./i.test(key) ? '=false' : '=')];
  });
  const result = spawnSync('git', [...gitBase, ...overrides, ...args], {
    cwd: repo, env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error || (!options.allowFailure && result.status !== 0)) fail('GIT_FAILED', (result.stderr || result.error?.message || 'Git exit ' + result.status).trim());
  return result;
}
const output = (repo, args) => git(repo, args).stdout.trim();
const commonDir = repo => realpath(output(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const head = repo => output(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
function repositoryState(repo) {
  // These inspection commands never read worktree contents or invoke filters.
  // core.worktree must be checked before status can hide the registered files.
  const inspect = args => {
    const result = spawnSync('git', [...gitBase, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail('GIT_FAILED', 'cannot inspect the working directory and configuration');
    return result.stdout;
  };
  const identity = inspect(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir']).trimEnd().split(/\r?\n/);
  if (identity.length !== 2 || !samePath(realpath(identity[0]), repo)) fail('WORKTREE_MISMATCH', 'Git redirects this registered working directory; preserve its configuration and files');
  const gitDir = realpath(identity[1]);
  const entries = inspect(['config', '--null', '--show-origin', '--name-only', '--list']).split('\0');
  if (entries.pop() !== '' || entries.length % 2) fail('UNSUPPORTED_CONFIG', 'cannot identify configuration origins');
  const origins = new Set([path.join(gitDir, 'config.worktree')]);
  for (let i = 0; i < entries.length; i += 2) {
    if (entries[i].startsWith('file:')) origins.add(path.resolve(repo, entries[i].slice(5)));
    else if (entries[i] !== 'command line:') fail('UNSUPPORTED_CONFIG', 'configuration origin must be a file or the controlled command line');
  }
  // Hash the effective files, including conditional includes and the presence
  // of config.worktree. Values remain private; receipts contain only a digest.
  const files = [...origins].sort().map(file => {
    let before;
    try { before = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
    const physical = realpath(file), stat = fs.statSync(physical, { bigint: true });
    if (!stat.isFile() || stat.size > 16n * 1024n * 1024n) fail('UNSUPPORTED_CONFIG', 'configuration must be a bounded ordinary file');
    const bytes = fs.readFileSync(physical), after = fs.statSync(physical, { bigint: true });
    const linkAfter = fs.lstatSync(file, { bigint: true });
    if (before.ino !== linkAfter.ino || before.dev !== linkAfter.dev || stat.ino !== after.ino || stat.dev !== after.dev
      || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== stat.size) fail('SHARED_GIT_CHANGED', 'configuration changed during inspection');
    return [file, physical, String(stat.dev), String(stat.ino), crypto.createHash('sha256').update(bytes).digest('hex')];
  });
  return { gitDir, configDigest: crypto.createHash('sha256').update(JSON.stringify([realpath(repo), gitDir, entries, files])).digest('hex') };
}
function checkedRepository(repo, expected, operation) {
  const check = () => {
    const state = repositoryState(repo);
    if (state.configDigest !== expected) fail('SHARED_GIT_CHANGED', 'effective working-tree configuration changed; retain all files and review the baseline');
  };
  check();
  const value = operation();
  check();
  return value;
}
const clean = (repo, expected) => checkedRepository(repo, expected, () => !git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout);
const configDigest = common => crypto.createHash('sha256').update(fs.readFileSync(path.join(common, 'config'))).digest('hex');
const refs = repo => Object.fromEntries(output(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split(/\r?\n/).filter(Boolean).map(line => line.split(' ')));
function protectedState(run) {
  if (configDigest(run.commonDir) !== run.configDigest) fail('SHARED_GIT_CHANGED', 'shared repository configuration changed; preserve it and review before continuing');
  checkedRepository(run.repo, run.sourceConfigDigest, () => {});
  const current = refs(run.repo);
  if (Object.entries(run.protectedRefs).some(([ref, commit]) => current[ref] !== commit)) fail('SHARED_GIT_CHANGED', 'an existing Git reference changed; review the new baseline');
}

function worktrees(repo) {
  const entries = [], fields = git(repo, ['worktree', 'list', '--porcelain', '-z']).stdout.split('\0');
  let entry = {};
  for (const field of fields) {
    if (!field) { if (entry.worktree) entries.push(entry); entry = {}; continue; }
    const space = field.indexOf(' ');
    entry[space < 0 ? field : field.slice(0, space)] = space < 0 ? true : field.slice(space + 1);
  }
  return entries;
}

function writeReceipt(dir, value) {
  const file = path.join(dir, 'run.json'), temp = path.join(dir, '.receipt-' + crypto.randomUUID());
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}

function noSpecialTree(repo, commit) {
  for (const row of git(repo, ['ls-tree', '-rz', commit]).stdout.split('\0').filter(Boolean)) {
    if (!/^(?:100644|100755) blob /.test(row)) fail('SPECIAL_TREE', 'symlinks and submodules require a separate reviewed workflow');
  }
}

function prepare(options) {
  if (!options.plan || !options.repo || !options.out) fail('USAGE', 'prepare needs --plan, --repo and --out');
  const input = read(options.plan), verdict = evaluatePlan(input), plan = validatePlan(input), digest = digestPlan(plan);
  if (verdict.verdict !== 'PARALLEL_WORKTREE') fail('WRITE_PLAN_REQUIRED', 'prepare requires a parallel worktree write plan');
  if (!options['write-opt-in'] || options['approved-plan'] !== digest) fail('APPROVAL_REQUIRED', 'supply the reviewed plan digest and separate --write-opt-in after user approval');
  if (plan.units.some(unit => unit.dependsOn.length)) fail('WAVE_REQUIRED', 'prepare one independent wave; integrate and verify prerequisites before preparing the next wave from its new baseline');
  const repo = realpath(options.repo), common = commonDir(repo), base = head(repo);
  if (output(repo, ['rev-parse', '--is-bare-repository']) !== 'false') fail('BARE_REPOSITORY', 'a working checkout is required');
  if (!samePath(realpath(output(repo, ['rev-parse', '--show-toplevel'])), repo)) fail('REPOSITORY_ROOT_REQUIRED', '--repo must name the checkout root');
  const sourceConfigDigest = repositoryState(repo).configDigest;
  if (!clean(repo, sourceConfigDigest)) fail('DIRTY_SOURCE', 'preserve and commit source changes before preparing an isolated baseline');
  noSpecialTree(repo, base);
  const requested = path.resolve(options.out);
  // Resolve the existing parent before creating anything, including through junctions.
  const out = path.join(realpath(path.dirname(requested)), path.basename(requested));
  if (fs.existsSync(out)) fail('OUTPUT_EXISTS', 'use a fresh run directory');
  const existing = worktrees(repo);
  if (inside(common, out) || existing.some(item => inside(realpath(item.worktree), out))) fail('OUTPUT_IN_REPOSITORY', 'run directory must be outside every registered checkout and the Git common directory');
  fs.mkdirSync(out, { mode: 0o700 });
  fs.mkdirSync(path.join(out, 'worktrees'));
  const manifest = { schema: 1, status: 'PREPARING', runId: crypto.randomUUID(), repo, commonDir: common, base, sourceConfigDigest, configDigest: configDigest(common), protectedRefs: refs(repo), planDigest: digest, plan, createdAt: new Date().toISOString(), units: [], recovery: [] };
  writeReceipt(out, manifest);
  try {
    for (let i = 0; i < plan.units.length; i++) {
      const unit = plan.units[i], name = String(i + 1).padStart(2, '0') + '-' + unit.id.toLowerCase();
      const target = path.join(out, 'worktrees', name), branch = 'codex/parallel-' + manifest.runId.slice(0, 8) + '-' + name;
      const record = { id: unit.id, kind: unit.kind, path: target, branch, status: 'CREATING' };
      manifest.units.push(record); writeReceipt(out, manifest);
      // A conditional include may become active only in the new Git directory.
      // Register without checkout, then inspect/disable its drivers before any
      // files are materialized. checkout-index without --force preserves an
      // unexpected concurrently created file instead of overwriting it.
      checkedRepository(repo, sourceConfigDigest, () => git(repo, ['worktree', 'add', '--no-checkout', '--lock', '--reason', 'Qoder parallel ' + manifest.runId, '-b', branch, '--', target, base]));
      if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(path.join(target, '.git')).isFile() || fs.lstatSync(path.join(target, '.git')).isSymbolicLink()) fail('WORKTREE_MISMATCH', 'new working directory metadata was redirected');
      const state = repositoryState(target);
      if (!samePath(commonDir(target), common) || !samePath(realpath(fs.readFileSync(path.join(state.gitDir, 'gitdir'), 'utf8').trim()), realpath(path.join(target, '.git')))
        || output(target, ['symbolic-ref', '--quiet', 'HEAD']) !== 'refs/heads/' + branch) fail('WORKTREE_MISMATCH', 'new working directory Git identity does not match its registration');
      record.gitDir = state.gitDir; record.configDigest = state.configDigest;
      if (fs.readdirSync(target).some(name => name !== '.git')) fail('DIRTY_WORKER', 'new working directory acquired unexpected files; preserve it for review');
      checkedRepository(target, record.configDigest, () => git(target, ['read-tree', base]));
      checkedRepository(target, record.configDigest, () => git(target, ['checkout-index', '--all']));
      if (!clean(target, record.configDigest)) fail('DIRTY_WORKER', 'new working directory is not clean after materialization');
      record.status = 'PREPARED';
      manifest.recovery.push({ path: target, branch, note: 'Retain changed worktrees. After review, unlock and remove only this named clean worktree; never force-remove unknown or changed data.' });
      writeReceipt(out, manifest);
    }
    if (head(repo) !== base || !clean(repo, sourceConfigDigest)) fail('BASE_MOVED', 'source changed during preparation; retain the prepared worktrees for review');
    protectedState(manifest);
    manifest.status = 'PREPARED'; writeReceipt(out, manifest);
    return manifest;
  } catch (error) {
    manifest.status = 'PREPARE_FAILED'; manifest.error = { code: error.code || 'FAILED', message: error.message };
    writeReceipt(out, manifest);
    error.message += '; retained worktrees and recovery receipt: ' + path.join(out, 'run.json');
    throw error;
  }
}

function allowed(file, owned) {
  // Git emits slash-separated paths on every platform. A literal backslash
  // on POSIX is not a separator; case folding there would also grant a
  // different file the ownership of an approved path.
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const name = key(file);
  return owned.some(root => name === key(root) || name.startsWith(key(root) + '/'));
}

function verify(options) {
  if (!options.run) fail('USAGE', 'verify needs --run <run.json>');
  const file = path.resolve(options.run), dir = realpath(path.dirname(file)), run = read(file);
  if (!run || run.schema !== 1 || run.status !== 'PREPARED' || !Array.isArray(run.units) || !run.protectedRefs || typeof run.protectedRefs !== 'object' || Array.isArray(run.protectedRefs)) fail('INVALID_RUN', 'run is not a completed preparation');
  if (!/^[a-f0-9]{64}$/.test(run.sourceConfigDigest || '') || run.units.some(unit => !/^[a-f0-9]{64}$/.test(unit?.configDigest || ''))) fail('CONFIG_BINDING_REQUIRED', 'receipt has no complete working-tree configuration binding; retain the existing worktrees and review or prepare a new baseline');
  const plan = validatePlan(run.plan);
  if (run.planDigest !== digestPlan(plan) || run.units.length !== plan.units.length) fail('PLAN_MISMATCH', 'run plan or units changed');
  if (evaluatePlan(plan).verdict !== 'PARALLEL_WORKTREE' || plan.units.some(unit => unit.dependsOn.length)) fail('INVALID_RUN', 'run must contain one independent write wave');
  const repo = realpath(run.repo), common = commonDir(repo);
  if (!samePath(common, realpath(run.commonDir)) || head(repo) !== run.base) fail('BASE_MOVED', 'source identity or HEAD changed; review and prepare a new baseline');
  if (!clean(repo, run.sourceConfigDigest)) fail('DIRTY_SOURCE', 'source has changes; preserve them before integration review');
  protectedState(run);
  const registered = worktrees(repo), units = [];
  const root = realpath(path.join(dir, 'worktrees'));
  if (!inside(dir, root)) fail('WORKTREE_MISMATCH', 'worktree container escaped the run');
  for (let i = 0; i < plan.units.length; i++) {
    const planned = plan.units[i], unit = run.units[i];
    const name = String(i + 1).padStart(2, '0') + '-' + planned.id.toLowerCase();
    const expected = path.join(root, name), branch = 'codex/parallel-' + String(run.runId).slice(0, 8) + '-' + name;
    if (unit.id !== planned.id || unit.kind !== planned.kind || unit.branch !== branch || unit.status !== 'PREPARED' || !samePath(path.resolve(unit.path), expected) || fs.lstatSync(unit.path).isSymbolicLink()) fail('WORKTREE_MISMATCH', 'worker path or identity changed');
    const real = realpath(unit.path), registration = registered.find(item => samePath(realpath(item.worktree), real));
    if (!registration || registration.branch !== 'refs/heads/' + unit.branch || registration.locked !== 'Qoder parallel ' + run.runId
      || !samePath(commonDir(real), common) || !samePath(realpath(output(real, ['rev-parse', '--absolute-git-dir'])), realpath(unit.gitDir))) fail('WORKTREE_MISMATCH', 'worker registration, branch or Git directory changed');
    if (!clean(real, unit.configDigest)) fail('DIRTY_WORKER', 'commit or preserve worker changes before verification: ' + planned.id);
    const tip = head(real);
    if (git(real, ['merge-base', '--is-ancestor', run.base, tip], { allowFailure: true }).status !== 0) fail('FOREIGN_HISTORY', 'worker is not based on the recorded source: ' + planned.id);
    const commits = output(real, ['rev-list', '--reverse', '--topo-order', '--parents', run.base + '..' + tip]).split(/\r?\n/).filter(Boolean);
    let prior = run.base;
    const changed = new Set();
    for (const row of commits) {
      const [commit, ...parents] = row.split(' ');
      if (parents.length !== 1 || parents[0] !== prior) fail('FOREIGN_HISTORY', 'worker history must be a linear series of owned commits');
      const names = git(real, ['diff', '--name-only', '--no-renames', '-z', prior, commit, '--']).stdout.split('\0').filter(Boolean);
      for (const name of names) {
        if (!allowed(name, planned.ownedPaths)) fail('OUTSIDE_OWNERSHIP', planned.id + ' changed an unowned path: ' + name);
        changed.add(name);
      }
      noSpecialTree(real, commit); prior = commit;
    }
    if (planned.kind === 'write' && !commits.length) fail('WORKER_NOT_READY', 'write worker has no committed result: ' + planned.id);
    units.push({ id: planned.id, path: real, branch: unit.branch, base: run.base, head: tip, configDigest: unit.configDigest, commits: commits.map(row => row.split(' ')[0]), changedPaths: [...changed].sort() });
  }
  let accumulated = run.base;
  let tree = output(repo, ['rev-parse', run.base + '^{tree}']);
  for (const unit of units.filter(item => item.head !== run.base)) {
    const result = git(repo, ['merge-tree', '--write-tree', accumulated, unit.head], { allowFailure: true });
    if (result.status !== 0) fail('INTEGRATION_CONFLICT', 'merge preview failed; retain all worktrees and review: ' + result.stdout.slice(0, 2000));
    tree = result.stdout.split(/\r?\n/)[0];
    accumulated = git(repo, ['-c', 'user.name=Parallel Verifier', '-c', 'user.email=parallel@example.invalid', 'commit-tree', tree, '-p', accumulated, '-p', unit.head], { input: 'Isolated parallel integration preview\n' }).stdout.trim();
  }
  // Check again after preview; no branch/index/working-file is modified by it.
  if (head(repo) !== run.base || !clean(repo, run.sourceConfigDigest) || units.some(unit => head(unit.path) !== unit.head || !clean(unit.path, unit.configDigest))) fail('STATE_CHANGED', 'source or worker changed during verification; rerun after review');
  protectedState(run);
  return { ok: true, status: 'READY_FOR_REVIEW', runId: run.runId, planDigest: run.planDigest, base: run.base, units, integrationTree: tree,
    notice: 'Git objects were calculated; branches, indexes and working files were not merged. Review these exact heads, integrate sequentially and run the project gates again. This receipt is not test or deployment evidence.' };
}

function main(argv) {
  const [command, ...args] = argv, options = {}, seen = new Set();
  const allowed = command === 'prepare' ? ['plan', 'repo', 'out', 'approved-plan', 'write-opt-in', 'json'] : command === 'verify' ? ['run', 'json'] : [];
  if (!allowed.length) fail('USAGE', 'parallel-write.cjs prepare|verify (see parallel-orchestration skill)');
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.includes(key) || seen.has(key)) fail('USAGE', 'unknown or repeated option: ' + args[i]);
    seen.add(key);
    if (['write-opt-in', 'json'].includes(key)) options[key] = true;
    else { const value = args[++i]; if (!value?.trim() || value.startsWith('-')) fail('USAGE', 'missing option value'); options[key] = value; }
  }
  return command === 'prepare' ? prepare(options) : verify(options);
}
module.exports = { prepare, verify, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'FAILED', message: error.message })); process.exitCode = error.code === 'USAGE' ? 2 : 1; }
}
