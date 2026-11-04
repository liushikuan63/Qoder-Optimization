'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CLI refuses the repository root instead of scanning the workspace', () => {
  const repo = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'check-release.js'), 'v0.0.0'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr + result.stdout, /built package directory/);
});
