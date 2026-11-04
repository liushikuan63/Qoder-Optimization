'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scriptsInCommand, findMissingHookTargets } = require('./hook-targets.cjs');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-hook-targets-'));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('extracts quoted and absolute script targets', () => {
  assert.deepStrictEqual(
    scriptsInCommand('"C:/node/node.exe" "C:/Users/user/.qoder/scripts/rules-reminder.js" --client-root "C:/Users/user/.qoder"'),
    ['C:/Users/user/.qoder/scripts/rules-reminder.js'],
  );
  assert.deepStrictEqual(
    scriptsInCommand('C:\\node\\node.exe C:\\Users\\user\\.qoder\\scripts\\stop-gate.js'),
    ['C:\\Users\\user\\.qoder\\scripts\\stop-gate.js'],
  );
});

test('reports a missing hook target and ignores a present one', () => fixture(root => {
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'present.js'), '');
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '"C:/node/node.exe" "' + path.join(scripts, 'present.js').replace(/\\/g, '/') + '"' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: '"C:/node/node.exe" "' + path.join(scripts, 'missing.js').replace(/\\/g, '/') + '"' }] }],
    },
  }));
  assert.deepStrictEqual(findMissingHookTargets(settings, scripts), ['missing.js']);
}));

test('invalid settings is ignored', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'settings.json'), '{not json');
  fs.mkdirSync(path.join(root, 'scripts'));
  assert.deepStrictEqual(findMissingHookTargets(path.join(root, 'settings.json'), path.join(root, 'scripts')), []);
}));
