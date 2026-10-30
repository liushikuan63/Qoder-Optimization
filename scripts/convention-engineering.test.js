'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('./convention-core.cjs');
const engine = require('./convention-engineering.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-engineering-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, write, context: { projectRoot: root, taskId: 'test', mode: 'write' } };
}
function command(f) {
  f.write('probe.cjs', "console.log('PROBE_OK');\n");
  const definition = { id: 'tools.identity', executable: process.execPath, sha256: core.hash(fs.readFileSync(process.execPath)), args: ['probe.cjs'], inputs: [{ path: 'probe.cjs', sha256: core.hash(fs.readFileSync(path.join(f.root, 'probe.cjs'))) }], expect: { exitCode: 0, stdoutIncludes: ['PROBE_OK'] } };
  const authority = { taskId: 'test', worktreeId: core.identity(f.root).worktreeId, commandDigests: [engine.commandDigest(definition)] };
  return { definition, authority };
}
test('style uses parser tokens, not strings inside comments', t => {
  const f = fixture(t); f.write('a.cjs', "// \"not a violation\"\nconst x = 'ok';\nmodule.exports = x;\n");
  assert.equal(engine.inspectStyle(core.snapshot(f.root, ['a.cjs']), { modules: 'commonjs', quotes: 'single', noTabs: true }).status, 'PASS');
  f.write('a.cjs', '\tconst x = "bad";\n');
  const result = engine.inspectStyle(core.snapshot(f.root, ['a.cjs']), { modules: 'commonjs', quotes: 'single', noTabs: true });
  assert.equal(result.status, 'FAIL'); assert.equal(result.issues.length, 2);
});
test('unsupported style syntax is unverified, not an empty success', t => {
  const f = fixture(t); f.write('a.vue', '<template>hi</template>');
  assert.equal(engine.inspectStyle(core.snapshot(f.root, ['a.vue']), { modules: 'esm' }).status, 'UNVERIFIED');
});
test('CommonJS policy rejects an ESM import', t => {
  const f = fixture(t); f.write('a.js', "import x from 'example';");
  assert.equal(engine.inspectStyle(core.snapshot(f.root, ['a.js']), { modules: 'commonjs' }).status, 'FAIL');
});
test('trusted invocation runs a real process with frozen nonempty expectation', t => {
  const f = fixture(t), { definition, authority } = command(f);
  const result = engine.runTrusted(definition, f.context, authority);
  assert.equal(result.status, 'PASS'); assert.equal(result.executed, true); assert.equal(result.record.termination, 'completed');
  assert.match(result.record.stdout, /PROBE_OK/);
});
test('read-only, unapproved arguments and wrong task never run the checker', t => {
  const f = fixture(t), { definition, authority } = command(f);
  f.context.mode = 'read-only'; assert.equal(engine.runTrusted(definition, f.context, authority).status, 'UNVERIFIED');
  f.context.mode = 'write'; definition.args.push('changed');
  assert.equal(engine.runTrusted(definition, f.context, authority).status, 'UNVERIFIED');
  definition.args.pop(); authority.taskId = 'other';
  assert.equal(engine.runTrusted(definition, f.context, authority).status, 'UNVERIFIED');
});
test('same-name replaced implementation is refused before execution', t => {
  const f = fixture(t), { definition, authority } = command(f);
  f.write('probe.cjs', "require('fs').writeFileSync('sentinel','bad');console.log('PROBE_OK');");
  assert.notEqual(engine.runTrusted(definition, f.context, authority).status, 'PASS');
  assert.equal(fs.existsSync(path.join(f.root, 'sentinel')), false);
});
test('script entry cannot be left out of approved input fingerprints', t => {
  const f = fixture(t), { definition, authority } = command(f);
  definition.inputs = []; authority.commandDigests = [engine.commandDigest(definition)];
  const result = engine.runTrusted(definition, f.context, authority);
  assert.equal(result.status, 'UNVERIFIED'); assert.notEqual(result.executed, true);
});
test('equals signs in script filenames cannot bypass implementation fingerprints', t => {
  const f = fixture(t), { definition, authority } = command(f);
  f.write('a=b.cjs', "console.log('PROBE_OK');"); definition.args = ['a=b.cjs']; definition.inputs = [];
  authority.commandDigests = [engine.commandDigest(definition)];
  assert.equal(engine.runTrusted(definition, f.context, authority).status, 'UNVERIFIED');
});
test('a checker returning the wrong value or exiting abnormally is not green', t => {
  const f = fixture(t), { definition, authority } = command(f);
  definition.expect.stdoutIncludes = ['INDEPENDENT_DIFFERENT_RESULT']; authority.commandDigests = [engine.commandDigest(definition)];
  assert.equal(engine.runTrusted(definition, f.context, authority).status, 'FAIL');
});
test('version ranges preserve valid alternatives and reject mismatches', () => {
  const policy = { declared: '>=20 <25', locked: '22.1.0' };
  const actual = { version: 'v24.16.0', sourceRef: 'real-process', executable: process.execPath };
  assert.equal(engine.checkVersions(policy, actual).status, 'PASS');
  assert.equal(engine.checkVersions({ ...policy, exactRuntime: true }, actual).status, 'FAIL');
  assert.equal(engine.checkVersions({ ...policy, locked: '19.9.0' }, actual).status, 'FAIL');
  assert.equal(engine.checkVersions(policy, null).status, 'UNVERIFIED');
  assert.equal(engine.checkVersions({ declared: '^0.2.1', locked: '0.2.9' }, { ...actual, version: '0.3.0' }).status, 'FAIL');
});
function manifests(f) {
  const pkg = { dependencies: { example: '^1.2.0' } };
  const lock = { lockfileVersion: 3, packages: { '': core.copy(pkg), 'node_modules/example': { version: '1.2.4', resolved: 'https://registry.npmjs.org/example/-/example-1.2.4.tgz', integrity: 'sha512-YWJjZA==' } } };
  f.write('package.json', pkg); f.write('package-lock.json', lock);
  const policy = { allowedRegistries: ['https://registry.npmjs.org/'], baseline: core.copy(pkg) };
  const run = () => engine.checkDependencies(core.snapshot(f.root, ['package.json', 'package-lock.json']), policy);
  return { pkg, lock, policy, run };
}
test('declared dependency, lock scope, source and resolved version are checked', t => {
  const f = fixture(t), m = manifests(f);
  assert.equal(m.run().status, 'PASS');
  m.lock.packages['node_modules/example'].dev = true; f.write('package-lock.json', m.lock);
  assert.equal(m.run().status, 'FAIL');
});
test('missing lock, range conflict, changed source and unknown specs cannot pass', t => {
  const f = fixture(t), m = manifests(f);
  fs.unlinkSync(path.join(f.root, 'package-lock.json')); assert.equal(m.run().status, 'UNVERIFIED');
  m.lock.packages['node_modules/example'].version = '2.0.0'; f.write('package-lock.json', m.lock); assert.equal(m.run().status, 'FAIL');
  m.lock.packages['node_modules/example'].version = '1.2.4'; m.lock.packages['node_modules/example'].resolved = 'file:../unsafe'; f.write('package-lock.json', m.lock); assert.equal(m.run().status, 'FAIL');
});
test('new dependencies require approved additions; equivalent duplicates are flagged', t => {
  const f = fixture(t), m = manifests(f); m.policy.baseline = {};
  assert.equal(m.run().status, 'FAIL');
  m.policy.approvedAdditions = ['example']; assert.equal(m.run().status, 'PASS');
  m.policy.equivalentGroups = [['example', 'second']];
  m.pkg.devDependencies = { second: '1.2.4' }; m.lock.packages[''].devDependencies = m.pkg.devDependencies; m.lock.packages['node_modules/second'] = { ...m.lock.packages['node_modules/example'] };
  m.policy.approvedAdditions.push('second'); f.write('package.json', m.pkg); f.write('package-lock.json', m.lock);
  assert.equal(m.run().status, 'FAIL');
});
test('transitive lockfile origins, integrity and resolution are checked', t => {
  const f = fixture(t), m = manifests(f);
  m.lock.packages['node_modules/example'].dependencies = { child: '^1.0.0' };
  m.lock.packages['node_modules/child'] = { version: '1.1.0', resolved: 'http://unapproved.invalid/child.tgz', integrity: 'sha512-YWJjZA==' };
  f.write('package-lock.json', m.lock); assert.equal(m.run().status, 'FAIL');
  m.lock.packages['node_modules/child'].resolved = 'https://registry.npmjs.org/child/-/child-1.1.0.tgz';
  f.write('package-lock.json', m.lock); assert.equal(m.run().status, 'PASS');
  delete m.lock.packages['node_modules/child']; f.write('package-lock.json', m.lock);
  assert.equal(m.run().status, 'UNVERIFIED');
});
test('self-written architecture PASS is not independent review authority', t => {
  const f = fixture(t); f.write('code.js', 'const x=1;'); const current = core.snapshot(f.root, ['code.js']);
  f.write('review.json', { snapshotDigest: current.digest, reviewerRef: 'independent', status: 'PASS', reason: 'frozen review' });
  const review = { id: 'architecture.review', reviewerRef: 'independent', source: { path: 'review.json', sha256: core.hash(fs.readFileSync(path.join(f.root, 'review.json'))) } };
  assert.equal(engine.checkReview(review, current, {}).status, 'UNVERIFIED');
  assert.equal(engine.checkReview(review, current, { reviewDigests: [core.hash(review)] }).status, 'PASS');
  f.write('code.js', 'const x=2;'); assert.equal(engine.checkReview(review, core.snapshot(f.root, ['code.js']), { reviewDigests: [core.hash(review)] }).status, 'UNVERIFIED');
});
test('aggregate checks inspect this process rather than accepting a claimed version', t => {
  const f = fixture(t); f.write('a.js', "'use strict';\n");
  const r = engine.check({ schema: 1, projectRoot: f.root, files: ['a.js'], versions: { tool: 'node', declared: '>=20', locked: process.version.slice(1), actual: '0.0.0' } });
  assert.equal(r.status, 'PASS'); assert.equal(r.checks[0].actual, process.version.slice(1));
});
