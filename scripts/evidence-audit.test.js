#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const { auditFile } = require('./evidence-audit.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-audit-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  const traces = {
    positive: { schema: 1, runId: 'round-1', cwd: root, level: 'static', termination: 'completed', exitCode: 0, stdout: 'PASS', stderr: '' },
    negative: { schema: 1, runId: 'round-1', cwd: root, level: 'static', termination: 'completed', exitCode: 1, stdout: 'FAIL', stderr: '' },
  };
  const plan = { schema: 1, task: 'audit-test', runId: 'round-1', cwd: root, checks: [{
    id: 'contract', claim: '测试检查器的证据要求', status: 'verified', requiredLevel: 'static', changedVariable: '移除一条条款',
    positive: { file: 'positive.json', sha256: '', expect: { exitCode: 0, stdoutIncludes: ['PASS'] } },
    negative: { file: 'negative.json', sha256: '', expect: { exitCode: 1, stdoutIncludes: ['FAIL'] } },
  }] };
  const writeTrace = side => {
    const buffer = Buffer.from(JSON.stringify(traces[side]));
    fs.writeFileSync(path.join(bundle, side + '.json'), buffer);
    plan.checks[0][side].sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  };
  writeTrace('positive'); writeTrace('negative');
  const report = path.join(bundle, 'report.json');
  const write = () => fs.writeFileSync(report, JSON.stringify(plan));
  const run = () => { write(); return auditFile(report); };
  return { root, bundle, report, traces, plan, writeTrace, write, run };
}
function assertBad(result, state) {
  assert.equal(result.exitCode, 1);
  if (state) assert.equal(result.results[0].state, state);
}

test('静态证据完整、输出和退出码正确可通过', t => {
  const f = fixture(t); const r = f.run();
  assert.equal(r.exitCode, 0); assert.equal(r.counts.accepted, 1);
});
test('静态证据不能冒充运行时行为', t => {
  const f = fixture(t); f.plan.checks[0].requiredLevel = 'runtime';
  assertBad(f.run(), 'REJECTED');
});
test('模拟推演不能冒充运行时行为', t => {
  const f = fixture(t); f.plan.checks[0].requiredLevel = 'runtime';
  for (const side of ['positive', 'negative']) { f.traces[side].level = 'simulation'; f.writeTrace(side); }
  assertBad(f.run(), 'REJECTED');
});
test('产物类型不是运行时行为的更高级替代', t => {
  const f = fixture(t); f.plan.checks[0].requiredLevel = 'runtime';
  for (const side of ['positive', 'negative']) { f.traces[side].level = 'artifact'; f.writeTrace(side); }
  assertBad(f.run(), 'REJECTED');
});
test('JSON日志被修改后哈希校验拒绝', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.bundle, 'positive.json'), ' ');
  assertBad(f.run(), 'REJECTED');
});
test('证据缺失明确不完整，不抛错或假绿', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.bundle, 'negative.json'));
  assertBad(f.run(), 'INCOMPLETE');
});
test('证据来自旧轮次必须拒绝', t => {
  const f = fixture(t); f.traces.positive.runId = 'old-round'; f.writeTrace('positive');
  assertBad(f.run(), 'REJECTED');
});
test('证据来自其他目录作用域必须拒绝', t => {
  const f = fixture(t); f.traces.positive.cwd = path.join(f.root, 'other'); f.writeTrace('positive');
  assertBad(f.run(), 'REJECTED');
});
for (const termination of ['skipped', 'timeout', 'crashed']) {
  test('负对照' + termination + '不能被非零退出伪装为预期失败', t => {
    const f = fixture(t); f.traces.negative.termination = termination; f.writeTrace('negative');
    assertBad(f.run(), 'INCOMPLETE');
  });
}
test('负对照不符合预期不能通过', t => {
  const f = fixture(t); f.traces.negative.exitCode = 0; f.writeTrace('negative');
  assertBad(f.run(), 'REJECTED');
});
test('正负对照用同一期望必须拒绝', t => {
  const f = fixture(t); f.plan.checks[0].negative.expect = f.plan.checks[0].positive.expect;
  assertBad(f.run(), 'REJECTED');
});
test('正负记录相同即使宽匹配都满足也拒绝', t => {
  const f = fixture(t);
  for (const side of ['positive', 'negative']) { f.traces[side].exitCode = 0; f.traces[side].stdout = 'PASS FAIL'; f.writeTrace(side); }
  f.plan.checks[0].negative.expect.exitCode = 0;
  assertBad(f.run(), 'REJECTED');
});
test('同一证据文件不算两个独立对照', t => {
  const f = fixture(t); f.traces.positive.stdout = 'PASS FAIL'; f.writeTrace('positive');
  f.plan.checks[0].negative = { file: './positive.json', sha256: f.plan.checks[0].positive.sha256, expect: { exitCode: 0, stdoutIncludes: ['FAIL'] } };
  assertBad(f.run(), 'REJECTED');
});
test('HTTP等负向测试可以正常退出但具有不同观察值', t => {
  const f = fixture(t);
  f.traces.positive.stdout = 'status=200'; f.traces.negative.stdout = 'status=404'; f.traces.negative.exitCode = 0;
  f.writeTrace('positive'); f.writeTrace('negative');
  f.plan.checks[0].positive.expect = { exitCode: 0, stdoutIncludes: ['status=200'] };
  f.plan.checks[0].negative.expect = { exitCode: 0, stdoutIncludes: ['status=404'] };
  assert.equal(f.run().exitCode, 0);
});
for (const status of ['unverified', 'hypothesis']) {
  test(status + '不能被算为已验证', t => {
    const f = fixture(t); f.plan.checks[0].status = status; f.plan.checks[0].reason = '本轮未完成验证';
    assertBad(f.run(), 'INCOMPLETE');
  });
}
test('全部排除不允许宣布全绿', t => {
  const f = fixture(t); f.plan.checks[0].status = 'excluded'; f.plan.checks[0].reason = '不属于当前范围';
  const r = f.run(); assert.equal(r.exitCode, 1); assert.equal(r.counts.excluded, 1); assert.equal(r.counts.accepted, 0);
});
test('未验证项或排除项必须给理由', t => {
  const f = fixture(t); f.plan.checks[0].status = 'excluded';
  assert.equal(f.run().exitCode, 2);
});
test('空检查清单不能宣布通过', t => {
  const f = fixture(t); f.plan.checks = [];
  assert.equal(f.run().exitCode, 1);
});
test('证据路径越界即使文件存在也拒绝', t => {
  const f = fixture(t); fs.copyFileSync(path.join(f.bundle, 'positive.json'), path.join(f.root, 'outside.json'));
  f.plan.checks[0].positive.file = '../outside.json';
  assertBad(f.run(), 'REJECTED');
});
test('绝对证据路径不自动扩大读取范围', t => {
  const f = fixture(t); f.plan.checks[0].positive.file = path.join(f.bundle, 'positive.json');
  assertBad(f.run(), 'REJECTED');
});
test('坏JSON证据明确不完整', t => {
  const f = fixture(t); const file = path.join(f.bundle, 'positive.json'); fs.writeFileSync(file, '{');
  f.plan.checks[0].positive.sha256 = crypto.createHash('sha256').update('{').digest('hex');
  assertBad(f.run(), 'INCOMPLETE');
});
test('坏JSON报告单独返回参数错误', t => {
  const f = fixture(t); fs.writeFileSync(f.report, '{');
  assert.equal(auditFile(f.report).exitCode, 2);
});
test('格式近似但类型错误不能触发脚本崩溃', t => {
  const f = fixture(t); f.plan.checks[0].positive.sha256 = [f.plan.checks[0].positive.sha256];
  assert.equal(f.run().exitCode, 2);
});
test('证据读取设体积边界', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.bundle, 'positive.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assertBad(f.run(), 'INCOMPLETE');
});
test('审计本身只读，不执行记录中命令，不改报告与文件', t => {
  const f = fixture(t); f.traces.positive.command = '此字段不是可执行指令'; f.writeTrace('positive'); f.write();
  const files = fs.readdirSync(f.bundle).sort();
  const before = files.map(n => fs.readFileSync(path.join(f.bundle, n)).toString('hex'));
  const r = auditFile(f.report); assert.equal(r.exitCode, 0);
  assert.deepEqual(fs.readdirSync(f.bundle).sort(), files);
  assert.deepEqual(files.map(n => fs.readFileSync(path.join(f.bundle, n)).toString('hex')), before);
});
test('CLI可直接调用并返回结构化只读结论', t => {
  const f = fixture(t); f.write();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'evidence-audit.cjs'), f.report, '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).verdict, 'PASS');
});
test('只改日志时间戳但两套预期均满足必须拒绝', t => {
  const f = fixture(t);
  for (const side of ['positive', 'negative']) {
    f.traces[side].exitCode = 0;
    f.traces[side].stdout = 'PASS FAIL timestamp=' + (side === 'positive' ? '1' : '2');
    f.writeTrace(side);
  }
  f.plan.checks[0].negative.expect.exitCode = 0;
  assertBad(f.run(), 'REJECTED');
});
test('弱正例预期若也匹配负例必须拒绝', t => {
  const f = fixture(t); f.traces.negative.exitCode = 0; f.writeTrace('negative');
  f.plan.checks[0].positive.expect = { exitCode: 0 };
  f.plan.checks[0].negative.expect.exitCode = 0;
  assertBad(f.run(), 'REJECTED');
});
test('CLI多传报告不能静默忽略后续文件', t => {
  const f = fixture(t); f.write();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'evidence-audit.cjs'), f.report, path.join(f.bundle, 'second.json')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2);
});
// 2026-10-27：--from-transcript 草稿（采集不判绿）
function transcriptFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: '跑一下测试' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'PASS 42', is_error: false }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'error TS1005', is_error: true }] } },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { root, file };
}
test('草稿采集本轮命令与退出码，且不判绿', t => {
  const f = transcriptFixture(t);
  const out = path.join(f.root, 'bundle', 'report.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'evidence-audit.cjs'), '--from-transcript', f.file, '--out', out], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(report.checks.length, 2);
  assert.ok(report.checks.every(c => c.status === 'unverified'));
  const failed = JSON.parse(fs.readFileSync(path.join(f.root, 'bundle', 'records', 'cmd-2.json'), 'utf8'));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.command, 'npm run build');
  // 审计草稿必须是 INCOMPLETE（退出 1），不能因为"有记录"就绿
  const audit = auditFile(out);
  assert.equal(audit.exitCode, 1);
  assert.equal(audit.verdict, 'INCOMPLETE');
});
test('草稿在本轮没有 Bash 命令时明确失败', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-draft-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: '只聊天' } }) + '\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'evidence-audit.cjs'), '--from-transcript', file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /没有找到本轮 Bash 命令/);
});
test('部分排除只标部分覆盖，不宣布全绿', t => {
  const f = fixture(t);
  f.plan.checks.push({ id: 'not-tested', claim: '另一未验范围', status: 'excluded', requiredLevel: 'runtime', reason: '本轮范围不包含' });
  const r = f.run(); assert.equal(r.verdict, 'PARTIAL'); assert.equal(r.exitCode, 1);
  assert.equal(r.counts.accepted, 1); assert.equal(r.counts.excluded, 1);
});
// 2026-11-17：交付前返工防线——需求覆盖矩阵与证据时效
function greenWithCoverage(f) {
  f.plan.lastChangeAt = '2026-11-17T10:00:00Z';
  f.plan.requirements = [{ id: 'req-1', text: '需求：修好后原有入口仍可用', checkIds: ['contract'] }];
  for (const side of ['positive', 'negative']) { f.traces[side].finishedAt = '2026-11-17T10:05:00Z'; f.writeTrace(side); }
}
test('需求全覆盖且证据晚于最后一轮改动可通过', t => {
  const f = fixture(t); greenWithCoverage(f);
  const r = f.run(); assert.equal(r.exitCode, 0); assert.equal(r.verdict, 'PASS');
  assert.equal(r.requirementCounts.accepted, 1);
});
test('需求没有映射到任何检查判红', t => {
  const f = fixture(t); greenWithCoverage(f); f.plan.requirements[0].checkIds = [];
  const r = f.run(); assert.equal(r.exitCode, 1); assert.equal(r.verdict, 'FAIL');
  assert.equal(r.requirements[0].state, 'REJECTED');
});
test('需求映射到未验证检查不完整', t => {
  const f = fixture(t); greenWithCoverage(f);
  f.plan.checks[0].status = 'unverified'; f.plan.checks[0].reason = '本轮未完成验证';
  const r = f.run(); assert.equal(r.exitCode, 1); assert.equal(r.verdict, 'INCOMPLETE');
  assert.equal(r.requirements[0].state, 'INCOMPLETE');
});
test('需求引用不存在的检查判红', t => {
  const f = fixture(t); greenWithCoverage(f); f.plan.requirements[0].checkIds = ['missing-check'];
  const r = f.run(); assert.equal(r.exitCode, 1); assert.equal(r.requirements[0].state, 'REJECTED');
});
test('证据早于最后一轮改动判红', t => {
  const f = fixture(t); greenWithCoverage(f);
  f.traces.negative.finishedAt = '2026-11-17T09:59:00Z'; f.writeTrace('negative');
  assertBad(f.run(), 'REJECTED');
});
test('声明改动时间但记录缺完成时间不完整', t => {
  const f = fixture(t); greenWithCoverage(f);
  delete f.traces.positive.finishedAt; f.writeTrace('positive');
  assertBad(f.run(), 'INCOMPLETE');
});
test('需求对应检查全部排除只标部分覆盖，不宣布全绿', t => {
  const f = fixture(t); greenWithCoverage(f);
  f.plan.checks[0].status = 'excluded'; f.plan.checks[0].reason = '本轮范围不包含';
  const r = f.run(); assert.equal(r.exitCode, 1); assert.equal(r.verdict, 'INCOMPLETE');
  assert.equal(r.requirements[0].state, 'EXCLUDED');
});
test('非法lastChangeAt让报告返回参数错误而不是静默通过', t => {
  const f = fixture(t); greenWithCoverage(f); f.plan.lastChangeAt = '2026-11-17';
  assert.equal(f.run().exitCode, 2);
});
test('变异对照：把需求改指向未验证检查后绿报告必须变红', t => {
  const f = fixture(t); greenWithCoverage(f);
  assert.equal(f.run().exitCode, 0);
  f.plan.requirements[0].checkIds = ['missing-check'];
  assert.equal(f.run().exitCode, 1);
  const r = auditFile(f.report); assert.equal(r.verdict, 'FAIL');
});
