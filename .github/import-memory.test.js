'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { encodeTar } = require('../scripts/archive-entries.cjs');
const { importMemory } = require('../scripts/import-memory.cjs');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-rollback-'));
  const client = path.join(base, 'client'), memory = path.join(client, 'memory');
  const archive = path.join(base, 'memory.tar.gz');
  fs.writeFileSync(archive, zlib.gzipSync(encodeTar([
    { name: 'MEMORY.md', data: Buffer.from('original index') },
    { name: 'a.md', data: Buffer.from('complete memory bytes') },
  ])));
  try { body({ base, client, memory, archive }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

// Cover both the old path-based writer and an exclusive fd-based writer. Each
// injected failure changes only this fixture's final memory destination.
function failSecondWrite(t, f, mode) {
  const open = fs.openSync, close = fs.closeSync, writeFile = fs.writeFileSync, write = fs.writeSync;
  const descriptors = new Map();
  let shortWrite = false;
  const fail = () => { throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' }); };
  const concurrentChange = () => {
    const first = path.join(f.memory, 'MEMORY.md');
    if (mode === 'replace') fs.renameSync(first, path.join(f.client, 'concurrent-original.md'));
    writeFile(first, mode === 'replace' ? 'original index' : 'parallel user edit');
  };
  t.mock.method(fs, 'openSync', function(file, ...args) {
    const fd = open.call(this, file, ...args);
    if (typeof file === 'string' && path.dirname(file) === f.memory) descriptors.set(fd, path.basename(file));
    return fd;
  });
  t.mock.method(fs, 'closeSync', function(fd) { descriptors.delete(fd); return close.apply(this, arguments); });
  t.mock.method(fs, 'writeFileSync', function(file, data, options) {
    if (typeof file === 'string' && path.dirname(file) === f.memory && path.basename(file) === 'a.md') {
      if (mode === 'partial') writeFile(file, Buffer.from(data).subarray(0, 3), options);
      else concurrentChange();
      return fail();
    }
    return writeFile.apply(this, arguments);
  });
  t.mock.method(fs, 'writeSync', function(fd, bytes, offset, length, position) {
    if (descriptors.get(fd) === 'a.md') {
      if (mode === 'partial' && !shortWrite) { shortWrite = true; return write.call(this, fd, bytes, offset, Math.min(3, length), position); }
      if (mode !== 'partial') concurrentChange();
      return fail();
    }
    return write.apply(this, arguments);
  });
}

test('memory import rolls back its own partial write and keeps the original error', t => fixture(f => {
  failSecondWrite(t, f, 'partial');
  assert.throws(() => importMemory(f.archive, f.client, true), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(path.join(f.memory, 'MEMORY.md')), false);
  assert.equal(fs.existsSync(path.join(f.memory, 'a.md')), false);
  assert.deepEqual(fs.readdirSync(f.memory), []);
}));

for (const mode of ['edit', 'replace']) {
  test('memory rollback preserves a concurrent ' + mode + ' and retains recovery evidence', t => fixture(f => {
    failSecondWrite(t, f, mode);
    let error;
    try { importMemory(f.archive, f.client, true); } catch (caught) { error = caught; }
    assert.equal(error?.code, 'ENOSPC');
    assert.match(error.message, /injected ENOSPC/);
    assert.equal(fs.readFileSync(path.join(f.memory, 'MEMORY.md'), 'utf8'), mode === 'replace' ? 'original index' : 'parallel user edit');
    assert.equal(fs.existsSync(path.join(f.memory, 'a.md')), false);
    const recovery = fs.readdirSync(f.memory).find(name => name.startsWith('.import-memory-'));
    assert.ok(recovery, 'a conflicting rollback must keep its recovery directory');
    assert.ok(error.message.includes(path.join(f.memory, recovery)), error.message);
    assert.equal(fs.readFileSync(path.join(f.memory, recovery, 'MEMORY.md'), 'utf8'), 'original index');
    if (mode === 'replace') assert.equal(fs.readFileSync(path.join(f.client, 'concurrent-original.md'), 'utf8'), 'original index');
  }));
}

test('failure while staging memory never exposes partial destination files', t => fixture(f => {
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function(file, data, options) {
    if (typeof file === 'string' && path.basename(file) === 'MEMORY.md' && file.startsWith(f.memory + path.sep)) {
      original(file, 'partial', options);
      throw Object.assign(new Error('injected staging ENOSPC'), { code: 'ENOSPC' });
    }
    return original.apply(this, arguments);
  });
  assert.throws(() => importMemory(f.archive, f.client, true), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(path.join(f.memory, 'MEMORY.md')), false);
  assert.deepEqual(fs.readdirSync(f.memory), []);
}));

test('successful import verifies final bytes and removes its staging directory', () => fixture(f => {
  importMemory(f.archive, f.client, true);
  assert.equal(fs.readFileSync(path.join(f.memory, 'MEMORY.md'), 'utf8'), 'original index');
  assert.equal(fs.readFileSync(path.join(f.memory, 'a.md'), 'utf8'), 'complete memory bytes');
  assert.deepEqual(fs.readdirSync(f.memory).sort(), ['MEMORY.md', 'a.md']);
}));

for (const value of [null, '--apply', '--unknown', '', '   ']) {
  test('invalid --client-root is rejected before import writes: ' + JSON.stringify(value), () => fixture(f => {
    const args = [path.resolve(__dirname, '../scripts/import-memory.cjs'), f.archive, '--apply', '--client-root'];
    if (value !== null) args.push(value);
    const before = fs.readdirSync(f.base).sort();
    const result = spawnSync(process.execPath, args, {
      cwd: f.base, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: f.base, USERPROFILE: f.base, QODER_HOME: f.client },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /IMPORT_FAILED/);
    assert.deepEqual(fs.readdirSync(f.base).sort(), before);
  }));
}
