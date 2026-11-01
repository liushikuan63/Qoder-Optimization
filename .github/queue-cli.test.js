'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/work-queue-check.js');

for (const args of [['--file'], ['--file', '--json'], ['--flie', 'queue.md'], ['--file', ''], ['--selftest', '--unknown']]) {
  test('queue arguments cannot silently select a different queue: ' + JSON.stringify(args), () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cli-'));
    try {
      fs.writeFileSync(path.join(dir, '.qoder-work-queue.md'), '## 当前状态\n## 下一步\n## 阻塞点\n## 关键入口\n');
      const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 2, result.stdout + result.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
