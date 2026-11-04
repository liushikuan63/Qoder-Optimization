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
