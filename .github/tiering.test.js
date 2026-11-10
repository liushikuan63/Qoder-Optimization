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
  for (const file of ['tier-skills.cjs', 'client-root.js', 'capability-roots.cjs', 'package-dependencies.cjs', 'pack-share-extras.cjs', 'archive-entries.cjs', 'build-skills-index.cjs', 'skill-load.cjs', 'pkg-catalog.cjs', 'pkg-catalog-score.cjs']) put('scripts/' + file, fs.readFileSync(path.join(source, 'scripts', file)));
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

test('promote and demote follow actual usage without a fixed resident count', () => fixture(f => {
  const residentFile = path.join(f.root, 'skills-resident.json');
  assert.equal(f.run('tier-skills.cjs', ['--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo/SKILL.md')), true);
  assert.equal(f.run('tier-skills.cjs', ['--promote', 'demo', '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/SKILL.md')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(residentFile, 'utf8')).skills, ['demo']);
  const rerun = f.run('tier-skills.cjs', ['--apply']);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /library=0/);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/SKILL.md')), true);
  assert.equal(f.run('tier-skills.cjs', ['--demote', 'demo', '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo/SKILL.md')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(residentFile, 'utf8')).skills, []);
  assert.equal(f.run('tier-skills.cjs', ['--demote', 'skills-router']).status, 2);
}));

test('override-core lifts the floor only for an explicit demote list', () => fixture(f => {
  f.put('skills/verify-before-claim/SKILL.md', '---\nname: verify-before-claim\ndescription: floor fixture skill\n---\n');
  // 默认路径与改动前一致：不带开关时，地板技能既不能预演也不能落盘。
  assert.equal(f.run('tier-skills.cjs', ['--demote', 'verify-before-claim']).status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
  assert.equal(f.run('tier-skills.cjs', ['--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/verify-before-claim/SKILL.md')), true);
  // 开关不能单独触发整层盲迁。
  assert.equal(f.run('tier-skills.cjs', ['--override-core', '--apply']).status, 2);
  // 按需检索入口即使在开关下也受保护。
  assert.equal(f.run('tier-skills.cjs', ['--demote', 'skills-router', '--override-core']).status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/skills-router/SKILL.md')), true);
  const preview = f.run('tier-skills.cjs', ['--demote', 'verify-before-claim', '--override-core']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /OVERRIDE_CORE floor_lifted=verify-before-claim/);
  assert.match(preview.stdout, /DRY-RUN library=1/);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/verify-before-claim')), false);
  const applied = f.run('tier-skills.cjs', ['--demote', 'verify-before-claim', '--override-core', '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/verify-before-claim/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/verify-before-claim')), false);
  const query = f.run('skill-load.cjs', ['verify-before-claim']);
  assert.equal(query.status, 0, query.stdout + query.stderr);
  assert.match(query.stdout, /\[library\]/);
  assert.equal(f.run('tier-skills.cjs', ['--restore', 'verify-before-claim', '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/verify-before-claim/SKILL.md')), true);
}));

test('an empty scan never overwrites a populated index', () => fixture(f => {
  for (const tier of ['skills', 'skills-library']) {
    const real = path.join(f.base, 'outside', tier);
    fs.mkdirSync(path.join(real, 'resident-skill'), { recursive: true });
    fs.writeFileSync(path.join(real, 'resident-skill', 'SKILL.md'), '---\nname: resident-skill\ndescription: outside tier\n---\n');
    fs.rmSync(path.join(f.root, tier), { recursive: true, force: true });
    fs.symlinkSync(real, path.join(f.root, tier), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const index = path.join(f.root, 'skills-index.json');
  const populated = JSON.stringify({ generated_at: 'x', count: 2, entries: [] });
  fs.writeFileSync(index, populated);
  const result = f.run('build-skills-index.cjs', []);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /INDEX_EMPTY_REJECTED/);
  assert.equal(fs.readFileSync(index, 'utf8'), populated);
  // 负对照：层级为普通目录并扫描到条目时照常发布。
  fs.rmSync(path.join(f.root, 'skills'), { recursive: true, force: true });
  fs.mkdirSync(path.join(f.root, 'skills', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: plain tier\n---\n');
  const rebuilt = f.run('build-skills-index.cjs', []);
  assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
  assert.equal(JSON.parse(fs.readFileSync(index, 'utf8')).count, 1);
}));

test('an invalid resident list stops before moving anything', () => fixture(f => {
  f.put('skills-resident.json', '{"schema":1,"skills":["../outside"]}');
  assert.equal(f.run('tier-skills.cjs', ['--apply']).status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/asset.bin')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library')), false);
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


test('tier migration rejects a linked destination parent before moving a skill', () => fixture(f => {
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'skills-library'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('tier-skills.cjs', ['--apply']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo/SKILL.md')), true);
  assert.deepEqual(fs.readdirSync(outside), []);
}));


for (const mode of ['tier', 'skill', 'entry-directory']) test('live skill collection skips unsafe ' + mode + ' before reading and preserves ordinary skills', () => fixture(f => {
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(path.join(outside, 'foreign'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: foreign\ndescription: external fixture\n---\n');
  fs.writeFileSync(path.join(outside, 'foreign/SKILL.md'), '---\nname: foreign\ndescription: external fixture\n---\n');
  if (mode === 'tier') fs.symlinkSync(outside, path.join(f.root, 'skills-library'), process.platform === 'win32' ? 'junction' : 'dir');
  else if (mode === 'skill') fs.symlinkSync(outside, path.join(f.root, 'skills/foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  else fs.mkdirSync(path.join(f.root, 'skills/foreign/SKILL.md'), { recursive: true });
  f.put('scripts/collect-probe.cjs', `const fs=require('node:fs'),path=require('node:path'),read=fs.readFileSync;const outside=${JSON.stringify(outside)};fs.readFileSync=function(file,...args){if(String(file).endsWith('SKILL.md')&&fs.realpathSync(file).startsWith(outside+path.sep))throw new Error('external description was read');return read.call(this,file,...args);};console.log(JSON.stringify(require('./build-skills-index.cjs').collectSkills()));`);
  const result = f.run('collect-probe.cjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const names = JSON.parse(result.stdout).map(item => item.name);
  assert.deepEqual(names, ['demo', 'skills-router']);
}));


for (const priorIndex of [false, true]) test('concurrent resident selection aborts promotion and restores owned paths: priorIndex=' + priorIndex, () => fixture(f => {
  assert.equal(f.run('tier-skills.cjs', ['--only', 'demo', '--apply']).status, 0);
  const resident = path.join(f.root, 'skills-resident.json');
  f.put('skills-resident.json', '{"schema":1,"skills":["old"]}');
  const index = path.join(f.root, 'skills-index.json');
  const indexBefore = priorIndex ? fs.readFileSync(index) : null;
  if (!priorIndex) fs.unlinkSync(index);
  const concurrent = '{"schema":1,"skills":["concurrent-selection","old"]}';
  const builder = fs.readFileSync(path.join(f.root, 'scripts/build-skills-index.cjs'), 'utf8');
  f.put('scripts/build-skills-index.cjs', builder + '\nrequire("node:fs").writeFileSync(' + JSON.stringify(resident) + ',' + JSON.stringify(concurrent) + ');\n');
  const result = f.run('tier-skills.cjs', ['--promote', 'demo', '--apply']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(resident, 'utf8'), concurrent);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo/SKILL.md')), true);
  if (priorIndex) assert.deepEqual(fs.readFileSync(index), indexBefore);
  else assert.equal(fs.existsSync(index), false);
}));


for (const editIndex of [false, true]) test('late resident conflict restores only the tier transaction index: concurrentIndex=' + editIndex, () => fixture(f => {
  assert.equal(f.run('tier-skills.cjs', ['--only', 'demo', '--apply']).status, 0);
  const resident = path.join(f.root, 'skills-resident.json'), index = path.join(f.root, 'skills-index.json');
  f.put('skills-resident.json', '{"schema":1,"skills":["old"]}');
  const indexBefore = fs.readFileSync(index);
  const concurrent = '{"schema":1,"skills":["concurrent-selection","old"]}';
  const concurrentIndex = '{"generated_at":"concurrent","count":0,"entries":[]}';
  const preload = path.join(f.base, 'late-resident.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),link=fs.linkSync;let fired=false;fs.linkSync=function(from,to){const r=link.call(this,from,to);if(!fired&&to===${JSON.stringify(index)}){fired=true;fs.writeFileSync(${JSON.stringify(resident)},${JSON.stringify(concurrent)});if(${editIndex})fs.writeFileSync(to,${JSON.stringify(concurrentIndex)});}return r;};`);
  f.env.NODE_OPTIONS = '--require ' + preload;
  const result = f.run('tier-skills.cjs', ['--promote', 'demo', '--apply']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(resident, 'utf8'), concurrent);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/demo')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'skills-library/demo/SKILL.md')), true);
  if (editIndex) assert.equal(fs.readFileSync(index, 'utf8'), concurrentIndex);
  else assert.deepEqual(fs.readFileSync(index), indexBefore);
}));
