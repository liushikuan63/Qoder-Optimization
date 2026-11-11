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
const ROOT = path.join(TEMP, `mg-sensitive-${process.pid}-${Date.now()}`);
const BANK = path.join(HERE, '..', 'references', 'data', 'sensitive-words.json');
// 词库是单一真源：用例动态取词，不把敏感词抄进测试源码。
const WORD = Object.values(JSON.parse(fs.readFileSync(BANK, 'utf8')).categories).flat().find((w) => typeof w === 'string' && w.trim());

function fixture(name, files = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return dir;
}

function cli(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'sensitive-word-scan.mjs'), ...args], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, cwd,
  });
  const summary = /扫描 (\d+) 文件；命中 (\d+)/.exec(result.stdout || '');
  return { status: result.status, stdout: result.stdout || '', files: summary ? Number(summary[1]) : null, hits: summary ? Number(summary[2]) : null };
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('sensitive-word-scan', async (t) => {
  fs.mkdirSync(ROOT, { recursive: true });

  await t.test('word bank is readable and yields a usable probe word', () => {
    assert.ok(WORD && WORD.length > 0, '词库必须能取出至少一个词');
  });

  await t.test('a plain hit is reported and --strict turns it into exit 1', () => {
    const dir = fixture('hit', { 'copy.txt': `活动文案：${WORD}限时领取\n` });
    const warn = cli(['--path', dir]);
    assert.equal(warn.status, 0, '默认只报告不判红');
    assert.equal(warn.files, 1);
    assert.ok(warn.hits >= 1, '命中数必须 ≥1');
    assert.match(warn.stdout, /\[sensitive\]/);

    const strict = cli(['--path', dir, '--strict']);
    assert.equal(strict.status, 1, '--strict 命中必须 exit 1');
  });

  await t.test('negative control: prohibition context and clean copy are not hits', () => {
    const negated = fixture('negated', { 'copy.txt': `禁止出现${WORD}这类表述\n` });
    const negResult = cli(['--path', negated, '--strict']);
    assert.equal(negResult.hits, 0, '教学/禁止语境不得算命中');
    assert.equal(negResult.status, 0);

    const clean = fixture('clean', { 'copy.txt': '普通活动文案，没有任何命中词\n' });
    const cleanResult = cli(['--path', clean, '--strict']);
    assert.equal(cleanResult.hits, 0);
    assert.equal(cleanResult.status, 0);
  });

  await t.test('excluded directories and non-text files are not scanned', () => {
    const dir = fixture('excluded', {
      'keep.txt': '普通文案\n',
      'vendor/copy.txt': `活动文案：${WORD}限时领取\n`,
      'image.png': `活动文案：${WORD}限时领取\n`,
    });
    const result = cli(['--path', dir, '--exclude', 'vendor', '--strict']);
    assert.equal(result.status, 0);
    assert.equal(result.hits, 0);
    assert.equal(result.files, 1, '只应扫到 keep.txt：vendor 被排除、.png 不是文本扩展名');
  });
});