'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const script = process.env.SECRET_SCAN_SCRIPT || path.resolve(__dirname, '../scripts/share-secret-scan.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const input = path.join(dir, 'input.txt');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, TMPDIR: dir };
  const run = file => spawnSync(process.execPath, [script, file], { env, encoding: 'utf8', timeout: 15000 });
  try { body({ dir, input, run }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('scanner detects full private IPv4, internal hosts and absolute homes without echoing values', () => fixture(f => {
  const ip = ['10', '23', '45', '67'].join('.');
  const host = 'server.' + 'corp';
  const home = ['', 'home', 'someone', 'config'].join('/');
  fs.writeFileSync(f.input, [ip, host, home].join('\n'));
  const result = f.run(f.input);
  assert.equal(result.status, 1);
  for (const category of ['私网IP示例', '内网后缀主机', '他人家目录']) assert.ok(result.stdout.includes(category));
  for (const value of [ip, host, home]) assert.equal(result.stdout.includes(value), false);
}));

test('scanner does not mistake versions, relative paths or Markdown names for private data', () => fixture(f => {
  fs.writeFileSync(f.input, '10.12.5\n./home/home.component\n$T/case/home/.qoder\npm-skills.local.md\n192.0.2.1\n');
  const result = f.run(f.input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}));

test('scanner still rejects a credential-like value and does not disclose it', () => fixture(f => {
  const value = ['R4nd0m', 'Value42Plus'].join('');
  fs.writeFileSync(f.input, `password = "${value}"`);
  const result = f.run(f.input);
  assert.equal(result.status, 2);
  assert.ok(result.stdout.includes('凭据键值'));
  assert.equal((result.stdout + result.stderr).includes(value), false);
}));

test('scanner fails for missing targets and an empty input set', () => fixture(f => {
  assert.equal(f.run(f.input).status, 2);
  assert.equal(f.run(f.dir).status, 2);
}));

for (const format of ['json', 'json-escaped', 'yaml', 'gzip', 'nested-gzip']) {
  test('scanner detects credential values in ' + format, () => fixture(f => {
    const value = ['R4nd0m', 'Value42Plus'].join('');
    let content = Buffer.from(format === 'yaml' ? '"password": "' + value + '"' : JSON.stringify({ password: value }));
    if (format === 'json-escaped') content = Buffer.from('{"' + String.fromCharCode(92) + 'u0070assword":"' + value + '"}');
    let name = f.input;
    if (format.includes('gzip')) {
      content = require('zlib').gzipSync(content);
      name += '.gz';
      if (format === 'nested-gzip') { content = require('zlib').gzipSync(content); name += '.gz'; }
    }
    fs.writeFileSync(name, content);
    const result = f.run(name);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('凭据键值'));
    assert.equal((result.stdout + result.stderr).includes(value), false);
  }));
}

test('a damaged archive fails even beside clean text', () => fixture(f => {
  fs.writeFileSync(f.input, 'clean');
  fs.writeFileSync(path.join(f.dir, 'broken.tar.gz'), 'not an archive');
  assert.equal(f.run(f.dir).status, 2);
}));

test('scanner checks zip members without extracting them', () => fixture(f => {
  const content = path.join(f.dir, 'content');
  fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, 'entry.json'), JSON.stringify({ token: ['R4nd0m', 'Value42Plus'].join('') }));
  const zip = path.join(f.dir, 'bundle.zip');
  const build = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pack-folder.js'), content, zip], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const before = fs.readdirSync(f.dir).sort();
  assert.equal(f.run(zip).status, 2);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
}));

test('a forged zip member count cannot hide the last entry', () => fixture(f => {
  const dir = path.join(f.dir, 'content'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'clean');
  fs.writeFileSync(path.join(dir, 'z.json'), JSON.stringify({ token: ['R4nd0m', 'Value42Plus'].join('') }));
  const zip = path.join(f.dir, 'test.zip');
  const build = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pack-folder.js'), dir, zip]);
  assert.equal(build.status, 0);
  const data = fs.readFileSync(zip), end = data.length - 22;
  const count = data.readUInt16LE(end + 10);
  data.writeUInt16LE(count - 1, end + 8); data.writeUInt16LE(count - 1, end + 10);
  fs.writeFileSync(zip, data);
  const r = f.run(zip);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('无法完整检查'));
}));

test('description exemptions come from the distributed checker, not HOME', () => fixture(f => {
  const checker = path.resolve(__dirname, '../scripts/share-package-verify.cjs');
  const source = fs.readFileSync(checker, 'utf8');
  assert.ok(source.includes("path.join(__dirname, 'skills-doctor.cjs')"));
  assert.equal(source.includes("path.join(HOME, '.qoder'"), false);
}));
