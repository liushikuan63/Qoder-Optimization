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
