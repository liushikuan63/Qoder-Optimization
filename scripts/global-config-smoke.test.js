#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const { resolveSkillFile } = require('./client-root.js');
const runner = resolveSkillFile('global-config-smoke-runner', 'scripts/smoke-runner.cjs');
const checkerNames = ['skills-doctor.cjs', 'skill-collisions.cjs', 'config-doctor.cjs', 'rules-weekly-audit.js'];

function setup(t, singleClient = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  if (!singleClient) fs.mkdirSync(path.join(root, '.qoder-cn'));
  for (const name of checkerNames) fs.writeFileSync(path.join(scripts, name), 'console.log("未指认=0");');
  fs.writeFileSync(path.join(scripts, 'probe.test.js'), 'process.exit(0);');
  function run(args = []) {
    const r = spawnSync(process.execPath, [runner, ...args], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: root, USERPROFILE: root, TMP: root, TEMP: root, TMPDIR: root, SMOKE_SCRIPTS_DIR: scripts },
    });
    const dir = fs.readdirSync(root).find(n => n.startsWith('qoder-smoke-'));
    const summary = dir ? JSON.parse(fs.readFileSync(path.join(root, dir, 'summary.json'), 'utf8')) : null;
    return { ...r, summary };
  }
  return { scripts, run };
}

test('正常脚本和必需检查器全部执行', t => {
  const f = setup(t); const r = f.run();
  assert.equal(r.status, 0, r.stderr); assert.equal(r.summary.total, 5);
  assert.equal(r.summary.green, 5); assert.equal(r.summary.skip, 0);
});
test('必需检查器缺失必须非零，不计为合法跳过', t => {
  const f = setup(t); fs.unlinkSync(path.join(f.scripts, 'config-doctor.cjs'));
  const r = f.run(); assert.equal(r.status, 1);
  assert.equal(r.summary.red, 1); assert.equal(r.summary.skip, 0);
  assert.ok(r.summary.results.some(e => e.name === 'config-doctor' && e.exit === 'MISSING'));
});
test('单客户端不适用检查器仍合法跳过', t => {
  const f = setup(t, true);
  for (const n of checkerNames.slice(0, 3)) fs.unlinkSync(path.join(f.scripts, n));
  const r = f.run(); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary.skip, 3); assert.equal(r.summary.green, 2);
});
test('子测试非零保留失败状态', t => {
  const f = setup(t); fs.writeFileSync(path.join(f.scripts, 'probe.test.js'), 'process.exit(7);');
  const r = f.run(['--tests-only']); assert.equal(r.status, 1);
  assert.equal(r.summary.results[0].exit, 7);
});
test('子测试超时计红，不当作退出0', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.scripts, 'probe.test.js'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);');
  const r = f.run(['--tests-only', '--timeout-ms', '1000']);
  assert.equal(r.status, 1); assert.equal(r.summary.results[0].exit, 'TIMEOUT');
});
test('周检必须传只读参数', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.scripts, 'rules-weekly-audit.js'), 'process.exit(process.argv.includes("--no-fix") ? 0 : 9);');
  const r = f.run(['--only', 'rules-weekly-audit']); assert.equal(r.status, 0, r.stdout);
});
