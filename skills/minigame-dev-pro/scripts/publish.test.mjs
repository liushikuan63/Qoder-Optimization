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
const ROOT = path.join(TEMP, `mg-publish-${process.pid}-${Date.now()}`);
// 上传不可逆：所有用例都指向一个不存在的 cli，确保永远走不到真实上传/真实设备。
const GHOST_CLI = path.join(ROOT, 'no-such-cli.bat');

function project(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ deviceOrientation: 'portrait' }), 'utf8');
  return dir;
}

function cli(args) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'publish.mjs'), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: ROOT,
    env: { ...process.env, WX_DEVTOOL_CLI: GHOST_CLI },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('publish gates (never uploads)', async (t) => {
  fs.mkdirSync(ROOT, { recursive: true });

  await t.test('missing project, absent project and missing version are refused', () => {
    const noProject = cli(['--json']);
    assert.equal(noProject.status, 1);
    assert.match(JSON.parse(noProject.stdout).error, /缺少必填参数 --project/);

    const absent = cli(['--project', path.join(ROOT, 'ghost'), '--version', '1.0.0', '--confirm', 'yes', '--cli', GHOST_CLI, '--json']);
    assert.equal(absent.status, 1);
    assert.match(JSON.parse(absent.stdout).error, /项目路径不存在/);

    const dir = project('no-version');
    const noVersion = cli(['--project', dir, '--confirm', 'yes', '--cli', GHOST_CLI, '--json']);
    assert.equal(noVersion.status, 1);
    assert.match(JSON.parse(noVersion.stdout).error, /缺少必填参数 --version/);
  });

  await t.test('version must be closed semver, not an injectable prefix', () => {
    const dir = project('bad-version');
    for (const version of ['1.0', 'v1.0.0', '1.0.0; echo hacked', '1.0.0 --robot 1', '']) {
      const result = cli(['--project', dir, '--version', version, '--confirm', 'yes', '--cli', GHOST_CLI, '--json']);
      assert.equal(result.status, 1, `版本号 ${JSON.stringify(version)} 必须被拒`);
      assert.match(JSON.parse(result.stdout).error, /版本号格式不正确|缺少必填参数 --version/);
    }
    const good = cli(['--project', dir, '--version', '1.0.0-rc1', '--confirm', 'yes', '--cli', GHOST_CLI, '--json']);
    assert.equal(good.status, 1, '合法版本号也只应停在 cli 不可用这一步');
    assert.match(JSON.parse(good.stdout).error, /指定的 cli 路径不存在/);
  });

  await t.test('irreversible upload requires an explicit --confirm yes', () => {
    const dir = project('confirm');
    for (const args of [[], ['--confirm', 'no'], ['--confirm', 'true'], ['--confirm', 'YES']]) {
      const result = cli(['--project', dir, '--version', '1.0.0', '--cli', GHOST_CLI, '--json', ...args]);
      assert.equal(result.status, 1, `确认参数 ${JSON.stringify(args)} 不得放行上传`);
      const body = JSON.parse(result.stdout);
      assert.match(body.error, /不可逆操作，需显式确认/);
      assert.match(body.hint, /--confirm yes/);
    }
    // 负对照的反面：显式 yes 才越过确认门，随后仍被不存在的 cli 挡住（证明门顺序正确且没有真上传）。
    const confirmed = cli(['--project', dir, '--version', '1.0.0', '--confirm', 'yes', '--cli', GHOST_CLI, '--json']);
    assert.equal(confirmed.status, 1);
    assert.match(JSON.parse(confirmed.stdout).error, /指定的 cli 路径不存在/);
    assert.ok(!/已上传|uploaded/.test(confirmed.stdout), '任何用例都不得出现上传成功');
  });
});