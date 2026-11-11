'use strict';
// 白名单真源（scripts/skill-reference-allowlist.cjs）的判据：增删改判红判绿、格式非法、路径越界。
// 白名单错了会直接放行悬空引用，所以它必须有自己的测试，而不是只被 integrity 顺带读取。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const integrity = require('./skill-reference-integrity.cjs');
const shipped = require('./skill-reference-allowlist.cjs');

function fixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'skills/demo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: fixture\n---\n\n# Demo\n\n见 [缺失文档](references/absent.md)。\n');
  if (entries !== undefined) putAllowlist(dir, entries);
  return dir;
}
function putAllowlist(dir, entries) {
  fs.writeFileSync(path.join(dir, 'scripts/skill-reference-allowlist.cjs'),
    "'use strict';\nmodule.exports = " + JSON.stringify({ schema: 1, entries }, null, 2) + ';\n');
}
const entry = (override = {}) => ({ skill: 'demo', ref: 'references/absent.md', reason: 'fixture: deliberately dangling reference', ...override });
const missingRefs = dir => integrity.scan(dir).missing.map(item => item.ref);

test('the shipped allowlist loads and its count matches what the scanner reports', () => {
  const loaded = integrity.loadAllowlist(repo);
  assert.equal(loaded.length, shipped.entries.length);
  assert.ok(loaded.length >= 3);
  for (const item of loaded) {
    assert.ok(item.skill.trim() && item.ref.trim() && item.reason.trim());
    assert.ok(!path.isAbsolute(item.ref));
  }
  assert.equal(new Set(loaded.map(item => item.skill + '\u0000' + item.ref)).size, loaded.length);
  assert.equal(integrity.scan(repo).allowlisted, loaded.length);
});

test('adding an entry turns a dangling reference green and removing it turns red again', t => {
  const dir = fixture(t);
  assert.deepEqual(missingRefs(dir), ['references/absent.md']);
  putAllowlist(dir, [entry()]);
  assert.deepEqual(missingRefs(dir), []);
  assert.equal(integrity.scan(dir).allowlisted, 1);
  putAllowlist(dir, []);
  assert.deepEqual(missingRefs(dir), ['references/absent.md']);
});

test('editing the entry ref re-exposes the dangling reference', t => {
  const dir = fixture(t, [entry()]);
  assert.deepEqual(missingRefs(dir), []);
  putAllowlist(dir, [entry({ ref: 'references/other.md' })]);
  assert.deepEqual(missingRefs(dir), ['references/absent.md']);
  putAllowlist(dir, [entry({ skill: 'another-skill' })]);
  assert.deepEqual(missingRefs(dir), ['references/absent.md']);
});

test('negative control: an empty reason is rejected instead of silently dropped', t => {
  const dir = fixture(t, [entry({ reason: '   ' })]);
  assert.throws(() => integrity.loadAllowlist(dir), /non-empty reason/);
  assert.throws(() => integrity.scan(dir), /non-empty reason/);
});

test('a missing or non-string field is rejected', t => {
  for (const override of [{ ref: undefined }, { skill: undefined }, { reason: undefined }, { ref: 42 }, { skill: null }]) {
    const dir = fixture(t, [entry(override)]);
    assert.throws(() => integrity.loadAllowlist(dir), /requires a non-empty/, JSON.stringify(override));
  }
  const notObject = fixture(t, ['references/absent.md']);
  assert.throws(() => integrity.loadAllowlist(notObject), /must be an object/);
});

test('absolute and UNC refs are rejected as out-of-scope exemptions', t => {
  for (const ref of ['/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '\\\\server\\share\\secret.md']) {
    const dir = fixture(t, [entry({ ref })]);
    assert.throws(() => integrity.loadAllowlist(dir), /must be relative/, ref);
  }
});

test('a control character in the key fields is rejected', t => {
  for (const ref of ['references/absent.md\u0000other', 'references/absent.md\nother']) {
    const dir = fixture(t, [entry({ ref })]);
    assert.throws(() => integrity.loadAllowlist(dir), /control characters/);
  }
  const skill = fixture(t, [entry({ skill: 'demo\u0000evil' })]);
  assert.throws(() => integrity.loadAllowlist(skill), /control characters/);
});

test('a duplicate skill/ref pair is rejected', t => {
  const dir = fixture(t, [entry(), entry({ reason: 'fixture: second reason for the same pair' })]);
  assert.throws(() => integrity.loadAllowlist(dir), /duplicates demo/);
});

test('a bad schema or non-array entries is rejected', t => {
  const badSchema = fixture(t);
  fs.writeFileSync(path.join(badSchema, 'scripts/skill-reference-allowlist.cjs'), "module.exports = { schema: 2, entries: [] };\n");
  assert.throws(() => integrity.loadAllowlist(badSchema), /invalid allowlist schema/);
  const badEntries = fixture(t);
  fs.writeFileSync(path.join(badEntries, 'scripts/skill-reference-allowlist.cjs'), "module.exports = { schema: 1, entries: {} };\n");
  assert.throws(() => integrity.loadAllowlist(badEntries), /invalid allowlist schema/);
});

test('relative parent refs stay allowed because upstream paths are legitimate exemptions', t => {
  const dir = fixture(t, [entry({ ref: '../../docs/internal/upstream.md' })]);
  const loaded = integrity.loadAllowlist(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].ref, '../../docs/internal/upstream.md');
});

test('no allowlist file means no exemptions', t => {
  const dir = fixture(t);
  assert.deepEqual(integrity.loadAllowlist(dir), []);
  assert.deepEqual(missingRefs(dir), ['references/absent.md']);
});

test('a JSON allowlist is validated by the same rules', t => {
  const dir = fixture(t);
  const json = path.join(dir, 'scripts/skill-reference-allowlist.json');
  fs.writeFileSync(json, JSON.stringify({ schema: 1, entries: [entry()] }));
  assert.deepEqual(missingRefs(dir), []);
  fs.writeFileSync(json, JSON.stringify({ schema: 1, entries: [entry({ reason: '' })] }));
  assert.throws(() => integrity.loadAllowlist(dir), /non-empty reason/);
});

test('mutation: the old silent filter would have dropped the malformed entry', t => {
  const dir = fixture(t, [entry({ reason: '' })]);
  const source = fs.readFileSync(path.join(__dirname, 'skill-reference-integrity.cjs'), 'utf8');
  const anchor = 'return validateAllowlist(data);';
  assert.equal(source.split(anchor).length - 1, 1);
  const mutant = path.join(dir, 'mutant-integrity.cjs');
  fs.writeFileSync(mutant, source.replace(anchor,
    "return data.entries.filter(entry => entry && typeof entry.skill === 'string' && typeof entry.ref === 'string' && typeof entry.reason === 'string' && entry.reason.trim());"));
  assert.throws(() => integrity.loadAllowlist(dir), /non-empty reason/);
  const old = require(mutant);
  assert.deepEqual(old.loadAllowlist(dir), []);
  assert.deepEqual(old.scan(dir).missing.map(item => item.ref), ['references/absent.md']);
});