import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = process.env.MINIGAME_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEMP, `mg-copyright-${process.pid}-${Date.now()}`);
const BANK = path.join(HERE, '..', 'references', 'data', 'copyright-ip.json');
const HINTS = (() => {
  try {
    const bank = JSON.parse(fs.readFileSync(BANK, 'utf8'));
    if (Array.isArray(bank.unauthorizedIpHints) && bank.unauthorizedIpHints.length) return bank.unauthorizedIpHints;
  } catch { /* 词库不可用时用内置回退 */ }
  return ['disney', 'pokemon'];
})();
const HINT = HINTS.find((h) => /^[A-Za-z0-9_-]+$/.test(h)) || 'disney';

function assets(name, files) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'fixture-bytes', 'utf8');
  return dir;
}

function cli(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, cwd: ROOT,
  });
  const summary = /扫描 (\d+) 文件；授权警示 (\d+)/.exec(result.stdout || '');
  return { status: result.status, stdout: result.stdout || '', files: summary ? Number(summary[1]) : null, warnings: summary ? Number(summary[2]) : null };
}

const TOOL = path.join(HERE, 'copyright-asset-scan.mjs');

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('copyright-asset-scan', async (t) => {
  fs.mkdirSync(ROOT, { recursive: true });

  await t.test('an IP hint in a filename raises a warning, a clean name does not', () => {
    const risky = assets('risky', [`${HINT}-background.png`, 'hero.png']);
    const hit = cli(TOOL, ['--path', risky]);
    assert.equal(hit.status, 0, '只 warning，不自动判定侵权');
    assert.equal(hit.files, 2);
    assert.ok(hit.warnings >= 1, '文件名含未授权 IP 线索必须警示');
    assert.match(hit.stdout, /\[copyright-warn\]/);
    assert.match(hit.stdout, /须人工确认/);

    const clean = assets('clean', ['hero.png', 'background.png']);
    const none = cli(TOOL, ['--path', clean]);
    assert.equal(none.warnings, 0, '干净文件名不得产生警示');
    assert.equal(none.files, 2);
  });

  await t.test('missing --path prints usage and an absent directory scans nothing', () => {
    const usage = cli(TOOL, []);
    assert.equal(usage.status, 0);
    assert.match(usage.stdout, /用法：node copyright-asset-scan\.mjs --path/);

    const absent = cli(TOOL, ['--path', path.join(ROOT, 'ghost-dir')]);
    assert.equal(absent.status, 0);
    assert.equal(absent.files, 0);
    assert.equal(absent.warnings, 0);
  });

  await t.test('a missing bank falls back to the built-in hints instead of crashing', () => {
    // 把脚本复制到隔离目录：其 references/data 不存在，必须走内置回退列表。
    const sandbox = path.join(ROOT, 'no-bank');
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    const copy = path.join(sandbox, 'scripts', 'copyright-asset-scan.mjs');
    fs.copyFileSync(TOOL, copy);
    const dir = path.join(sandbox, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'disney-castle.png'), 'fixture-bytes', 'utf8');
    const result = cli(copy, ['--path', dir]);
    assert.equal(result.status, 0);
    assert.equal(result.files, 1);
    assert.ok(result.warnings >= 1, '词库缺失时回退列表仍须生效');
  });
});