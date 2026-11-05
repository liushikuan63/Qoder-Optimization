'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const roots = require('../scripts/capability-roots.cjs');
const installer = require('../scripts/install-package.cjs');
const { collectSkills } = require('../scripts/build-skills-index.cjs');
const { localPresence } = require('../scripts/pkg-catalog.cjs');
function fixture(t, cross = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-bound-library-'));
  let client = path.join(base, 'client');
  if (cross) {
    const other = process.platform === 'win32' ? path.join(os.userInfo().homedir, 'AppData/Local/Temp') : '/dev/shm';
    if (!fs.existsSync(other) || fs.statSync(other).dev === fs.statSync(base).dev) { t.skip('a second writable volume is unavailable'); return null; }
    client = fs.mkdtempSync(path.join(other, 'qo-bound-client-'));
  }
  fs.mkdirSync(client, { recursive: true });
  const library = path.join(base, 'library'); fs.mkdirSync(library);
  const link = path.join(client, 'skills-library'); fs.symlinkSync(library, link, process.platform === 'win32' ? 'junction' : 'dir');
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const skill = (tier, name, text = 'owned fixture') => put(path.join(tier === 'core' ? path.join(client, 'skills') : library, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + text + '\n---\n' + text + '\n');
  const bind = () => { const value = roots.bindLibrary(client, library); put(path.join(client, roots.FILE), JSON.stringify(value)); return value; };
  const install = (options = {}) => installer.apply(installer.prepare({ client, profile: 'routing', catalogFile: path.join(root, 'catalog.json'), ...options }), { yes: true });
  t.after(() => { if (!client.startsWith(base + path.sep)) { assert.match(path.basename(client), /^qo-bound-client-/); fs.rmSync(client, { recursive: true, force: true }); } assert.match(path.basename(base), /^qo-bound-library-/); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, client, library, link, put, skill, bind, install };
}
test('unbound tiers are unreadable and explicit binding authorizes only that ordinary subtree', t => {
  const f = fixture(t); f.skill('library', 'demo'); f.skill('core', 'safe-core');
  const entry = { id: 'skill:demo', name: 'demo', category: 'skill', source: 'skills/demo', status: 'shipped', install: { mode: 'copy-skill' } };
  assert.deepEqual(collectSkills(f.client).map(item => item.name), ['safe-core']);
  assert.equal(localPresence(entry, root, f.client).present, null);
  f.bind(); assert.deepEqual(collectSkills(f.client).map(item => item.name).sort(), ['demo', 'safe-core']);
  assert.equal(roots.ordinaryWithin(f.client, path.join(f.link, 'demo/SKILL.md')), true);
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); f.put(path.join(outside, 'SKILL.md'), 'OUTSIDE');
  fs.symlinkSync(outside, path.join(f.library, 'linked-child'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(roots.ordinaryWithin(f.client, path.join(f.link, 'linked-child/SKILL.md')), false);
  assert.equal(collectSkills(f.client).some(item => item.name === 'linked-child'), false);
  assert.throws(() => require('../scripts/client-root.js').resolveSkillFile('linked-child', 'SKILL.md', f.client), /Missing/);
  assert.equal(require('../scripts/skill-usage.cjs').installedTiers(f.client).has('linked-child'), false);
});
test('bound duplicate names are quarantined before descriptions and unrelated skills remain usable', t => {
  const f = fixture(t); f.skill('core', 'same'); f.skill('library', 'same'); f.skill('library', 'other'); f.bind();
  const entries = collectSkills(f.client);
  assert.deepEqual(entries.map(item => item.name), ['other']);
  assert.deepEqual(entries.diagnostics, [{ code: 'AMBIGUOUS_SKILL_QUARANTINED', name: 'same' }]);
  assert.equal(require('../scripts/skill-usage.cjs').installedTiers(f.client).has('same'), false);
});
test('physical Unicode directory names retain their filesystem spelling', t => {
  const f = fixture(t), actual = path.join(f.base, 'İstanbul 中文'); fs.mkdirSync(actual);
  fs.unlinkSync(f.link); fs.symlinkSync(actual, f.link, process.platform === 'win32' ? 'junction' : 'dir');
  const binding = roots.bindLibrary(f.client, actual); f.put(path.join(f.client, roots.FILE), JSON.stringify(binding));
  f.put(path.join(actual, 'demo/SKILL.md'), 'UNICODE_ROOT_SENTINEL');
  assert.ok(fs.existsSync(binding.library.real));
  assert.equal(roots.readFileWithin(f.client, path.join(f.link, 'demo/SKILL.md')).toString(), 'UNICODE_ROOT_SENTINEL');
});
test('substitution of a bound junction or ordinary replacement refuses the old identity', t => {
  const f = fixture(t); f.bind();
  fs.unlinkSync(f.link); fs.mkdirSync(f.link);
  assert.throws(() => roots.readBindings(f.client), /身份已改变/);
  assert.throws(() => roots.assertClientPath(f.client, path.join(f.link, 'demo/SKILL.md')), /身份已改变/);
});
test('approved optional parallel install includes its runtime and remains in the library', t => {
  const f = fixture(t), result = f.install({ bindLibrary: f.library, install: ['skill:parallel-orchestration'] });
  assert.equal(result.ready, true);
  assert.ok(fs.existsSync(path.join(f.library, 'parallel-orchestration/SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.client, 'skills/parallel-orchestration')), false);
  for (const name of ['parallel-plan.cjs', 'parallel-context.cjs', 'parallel-write.cjs']) assert.ok(fs.existsSync(path.join(f.client, 'scripts', name)), name);
  assert.equal(f.install({ install: ['skill:parallel-orchestration'] }).ready, true);
  const index = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-index.json')));
  assert.ok(index.entries.some(item => item.name === 'parallel-orchestration' && item.tier === 'library'));
});
test('binding config changed after planning is rejected before publication', t => {
  const f = fixture(t); f.bind();
  const plan = installer.prepare({ client: f.client, profile: 'routing', catalogFile: path.join(root, 'catalog.json') });
  f.put(path.join(f.client, roots.FILE), '{}');
  assert.throws(() => installer.apply(plan, { yes: true }), /绑定|身份/);
  assert.equal(fs.existsSync(path.join(f.client, 'scripts/rules-reminder.js')), false);
});
test('carrier preflight uses an explicit client without exposing MCP or hook arguments', t => {
  const f = fixture(t); f.skill('core', 'safe-core'); f.bind();
  f.put(path.join(f.client, 'settings.json'), JSON.stringify({ mcpServers: { demo: { command: 'node', env: { TOKEN: 'PRIVATE_MCP_TOKEN_SENTINEL' } } }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node demo-hook.js --token PRIVATE_HOOK_SENTINEL', timeout: 10 }] }] } }));
  for (const type of ['mcp', 'hook']) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/carrier-preflight.cjs'), '--client-root', f.client, '--type', type, '--name', 'demo', '--json'], { env: { ...process.env, QODER_HOME: path.join(f.base, 'wrong') }, encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_MCP_TOKEN_SENTINEL|PRIVATE_HOOK_SENTINEL/);
    const json = JSON.parse(result.stdout); assert.equal(json.counts.skill, 1);
  }
});
test('cross-volume library update uses same-volume backup and restores old bytes after late failure', t => {
  const f = fixture(t, true); if (!f) return;
  f.install({ bindLibrary: f.library, workflowMode: 'route' });
  const oldPackage = path.join(f.base, 'old-package'), oldEntry = require('../catalog.json').entries.find(item => item.id === 'skill:parallel-orchestration');
  const oldBody = '---\nname: parallel-orchestration\ndescription: old trusted fixture\n---\nOLD_TRUSTED_LIBRARY\n';
  f.put(path.join(oldPackage, oldEntry.source, 'SKILL.md'), oldBody);
  f.put(path.join(f.library, 'parallel-orchestration/SKILL.md'), oldBody);
  f.put(path.join(oldPackage, 'catalog.json'), JSON.stringify({ schema: 1, entries: [oldEntry] }));
  f.put(path.join(f.client, 'share-package.json'), JSON.stringify({ catalog: path.join(oldPackage, 'catalog.json') }));
  const options = { client: f.client, profile: 'routing', catalogFile: path.join(root, 'catalog.json'), install: ['skill:parallel-orchestration'], workflowMode: 'model' };
  const plan = installer.prepare(options), open = fs.openSync;
  fs.openSync = function(file, flags, ...args) { if (file === path.join(f.client, 'settings.json') && flags === 'wx') throw new Error('fixture late failure'); return open.call(this, file, flags, ...args); };
  try { assert.throws(() => installer.apply(plan, { yes: true }), /已回滚/); } finally { fs.openSync = open; }
  assert.equal(fs.readFileSync(path.join(f.library, 'parallel-orchestration/SKILL.md'), 'utf8'), oldBody);
  const result = installer.apply(installer.prepare(options), { yes: true });
  assert.equal(result.ready, true); assert.equal(result.receipt.externalRecoveryDirectories.length, 1);
  assert.equal(fs.statSync(result.receipt.externalRecoveryDirectories[0]).dev, fs.statSync(f.library).dev);
  assert.equal(fs.readFileSync(path.join(f.library, 'parallel-orchestration/SKILL.md'), 'utf8'), fs.readFileSync(path.join(root, 'skills/parallel-orchestration/SKILL.md'), 'utf8'));
});
for (const existing of [false, true]) test('partial binding write is owned and rolled back: existing=' + existing, t => {
  const f = fixture(t); if (existing) f.bind();
  const binding = path.join(f.client, roots.FILE), before = fs.existsSync(binding) ? fs.readFileSync(binding) : null;
  const plan = installer.prepare({ client: f.client, profile: 'routing', bindLibrary: f.library, catalogFile: path.join(root, 'catalog.json') });
  const open = fs.openSync, write = fs.writeSync; let targetFd, first = false, fired = false;
  fs.openSync = function(file, flags, ...args) { const fd = open.call(this, file, flags, ...args); if (file === binding && flags === 'wx') targetFd = fd; return fd; };
  fs.writeSync = function(fd, buffer, offset, length, position) { if (!fired && fd === targetFd) { if (!first) { first = true; return write.call(this, fd, buffer, offset, Math.min(length, 5), position); } fired = true; const e = new Error('fixture disk full'); e.code = 'ENOSPC'; throw e; } return write.apply(this, arguments); };
  try { assert.throws(() => installer.apply(plan, { yes: true }), /本事务变更已回滚/); } finally { fs.openSync = open; fs.writeSync = write; }
  assert.equal(fired, true);
  if (before) assert.ok(fs.readFileSync(binding).equals(before)); else assert.equal(fs.existsSync(binding), false);
  assert.equal(fs.existsSync(path.join(f.client, 'package-activation.json')), false);
});
test('external transaction directory replacement refuses before any library publication', t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  const mk = fs.mkdtempSync; let fired = false;
  fs.mkdtempSync = function(prefix, ...args) { const dir = mk.call(this, prefix, ...args); if (!fired && String(prefix).toLowerCase().startsWith((f.library + path.sep + '.package-activation-').toLowerCase())) { fs.renameSync(dir, dir + '-original'); fs.symlinkSync(other, dir, process.platform === 'win32' ? 'junction' : 'dir'); fired = true; } return dir; };
  try { assert.throws(() => f.install({ bindLibrary: f.library, install: ['skill:parallel-orchestration'] }), /暂存目录/); } finally { fs.mkdtempSync = mk; }
  assert.equal(fired, true); assert.deepEqual(fs.readdirSync(other), []);
  assert.equal(fs.existsSync(path.join(f.library, 'parallel-orchestration')), false);
});
test('revoked cached bindings refuse content reads before opening a skill entry', t => {
  const f = fixture(t); f.skill('library', 'demo'); f.bind(); const binding = roots.readBindings(f.client);
  fs.unlinkSync(path.join(f.client, roots.FILE));
  let opened = 0; const open = fs.openSync;
  fs.openSync = function(file, ...args) { if (String(file).endsWith('SKILL.md')) opened++; return open.call(this, file, ...args); };
  try { assert.throws(() => roots.readFileWithin(f.client, path.join(f.link, 'demo/SKILL.md'), binding)); } finally { fs.openSync = open; }
  assert.equal(opened, 0);
});
test('direct catalog installation refuses a binding revoked during staging', t => {
  const f = fixture(t); f.install({ bindLibrary: f.library });
  const binding = path.join(f.client, roots.FILE), preload = path.join(f.base, 'revoke.cjs');
  f.put(preload, `const fs=require('node:fs'),copy=fs.cpSync;let fired=false;fs.cpSync=function(source,target,...args){const result=copy.call(this,source,target,...args);if(!fired&&String(target).includes('.pkg-install-')){fired=true;fs.unlinkSync(${JSON.stringify(binding)});fs.writeFileSync(${JSON.stringify(path.join(f.base, 'revoke-fired'))},'yes');}return result;};`);
  const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:parallel-orchestration', '--catalog', path.join(root, 'catalog.json'), '--tier', 'library', '--apply'], { env: { ...process.env, QODER_HOME: f.client }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(fs.existsSync(path.join(f.base, 'revoke-fired')), true, result.stderr);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /绑定/);
  assert.equal(fs.existsSync(binding), false); assert.equal(fs.existsSync(path.join(f.library, 'parallel-orchestration')), false);
});
