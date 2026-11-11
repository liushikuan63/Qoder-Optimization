import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReleaseGate } from './release-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = process.env.MINIGAME_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEMP, `mg-release-gate-${process.pid}-${Date.now()}`);
const SECTIONS = ['上线前检查', '热更预案', '社区与合规沟通', 'Post-Mortem 复盘'];

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
  const result = spawnSync(process.execPath, [path.join(HERE, 'release-gate.mjs'), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, cwd,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('release-gate', async (t) => {
  await t.test('complete checklist passes and a missing section fails', () => {
    const full = fixture('full', { 'production/release-checklist.md': SECTIONS.join('\n') });
    const good = runReleaseGate(full);
    assert.equal(good.found, true);
    assert.equal(good.complete, true);
    assert.deepEqual(good.missing, []);

    const partial = fixture('partial', { 'production/release-checklist.md': SECTIONS.slice(0, 2).join('\n') });
    const bad = runReleaseGate(partial);
    assert.equal(bad.found, true);
    assert.equal(bad.complete, false, '缺章节必须判不完整');
    assert.deepEqual(bad.missing, ['复盘', '合规沟通']);
  });

  await t.test('absent checklist is reported, never silently complete', () => {
    const empty = fixture('empty');
    const result = runReleaseGate(empty);
    assert.equal(result.found, false);
    assert.equal(result.complete, false);
    assert.deepEqual(result.missing, ['上线前', '热更', '复盘', '合规沟通']);
  });

  await t.test('root-level checklist and explicit --checklist are both honoured', () => {
    const root = fixture('root-level', { 'release-checklist.md': SECTIONS.join('\n') });
    assert.equal(runReleaseGate(root).complete, true);
    const custom = fixture('custom', { 'docs/my-list.md': SECTIONS.join('\n') });
    const elsewhere = fixture('custom-project');
    assert.equal(runReleaseGate(elsewhere, { checklist: path.join(custom, 'docs/my-list.md') }).complete, true);
  });

  await t.test('CLI refuses missing or nonexistent --project', () => {
    const missing = cli(['--json']);
    assert.equal(missing.status, 1, 'P0 输入契约：缺 --project 必须 exit 1');
    assert.equal(JSON.parse(missing.stdout).ok, false);
    const absent = cli(['--project', path.join(ROOT, 'no-such-project'), '--json']);
    assert.equal(absent.status, 1);
    assert.match(JSON.parse(absent.stdout).error, /项目路径不存在/);
  });

  await t.test('CLI reports completeness without claiming official approval', () => {
    const full = fixture('cli-full', { 'production/release-checklist.md': SECTIONS.join('\n') });
    const good = cli(['--project', full, '--json']);
    assert.equal(good.status, 0);
    const goodBody = JSON.parse(good.stdout);
    assert.equal(goodBody.complete, true);
    assert.match(goodBody.note, /不标"已通过官方审核"/);

    const partial = fixture('cli-partial', { 'production/release-checklist.md': '上线前检查\n热更预案\n' });
    const bad = cli(['--project', partial, '--json']);
    // 现有契约：warn 级缺口仍 exit 0，调用方必须读 complete 字段，不能只看退出码。
    assert.equal(bad.status, 0);
    const badBody = JSON.parse(bad.stdout);
    assert.equal(badBody.complete, false);
    assert.deepEqual(badBody.missing, ['复盘', '合规沟通']);
  });
});