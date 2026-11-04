'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nodeTooOld, assertNodeVersion } = require('./install-package.cjs');

test('Node 20 is rejected by the installer preflight', () => {
  assert.strictEqual(nodeTooOld('20.11.1'), true);
  assert.strictEqual(nodeTooOld('24.15.9'), true);
  assert.throws(() => assertNodeVersion('20.11.1'), /24\.16\+/);
});

test('Node 24.16 and newer pass the preflight', () => {
  assert.strictEqual(nodeTooOld('24.16.0'), false);
  assert.strictEqual(nodeTooOld('24.16.1'), false);
  assert.strictEqual(nodeTooOld('25.0.0'), false);
  assert.doesNotThrow(() => assertNodeVersion('24.16.0'));
});
