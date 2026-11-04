'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan } = require('./skill-reference-integrity.cjs');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-ref-integrity-'));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('valid local references pass', () => fixture(root => {
  write(root, 'skills/alpha/SKILL.md', 'Load `references/guide.md` and `scripts/run.cjs`.');
  write(root, 'skills/alpha/references/guide.md', '# guide');
  write(root, 'skills/alpha/scripts/run.cjs', 'module.exports = 1;');
  const result = scan(root);
  assert.strictEqual(result.missing.length, 0);
}));

test('missing reference is reported with skill and source file', () => fixture(root => {
  write(root, 'skills/beta/SKILL.md', 'Load `references/missing.md`.');
  const result = scan(root);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].skill, 'beta');
  assert.strictEqual(result.missing[0].ref, 'references/missing.md');
  assert.strictEqual(result.missing[0].from, 'skills/beta/SKILL.md');
}));

test('transitive markdown reference is checked', () => fixture(root => {
  write(root, 'skills/gamma/SKILL.md', 'Load `references/index.md`.');
  write(root, 'skills/gamma/references/index.md', 'Then read `references/detail.md`.');
  const result = scan(root);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].ref, 'references/detail.md');
}));

test('allowlist suppresses a documented example', () => fixture(root => {
  write(root, 'skills/delta/SKILL.md', 'Example: `scripts/old.cjs` and `scripts/new.cjs`.');
  write(root, 'scripts/skill-reference-allowlist.json', JSON.stringify({
    schema: 1,
    entries: [
      { skill: 'delta', ref: 'scripts/old.cjs', reason: 'example path in a before/after snippet' },
      { skill: 'delta', ref: 'scripts/new.cjs', reason: 'example path in a before/after snippet' },
    ],
  }));
  const result = scan(root);
  assert.strictEqual(result.missing.length, 0);
  assert.strictEqual(result.allowlisted, 2);
}));

test('code fences are not treated as references', () => fixture(root => {
  write(root, 'skills/epsilon/SKILL.md', '```text\nreferences/not-real.md\n```');
  const result = scan(root);
  assert.strictEqual(result.missing.length, 0);
}));

test('CLI exits 2 on missing and 0 when clean', () => fixture(root => {
  write(root, 'skills/zeta/SKILL.md', 'Load `references/missing.md`.');
  const cli = path.join(__dirname, 'skill-reference-integrity.cjs');
  const bad = spawnSync(process.execPath, [cli, '--root', root, '--check'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  write(root, 'skills/zeta/references/missing.md', '# present');
  const good = spawnSync(process.execPath, [cli, '--root', root, '--check'], { encoding: 'utf8' });
  assert.strictEqual(good.status, 0);
}));

test('transitive traversal checks chains deeper than three documents', () => fixture(root => {
  write(root, 'skills/deep/SKILL.md', 'Read `references/one.md`.');
  for (const [name, next] of [['one', 'two'], ['two', 'three'], ['three', 'four'], ['four', 'missing']]) {
    write(root, `skills/deep/references/${name}.md`, `Read \`references/${next}.md\`.`);
  }
  const result = scan(root);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].ref, 'references/missing.md');
}));

test('reference cycles terminate without suppressing missing siblings', () => fixture(root => {
  write(root, 'skills/cycle/SKILL.md', 'Read `references/one.md`.');
  write(root, 'skills/cycle/references/one.md', 'Read `references/two.md`.');
  write(root, 'skills/cycle/references/two.md', 'Read `references/one.md` and `references/missing.md`.');
  assert.strictEqual(scan(root).missing.length, 1);
}));

test('a missing root or empty package cannot produce a clean integrity result', () => fixture(root => {
  assert.throws(() => scan(path.join(root, 'missing')), /root|directory|ENOENT/i);
  assert.throws(() => scan(root), /skills|empty|package/i);
}));

test('CLI rejects missing option values and unknown options', () => fixture(root => {
  const cli = path.join(__dirname, 'skill-reference-integrity.cjs');
  for (const args of [['--root'], ['--root', '--check'], ['--root', root, '--check', '--typo']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.strictEqual(result.status, 2, JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr }));
  }
}));

test('a dependency outside the package cannot satisfy a shipped reference', () => fixture(root => {
  const pkg = path.join(root, 'package');
  write(pkg, 'skills/escape/SKILL.md', 'Read `../../../references/outside.md`.');
  write(root, 'references/outside.md', '# exists outside the distributed package');
  assert.strictEqual(scan(pkg).missing.length, 1);
}));

test('a linked reference directory cannot satisfy a dependency outside the package', () => fixture(root => {
  const pkg = path.join(root, 'package');
  write(pkg, 'skills/linked/SKILL.md', 'Read `references/outside.md`.');
  write(root, 'outside/outside.md', '# external');
  const link = path.join(pkg, 'skills/linked/references');
  fs.symlinkSync(path.join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(scan(pkg).missing.length, 1);
}));
