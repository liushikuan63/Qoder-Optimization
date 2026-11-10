'use strict';
// 开工确认核心自测：画像、绑定、卡片校验、AskUserQuestion 载荷、台账与隐私。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-test-'));
process.env.KICKOFF_STATE_DIR = STATE;
const core = require('./kickoff-core.cjs');

let n = 0;
function check(label, fn) {
  try { fn(); console.log('PASS  ' + label); }
  catch (error) { n++; console.log('FAIL  ' + label + ' :: ' + (error.code || error.message)); }
}
function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}
function freshState() {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
}
function contextFor(prompt = '修复登录按钮的文案', session = 'sess-1') {
  return core.createKickoffContext({ sessionId: session, prompt, cwd: process.cwd(), requestMessageId: 'msg-' + session });
}
function simpleCard(context) {
  return {
    schema: 1,
    bindingDigest: context.binding,
    taskId: 'task-simple',
    profile: 'simple',
    understanding: {
      goal: '修复登录按钮文案',
      object: '登录页按钮',
      scope: '只改文案，不改样式',
      acceptance: '按钮显示新文案且页面无回归',
      prohibitions: ['不改样式', '不动接口'],
    },
    steps: ['定位按钮文案', '修改文案', '复跑页面测试'],
    parallel: { mode: 'serial', reason: '单文件小改动，串行即可' },
  };
}
function complexCard(context) {
  return {
    schema: 1,
    bindingDigest: context.binding,
    taskId: 'task-complex',
    profile: 'complex',
    understanding: {
      goal: '跨模块修复权限并发布',
      object: '权限模块与发布脚本',
      scope: '后端鉴权、hook、测试与发布',
      acceptance: '全量测试通过且 Release 资产可下载',
      prohibitions: ['不改生产凭据'],
    },
    steps: ['只读取证', '改鉴权', '改 hook', '跑全量', '发布复验'],
    parallel: { mode: 'parallel', reason: '只读调查可并行，写入收敛为单会话' },
    documentation: { mode: 'update', target: 'README.md', recommend: true, reason: '交接需要' },
    goal: { mode: 'create', title: '权限修复与发布', recommend: true, reason: '跨多回合' },
  };
}

console.log('# classify');
check('纯问答：短问题不建卡', () => assert.strictEqual(core.classifyKickoffTask('这个函数是做什么的？').profile, 'question'));
check('纯问答：如何优化是问答', () => assert.strictEqual(core.classifyKickoffTask('如何优化这个函数？').profile, 'question'));
check('简单任务：单文件改文案', () => assert.strictEqual(core.classifyKickoffTask('把 README 的版本号改成 0.1.5').profile, 'simple'));
check('复杂任务：跨模块+发布', () => assert.strictEqual(core.classifyKickoffTask('跨模块重构权限校验，改 hook、测试并发布 0.1.5').profile, 'complex'));
check('复杂任务：长请求', () => assert.strictEqual(core.classifyKickoffTask('修复登录按钮文案。' + '补充上下文。'.repeat(30)).profile, 'complex'));
check('命令入口不建卡', () => assert.strictEqual(core.classifyKickoffTask('/clarify 帮我理一下').profile, 'question'));
check('用户显式跳过确认', () => assert.strictEqual(core.classifyKickoffTask('直接做，不用确认，改个文案').explicitSkip, true));
check('继续指令识别', () => assert.strictEqual(core.isContinuation('继续'), true));
check('带范围变化的继续不算', () => assert.strictEqual(core.isContinuation('继续，但把范围改成跨模块'), false));

console.log('# prepare');
freshState();
check('纯问答不创建 pending', () => {
  const result = core.prepareKickoff({ sessionId: 'sess-q', prompt: '这个函数是做什么的？', cwd: process.cwd() });
  assert.strictEqual(result.skip, true);
  assert.strictEqual(result.reason, 'QUESTION');
  assert.strictEqual(fs.readdirSync(STATE).filter(name => name.startsWith('pending-')).length, 0);
});
check('执行任务创建 pending 且不存原文', () => {
  const prompt = '修复登录按钮的文案';
  const result = core.prepareKickoff({ sessionId: 'sess-p', prompt, cwd: process.cwd() });
  assert.strictEqual(result.skip, false);
  const file = path.join(STATE, 'pending-sess-p.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(result.context.binding));
  assert.ok(!text.includes(prompt), 'pending must not store raw prompt');
  const pending = core.readPending('sess-p');
  assert.ok(pending && pending.context.requestDigest === crypto.createHash('sha256').update(prompt).digest('hex'));
});
check('缺少 session 时跳过', () => {
  assert.strictEqual(core.prepareKickoff({ sessionId: '', prompt: '修复按钮', cwd: process.cwd() }).reason, 'NO_SESSION');
});
check('非法 cwd 报错', () => {
  throwsCode(() => core.prepareKickoff({ sessionId: 'sess-x', prompt: '修复按钮', cwd: 'relative' }), 'INVALID_KICKOFF_CONTEXT');
});

console.log('# compose');
freshState();
check('简单卡只返回计划确认 1 问', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-c1');
  core.writePending(context);
  const result = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  assert.strictEqual(result.action, 'ASK_CONFIRMATION');
  assert.strictEqual(result.profile, 'simple');
  assert.strictEqual(result.questions.length, 1);
  assert.strictEqual(result.questions[0].options[0].label.includes('推荐'), true);
  assert.ok(result.cardDigest);
});
check('复杂卡返回计划/文档/目标/并行 4 问', () => {
  const context = contextFor('跨模块重构权限校验并发布', 'sess-c2');
  core.writePending(context);
  const result = core.composeCard({ schema: 1, context, card: complexCard(context) }, context.binding);
  assert.strictEqual(result.questions.length, 4);
  assert.deepStrictEqual(result.questions.slice(1).map(item => item.header), ['文档', '目标', '并行']);
  assert.ok(result.questions[1].options[0].label.includes('推荐'));
  assert.ok(result.questions[2].options[0].label.includes('推荐'));
  assert.ok(result.questions[3].options[0].label.includes('推荐'));
});
check('绑定不符拒绝', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-c3');
  core.writePending(context);
  throwsCode(() => core.composeCard({ schema: 1, context, card: simpleCard(context) }, '0'.repeat(64)), 'KICKOFF_SCOPE_MISMATCH');
});
check('步骤不足拒绝', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-c4');
  core.writePending(context);
  const card = { ...simpleCard(context), steps: ['只一步'] };
  throwsCode(() => core.composeCard({ schema: 1, context, card }, context.binding), 'INVALID_KICKOFF_CARD');
});
check('简单卡不得请求文档或目标', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-c5');
  core.writePending(context);
  const card = { ...simpleCard(context), documentation: { mode: 'update', target: 'README.md', recommend: true, reason: '需要' } };
  throwsCode(() => core.composeCard({ schema: 1, context, card }, context.binding), 'INVALID_KICKOFF_CARD');
});
check('复杂卡必须决定文档与目标', () => {
  const context = contextFor('跨模块重构权限校验并发布', 'sess-c6');
  core.writePending(context);
  const card = complexCard(context);
  delete card.goal;
  throwsCode(() => core.composeCard({ schema: 1, context, card }, context.binding), 'INVALID_KICKOFF_CARD');
});
check('compose 后 pending 记录卡片摘要与模式', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-c7');
  core.writePending(context);
  const result = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  const pending = core.readPending('sess-c7');
  assert.strictEqual(pending.cardDigest, result.cardDigest);
  assert.deepStrictEqual(pending.modes, { documentation: 'none', goal: 'none', parallel: 'serial' });
});

console.log('# record');
freshState();
check('未 compose 不能记录确认', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r1');
  core.writePending(context);
  throwsCode(() => core.recordConfirmation({ schema: 1, context, cardDigest: '0'.repeat(64), choice: 'proceed' }, context.binding), 'CARD_NOT_COMPOSED');
});
check('proceed 记录确认并清 pending', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r2');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  const result = core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'proceed' }, context.binding);
  assert.strictEqual(result.action, 'proceed');
  assert.strictEqual(core.readPending('sess-r2'), null);
  const confirmed = core.readConfirmed('sess-r2');
  assert.strictEqual(confirmed.choice, 'proceed');
  assert.deepStrictEqual(confirmed.selections, { documentation: 'none', goal: 'none', parallel: 'serial' });
});
check('错误 cardDigest 拒绝', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r3');
  core.writePending(context);
  core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  throwsCode(() => core.recordConfirmation({ schema: 1, context, cardDigest: 'f'.repeat(64), choice: 'proceed' }, context.binding), 'STALE_KICKOFF_CARD');
});
check('adjust 保留 pending', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r4');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  const result = core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'adjust' }, context.binding);
  assert.strictEqual(result.action, 'revise');
  assert.ok(core.readPending('sess-r4'));
});
check('cancel 记录取消并清 pending', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r5');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'cancel' }, context.binding);
  assert.strictEqual(core.readPending('sess-r5'), null);
  assert.strictEqual(core.readConfirmed('sess-r5').choice, 'cancel');
});
check('已确认后继续指令不重复建卡', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-r6');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'proceed' }, context.binding);
  const result = core.prepareKickoff({ sessionId: 'sess-r6', prompt: '继续', cwd: process.cwd() });
  assert.strictEqual(result.reason, 'CONTINUATION');
  assert.ok(core.buildContinuationNote(result.continuation).includes('已确认继续'));
});

console.log('# state safety');
freshState();
check('篡改 pending 上下文后读取为空', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-t1');
  core.writePending(context);
  const file = path.join(STATE, 'pending-sess-t1.json');
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  pending.context.profileHint = 'complex';
  fs.writeFileSync(file, JSON.stringify(pending));
  assert.strictEqual(core.readPending('sess-t1'), null);
});
check('过期 pending 读取为空', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-t2');
  core.writePending(context);
  const file = path.join(STATE, 'pending-sess-t2.json');
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  pending.at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(pending));
  assert.strictEqual(core.readPending('sess-t2'), null);
});
check('confirmed 只存哈希与选择', () => {
  const context = contextFor('修复登录按钮的文案', 'sess-t3');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: simpleCard(context) }, context.binding);
  core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'proceed' }, context.binding);
  const text = fs.readFileSync(path.join(STATE, 'confirmed-sess-t3.json'), 'utf8');
  assert.ok(!text.includes('修复登录按钮的文案'));
  assert.ok(!text.includes('定位按钮文案'));
  assert.ok(text.includes(composed.cardDigest));
});

console.log('# CLI');
freshState();
check('compose CLI 从 stdin 读取并返回载荷', () => {
  const context = core.prepareKickoff({ sessionId: 'sess-cli', prompt: '修复登录按钮的文案', cwd: process.cwd() }).context;
  const input = JSON.stringify({ schema: 1, context, card: simpleCard(context) });
  const script = path.join(__dirname, 'kickoff-core.cjs');
  const result = spawnSync(process.execPath, [script, '--compose', '-', '--binding', context.binding, '--json'], {
    input, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, KICKOFF_STATE_DIR: STATE },
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.action, 'ASK_CONFIRMATION');
  assert.strictEqual(parsed.questions.length, 1);
});

fs.rmSync(STATE, { recursive: true, force: true });
if (n) {
  console.log(n + ' FAILURE(S)');
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}
