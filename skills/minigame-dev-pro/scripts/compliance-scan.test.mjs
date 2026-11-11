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
const ROOT = path.join(TEMP, `mg-compliance-${process.pid}-${Date.now()}`);

function project(name, code) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.js'), code, 'utf8');
  return dir;
}

function cli(args) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'compliance-scan.mjs'), ...args], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, cwd: ROOT,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('compliance-scan', async (t) => {
  fs.mkdirSync(ROOT, { recursive: true });

  await t.test('input contract and filter keys are enforced', () => {
    const missing = cli(['--json']);
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).error, /缺少必填参数 --project/);

    const absent = cli(['--project', path.join(ROOT, 'ghost'), '--json']);
    assert.equal(absent.status, 1);
    assert.match(JSON.parse(absent.stdout).error, /项目路径不存在/);

    const dir = project('bad-filter', 'export const a = 1;\n');
    const badFilter = cli(['--project', dir, '--filter', 'level:block', '--json']);
    assert.equal(badFilter.status, 1, '非法过滤器 key 必须中断而不是静默忽略');
    const body = JSON.parse(badFilter.stdout);
    assert.match(body.error, /无效的过滤器 key: level/);
    assert.match(body.hint, /severity, category, rule/);
  });

  await t.test('clean code passes and share-reward code is a blocking violation', () => {
    // RULE-005 要求接入防沉迷，否则任何项目都判 block；干净夹具必须带上它。
    const clean = project('clean', 'wx.checkIsUserAdvisedToRest({});\n');
    const pass = cli(['--project', clean, '--json']);
    assert.equal(pass.status, 0);
    const passBody = JSON.parse(pass.stdout);
    assert.equal(passBody.status, 'pass');
    assert.equal(passBody.totalViolationCount, 0);
    assert.equal(passBody.scannedFiles, 1);

    const dirty = project('dirty', 'wx.checkIsUserAdvisedToRest({});\nfunction shareReward() { return 1; }\n');
    const fail = cli(['--project', dirty, '--json']);
    const failBody = JSON.parse(fail.stdout);
    assert.equal(failBody.status, 'fail', '命中红线必须判 fail');
    assert.ok(failBody.totalViolationCount >= 1);
    assert.ok(failBody.violations.some((v) => v.rule === 'RULE-008' && v.severity === 'block'));
    // 现有契约：违规也 exit 0，调用方必须读 status；这里把该口径钉住，改动必须是有意为之。
    assert.equal(fail.status, 0);
    assert.match(failBody.recommendation, /必须修复/);
  });

  await t.test('known gap F30: share-reward wording inside a string literal is stripped and missed', () => {
    // 这不是"工具应该放行"的断言，而是把已知盲区钉住：collectJsFiles 会剥离注释与字符串字面量，
    // 于是中文分享奖励文案（真实项目里最常见的形态）检不出来。修掉盲区时本用例会判红，提醒同步更新。
    const dir = project('string-only', 'wx.checkIsUserAdvisedToRest({});\nconst tip = "分享得金币";\n');
    const body = JSON.parse(cli(['--project', dir, '--json']).stdout);
    assert.equal(body.status, 'pass');
    assert.equal(body.totalViolationCount, 0);
  });

  await t.test('filters narrow the list but never erase the total', () => {
    const dirty = project('filtered', 'wx.checkIsUserAdvisedToRest({});\nfunction shareReward() { return 1; }\n');
    const hit = cli(['--project', dirty, '--filter', 'rule:RULE-008', '--json']);
    const hitBody = JSON.parse(hit.stdout);
    assert.equal(hitBody.filterApplied, true);
    assert.ok(hitBody.violationCount >= 1);
    assert.ok(hitBody.violations.every((v) => v.rule === 'RULE-008'));

    const none = cli(['--project', dirty, '--filter', 'rule:RULE-999', '--json']);
    const noneBody = JSON.parse(none.stdout);
    assert.equal(noneBody.violationCount, 0, '过滤器不命中时列表为空');
    assert.ok(noneBody.totalViolationCount >= 1, '但总数不得被过滤器抹掉');
    assert.equal(noneBody.status, 'fail', '过滤后仍须按真实违规判 fail');
  });
});