'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./convention-core.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/main.js'), "'use strict';\nmodule.exports = 1;\n");
  fs.writeFileSync(path.join(root, 'policy.json'), '{"style":"commonjs","ui":false}\n');
  const source = { path: 'policy.json', sha256: core.hash(fs.readFileSync(path.join(root, 'policy.json'))) };
  const rule = { id: 'commonjs', dimension: 'coding-style', key: 'modules', value: 'commonjs', scope: '.', overridable: true, kind: 'policy', source, checkIds: ['style.syntax'] };
  const applicability = Object.fromEntries(core.DIMENSIONS.map(d => [d, { applies: d === 'coding-style', reason: d === 'coding-style' ? 'code change' : 'not part of this scoped check', source }]));
  const request = { schema: 1, projectRoot: root, taskId: 'task', sessionId: 'session', files: ['src/main.js'], mode: 'write', applicability, rules: [rule] };
  function approval() {
    const pack = core.resolve(request);
    return { taskId: request.taskId, sessionId: request.sessionId, worktreeId: pack.project.worktreeId, scopeDigest: pack.scopeDigest, sources: [{ ...source, ruleDigests: request.rules.map(core.hash) }], baseline: [source] };
  }
  return { root, source, rule, request, approval };
}
test('resolves five dimensions from scoped approved rules without writing', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root, 'policy.json'));
  const pack = core.resolve(f.request, f.approval());
  assert.equal(pack.ready, true); assert.equal(pack.decisions.length, 5);
  assert.equal(pack.decisions[0].decision, 'apply'); assert.deepEqual(pack.requiredCheckIds, ['style.syntax']);
  assert.equal(pack.decisions[4].decision, 'not_applicable');
  assert.equal(pack.writes, 0); assert.deepEqual(fs.readFileSync(path.join(f.root, 'policy.json')), before);
  assert.throws(() => { pack.decisions[0].checkIds.push('fake'); }, TypeError);
});
test('a repository policy label is not approval', t => {
  const f = fixture(t), pack = core.resolve(f.request);
  assert.equal(pack.ready, false); assert.equal(pack.decisions[0].decision, 'needs_evidence');
});
test('policy pins bind requirement content and task scope, not just a filename', t => {
  const f = fixture(t), approval = f.approval();
  f.request.rules[0].value = 'esm';
  assert.equal(core.resolve(f.request, approval).ready, false);
  f.request.rules[0].value = 'commonjs'; f.request.taskId = 'another';
  assert.equal(core.resolve(f.request, approval).ready, false);
});
test('missing or false applicability cannot erase an approved obligation', t => {
  const f = fixture(t); delete f.request.applicability.i18n;
  assert.equal(core.resolve(f.request, f.approval()).ready, false);
  f.request.applicability['coding-style'].applies = false;
  assert.equal(core.resolve(f.request, f.approval()).decisions[0].decision, 'needs_evidence');
});
test('more specific policies may override only an overridable parent', t => {
  const f = fixture(t);
  f.request.rules.push({ ...f.rule, id: 'child', scope: 'src', value: 'esm' });
  assert.equal(core.resolve(f.request, f.approval()).decisions[0].bindings[0].value, 'esm');
  f.request.rules[0].overridable = false;
  assert.equal(core.resolve(f.request, f.approval()).decisions[0].decision, 'ask');
});
test('equal-scope conflicts ask instead of counting the majority', t => {
  const f = fixture(t); f.request.rules.push({ ...f.rule, id: 'conflict', value: 'esm' });
  for (let i = 0; i < 10; i++) f.request.rules.push({ ...f.rule, id: 'copy' + i });
  assert.equal(core.resolve(f.request, f.approval()).decisions[0].decision, 'ask');
});
test('cold start uses reversible independent observations, never generated copies', t => {
  const f = fixture(t);
  Object.assign(f.rule, { kind: 'observation', lowCost: true, reversible: true });
  const authority = f.approval();
  let p = core.resolve(f.request, authority);
  assert.equal(p.ready, true); assert.equal(p.decisions[0].bindings[0].origin, 'task-inference');
  f.request.rules.push({ ...f.rule, id: 'copied' });
  p = core.resolve(f.request, authority); assert.equal(p.decisions[0].independentSources, 1);
  authority.generatedPaths = ['policy.json'];
  assert.equal(core.resolve(f.request, authority).ready, false);
});
test('task-scoped conflict decisions require exact conflict and override authority', t => {
  const f = fixture(t); f.rule.overridable = false;
  f.request.rules.push({ ...f.rule, id: 'child', scope: 'src', value: 'esm', overridable: true });
  const authority = f.approval(), unresolved = core.resolve(f.request, authority), conflict = unresolved.decisions[0].conflicts[0];
  authority.resolutions = [{ scopeDigest: unresolved.scopeDigest, conflictDigest: conflict.conflictDigest, selectedRuleId: 'child', sourceRef: 'real-user-answer' }];
  assert.equal(core.resolve(f.request, authority).decisions[0].decision, 'ask');
  authority.resolutions[0].overrideLocked = true;
  assert.equal(core.resolve(f.request, authority).decisions[0].bindings[0].origin, 'task-decision');
  authority.resolutions[0].conflictDigest = '0'.repeat(64);
  assert.equal(core.resolve(f.request, authority).decisions[0].decision, 'ask');
});
test('uncovered task files stay unresolved rather than inheriting another module implicitly', t => {
  const f = fixture(t); f.rule.scope = 'src/main.js'; f.request.files.push('src/new.js');
  assert.equal(core.resolve(f.request, f.approval()).ready, false);
});
test('read-only mode does not create caches or approve persistent policy', t => {
  const f = fixture(t); f.request.mode = 'read-only';
  const before = fs.readdirSync(f.root).sort();
  assert.equal(core.resolve(f.request, f.approval()).writes, 0);
  assert.deepEqual(fs.readdirSync(f.root).sort(), before);
});
test('source changes invalidate both policy and applicability', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'policy.json'), '{}');
  assert.throws(() => core.resolve(f.request), { code: 'SOURCE_CHANGED' });
});
test('B03 snapshot fingerprints raw bytes even when decoding removes a BOM', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.json');
  const original = fs.readFileSync(file), before = core.snapshot(f.root, ['policy.json']);
  const changed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
  fs.writeFileSync(file, changed);
  const after = core.snapshot(f.root, ['policy.json']);
  assert.equal(after.files[0].content, before.files[0].content);
  assert.equal(after.files[0].sha256, core.hash(changed));
  assert.notEqual(after.digest, before.digest);
  assert.throws(() => core.verifySource(f.root, f.source), { code: 'SOURCE_CHANGED' });
  assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), SyntaxError);
  fs.writeFileSync(file, original);
  assert.equal(core.snapshot(f.root, ['policy.json']).digest, before.digest);
  assert.deepEqual(core.verifySource(f.root, f.source), f.source);
});
test('B03 staged source fingerprints retain exact blob bytes', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.json');
  const run = args => { const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run(['init', '--quiet']);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), '*.json -text\n');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"label":"保存"}\r\n')]);
  fs.writeFileSync(file, bytes); run(['add', '--', 'policy.json']);
  const indexed = core.snapshot(f.root, ['policy.json'], 'staged');
  assert.equal(indexed.files[0].sha256, core.hash(bytes));
  assert.equal(core.snapshot(f.root, ['policy.json']).files[0].sha256, indexed.files[0].sha256);
  fs.writeFileSync(file, '{"label":"changed"}');
  assert.equal(core.snapshot(f.root, ['policy.json'], 'staged').digest, indexed.digest);
  assert.notEqual(core.snapshot(f.root, ['policy.json']).digest, indexed.digest);
  const nonUtf8 = Buffer.from([0x80, 0x0a]);
  fs.writeFileSync(file, nonUtf8); run(['add', '--', 'policy.json']);
  assert.equal(core.snapshot(f.root, ['policy.json'], 'staged').files[0].sha256, core.hash(nonUtf8));
});
test('JSON duplicate keys and executable syntax are rejected', () => {
  assert.throws(() => core.parseJson('{"x":1,"x":2}'), { code: 'DUPLICATE_KEY' });
  assert.throws(() => core.parseJson('{"x":{"y":1,"y":2}}'), { code: 'DUPLICATE_KEY' });
  assert.throws(() => core.parseJson('{"x":process.exit()}'));
  assert.deepEqual(core.parseJson('{"x":[1,{"y":2}]}'), { x: [1, { y: 2 }] });
});
test('path traversal, secret paths and external links are rejected', t => {
  const f = fixture(t);
  for (const value of ['../outside', '/etc/passwd', 'C:/outside', 'src/../policy.json', '.git/config', 'src\\main.js']) assert.throws(() => core.snapshot(f.root, [value]), { code: 'PATH_SCOPE' });
  assert.throws(() => core.snapshot(f.root, ['.env']), { code: 'SENSITIVE_PATH' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'x.json'), '{}');
  fs.symlinkSync(outside, path.join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => core.snapshot(f.root, ['redirect/x.json']), { code: 'PATH_SCOPE' });
});
test('staged snapshot reads the index, including deletion, not the working tree', t => {
  const f = fixture(t);
  const run = args => { const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run(['init', '--quiet']); run(['add', '--', 'src/main.js']);
  const staged = core.snapshot(f.root, ['src/main.js'], 'staged');
  fs.writeFileSync(path.join(f.root, 'src/main.js'), 'working tree only');
  assert.equal(core.snapshot(f.root, ['src/main.js'], 'staged').digest, staged.digest);
  assert.notEqual(core.snapshot(f.root, ['src/main.js']).digest, staged.digest);
  fs.unlinkSync(path.join(f.root, 'src/main.js'));
  run(['add', '-u', '--', 'src/main.js']);
  assert.equal(core.snapshot(f.root, ['src/main.js'], 'staged').files[0].exists, false);
});
test('real root identity treats aliases as the same directory', t => {
  const f = fixture(t);
  assert.equal(core.identity(f.root).worktreeId, core.identity(path.join(f.root, 'src', '..')).worktreeId);
});
test('discovery is explicit and never runs project configuration', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"engines":{"node":">=20"},"scripts":{"test":"do-not-execute"}}');
  fs.writeFileSync(path.join(f.root, 'eslint.config.js'), 'throw new Error("executed");');
  const p = core.discover(f.root);
  assert.deepEqual(p.packageInfo.scripts, ['test']); assert.equal(p.policy, null); assert.equal(p.writes, 0);
  assert.equal(p.observations.length, 2);
});
test('rule command injection and unsupported check IDs cannot execute', t => {
  const f = fixture(t);
  f.rule.value = { shell: 'never-execute' };
  assert.throws(() => core.resolve(f.request), { code: 'UNTRUSTED_COMMAND' });
  f.rule.value = 'cjs'; f.rule.checkIds = ['unknown'];
  assert.throws(() => core.resolve(f.request), { code: 'INVALID_RULE' });
});
test('empty and unverified results are not PASS; known violations dominate', () => {
  assert.equal(core.aggregate([]).status, 'UNVERIFIED');
  assert.equal(core.aggregate([{ status: 'NOT_APPLICABLE' }]).status, 'NOT_APPLICABLE');
  assert.equal(core.aggregate([{ status: 'PASS' }, { status: 'UNVERIFIED' }]).exitCode, 2);
  assert.equal(core.aggregate([{ status: 'FAIL' }, { status: 'UNVERIFIED' }]).exitCode, 1);
});
test('changed packages and lost dimensions cannot pass integrity validation', t => {
  const f = fixture(t), pack = core.copy(core.resolve(f.request, f.approval()));
  pack.decisions.pop(); assert.throws(() => core.assertPackage(pack), { code: 'PACKAGE_CHANGED' });
});
test('CLI rejects missing, unknown and malformed input with a nonzero status', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'convention-core.cjs'), 'unknown'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.equal(JSON.parse(r.stderr).code, 'USAGE');
});
