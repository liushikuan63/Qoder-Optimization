'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { encodeTar, archiveEntries } = require('../scripts/archive-entries.cjs');
const source = path.resolve(__dirname, '..');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-'));
  const home = path.join(base, 'home'), client = path.join(home, '.qoder');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: client, TEMP: base, TMP: base, TMPDIR: base, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'Local') };
  const run = (script, args) => spawnSync(process.execPath, [path.join(source, 'scripts', script), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const archive = (entries, name = 'memory.tar.gz') => {
    const file = path.join(base, name);
    fs.writeFileSync(file, zlib.gzipSync(encodeTar(entries.map(([name, text]) => ({ name, data: Buffer.from(text) })))));
    return file;
  };
  try { body({ base, home, client, env, run, archive }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

for (const prefix of ['', 'qoder-memory-export-demo/']) {
  test('memory import supports root layout ' + (prefix || 'flat') + ' without implicit writes', () => fixture(f => {
    const file = f.archive([[prefix + 'MEMORY.md', '- [A](a.md)'], [prefix + 'a.md', 'approved memory']]);
    assert.equal(f.run('import-memory.cjs', [file]).status, 0);
    assert.equal(fs.existsSync(f.client), false);
    const r = f.run('import-memory.cjs', [file, '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(f.client, 'memory/a.md'), 'utf8'), 'approved memory');
    assert.equal(f.run('import-memory.cjs', [file, '--apply']).status, 0);
  }));
}

test('memory conflict rejects the entire import, including new files', () => fixture(f => {
  const file = f.archive([['MEMORY.md', 'new index'], ['a.md', 'new memory']]);
  fs.mkdirSync(path.join(f.client, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(f.client, 'memory/MEMORY.md'), 'existing index');
  const r = f.run('import-memory.cjs', [file, '--apply']);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(path.join(f.client, 'memory/MEMORY.md'), 'utf8'), 'existing index');
  assert.equal(fs.existsSync(path.join(f.client, 'memory/a.md')), false);
}));

test('archive path traversal and corrupted headers are rejected before import', () => fixture(f => {
  assert.throws(() => encodeTar([{ name: '../escape.md', data: Buffer.from('x') }]), /unsafe/);
  const data = encodeTar([{ name: 'MEMORY.md', data: Buffer.from('x') }]);
  data[0] ^= 1;
  const file = path.join(f.base, 'bad.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(data));
  assert.equal(f.run('import-memory.cjs', [file, '--apply']).status, 2);
  assert.equal(fs.existsSync(f.client), false);
}));

test('archive encoder roundtrip preserves independent input bytes', () => {
  const entries = [{ name: 'MEMORY.md', data: Buffer.from('index') }, { name: 'a.md', data: Buffer.from([0, 127, 255]) }];
  assert.deepEqual(archiveEntries('test.tar.gz', zlib.gzipSync(encodeTar(entries))), entries);
});

test('disk read-only mode never writes a heartbeat and rejects write flags', () => fixture(f => {
  const empty = path.join(f.base, 'empty'); fs.mkdirSync(empty);
  const args = ['--root', empty, '--extra-root', empty, '--simulate-free', String(100 * 1024 ** 3), '--json'];
  let r = f.run('disk-sweeper.js', [...args, '--read-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.client), false);
  assert.equal(f.run('disk-sweeper.js', [...args, '--read-only', '--apply']).status, 2);
  r = f.run('disk-sweeper.js', args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/disk-sweeper/heartbeat.log')), true);
}));

test('weekly read-only mode propagates to child checks and does not write history', () => fixture(f => {
  const scripts = path.join(f.client, 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['sync-memory.sh', 'sync-global-config.sh']) fs.writeFileSync(path.join(scripts, name), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(scripts, 'stop-gate.js'), "console.log('empty report')");
  for (const file of ['tmp-sweeper.js', 'client-root.js']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(scripts, file));
  fs.writeFileSync(path.join(scripts, 'disk-sweeper.js'), "if (!process.argv.includes('--read-only')) process.exit(7); console.log(JSON.stringify({freeGb:100,level:'ok',tier1Files:0,tier1Bytes:0,extraFiles:0,extraBytes:0}));");
  for (const flag of ['--read-only', '--no-fix']) {
    const r = f.run('rules-weekly-audit.js', [flag]);
    assert.ok(r.status === 0 || r.status === 1, r.stdout + r.stderr);
    assert.equal(r.stdout.includes('disk-sweeper.js --json 未能执行'), false);
    assert.equal(r.stdout.includes('tmp-sweeper.js 未能执行'), false);
    assert.equal(fs.existsSync(path.join(f.client, 'tmp')), false);
  }
  f.run('rules-weekly-audit.js', []);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/rules-audit/history.log')), true);
}));

test('memory merge guidance retains deletion conflicts and rejects size-based winners', () => {
  const text = fs.readFileSync(path.join(source, 'skills/memory-bank-divergence-repair/SKILL.md'), 'utf8');
  for (const required of ['共同基线', '主动删除', '删除/修改冲突', '无基线', 'mtime']) assert.ok(text.includes(required));
  assert.equal(text.includes('直接 `cp` 超集'), false);
  const slim = fs.readFileSync(path.join(source, 'skills/injected-context-slimming/SKILL.md'), 'utf8');
  assert.ok(slim.includes('许可反转') && slim.includes('删除反例'));
  assert.equal(slim.includes('截首句 + 字数上限'), false);
});
