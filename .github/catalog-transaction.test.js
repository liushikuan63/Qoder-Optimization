'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const source = path.resolve(__dirname, '..');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-transaction-'));
  const pkg = path.join(base, 'package'), client = path.join(base, 'client');
  const scripts = path.join(client, 'scripts'), index = path.join(client, 'skills-index.json');
  const target = path.join(client, 'skills-library/demo');
  fs.mkdirSync(path.join(pkg, 'skills/demo'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: transaction fixture\n---\n# New skill\n');
  const catalog = path.join(pkg, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify({ schema: 1, entries: [{ id: 'skill:demo', category: 'skill', name: 'demo', status: 'shipped', source: 'skills/demo', install: { mode: 'copy-skill', tier: 'library' } }] }));
  for (const name of ['build-skills-index.cjs', 'client-root.js']) fs.copyFileSync(path.join(source, 'scripts', name), path.join(scripts, name));
  const env = { ...process.env, HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), QODER_HOME: client, TEMP: base, TMP: base, TMPDIR: base };
  const run = (extra = [], preload, entry = 'skill:demo') => spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), path.join(source, 'scripts/pkg-catalog.cjs'), 'install', entry, '--catalog', catalog, '--apply', ...extra], { encoding: 'utf8', env, timeout: 15000 });
  const hook = code => { const file = path.join(base, 'race.cjs'); fs.writeFileSync(file, code); return file; };
  try { body({ base, pkg, client, scripts, catalog, index, target, run, hook }); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
}

for (const existing of [false, true]) {
  test('failed index builder preserves a parallel index when original ' + (existing ? 'exists' : 'is absent'), () => fixture(f => {
    if (existing) fs.writeFileSync(f.index, 'original index');
    fs.writeFileSync(path.join(f.scripts, 'build-skills-index.cjs'), 'require("fs").writeFileSync(' + JSON.stringify(f.index) + ', "parallel index"); process.exit(7);');
    const r = f.run();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.readFileSync(f.index, 'utf8'), 'parallel index');
  }));
}

test('index staging refuses a concurrent edit made while skill files are copied', () => fixture(f => {
  fs.writeFileSync(f.index, 'original index');
  const preload = f.hook('const fs=require("fs"),path=require("path"),copy=fs.cpSync; let fired=false; fs.cpSync=function(a,b,o){ const r=copy(a,b,o); if(!fired&&path.basename(b)==="new-0"){fired=true;fs.writeFileSync(' + JSON.stringify(f.index) + ',"parallel index");} return r; };');
  const r = f.run([], preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(f.index, 'utf8'), 'parallel index');
  assert.equal(fs.existsSync(f.target), false);
}));

test('index commit restores the actual file moved if it changed after the comparison', () => fixture(f => {
  fs.writeFileSync(f.index, 'original index');
  const preload = f.hook('const fs=require("fs"),rename=fs.renameSync; let fired=false; fs.renameSync=function(a,b){if(!fired&&a===' + JSON.stringify(f.index) + '){fired=true;fs.writeFileSync(a,"parallel index");}return rename(a,b);};');
  const r = f.run([], preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(f.index, 'utf8'), 'parallel index');
  assert.equal(fs.existsSync(f.target), false);
}));

test('rollback preserves a published index changed by another writer after installation', () => fixture(f => {
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, 'SKILL.md'), 'previous skill');
  fs.writeFileSync(f.index, 'original index');
  const preload = f.hook('const fs=require("fs"),stat=fs.statSync; let fired=false; fs.statSync=function(p,...args){if(!fired&&p===' + JSON.stringify(f.target) + '&&fs.existsSync(' + JSON.stringify(f.index) + ')&&fs.readFileSync(' + JSON.stringify(f.index) + ',"utf8").includes("generated_at")){fired=true;fs.writeFileSync(' + JSON.stringify(f.index) + ',"parallel index");throw new Error("fixture post-index failure");}return stat(p,...args);};');
  const r = f.run(['--force'], preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(f.index, 'utf8'), 'parallel index');
  assert.equal(fs.readFileSync(path.join(f.target, 'SKILL.md'), 'utf8'), 'previous skill');
}));

test('successful index staging publishes the installed skill and preserves ordinary rebuild behavior', () => fixture(f => {
  fs.writeFileSync(f.index, 'original index');
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const index = JSON.parse(fs.readFileSync(f.index, 'utf8'));
  assert.equal(index.count, 1);
  assert.equal(index.entries[0].name, 'demo');
  assert.equal(index.entries[0].tier, 'library');
  assert.ok(fs.existsSync(index.entries[0].path));
}));

test('a builder exiting zero without producing an index does not report installation success', () => fixture(f => {
  fs.writeFileSync(f.index, 'original index');
  fs.writeFileSync(path.join(f.scripts, 'build-skills-index.cjs'), 'process.exit(0);');
  const r = f.run();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(f.index, 'utf8'), 'original index');
  assert.equal(fs.existsSync(f.target), false);
}));

test('exclusive index publication preserves a path created after the precommit check', () => fixture(f => {
  fs.writeFileSync(f.index, 'original index');
  const preload = f.hook('const fs=require("fs"),open=fs.openSync; let fired=false; fs.openSync=function(p,flags,...args){if(!fired&&p===' + JSON.stringify(f.index) + '&&flags==="wx"){fired=true;fs.writeFileSync(p,"parallel index");}return open(p,flags,...args);};');
  const r = f.run([], preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(f.index, 'utf8'), 'parallel index');
  assert.equal(fs.existsSync(f.target), false);
}));

test('script-only installation does not inspect or modify the skill index', () => fixture(f => {
  fs.mkdirSync(path.join(f.pkg, 'scripts'));
  fs.writeFileSync(path.join(f.pkg, 'scripts/demo.js'), 'console.log("script fixture");');
  fs.writeFileSync(f.catalog, JSON.stringify({ schema: 1, entries: [{ id: 'script:demo.js', category: 'script', name: 'demo.js', status: 'shipped', source: 'scripts/demo.js', install: { mode: 'copy-file' } }] }));
  fs.mkdirSync(f.index);
  const r = f.run([], undefined, 'script:demo.js');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(f.scripts, 'demo.js'), 'utf8'), 'console.log("script fixture");');
  assert.equal(fs.statSync(f.index).isDirectory(), true);
}));
