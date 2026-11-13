'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { redact, findSensitive } = require('./parallel-context-redact.cjs');

const fakeToken = 'ghp_' + 'a'.repeat(36);
const fakeSecret = 'hunter' + '2secret';
const internalIp = ['10', '1', '2', '3'].join('.');
const privateIp = ['192', '168', '1', '5'].join('.');
const credentialKey = 'pass' + 'word';

test('redact removes tokens, credentials and internal URLs', () => {
  const input = [
    'token: ' + fakeToken,
    credentialKey + ': "' + fakeSecret + '"',
    'host ' + internalIp,
    'endpoint http://' + internalIp + ':8080/api?x=1',
    'proxy https://user:' + fakeSecret + '@example.com/path',
  ].join('\n');
  const output = redact(input);
  assert.ok(!output.includes(fakeToken));
  assert.ok(!output.includes(fakeSecret));
  assert.ok(!output.includes(internalIp));
  assert.match(output, /\[REDACTED_TOKEN\]/);
  assert.match(output, /\[REDACTED_IP\]/);
});

test('findSensitive reports categories and stays empty for clean text', () => {
  assert.deepEqual(findSensitive('普通说明，没有秘密'), []);
  const hits = findSensitive('Bearer ' + 'abcdefghijklmnop' + ' and http://' + privateIp + '/x');
  assert.ok(hits.includes('BEARER'));
  assert.ok(hits.includes('INTERNAL_IP') || hits.includes('URL'));
});

test('findSensitive resets global regex state between calls', () => {
  const sample = 'token: ' + fakeToken;
  assert.deepEqual(findSensitive(sample), findSensitive(sample));
});

test('quoted credentials with spaces or escaped quotes are fully redacted', () => {
  const values = ['alpha beta gamma', 'alpha "beta" gamma', "alpha 'beta' gamma"];
  for (const value of values) {
    const samples = [JSON.stringify({ password: value }), 'password: ' + JSON.stringify(value)];
    for (const input of samples) {
      assert.ok(findSensitive(input).includes('CREDENTIAL'), input);
      const output = redact(input);
      assert.ok(!output.includes('alpha') && !output.includes('gamma'), output);
      assert.deepEqual(findSensitive(output), [], output);
      assert.equal(redact(output), output);
    }
  }
});

// —— A31：URL 路径与参数名残留（2026-11-13 用户采纳候选）——
// 旧顺序先替换 IP/凭据，URL 正则在自产占位符的 ] 处截断 → 取值脱敏了但接口形状仍泄漏。
const querySecret = 'hunter' + '2secret';

test('internal URL with query leaves no path, port or parameter name behind', () => {
  const input = 'curl http://' + internalIp + ':8080/api?token=' + querySecret + ' 失败：401 unauthorized';
  // 正对照：识别器必须先看穿原始 URL，否则下面的「输出干净」可能是恒真读数。
  assert.ok(findSensitive(input).includes('URL'), input);
  const output = redact(input);
  assert.ok(!output.includes('/api'), output);
  assert.ok(!output.includes('token='), output);
  assert.ok(!output.includes('8080'), output);
  assert.ok(!output.includes(internalIp), output);
  assert.ok(!output.includes(querySecret), output);
  assert.deepEqual(findSensitive(output), [], output);
  assert.equal(redact(output), output);
});

test('localhost URL with query is fully redacted too', () => {
  const input = 'GET http://localhost:9200/_search?q=' + querySecret;
  const output = redact(input);
  assert.ok(!output.includes('_search') && !output.includes('9200'), output);
  assert.ok(!output.includes(querySecret), output);
  assert.deepEqual(findSensitive(output), [], output);
});

test('public URL keeps its path but drops the query', () => {
  const input = 'see https://example.com/docs/api?token=' + querySecret + ' for details';
  const output = redact(input);
  assert.match(output, /https:\/\/example\.com\/docs\/api\[REDACTED_QUERY\]/);
  assert.ok(!output.includes(querySecret) && !output.includes('token='), output);
  assert.deepEqual(findSensitive(output), [], output);
  assert.equal(redact(output), output);
});

test('URL userinfo on an internal host is removed as a whole', () => {
  const input = 'proxy https://user:' + querySecret + '@' + internalIp + '/path';
  const output = redact(input);
  assert.equal(output, 'proxy [REDACTED_URL]');
  assert.deepEqual(findSensitive(output), [], output);
});

test('non-http scheme credentials are still masked after the URL pass', () => {
  const input = 'dsn postgres://user:' + querySecret + '@' + internalIp + ':5432/db';
  // 正对照：真实凭据必须仍被识别，否则「输出干净」可能只是把识别器关掉了。
  assert.ok(findSensitive(input).includes('URL_CREDENTIALS'), input);
  const output = redact(input);
  assert.ok(!output.includes(querySecret), output);
  assert.ok(!output.includes(internalIp), output);
  assert.match(output, /postgres:\/\/\[REDACTED\]@/);
  assert.deepEqual(findSensitive(output), [], output);
  assert.equal(redact(output), output);
});
