'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const bash = process.platform === 'win32'
  ? [process.env.QODER_BASH, 'C:/Program Files/Git/bin/bash.exe', 'D:/software/Git/bin/bash.exe'].find(file => file && fs.existsSync(file)) || 'bash'
  : 'bash';
for (const failing of [false, true]) {
  test('memory-sync self-tests use disposable clients and reject a failed silent guard: ' + failing, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-runner-'));
    try {
      const guard = path.join(base, 'failed-guard.js');
      fs.writeFileSync(guard, 'process.exit(9);\n');
      const env = { ...process.env, HOME: base, USERPROFILE: base, QODER_HOME: path.join(base, '.qoder'),
        SUT: path.join(root, 'scripts/sync-memory.sh'), GUARD_SUT: failing ? guard : path.join(root, 'scripts/global-config-guard.js') };
      const result = spawnSync(bash, [path.join(root, 'scripts/sync-memory.test.sh')], { env, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, failing ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.stdout, failing ? /FAIL\s+T12 guard/ : /PASS=18 FAIL=0/);
      assert.equal(fs.existsSync(path.join(base, '.qoder')), false, 'caller HOME must stay untouched');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}
