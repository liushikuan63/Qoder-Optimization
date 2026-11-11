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
const ROOT = path.join(TEMP, `mg-gate-check-${process.pid}-${Date.now()}`);

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

function minigame(name) {
  return fixture(name, {
    'game.json': JSON.stringify({ deviceOrientation: 'portrait' }),
    'game.js': 'export const started = true;\n',
    'project.config.json': JSON.stringify({ appid: 'wx0000000000000000', projectname: name }),
  });
}

function cli(args) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'gate-check.mjs'), ...args], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, cwd: ROOT,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('gate-check', async (t) => {
  fs.mkdirSync(ROOT, { recursive: true });

  await t.test('input contract: project, platform and supported platform are all required', () => {
    const noProject = cli(['--json']);
    assert.equal(noProject.status, 1);
    assert.match(JSON.parse(noProject.stdout).error, /缺少必填参数 --project/);

    const dir = minigame('no-platform');
    const noPlatform = cli(['--project', dir, '--json']);
    assert.equal(noPlatform.status, 1);
    assert.match(JSON.parse(noPlatform.stdout).error, /缺少 --platform/);

    const unsupported = cli(['--project', dir, '--platform', 'alipay', '--json']);
    assert.equal(unsupported.status, 1, '未核实预算的平台不得放行');
    assert.match(JSON.parse(unsupported.stdout).error, /预算未核实/);

    const absent = cli(['--project', path.join(ROOT, 'ghost'), '--platform', 'wechat', '--json']);
    assert.equal(absent.status, 1);
    assert.match(JSON.parse(absent.stdout).error, /项目路径不存在/);
  });

  await t.test('a non-minigame directory is a hard failure and still writes the report', () => {
    const dir = fixture('not-a-game', { 'README.md': '只是一个普通目录\n' });
    const out = path.join(ROOT, 'report-out');
    const result = cli(['--project', dir, '--platform', 'wechat', '--out', out, '--json']);
    assert.equal(result.status, 1, '结构非法必须硬失败');
    const body = JSON.parse(result.stdout);
    assert.equal(body.gate, 'fail');
    assert.equal(body.readyForRelease, false);
    assert.ok(body.failures.some((f) => f.category === 'structure' && f.level === 'error'));
    assert.equal(fs.existsSync(path.join(out, 'gate-report.md')), true, '判红也要留下报告');
    assert.equal(body.reportPath, path.join(out, 'gate-report.md'));
  });

  await t.test('a valid minigame clears the structure layer (negative control for the case above)', () => {
    const dir = minigame('valid-game');
    const result = cli(['--project', dir, '--platform', 'wechat', '--json']);
    assert.equal(result.status, 0, '结构合法时不得硬失败');
    const body = JSON.parse(result.stdout);
    assert.equal(body.structure.valid, true);
    assert.equal(body.structure.type, 'minigame');
    assert.notEqual(body.gate, 'fail');
    assert.ok(!body.failures.some((f) => f.category === 'structure'), '结构层不得再出现在 failures 里');
    assert.equal(fs.existsSync(path.join(dir, 'production', 'gate-report.md')), true);
    // 证据不全时只能是 warn，绝不冒充可上线。
    if (body.gate === 'warn') assert.equal(body.readyForRelease, false);
  });
});