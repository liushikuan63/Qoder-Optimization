'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('child_process');

test('share-package-verify 自测全过（1 正例 / 4 负例）', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'share-package-verify.cjs'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SELFTEST=PASS/);
});

for (const [name, scriptCount, includeDirectory, exitCode] of [
  ['count a directory script once regardless of nested files', 2, true, 0],
  ['reject catalog counts that omit a directory script', 1, true, 2],
  ['reject a missing directory script', 2, false, 2],
]) {
  test(name, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgverify-directory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, text) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    for (const file of ['VERSION', 'skills-manifest.json', 'Qoder-AI编码通用规则.md', 'README-安装说明.md', 'INDEX.md']) write(file, '{}\n');
    write('catalog.json', JSON.stringify({ counts: { skill: 0, command: 0, agent: 0, script: scriptCount } }));
    write('scripts/plain.cjs', 'module.exports = true;\n');
    if (includeDirectory) {
      write('scripts/runtime/package.json', '{"main":"index.cjs"}\n');
      write('scripts/runtime/package-lock.json', '{"lockfileVersion":3}\n');
      write('scripts/runtime/index.cjs', "module.exports = require('./lib/part.cjs');\n");
      write('scripts/runtime/lib/part.cjs', 'module.exports = true;\n');
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'share-package-verify.cjs'), root], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, exitCode, result.stdout + result.stderr);
    assert.match(result.stdout, exitCode === 0 ? /script=2/ : /catalog 计数不符/);
  });
}
