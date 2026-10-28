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
  for (const name of ['pkg-catalog.cjs', 'client-root.js', 'pack-folder.js', 'pack-share-extras.cjs']) put('scripts/' + name, fs.readFileSync(path.join(source, 'scripts', name)));
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
  for (const bad of ['.qoder-work-queue.md', 'scripts/x.bak.1', 'scripts/credentials.json', 'scripts/x.pem', '.github/workflows/release.yml', 'scripts/../secret', 'scripts/./x.js', '/scripts/x.js', 'scripts\\x.js']) assert.equal(isPublicFile(bad), false, bad);
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
  fs.writeFileSync(path.join(dest, 'build.json'), JSON.stringify({ tag: 'v0.0.2', package: name, commit, sha256: digest }));
  let release = existing ? { tag_name: 'v0.0.2', draft, html_url: 'https://github.com/example/project/releases/tag/v0.0.2', assets: [{ name: name + '.zip' }, { name: name + '.zip.sha256' }] } : null;
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/commits/')) return { status: 0, stdout: wrongCommit ? 'b'.repeat(40) : commit };
    if (args[0] === 'api') {
      if (error) return { status: 1, stderr: 'gh: Forbidden (HTTP 403)' };
      if (args[1].includes('/releases?')) return { status: 0, stdout: JSON.stringify([release ? [release] : []]) };
      return release && !release.draft ? { status: 0, stdout: JSON.stringify(release) } : { status: 1, stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (args[1] === 'create') release = { tag_name: 'v0.0.2', draft: true, html_url: 'https://github.com/example/project/releases/tag/v0.0.2', assets: [] };
    if (args[1] === 'upload') release.assets.push({ name: path.basename(args[3]) });
    if (args[1] === 'download') {
      const asset = args[args.indexOf('--pattern') + 1];
      const target = path.join(args[args.indexOf('--dir') + 1], asset);
      fs.copyFileSync(path.join(dest, asset), target);
      if (mismatch) fs.appendFileSync(target, 'different remote content');
    }
    if (args[1] === 'edit') release.draft = false;
    return { status: 0, stdout: '' };
  };
  return { dest, gh, calls };
}

test('same-name assets are downloaded and compared, never blindly skipped', () => withFixture(f => {
  const p = publicationFixture(f);
  const result = publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(result.assets.length, 2);
  assert.equal(p.calls.filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.some(args => ['upload', 'create', 'edit'].includes(args[1])), false);
}));

test('existing draft hidden from the tag endpoint is verified without duplication', () => withFixture(f => {
  const p = publicationFixture(f, { draft: true });
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p });
  assert.equal(p.calls.some(args => args[1] === 'create' || args[1] === 'upload'), false);
  assert.equal(p.calls.filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.filter(args => args[1] === 'edit').length, 1);
}));

test('different same-name content stops without replacing any asset', () => withFixture(f => {
  const p = publicationFixture(f, { mismatch: true });
  assert.throws(() => publishRelease({ repo: 'example/project', tag: 'v0.0.2', ...p }), /content mismatch/);
  assert.equal(p.calls.some(args => ['upload', 'create', 'edit'].includes(args[1])), false);
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
  const editAt = p.calls.findIndex(args => args[1] === 'edit');
  assert.equal(p.calls.slice(0, editAt).filter(args => args[1] === 'download').length, 2);
  assert.equal(p.calls.some(args => args.includes('--clobber')), false);
}));

test('release notes come from the CHANGELOG section when present', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  const root = path.join(f.base, 'notes-root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), ['# Changelog', '', '## [0.0.2] - 2026-10-28', '', '### Added', '- fixture note line', '', '## [0.0.1] - 2026-10-27', '', '- older line', ''].join(String.fromCharCode(10)));
  const original = p.gh;
  let captured = null;
  p.gh = args => { if (args[1] === 'create') { const i = args.indexOf('--notes-file'); if (i > 0) captured = fs.readFileSync(args[i + 1], 'utf8'); } return original(args); };
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', root, ...p });
  const create = p.calls.find(args => args[1] === 'create');
  assert.ok(create);
  assert.equal(create.includes('--generate-notes'), false);
  assert.ok(captured && captured.includes('fixture note line'));
  assert.equal(captured.includes('older line'), false);
}));

test('release notes fall back to generated notes without a CHANGELOG section', () => withFixture(f => {
  const p = publicationFixture(f, { existing: false });
  const root = path.join(f.base, 'no-notes-root');
  fs.mkdirSync(root);
  publishRelease({ repo: 'example/project', tag: 'v0.0.2', root, ...p });
  const create = p.calls.find(args => args[1] === 'create');
  assert.ok(create.includes('--generate-notes'));
  assert.equal(create.includes('--notes-file'), false);
}));
