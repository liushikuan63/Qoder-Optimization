'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { archiveEntries } = require('../scripts/archive-entries.cjs');
const script = path.resolve(__dirname, '../scripts/pack-folder.js');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-folder-test-'));
  const input = path.join(base, 'input'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'README.md'), 'approved fixture');
  const run = (output = path.join(base, 'output.zip'), extraEnv = {}, folder = input, preload) => {
    const env = { ...process.env, ...extraEnv }; if (!Object.hasOwn(extraEnv, 'SOURCE_DATE_EPOCH')) delete env.SOURCE_DATE_EPOCH;
    return spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), script, folder, output], { env, encoding: 'utf8', timeout: 10000 });
  };
  try { body({ base, input, run }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

function localTime(bytes, wanted) {
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const n = bytes.readUInt16LE(cursor + 26), extra = bytes.readUInt16LE(cursor + 28), packed = bytes.readUInt32LE(cursor + 18);
    const name = bytes.subarray(cursor + 30, cursor + 30 + n).toString('utf8');
    if (name === wanted) return { time: bytes.readUInt16LE(cursor + 10), date: bytes.readUInt16LE(cursor + 12) };
    cursor += 30 + n + extra + packed;
  }
  throw new Error('missing ZIP timestamp: ' + wanted);
}

for (const [label, mtime, expected] of [
  ['before 1980', 0, { time: 0, date: (1 << 5) | 1 }],
  ['after 2107', Date.UTC(2110, 0, 1) / 1000, { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }],
]) {
  test('default file mtime ' + label + ' is clamped to the ZIP date range', () => fixture(f => {
    const file = path.join(f.input, 'epoch.txt'), output = path.join(f.base, 'output.zip');
    fs.writeFileSync(file, 'timestamp fixture'); fs.utimesSync(file, mtime, mtime);
    let preload;
    // Some Windows runtimes wrap utimes above 2^32 seconds. Still exercise the
    // upper ZIP boundary against the Stats value that a supporting filesystem returns.
    if (mtime > 0 && fs.statSync(file).mtimeMs !== mtime * 1000) {
      preload = path.join(f.base, 'future-stat.cjs');
      fs.writeFileSync(preload, 'const fs=require("fs"),open=fs.openSync;const handles=new Set();fs.openSync=function(p,...args){const fd=open.call(this,p,...args);if(p===' + JSON.stringify(file) + ')handles.add(fd);return fd;};for(const method of ["statSync","lstatSync","fstatSync"]){const original=fs[method];fs[method]=function(p,...args){const st=original.call(this,p,...args);if(p===' + JSON.stringify(file) + '||handles.has(p))st.mtimeMs=' + mtime * 1000 + ';return st;};}');
    }
    const r = f.run(output, {}, f.input, preload);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(localTime(fs.readFileSync(output), 'input/epoch.txt'), expected);
  }));
}

test('explicit out-of-range SOURCE_DATE_EPOCH remains an error without output', () => fixture(f => {
  for (const value of ['0', String(Date.UTC(2110, 0, 1) / 1000), 'not-a-number']) {
    const output = path.join(f.base, 'invalid.zip');
    const r = f.run(output, { SOURCE_DATE_EPOCH: value });
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(output), false);
  }
}));

test('directory links are rejected before external contents enter a ZIP', () => fixture(f => {
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.txt'), 'outside fixture');
  fs.symlinkSync(outside, path.join(f.input, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(f.base, 'output.zip'), r = f.run(output);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside fixture');
}));

test('a linked input root is rejected', () => fixture(f => {
  const alias = path.join(f.base, 'root-alias');
  fs.symlinkSync(f.input, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(f.base, 'output.zip'), r = f.run(output, {}, alias);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
}));

test('an output inside the input is rejected without replacing an earlier ZIP', () => fixture(f => {
  const output = path.join(f.input, 'result.zip'); fs.writeFileSync(output, 'previous ZIP bytes');
  const r = f.run(output);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'previous ZIP bytes');
}));

test('output containment resolves an existing parent junction', () => fixture(f => {
  const alias = path.join(f.base, 'output-alias');
  fs.symlinkSync(f.input, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(alias, 'result.zip'), r = f.run(output);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
}));

test('a sibling sharing the input name prefix remains a valid output location', () => fixture(f => {
  const sibling = path.join(f.base, 'input-other'); fs.mkdirSync(sibling);
  const output = path.join(sibling, 'result.zip'), r = f.run(output, { SOURCE_DATE_EPOCH: String(Date.UTC(2026, 0, 1) / 1000) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(archiveEntries('result.zip', fs.readFileSync(output)).map(e => e.name), ['input/README.md']);
}));

test('a parent junction substituted after scanning cannot supply external archive bytes', () => fixture(f => {
  const sub = path.join(f.input, 'sub'), outside = path.join(f.base, 'outside');
  fs.mkdirSync(sub); fs.mkdirSync(outside);
  const file = path.join(sub, 'entry.txt'), moved = path.join(f.base, 'original-sub');
  fs.writeFileSync(file, 'approved source'); fs.writeFileSync(path.join(outside, 'entry.txt'), 'outside fixture');
  const preload = path.join(f.base, 'source-race.cjs');
  fs.writeFileSync(preload, 'const fs=require("fs"),read=fs.readFileSync,open=fs.openSync;let fired=false;function race(p){if(!fired&&p===' + JSON.stringify(file) + '){fired=true;fs.renameSync(' + JSON.stringify(sub) + ',' + JSON.stringify(moved) + ');fs.symlinkSync(' + JSON.stringify(outside) + ',' + JSON.stringify(sub) + ',process.platform==="win32"?"junction":"dir");}}fs.readFileSync=function(p,...args){race(p);return read.call(this,p,...args);};fs.openSync=function(p,...args){race(p);return open.call(this,p,...args);};');
  const output = path.join(f.base, 'output.zip'), r = f.run(output, {}, f.input, preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(path.join(moved, 'entry.txt'), 'utf8'), 'approved source');
  assert.equal(fs.readFileSync(path.join(outside, 'entry.txt'), 'utf8'), 'outside fixture');
}));

test('a regular file replaced after scanning is rejected by opened-file identity', () => fixture(f => {
  const file = path.join(f.input, 'README.md'), original = path.join(f.base, 'original.md');
  const preload = path.join(f.base, 'file-race.cjs');
  fs.writeFileSync(preload, 'const fs=require("fs"),read=fs.readFileSync,open=fs.openSync;let fired=false;function race(p){if(!fired&&p===' + JSON.stringify(file) + '){fired=true;fs.renameSync(p,' + JSON.stringify(original) + ');fs.writeFileSync(p,"replaced fixture");}}fs.readFileSync=function(p,...args){race(p);return read.call(this,p,...args);};fs.openSync=function(p,...args){race(p);return open.call(this,p,...args);};');
  const output = path.join(f.base, 'output.zip'), r = f.run(output, {}, f.input, preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'approved fixture');
}));

test('in-place source edits during a descriptor read fail the post-read consistency check', () => fixture(f => {
  const file = path.join(f.input, 'README.md'), preload = path.join(f.base, 'read-race.cjs');
  fs.writeFileSync(preload, 'const fs=require("fs"),read=fs.readFileSync,open=fs.openSync;const handles=new Set();let fired=false;fs.openSync=function(p,...args){const fd=open.call(this,p,...args);if(p===' + JSON.stringify(file) + ')handles.add(fd);return fd;};fs.readFileSync=function(p,...args){const data=read.call(this,p,...args);if(!fired&&(p===' + JSON.stringify(file) + '||handles.has(p))){fired=true;const old=fs.statSync(' + JSON.stringify(file) + ').mtimeMs;fs.writeFileSync(' + JSON.stringify(file) + ',"modified fixture");fs.utimesSync(' + JSON.stringify(file) + ',(old+10000)/1000,(old+10000)/1000);}return data;};');
  const output = path.join(f.base, 'output.zip'), r = f.run(output, {}, f.input, preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'modified fixture');
}));

test('non-regular filesystem members are rejected before any content read', () => fixture(f => {
  const file = path.join(f.input, 'README.md'), preload = path.join(f.base, 'special-file.cjs');
  fs.writeFileSync(preload, 'const fs=require("fs"),stat=fs.lstatSync;fs.lstatSync=function(p,...args){const st=stat.call(this,p,...args);if(p===' + JSON.stringify(file) + '){st.isFile=()=>false;st.isDirectory=()=>false;}return st;};');
  const output = path.join(f.base, 'output.zip'), r = f.run(output, {}, f.input, preload);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(output), false);
}));
