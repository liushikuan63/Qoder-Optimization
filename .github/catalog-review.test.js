'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-review-'));
  const pkg = path.join(base, 'package'), client = path.join(base, 'client');
  const put = (p, bytes) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); };
  const entry = { id: 'skill:demo', category: 'skill', name: 'demo', status: 'shipped', source: 'skills/demo', install: { mode: 'copy-skill', tier: 'library' } };
  const catalog = path.join(pkg, 'catalog.json');
  const body = '---\nname: demo\ndescription: catalog review\n---\n# Packaged skill\n';
  put(path.join(pkg, 'skills/demo/SKILL.md'), body);
  put(catalog, JSON.stringify({ schema: 1, entries: [entry] }));
  const env = { ...process.env, HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), QODER_HOME: client, QODER_SHARE_CATALOG: catalog, TEMP: base, TMP: base, TMPDIR: base };
  const run = args => spawnSync(process.execPath, [path.join(source, 'scripts/pkg-catalog.cjs'), ...args], { env, encoding: 'utf8', timeout: 20000 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, pkg, client, entry, catalog, body, put, run };
}

for (const args of [
  ['install', 'skill:demo', '--apply', '--tier'],
  ['install', 'skill:demo', '--apply', '--tier', ''],
  ['install', 'skill:demo', '--apply', '--catalog'],
  ['install', 'skill:demo', '--apply', '--catalog', ''],
  ['install', 'skill:demo', '--apply', '--aply'],
  ['install', 'skill:demo', '--apply', '--tier', 'core', '--tier', 'library'],
  ['register', '--apply'],
  ['drift', 'unexpected-target'],
]) {
  test('catalog CLI rejects ambiguous arguments before writing: ' + JSON.stringify(args), t => {
    const f = fixture(t), r = f.run(args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.existsSync(f.client), false, 'invalid arguments created a client or installed files');
  });
}

test('drift compares every installed tier instead of only the first copy', t => {
  const f = fixture(t);
  f.put(path.join(f.client, 'skills/demo/SKILL.md'), f.body);
  f.put(path.join(f.client, 'skills-library/demo/SKILL.md'), 'local edits in the second tier');
  const r = f.run(['drift']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRIFT 1/);
  assert.match(r.stdout, /skills-library/);
  assert.doesNotMatch(r.stdout, /DRIFT_NONE/);
});

test('drift reports an unavailable package source instead of asserting equality', t => {
  const f = fixture(t);
  f.put(path.join(f.client, 'skills-library/demo/SKILL.md'), f.body);
  fs.rmSync(path.join(f.pkg, 'skills/demo'), { recursive: true });
  const r = f.run(['drift']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /DRIFT_UNVERIFIED/);
  assert.doesNotMatch(r.stdout, /DRIFT_NONE/);
});

test('a partial skill directory with a missing entry point is reported as drift', t => {
  const f = fixture(t);
  f.put(path.join(f.client, 'skills-library/demo/local.md'), 'preserve local notes');
  const r = f.run(['drift']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRIFT 1/);
  assert.doesNotMatch(r.stdout, /DRIFT_NONE/);
});

test('ordinary installed copies compare cleanly while extra local files remain outside the comparison', t => {
  const f = fixture(t);
  f.put(path.join(f.client, 'skills-library/demo/SKILL.md'), f.body);
  f.put(path.join(f.client, 'skills-library/demo/local-notes.md'), 'local only');
  const r = f.run(['drift']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRIFT_NONE/);
});

test('catalog valid install remains dry-run unless apply is explicit', t => {
  const f = fixture(t);
  const preview = f.run(['install', 'skill:demo', '--tier', 'core']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(fs.existsSync(f.client), false);
  const applied = f.run(['install', 'skill:demo', '--tier', 'core', '--apply']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(fs.readFileSync(path.join(f.client, 'skills/demo/SKILL.md'), 'utf8'), f.body);
});
