'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const source = path.resolve(__dirname, '..');
const { CORE } = require('../scripts/tier-skills.cjs');
const { resolveSkillFile } = require('../scripts/client-root.js');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tiering-test-'));
  const home = path.join(base, 'home');
  const root = path.join(home, '.qoder');
  const put = (file, data) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); };
  for (const file of ['tier-skills.cjs', 'client-root.js', 'package-dependencies.cjs', 'pack-share-extras.cjs', 'archive-entries.cjs', 'build-skills-index.cjs', 'skill-load.cjs', 'pkg-catalog.cjs']) put('scripts/' + file, fs.readFileSync(path.join(source, 'scripts', file)));
  for (const name of ['skills-router', 'demo']) put(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name} fixture skill\n---\n`);
  put('skills/demo/asset.bin', Buffer.from([0, 127, 255, 10]));
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: root, TEMP: base, TMP: base, TMPDIR: base };
  delete env.QODER_SHARE_CATALOG;
  const run = (file, args = []) => spawnSync(process.execPath, [path.join(root, 'scripts', file), ...args], { cwd: base, env, encoding: 'utf8', timeout: 20000 });
  try { body({ base, root, home, put, env, run }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test('approved resident policy contains exactly twelve distinct entries', () => {
  assert.equal(CORE.length, 12);
  assert.equal(new Set(CORE).size, 12);
  assert.ok(CORE.includes('skills-router') && !CORE.includes('office-docs'));
});

test('tiering preview performs zero directory or index writes', () => fixture(f => {
  const result = f.run('tier-skills.cjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo -> library/);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-index.json')), false);
}));

test('tiering and restoration preserve bytes and rebuild usable routes', () => fixture(f => {
  const original = fs.readFileSync(path.join(f.root, 'skills/demo/asset.bin'));
  assert.equal(f.run('tier-skills.cjs', ['--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'skills-library/demo/asset.bin')), original);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/skills-router/SKILL.md')), true);
  let query = f.run('skill-load.cjs', ['demo']);
  assert.equal(query.status, 0); assert.match(query.stdout, /\[library\]/);
  assert.equal(f.run('tier-skills.cjs', ['--restore', 'demo']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo')), false);
  assert.equal(f.run('tier-skills.cjs', ['--restore', 'demo', '--apply']).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'skills/demo/asset.bin')), original);
  query = f.run('skill-load.cjs', ['demo']);
  assert.equal(query.status, 0); assert.match(query.stdout, /\[core\]/);
  assert.equal(f.run('skill-load.cjs', ['definitely-no-such-capability']).status, 3);
}));

test('explicit keep does not move the extra resident entry', () => fixture(f => {
  assert.equal(f.run('tier-skills.cjs', ['--keep', 'demo', '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
}));

test('an explicit migration list leaves later unrelated additions alone', () => fixture(f => {
  f.put('skills/later/SKILL.md', '---\nname: later\ndescription: later fixture\n---\n');
  assert.equal(f.run('tier-skills.cjs', ['--only', 'demo', '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo/asset.bin')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/later/SKILL.md')), true);
  assert.equal(f.run('tier-skills.cjs', ['--only', 'skills-router', '--apply']).status, 2);
}));

test('duplicate destination stops before any move', () => fixture(f => {
  f.put('skills-library/demo/SKILL.md', 'existing library content');
  const result = f.run('tier-skills.cjs', ['--apply']);
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/asset.bin')), true);
  assert.equal(fs.readFileSync(path.join(f.root, 'skills-library/demo/SKILL.md'), 'utf8'), 'existing library content');
}));

test('index failure returns nonzero and rolls back directory moves', () => fixture(f => {
  f.put('scripts/build-skills-index.cjs', 'process.exit(7);');
  const result = f.run('tier-skills.cjs', ['--apply']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /索引重建失败/);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/asset.bin')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo')), false);
}));

test('missing index builder stops before writes', () => fixture(f => {
  fs.unlinkSync(path.join(f.root, 'scripts/build-skills-index.cjs'));
  assert.equal(f.run('tier-skills.cjs', ['--apply']).status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
}));

test('invalid options, traversal and absent restoration targets are rejected', () => fixture(f => {
  for (const args of [['--restore', '../../outside', '--apply'], ['--restore', 'absent', '--apply'], ['--keep'], ['--restore-all', '--restore', 'demo'], ['--unknown']]) {
    assert.equal(f.run('tier-skills.cjs', args).status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
}));

for (const [wrapper, skill, implementation, extra] of [
  ['office.js', 'office-docs', 'office.js', ['probe']],
  ['office.test.js', 'office-docs', 'office.js', []],
  ['validate-repowiki.js', 'write-repowiki', 'validate-repowiki.js', ['probe']],
  ['fix-repowiki-toc.js', 'write-repowiki', 'fix-repowiki-toc.js', ['probe']],
]) test(wrapper + ' resolves an on-demand implementation and preserves exit status', () => fixture(f => {
  f.put('scripts/' + wrapper, fs.readFileSync(path.join(source, 'scripts', wrapper)));
  f.put(`skills-library/${skill}/scripts/${implementation}`, 'console.log("resolved-library", process.argv.slice(2).join(" ")); process.exit(7);');
  const result = f.run(wrapper, extra);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /resolved-library/);
}));

test('resource resolver rejects missing, ambiguous and traversing paths', () => fixture(f => {
  assert.throws(() => resolveSkillFile('office-docs', 'scripts/office.js', f.root), /Missing/);
  f.put('skills/office-docs/scripts/office.js', 'core');
  assert.equal(resolveSkillFile('office-docs', 'scripts/office.js', f.root), path.join(f.root, 'skills/office-docs/scripts/office.js'));
  f.put('skills-library/office-docs/scripts/office.js', 'library');
  assert.throws(() => resolveSkillFile('office-docs', 'scripts/office.js', f.root), /Ambiguous/);
  assert.throws(() => resolveSkillFile('../outside', 'scripts/office.js', f.root), /Invalid/);
}));

test('consumer cannot report success when an available index builder fails', () => fixture(f => {
  const pkg = path.join(f.base, 'package');
  fs.mkdirSync(path.join(pkg, 'skills/install-demo'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills/install-demo/SKILL.md'), '---\nname: install-demo\ndescription: install fixture\n---\n');
  const catalog = path.join(pkg, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify({ schema: 1, entries: [{ id: 'skill:install-demo', category: 'skill', name: 'install-demo', status: 'shipped', source: 'skills/install-demo', install: { mode: 'copy-skill', tier: 'library' } }] }));
  f.put('scripts/build-skills-index.cjs', 'process.exit(7);');
  const result = f.run('pkg-catalog.cjs', ['install', 'skill:install-demo', '--catalog', catalog, '--apply']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /已回滚.*索引重建失败/);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/install-demo/SKILL.md')), false);
}));
