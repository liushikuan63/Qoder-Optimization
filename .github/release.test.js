'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { metadataFor, isPublicFile, PUBLIC_PATHS } = require('../scripts/pack-share-extras.cjs');
const { checkRelease, walk } = require('./check-release.js');
const { buildRelease, verifyZip, windowsLineEndings, sha256 } = require('./build-release.js');
const { publishRelease } = require('./publish-release.js');
const source = path.resolve(__dirname, '..');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const put = (file, data) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  for (const name of ['skills/demo', 'scripts', 'commands', 'agents', 'hooks', 'mcp', 'plugins']) fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const file of PUBLIC_PATHS.filter(name => name.includes('.') && !['catalog.json', 'skills-manifest.json'].includes(name))) put(file, 'fixture\n');
  put('LICENSE', 'Fixture license\n');
  put('.gitattributes', fs.readFileSync(path.join(source, '.gitattributes')));
  put('VERSION', 'v0.0.2\n2026-10-28\n');
  put('skills/demo/SKILL.md', '---\nname: demo\ndescription: 离线报表 export report\n---\n\n# Demo\n');
  put('skills/demo/LICENSE', 'Fixture license retained\n');
  for (const name of ['pkg-catalog.cjs', 'client-root.js', 'package-dependencies.cjs', 'archive-entries.cjs', 'import-memory.cjs', 'pack-folder.js', 'pack-share-extras.cjs']) put('scripts/' + name, fs.readFileSync(path.join(source, 'scripts', name)));
  put('qoder-memory-export-generic.tar.gz', require('zlib').gzipSync(require('../scripts/archive-entries.cjs').encodeTar([{ name: 'MEMORY.md', data: Buffer.from('fixture memory') }])));
  put('scripts/demo.cmd', Buffer.from([64, 101, 99, 104, 111, 32, 0x81, 0x40, 10]));
  put('commands/demo.md', '# Command\n');
  put('agents/demo.md', '# Agent\n');
  put('catalog.json', JSON.stringify({ schema: 1, package: { name: 'Qoder-Optimization', version: '0.0.2' }, entries: [] }));
  put('skills-manifest.json', JSON.stringify({ package_name: 'Qoder-Optimization', version: '0.0.2', skills: [] }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMP: base, TEMP: base, TMPDIR: base };
  for (const key of Object.keys(env)) if (/^(QODER_|GH_|GITHUB_|SMOKE_|AUTH_LOCK_|RISKY_MATCH_|ATTEMPT_LOCK_)/.test(key)) delete env[key];
  const exec = (file, args, cwd = root, extra = {}) => spawnSync(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const refresh = () => {
    const data = metadataFor(root);
    for (const [file, content] of Object.entries(data.files)) put(file, content);
    const rows = Object.entries({ Skills: data.catalog.counts.skill, 技能: data.catalog.counts.skill, Scripts: data.catalog.counts.script, 脚本: data.catalog.counts.script, Commands: data.catalog.counts.command, 命令: data.catalog.counts.command, 'Sub-agents': data.catalog.counts.agent, 子智能体: data.catalog.counts.agent, 'Catalog entries': data.catalog.entries.length, 目录条目: data.catalog.entries.length }).map(([key, value]) => `| ${key} | ${value} | fixture |`);
    const link = 'https://github.com/example/Qoder-Optimization/releases/download/v0.0.2/Qoder-Optimization-0.0.2.zip';
    const skillEntries = data.catalog.entries.filter(entry => entry.category === 'skill');
    const coreEntries = skillEntries.filter(entry => entry.tier === 'core');
    const coreChars = coreEntries.reduce((sum, entry) => sum + entry.description.length, 0);
    const totalChars = skillEntries.reduce((sum, entry) => sum + entry.description.length, 0);
    put('SKILLS-清单.md', skillEntries.map(entry => '- `' + entry.name + '`（' + (entry.tier === 'core' ? '常驻' : '按需') + '）').join('\n'));
    put('README.md', ['# English / 简体中文', 'version-0.0.2-blue', `| 0.0.2 | 2026-10-28 | English | [zip](${link}) |`, `| 0.0.2 | 2026-10-28 | 中文 | [zip](${link}) |`, ...rows,
      `${coreEntries.length} core skill descriptions total ${coreChars} characters; all ${skillEntries.length} skill descriptions total ${totalChars} characters`,
      `${coreEntries.length} 个常驻技能的描述共 ${coreChars} 字符；${skillEntries.length} 个技能的描述共 ${totalChars} 字符`, ''].join('\n'));
    for (const [file, content] of Object.entries(metadataFor(root).files)) put(file, content);
    return data;
  };
  refresh();
  return { base, root, home, put, exec, refresh, close: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function withFixture(body) {
  const f = fixture();
  try { return body(f); } finally { f.close(); }
}

function commitFixture(f, extraFiles = []) {
  fs.mkdirSync(path.join(f.root, '.github'));
  f.put('.github/fixture.yml', 'not shipped\n');
  for (const args of [['init', '-q'], ['add', '--', ...walk(f.root), '.github/fixture.yml', ...extraFiles], ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Release fixture']]) {
    const result = f.exec('git', args);
    assert.equal(result.status, 0, result.stderr);
  }
}

test('generator is dry-run by default, ignores private HOME, preserves third-party data', () => withFixture(f => {
  fs.mkdirSync(path.join(f.home, '.qoder', 'skills', 'private'), { recursive: true });
  const privateFile = path.join(f.home, '.qoder', 'skills', 'private', 'SKILL.md');
  fs.writeFileSync(privateFile, 'private fixture must remain local');
  const before = Object.fromEntries(walk(f.root).map(file => [file, sha256(path.join(f.root, file))]));
  let result = f.exec(process.execPath, [path.join(source, 'scripts/pack-share-extras.cjs'), f.root, '--version', '0.0.3']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.fromEntries(walk(f.root).map(file => [file, sha256(path.join(f.root, file))])), before);
  result = f.exec(process.execPath, [path.join(source, 'scripts/pack-share-extras.cjs'), f.root, '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'private fixture must remain local');
  assert.equal(fs.existsSync(path.join(f.root, 'skills/private')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'skills/demo/LICENSE'), 'utf8'), 'Fixture license retained\n');
  const generated = JSON.parse(fs.readFileSync(path.join(f.root, 'catalog.json')));
  assert.equal(generated.entries.find(entry => entry.id === 'skill:demo').tier, 'library');
  assert.equal(generated.entries.find(entry => entry.id === 'skill:demo').install.tier, 'library');
}));

test('generated package can register, search and install through its own consumer', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  for (const args of [['register', f.root], ['search', '离线 报表'], ['install', 'skill:demo'], ['install', 'skill:demo', '--apply'], ['install', 'script:demo.cmd', '--apply']]) {
    const result = f.exec(process.execPath, [cli, ...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (args.length === 2 && args[0] === 'install') assert.equal(fs.existsSync(path.join(f.home, '.qoder/skills-library/demo')), false);
  }
  assert.equal(sha256(path.join(f.home, '.qoder/skills-library/demo/SKILL.md')), sha256(path.join(f.root, 'skills/demo/SKILL.md')));
  assert.equal(sha256(path.join(f.home, '.qoder/scripts/demo.cmd')), sha256(path.join(f.root, 'scripts/demo.cmd')));
  assert.equal(f.exec(process.execPath, [cli, 'search', '离线 absentword']).status, 3);
}));

test('cross-tier install refuses before changing existing routes', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'install', 'skill:demo', '--apply']).status, 0);
  const result = f.exec(process.execPath, [cli, 'install', 'skill:demo', '--tier', 'core', '--apply']);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/skills/demo')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/skills-library/demo/SKILL.md')), true);
}));

test('script installation previews and installs the complete local dependency closure', () => withFixture(f => {
  f.put('scripts/helper.js', 'module.exports = 42;');
  f.put('scripts/worker.js', "console.log(require('./helper.js'));");
  f.refresh();
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  const preview = f.exec(process.execPath, [cli, 'install', 'script:worker.js']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes('script:helper.js'));
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/scripts')), false);
  const install = f.exec(process.execPath, [cli, 'install', 'script:worker.js', '--apply']);
  assert.equal(install.status, 0, install.stderr);
  const run = f.exec(process.execPath, [path.join(f.home, '.qoder/scripts/worker.js')]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
}));

test('script directory dependencies retain their locked runtime without copying installed modules', () => withFixture(f => {
  f.put('scripts/runtime/package.json', JSON.stringify({ name: 'fixture-runtime', main: 'index.cjs', dependencies: {} }));
  f.put('scripts/runtime/package-lock.json', JSON.stringify({ name: 'fixture-runtime', lockfileVersion: 3, packages: {} }));
  f.put('scripts/runtime/index.cjs', 'module.exports = 42;');
  f.put('scripts/runtime/node_modules/private-cache.js', 'not a distribution file');
  f.put('scripts/worker.cjs', "console.log(require('./runtime'));");
  const catalog = f.refresh().catalog;
  const runtime = catalog.entries.find(e => e.id === 'script:runtime');
  assert.equal(runtime.source, 'scripts/runtime');
  assert.equal(runtime.install.mode, 'copy-directory');
  assert.deepEqual(catalog.entries.find(e => e.id === 'script:worker.cjs').dependencies, ['script:runtime']);
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  const preview = f.exec(process.execPath, [cli, 'install', 'script:worker.cjs']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /script:runtime/);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder')), false);
  const install = f.exec(process.execPath, [cli, 'install', 'script:worker.cjs', '--apply']);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /npm ci --ignore-scripts --prefix/);
  for (const file of ['package.json', 'package-lock.json', 'index.cjs']) {
    assert.equal(sha256(path.join(f.home, '.qoder/scripts/runtime', file)), sha256(path.join(f.root, 'scripts/runtime', file)));
  }
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/scripts/runtime/node_modules')), false);
  const run = f.exec(process.execPath, [path.join(f.home, '.qoder/scripts/worker.cjs')]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
}));

test('script directories without locked manifests are rejected', () => withFixture(f => {
  f.put('scripts/runtime/index.cjs', 'module.exports = 42;');
  assert.throws(() => f.refresh(), /package\.json|package-lock\.json/);
}));

test('script dependencies follow Node file-before-directory resolution', () => withFixture(f => {
  f.put('scripts/runtime/package.json', JSON.stringify({ name: 'fixture-runtime', main: 'index.cjs' }));
  f.put('scripts/runtime/package-lock.json', '{}');
  f.put('scripts/runtime/index.cjs', 'module.exports = 2;');
  f.put('scripts/runtime.js', 'module.exports = 1;');
  f.put('scripts/worker.cjs', "console.log(require('./runtime'));");
  const catalog = f.refresh().catalog;
  assert.deepEqual(catalog.entries.find(entry => entry.id === 'script:worker.cjs').dependencies, ['script:runtime.js']);
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'install', 'script:worker.cjs', '--apply']).status, 0);
  const installed = f.exec(process.execPath, [path.join(f.home, '.qoder/scripts/worker.cjs')]);
  const original = f.exec(process.execPath, [path.join(f.root, 'scripts/worker.cjs')]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(original.status, 0, original.stderr);
  assert.equal(installed.stdout.trim(), '1');
  assert.equal(installed.stdout, original.stdout);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/scripts/runtime')), false);
}));

test('an incomplete installed script runtime blocks dependent files before writes', () => withFixture(f => {
  f.put('scripts/runtime/package.json', JSON.stringify({ name: 'fixture-runtime', main: 'index.cjs' }));
  f.put('scripts/runtime/package-lock.json', '{}');
  f.put('scripts/runtime/index.cjs', 'module.exports = 42;');
  f.put('scripts/worker.cjs', "console.log(require('./runtime'));");
  f.refresh();
  const target = path.join(f.home, '.qoder/scripts/runtime');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), 'existing incomplete runtime');
  const result = f.exec(process.execPath, [path.join(f.root, 'scripts/pkg-catalog.cjs'), 'install', 'script:worker.cjs', '--apply']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/scripts/worker.cjs')), false);
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), 'existing incomplete runtime');
}));

test('installed script runtimes can be reused without traversing npm module links', () => withFixture(f => {
  f.put('scripts/runtime/package.json', JSON.stringify({ name: 'fixture-runtime', main: 'index.cjs' }));
  f.put('scripts/runtime/package-lock.json', '{}');
  f.put('scripts/runtime/index.cjs', 'module.exports = 42;');
  f.put('scripts/worker.cjs', "console.log(require('./runtime'));");
  f.refresh();
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'install', 'script:runtime', '--apply']).status, 0);
  const target = path.join(f.home, '.qoder/scripts/runtime');
  const modules = path.join(target, 'node_modules');
  fs.mkdirSync(path.join(modules, 'dependency'), { recursive: true });
  fs.symlinkSync(path.join(modules, 'dependency'), path.join(modules, 'linked-dependency'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.exec(process.execPath, [cli, 'install', 'script:worker.cjs', '--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.lstatSync(path.join(modules, 'linked-dependency')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(target, 'index.cjs'), 'utf8'), 'module.exports = 42;');
  f.put('scripts/other-worker.cjs', "console.log(require('./runtime'));");
  f.refresh();
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(target, 'linked-source'), process.platform === 'win32' ? 'junction' : 'dir');
  const rejected = f.exec(process.execPath, [cli, 'install', 'script:other-worker.cjs', '--apply']);
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder/scripts/other-worker.cjs')), false);
  assert.deepEqual(fs.readdirSync(outside), []);
}));

test('missing dependency metadata blocks all writes', () => withFixture(f => {
  f.put('scripts/helper.js', 'module.exports = 42;');
  f.put('scripts/worker.js', "require('./helper.js');");
  const data = f.refresh().catalog;
  data.entries = data.entries.filter(e => e.id !== 'script:helper.js');
  f.put('catalog.json', JSON.stringify(data));
  const result = f.exec(process.execPath, [path.join(f.root, 'scripts/pkg-catalog.cjs'), 'install', 'script:worker.js', '--apply']);
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder')), false);
}));

test('failed forced installation restores the previous skill and index', () => withFixture(f => {
  const target = path.join(f.home, '.qoder/skills-library/demo');
  const scripts = path.join(f.home, '.qoder/scripts');
  fs.mkdirSync(target, { recursive: true }); fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'previous content');
  const index = path.join(f.home, '.qoder/skills-index.json');
  fs.writeFileSync(index, 'previous index');
  fs.writeFileSync(path.join(scripts, 'build-skills-index.cjs'), 'process.exit(7);');
  const result = f.exec(process.execPath, [path.join(f.root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:demo', '--force', '--apply']);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'previous content');
  assert.equal(fs.readFileSync(index, 'utf8'), 'previous index');
}));

test('rollback preserves a destination created concurrently after preflight', () => withFixture(f => {
  const target = path.join(f.home, '.qoder/skills-library/demo');
  const preload = path.join(f.base, 'race.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),path=require('path');const copy=fs.cpSync;let fired=false;fs.cpSync=function(a,b,o){const r=copy(a,b,o);if(!fired&&path.basename(b)==='new-0'){fired=true;fs.mkdirSync(${JSON.stringify(target)},{recursive:true});fs.writeFileSync(path.join(${JSON.stringify(target)},'SKILL.md'),'parallel content');fs.writeFileSync(${JSON.stringify(path.join(f.home, '.qoder/skills-index.json'))},'parallel index');}return r;};`);
  const result = f.exec(process.execPath, ['--require', preload, path.join(f.root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:demo', '--apply']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'parallel content');
  assert.equal(fs.readFileSync(path.join(f.home, '.qoder/skills-index.json'), 'utf8'), 'parallel index');
}));

test('a forced install refuses a target changed after preflight', () => withFixture(f => {
  const target = path.join(f.home, '.qoder/skills-library/demo'); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'original');
  const preload = path.join(f.base, 'race.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),path=require('path');const copy=fs.cpSync;let fired=false;fs.cpSync=function(a,b,o){const r=copy(a,b,o);if(!fired&&path.basename(b)==='new-0'){fired=true;fs.writeFileSync(path.join(${JSON.stringify(target)},'SKILL.md'),'parallel edit');}return r;};`);
  const result = f.exec(process.execPath, ['--require', preload, path.join(f.root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:demo', '--force', '--apply']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'parallel edit');
}));

test('child-process script dependencies are included in the install graph', () => {
  const deps = require('../scripts/package-dependencies.cjs').dependenciesFor(source, { id: 'script:stop-gate.js', category: 'script', name: 'stop-gate.js', source: 'scripts/stop-gate.js' });
  assert.ok(deps.includes('script:work-queue-check.js'));
});

test('legacy schema is readable; unknown schema cannot replace a good registration', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'register', f.root]).status, 0);
  const pointer = path.join(f.home, '.qoder/share-package.json');
  const before = fs.readFileSync(pointer, 'utf8');
  const catalog = JSON.parse(fs.readFileSync(path.join(f.root, 'catalog.json')));
  catalog.schema = 'qoder-share-catalog/1';
  f.put('catalog.json', JSON.stringify(catalog));
  assert.equal(f.exec(process.execPath, [cli, 'search', '报表']).status, 0);
  catalog.schema = 'qoder-share-catalog/99';
  f.put('catalog.json', JSON.stringify(catalog));
  assert.equal(f.exec(process.execPath, [cli, 'register', f.root]).status, 2);
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
}));

test('existing but unreadable registered catalog reports an error without rewriting the pointer', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'register', f.root]).status, 0);
  const pointer = path.join(f.home, '.qoder/share-package.json');
  const before = fs.readFileSync(pointer, 'utf8');
  f.put('catalog.json', '{invalid');
  assert.equal(f.exec(process.execPath, [cli, 'search', '报表']).status, 2);
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
}));

test('missing pointer target is distinguishable from no search match', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  assert.equal(f.exec(process.execPath, [cli, 'register', f.root]).status, 0);
  fs.renameSync(path.join(f.root, 'catalog.json'), path.join(f.root, 'moved.json'));
  assert.equal(f.exec(process.execPath, [cli, 'search', '报表']).status, 2);
}));

test('invalid install contract and path traversal are rejected without writes', () => withFixture(f => {
  const cli = path.join(f.root, 'scripts/pkg-catalog.cjs');
  for (const patch of [{ install: 'cp something', source: 'self-built' }, { source: '../private' }, { name: '../../escape', source: 'skills/demo' }]) {
    const catalog = f.refresh().catalog;
    Object.assign(catalog.entries.find(e => e.id === 'skill:demo'), patch);
    f.put('catalog.json', JSON.stringify(catalog));
    assert.equal(f.exec(process.execPath, [cli, 'install', 'skill:demo', '--apply', '--catalog', path.join(f.root, 'catalog.json')]).status, 2);
    assert.equal(fs.existsSync(path.join(f.home, '.qoder/skills-library')), false);
  }
}));

test('clean release gate passes', () => withFixture(f => {
  assert.deepEqual(checkRelease(f.root, 'v0.0.2').problems, []);
}));

for (const [label, mutate, expected] of [
  ['catalog version', f => { const c = f.refresh().catalog; c.package.version = '0.0.1'; f.put('catalog.json', JSON.stringify(c)); }, 'catalog.package.version'],
  ['manifest version', f => { const m = f.refresh().manifest; m.version = '0.0.1'; f.put('skills-manifest.json', JSON.stringify(m)); }, 'manifest.version'],
  ['manifest file count', f => { const m = f.refresh().manifest; m.skills[0].files++; f.put('skills-manifest.json', JSON.stringify(m)); }, 'manifest skill'],
  ['catalog count', f => { const c = f.refresh().catalog; c.counts.script++; f.put('catalog.json', JSON.stringify(c)); }, 'catalog count'],
  ['install source', f => { const c = f.refresh().catalog; c.entries[0].source = 'self-built'; f.put('catalog.json', JSON.stringify(c)); }, 'install/source'],
  ['duplicate entry', f => { const c = f.refresh().catalog; c.entries.push(c.entries[0]); f.put('catalog.json', JSON.stringify(c)); }, 'duplicate'],
  ['missing required file', f => fs.unlinkSync(path.join(f.root, 'LICENSE')), 'missing: LICENSE'],
  ['empty file', f => f.put('LICENSE', ''), 'empty file'],
  ['README language drift', f => f.put('README.md', fs.readFileSync(path.join(f.root, 'README.md'), 'utf8').replace('| 技能 | 1 |', '| 技能 | 9 |')), 'README count'],
  ['README tier drift', f => f.put('README.md', fs.readFileSync(path.join(f.root, 'README.md'), 'utf8').replace('0 core skill descriptions', '9 core skill descriptions')), 'tier statistics'],
  ['skill-list tier drift', f => f.put('SKILLS-清单.md', '- `demo`（常驻）'), 'skill-list tier'],
  ['INDEX version drift', f => f.put('INDEX.md', 'old index\n'), 'INDEX.md'],
  ['backup leakage', f => f.put('scripts/demo.cmd.bak.1', 'backup'), 'unexpected release'],
  ['queue leakage', f => f.put('.qoder-work-queue.md', 'local queue'), 'unexpected release'],
  ['secret-like file', f => f.put('scripts/client.key', 'fake fixture'), 'unexpected release'],
]) test('gate rejects ' + label, () => withFixture(f => {
  mutate(f);
  assert.ok(checkRelease(f.root, 'v0.0.2').problems.some(problem => problem.includes(expected)));
}));

test('public source policy permits licenses and rejects private or traversing paths', () => {
  for (const good of ['LICENSE', 'mcp/offline/LICENSE-cua-driver.txt', 'scripts/backup-file.js', 'skills/demo/SKILL.md']) assert.equal(isPublicFile(good), true, good);
  for (const bad of ['docs/private-design.md', '.qoder-work-queue.md', 'scripts/x.bak.1', 'scripts/credentials.json', 'scripts/x.pem', '.github/workflows/release.yml', 'scripts/../secret', 'scripts/./x.js', '/scripts/x.js', 'scripts\\x.js']) assert.equal(isPublicFile(bad), false, bad);
});

test('local design documents are ignored without ignoring source scripts', () => {
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', 'docs/private-design.md'], { cwd: source, encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(ignored.stdout.trim(), 'docs/private-design.md');
  const sourceFile = spawnSync('git', ['check-ignore', '--no-index', '--', 'scripts/convention-core.cjs'], { cwd: source, encoding: 'utf8' });
  assert.equal(sourceFile.status, 1, sourceFile.stderr);
  const router = fs.readFileSync(path.join(source, 'skills/skills-router/SKILL.md'), 'utf8');
  assert.equal(router.includes('../../docs/'), false);
  const cases = JSON.parse(fs.readFileSync(path.join(source, 'skills/verify-before-claim/references/adaptive-verification.cases.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(source, 'skills/verify-before-claim/references', cases.basis)));
});

test('Windows line-ending conversion preserves GBK bytes', () => {
  assert.deepEqual(windowsLineEndings(Buffer.from([0x81, 0x40, 10, 13, 10])), Buffer.from([0x81, 0x40, 13, 10, 13, 10]));
});

test('build uses only committed files and verifies the complete ZIP with a stable digest', () => withFixture(f => {
  commitFixture(f);
  f.put('.qoder-work-queue.md', 'must not ship');
  f.put('scripts/untracked.js', 'must not ship');
  f.put('README.md', 'uncommitted text must not ship');
  const first = buildRelease({ root: f.root, tag: 'v0.0.2', ref: 'HEAD', dest: path.join(f.base, 'dist1') });
  const second = buildRelease({ root: f.root, tag: 'v0.0.2', ref: 'HEAD', dest: path.join(f.base, 'dist2') });
  assert.equal(first.sha256, second.sha256);
  assert.equal(Object.hasOwn(first.files, '.qoder-work-queue.md'), false);
  assert.equal(Object.hasOwn(first.files, 'scripts/untracked.js'), false);
  assert.equal(Object.keys(first.files).some(file => file.startsWith('.github/')), false);
  assert.equal(fs.readFileSync(path.join(f.base, 'dist1', first.package, 'README.md'), 'utf8').includes('English'), true);
  assert.deepEqual(fs.readFileSync(path.join(f.base, 'dist1', first.package, 'scripts/demo.cmd')), windowsLineEndings(fs.readFileSync(path.join(f.root, 'scripts/demo.cmd'))));
  assert.throws(() => verifyZip(path.join(f.base, 'dist1', first.package + '.zip'), 'Qoder-Optimization-0.0.1', Object.keys(first.files)), /unexpected ZIP/);
  assert.throws(() => buildRelease({ root: f.root, tag: 'v0.0.2', ref: 'HEAD', dest: path.join(f.base, 'dist1') }), /already exists/);
}));

test('memory archive gate ignores the platform gzip header but not content', () => withFixture(f => {
  const archive = path.join(f.root, 'qoder-memory-export-generic.tar.gz');
  const original = fs.readFileSync(archive);
  const unix = Buffer.from(original); unix[9] = 3;
  f.put('qoder-memory-export-generic.tar.gz', unix);
  assert.deepEqual(checkRelease(f.root, 'v0.0.2').problems, []);
  const { archiveEntries, encodeTar } = require('../scripts/archive-entries.cjs');
  const members = archiveEntries(archive, unix).map(e => ({ name: e.name, data: e.name === 'MEMORY.md' ? Buffer.from('tampered') : e.data }));
  f.put('qoder-memory-export-generic.tar.gz', require('zlib').gzipSync(encodeTar(members)));
  assert.ok(checkRelease(f.root, 'v0.0.2').problems.some(p => p.includes('memory archive tools drift')));
}));

test('offline components are optional archives without omission or overlap', () => withFixture(f => {
  f.put('mcp/offline/LICENSE-cua-driver.txt', 'fixture license');
  f.put('mcp/offline/tool.bin', Buffer.from([0, 1, 2, 3]));
  f.refresh();
  commitFixture(f);
  const dest = path.join(f.base, 'split');
  const evidence = buildRelease({ root: f.root, tag: 'v0.0.2', ref: 'HEAD', dest });
  assert.equal(evidence.artifacts.length, 2);
  assert.ok(evidence.artifacts[0].files.every(file => !file.startsWith('mcp/offline/')));
  assert.ok(evidence.artifacts[1].files.every(file => file.startsWith('mcp/offline/')));
  const result = require('./verify-delivery.js').verifyDelivery(evidence, dest);
  assert.equal(result.files, Object.keys(evidence.files).length);
  assert.equal(result.verified, true);
}));

test('a tracked private file blocks the build rather than being silently exported', () => withFixture(f => {
  f.put('scripts/credentials.json', '{"fixture":true}\n');
  commitFixture(f);
  assert.throws(() => buildRelease({ root: f.root, tag: 'v0.0.2', ref: 'HEAD', dest: path.join(f.base, 'dist') }), /unapproved tracked file/);
  assert.equal(fs.existsSync(path.join(f.base, 'dist/Qoder-Optimization-0.0.2.zip')), false);
}));

function publicationFixture(f, { existing = true, mismatch = false, error = false, wrongCommit = false, draft = false } = {}) {
  const dest = path.join(f.base, 'publish');
  fs.mkdirSync(dest);
  const name = 'Qoder-Optimization-0.0.2';
  fs.writeFileSync(path.join(dest, name + '.zip'), 'archive fixture');
  const digest = sha256(path.join(dest, name + '.zip'));
  fs.writeFileSync(path.join(dest, name + '.zip.sha256'), `${digest}  ${name}.zip\n`);
  const commit = 'a'.repeat(40);
  fs.writeFileSync(path.join(dest, 'build.json'), JSON.stringify({ tag: 'v0.0.2', package: name, commit, sha256: digest, artifacts: [{ name: name + '.zip', sha256: digest }] }));
  let release = existing ? { id: 900, tag_name: 'v0.0.2', draft, html_url: 'https://github.com/example/project/releases/tag/v0.0.2', assets: [{ name: name + '.zip' }, { name: name + '.zip.sha256' }] } : null;
  let visibleInList = existing;
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/commits/')) return { status: 0, stdout: wrongCommit ? 'b'.repeat(40) : commit };
    if (args[0] === 'api') {
      if (error) return { status: 1, stderr: 'gh: Forbidden (HTTP 403)' };
      const method = args.includes('POST') ? 'POST' : args.includes('PATCH') ? 'PATCH' : 'GET';
      const endpoint = args.find(arg => arg.startsWith('repos/')) || args[1];
      if (method === 'POST') {
        release = { id: 901, tag_name: 'v0.0.2', draft: true, html_url: 'https://github.com/example/project/releases/tag/v0.0.2', assets: [] };
        visibleInList = false;
        return { status: 0, stdout: JSON.stringify(release) };
      }
      if (/\/releases\/\d+$/.test(endpoint)) {
        if (method === 'PATCH') release.draft = false;
        return { status: 0, stdout: JSON.stringify(release) };
      }
      if (endpoint.includes('/releases?')) return { status: 0, stdout: JSON.stringify(visibleInList && release ? [[release]] : [[]]) };
      return release && !release.draft ? { status: 0, stdout: JSON.stringify(release) } : { status: 1, stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (args[1] === 'upload') release.assets.push({ name: path.basename(args[3]) });
    if (args[1] === 'download') {
      const asset = args[args.indexOf('--pattern') + 1];
      const target = path.join(args[args.indexOf('--dir') + 1], asset);
      fs.copyFileSync(path.join(dest, asset), target);
      if (mismatch) fs.appendFileSync(target, 'different remote content');
    }
    return { status: 0, stdout: '' };
  };
  return { dest, gh, calls };
}

test('same-name assets are downloaded and compared, never blindly skipped', () => withFixture(f => {
  const p = publicationFixture(f);
  const result = publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(result.assets.length, 2);
  assert.equal(p.calls.filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.some(a => a[1] === 'upload' || a.includes('POST') || a.includes('PATCH')), false);
}));

test('existing draft hidden from the tag endpoint is verified without duplication', () => withFixture(f => {
  const p = publicationFixture(f, { draft: true });
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(p.calls.some(a => a.includes('POST') || a[1] === 'upload'), false);
  assert.equal(p.calls.filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.filter(a => a.includes('PATCH')).length, 1);
}));

test('different same-name content stops without replacing any asset', () => withFixture(f => {
  const p = publicationFixture(f, { mismatch: true });
  assert.throws(() => publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p }), /content mismatch/);
  assert.equal(p.calls.some(a => a[1] === 'upload' || a.includes('POST') || a.includes('PATCH')), false);
}));

test('authentication failures are not treated as a missing release', () => withFixture(f => {
  const p = publicationFixture(f, { error: true });
  assert.throws(() => publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p }), /gh failed/);
  assert.equal(p.calls.some(args => args[0] === 'release'), false);
}));

test('remote tag mismatch stops before release operations', () => withFixture(f => {
  const p = publicationFixture(f, { wrongCommit: true });
  assert.throws(() => publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p }), /remote tag/);
  assert.equal(p.calls.length, 1);
}));

test('new releases stay draft until both uploaded assets pass download verification', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(p.calls.filter(args => args[1] === 'upload').length, 2);
  const editAt = p.calls.findIndex(a => a.includes('PATCH'));
  assert.equal(p.calls.slice(0, editAt).filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.some(args => args.includes('--clobber')), false);
}));

test('split releases verify all four assets before leaving draft', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  const manifestFile = path.join(p.dest, 'build.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  const name = manifest.package + '-offline.zip';
  fs.writeFileSync(path.join(p.dest, name), 'offline fixture');
  const digest = sha256(path.join(p.dest, name));
  fs.writeFileSync(path.join(p.dest, name + '.sha256'), digest + '  ' + name + '\n');
  manifest.artifacts.push({ name, sha256: digest });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const result = publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(result.assets.length, 4);
  assert.equal(p.calls.filter(args => args[1] === 'download').length, 4);
  const publishedAt = p.calls.findIndex(a => a.includes('PATCH'));
  assert.equal(p.calls.slice(0, publishedAt).filter(args => args[1] === 'download').length, 4);
}));

test('release notes come from the CHANGELOG section when present', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  const root = path.join(f.base, 'notes-root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), ['# Changelog', '', '## [0.0.2] - 2026-10-28', '', '### Added', '- fixture note line', '', '## [0.0.1] - 2026-10-27', '', '- older line', ''].join(String.fromCharCode(10)));
  const original = p.gh;
  let captured = null;
  p.gh = args => { const at = args.findIndex(a => /^body=@/.test(a)); if (at >= 0) captured = fs.readFileSync(args[at].slice(6), 'utf8'); return original(args); };
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', root, ...p });
  const create = p.calls.find(a => a.includes('POST'));
  assert.ok(create);
  assert.equal(create.includes('generate_release_notes=true'), false);
  assert.ok(captured && captured.includes('fixture note line'));
  assert.equal(captured.includes('older line'), false);
}));

test('release notes fall back to generated notes without a CHANGELOG section', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  const root = path.join(f.base, 'no-notes-root');
  fs.mkdirSync(root);
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', root, ...p });
  const create = p.calls.find(a => a.includes('POST'));
  assert.ok(create.includes('generate_release_notes=true'));
  assert.equal(create.some(a => /^body=@/.test(a)), false);
}));
