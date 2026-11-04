'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { BASE_IDS } = require('../scripts/install-package.cjs');
const { isPublicFile } = require('../scripts/pack-share-extras.cjs');

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('share package carries the fixed plan, recall and routing chains', () => {
  assert.match(read('scripts/parallel-plan.cjs'), /PLAN_DOC_REQUIRED/);
  assert.match(read('scripts/parallel-context.cjs'), /DECISION_REQUIRED/);
  assert.match(read('scripts/parallel-context.cjs'), /command === 'recall'/);
  assert.match(read('scripts/capability-advisor.cjs'), /RELEVANT_LOCAL_LIBRARY_SKILL/);
  assert.match(read('skills/skills-router/SKILL.md'), /触发词：技能路由/);
  assert.match(read('skills/rules-conflict-audit/SKILL.md'), /触发词：规则冲突/);
  assert.match(read('skills/parallel-orchestration/SKILL.md'), /--markdown/);
  assert.match(read('skills/parallel-orchestration/SKILL.md'), /parallel-context\.cjs recall/);
});

test('base install ships the plan and recall scripts', () => {
  assert.ok(BASE_IDS.includes('script:parallel-plan.cjs'));
  assert.ok(BASE_IDS.includes('script:parallel-context.cjs'));
  const catalog = JSON.parse(read('catalog.json'));
  for (const id of ['script:parallel-plan.cjs', 'script:parallel-context.cjs']) {
    assert.ok(catalog.entries.some(entry => entry.id === id && entry.status === 'shipped'), id);
  }
});

test('backup process files are never tracked or shipped', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(tracked.filter(file => /\.bak(?:[._-]|\d|$)/i.test(file)), []);
  for (const rel of ['scripts/demo.cjs.bak', 'skills/demo/SKILL.md.bak.20260101', 'README.md.bak_1', 'catalog.json.bak-2', 'notes.bak2']) {
    assert.equal(isPublicFile(rel), false, rel);
  }
});


function installFixture(t) {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-resident-transaction-'));
  const client = path.join(base, 'client'), pkg = path.join(base, 'package');
  fs.mkdirSync(path.join(pkg, 'skills/demo'), { recursive: true });
  fs.mkdirSync(client);
  fs.writeFileSync(path.join(pkg, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: demo fixture\n---\n');
  const catalog = path.join(pkg, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify({ schema: 1, entries: [{ id: 'skill:demo', category: 'skill', name: 'demo', status: 'shipped', source: 'skills/demo', install: { mode: 'copy-skill' } }] }));
  const resident = path.join(client, 'skills-resident.json');
  const run = preload => spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), path.join(root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:demo', '--tier', 'core', '--apply', '--catalog', catalog], { env: { ...process.env, QODER_HOME: client }, encoding: 'utf8', timeout: 20000 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, client, resident, run };
}

test('an invalid resident preference blocks a resident install without reporting success', t => {
  const f = installFixture(t);
  const original = '{"schema":1,"skills":["../outside"]}';
  fs.writeFileSync(f.resident, original);
  const r = f.run();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/demo')), false);
  assert.equal(fs.readFileSync(f.resident, 'utf8'), original);
});

test('resident metadata publication failure rolls back the skill and retains prior preferences', t => {
  const f = installFixture(t);
  const original = '{"schema":1,"skills":["existing"]}';
  fs.writeFileSync(f.resident, original);
  const preload = path.join(f.base, 'fail-resident.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),rename=fs.renameSync,open=fs.openSync;fs.renameSync=function(from,to){if(to===${JSON.stringify(f.resident)})throw new Error('fixture resident publication failure');return rename.call(this,from,to);};fs.openSync=function(file,flags,...args){if(file===${JSON.stringify(f.resident)}&&flags==='wx')throw new Error('fixture resident publication failure');return open.call(this,file,flags,...args);};`);
  const r = f.run(preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/demo')), false);
  assert.equal(fs.readFileSync(f.resident, 'utf8'), original);
});


test('a concurrent resident preference edit is retained and aborts the install', t => {
  const f = installFixture(t);
  fs.writeFileSync(f.resident, '{"schema":1,"skills":["existing"]}');
  const concurrent = '{"schema":1,"skills":["concurrent"]}';
  const target = path.join(f.client, 'skills/demo/SKILL.md');
  const preload = path.join(f.base, 'resident-race.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),open=fs.openSync;let fired=false;fs.openSync=function(file,flags,...args){if(!fired&&file===${JSON.stringify(target)}&&flags==='wx'){fired=true;fs.writeFileSync(${JSON.stringify(f.resident)},${JSON.stringify(concurrent)});}return open.call(this,file,flags,...args);};`);
  const r = f.run(preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/demo')), false);
  assert.equal(fs.readFileSync(f.resident, 'utf8'), concurrent);
});

test('a linked installation parent cannot write a selected skill outside the client', t => {
  const f = installFixture(t);
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.client, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = f.run();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(outside), []);
});
