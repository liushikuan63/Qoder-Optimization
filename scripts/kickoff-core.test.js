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
// 业务名词里含动作词（“诱导发布”）：末句是问句时按问答处理，不因“发布”两字进入复杂任务
check('问答：业务名词含“发布”不误判为复杂', () => assert.strictEqual(core.classifyKickoffTask('诱导发布优先级如何设置，在哪个界面').profile, 'question'));
check('问答：有哪些界面', () => assert.strictEqual(core.classifyKickoffTask('诱导发布有哪些界面').profile, 'question'));
check('任务：新增需求仍是执行任务', () => assert.strictEqual(core.classifyKickoffTask('新增需求，可查看单个诱导屏信息，可在其他界面通过iframe调用相关诱导屏信息进行查看，要求做好响应式').profile, 'simple'));
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
check('复杂串行卡只问计划/文档/目标 3 问，不再单独问并行', () => {
  const context = contextFor('跨模块重构权限校验并发布', 'sess-c2s');
  core.writePending(context);
  const card = { ...complexCard(context), parallel: { mode: 'serial', reason: '顺序依赖' } };
  const result = core.composeCard({ schema: 1, context, card }, context.binding);
  assert.strictEqual(result.questions.length, 3);
  assert.deepStrictEqual(result.questions.slice(1).map(item => item.header), ['文档', '目标']);
});
check('多种理解时列出 2–4 种供选择', () => {
  const context = contextFor('优化导出功能', 'sess-c2i');
  core.writePending(context);
  const card = {
    ...complexCard(context),
    parallel: { mode: 'serial', reason: '单会话' },
    interpretations: [
      { label: '只调整筛选项', description: '保留现有导出格式，只改筛选条件。' },
      { label: '重做导出页', description: '重新设计导出页布局与交互。' },
    ],
  };
  const result = core.composeCard({ schema: 1, context, card }, context.binding);
  const plan = result.questions[0];
  assert.strictEqual(plan.question, '按哪种理解开工？');
  assert.strictEqual(plan.options.length, 3);
  assert.ok(plan.options[0].label.includes('推荐'));
  assert.strictEqual(plan.options[2].label, '都不对，我来补充');
});
check('理解数量越界拒绝', () => {
  const context = contextFor('优化导出功能', 'sess-c2j');
  core.writePending(context);
  const card = {
    ...complexCard(context),
    interpretations: [{ label: '只有一种', description: '不满足 2–4 种。' }],
  };
  throwsCode(() => core.composeCard({ schema: 1, context, card }, context.binding), 'INVALID_KICKOFF_CARD');
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

console.log('# preference');
const prefFile = path.join(STATE, 'kickoff-preference.json');
process.env.KICKOFF_PREFERENCE_FILE = prefFile;
check('无配置时开工提示卡默认常驻', () => assert.strictEqual(core.kickoffResidentEnabled(), true));
check('安装选择关闭后不再建卡', () => {
  fs.writeFileSync(prefFile, JSON.stringify({ schema: 1, resident: false }));
  assert.strictEqual(core.kickoffResidentEnabled(), false);
  const result = core.prepareKickoff({ sessionId: 'sess-pref', prompt: '修复登录按钮的文案', cwd: process.cwd() });
  assert.strictEqual(result.reason, 'USER_DISABLED');
  assert.strictEqual(fs.existsSync(path.join(STATE, 'pending-sess-pref.json')), false);
});
check('配置损坏时按默认常驻处理（不静默关闭）', () => {
  fs.writeFileSync(prefFile, '{not-json');
  assert.strictEqual(core.kickoffResidentEnabled(), true);
});
check('显式恢复常驻后重新建卡', () => {
  fs.writeFileSync(prefFile, JSON.stringify({ schema: 1, resident: true }));
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-pref2', prompt: '修复登录按钮的文案', cwd: process.cwd() }).skip, false);
});
console.log('# read-only fast path');
freshState();
check('审阅加建议的纯审阅请求跳过开工卡', () => {
  const result = core.prepareKickoff({ sessionId: 'sess-ro1', prompt: '审阅之前的实现，按你的理解，相关方案是否可以更优，请给出更优的建议', cwd: process.cwd() });
  assert.strictEqual(result.skip, true);
  assert.strictEqual(result.reason, 'READ_ONLY');
});
check('显式只读且声明不实施时跳过', () => {
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-ro2', prompt: '只读审阅，提出修改建议，不实施', cwd: process.cwd() }).reason, 'READ_ONLY');
});
check('先只读检查后执行仍要开工卡', () => {
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-ro3', prompt: '先只读检查，然后按计划执行修改', cwd: process.cwd() }).skip, false);
});
check('审阅并修改仍要开工卡', () => {
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-ro4', prompt: '审阅并修改登录按钮文案', cwd: process.cwd() }).skip, false);
});

console.log('# machine-readable selections');
freshState();
check('复杂卡选项带机读 value', () => {
  const context = contextFor(undefined, 'sess-sel1');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: complexCard(context) }, context.binding);
  const values = composed.questions.flatMap((question) => question.options.map((option) => option.value));
  for (const value of ['proceed', 'update', 'create', 'none', 'parallel', 'serial']) assert.ok(values.includes(value), value);
});
check('复杂卡未显式选择文档与目标时拒绝记录', () => {
  const context = contextFor(undefined, 'sess-sel2');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: complexCard(context) }, context.binding);
  throwsCode(() => core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'proceed' }, context.binding), 'MISSING_KICKOFF_SELECTION');
});
check('复杂卡显式选择 none 按用户选择落账', () => {
  const context = contextFor(undefined, 'sess-sel3');
  core.writePending(context);
  const composed = core.composeCard({ schema: 1, context, card: complexCard(context) }, context.binding);
  core.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice: 'proceed', selections: { documentation: 'none', goal: 'none', parallel: 'serial' } }, context.binding);
  assert.deepStrictEqual(core.readConfirmed('sess-sel3').selections, { documentation: 'none', goal: 'none', parallel: 'serial' });
});

console.log('# request binding');
check('requestId 命中即可匹配', () => assert.strictEqual(core.matchesRequest(contextFor(undefined, 'sess-bind1'), { requestMessageId: 'msg-sess-bind1' }), true));
check('空白差异时 promptKey 兜底匹配', () => assert.strictEqual(core.matchesRequest(contextFor('修复 登录按钮的文案', 'sess-bind2'), { text: '修复   登录按钮的文案' }), true));
check('不同请求不匹配', () => assert.strictEqual(core.matchesRequest(contextFor(undefined, 'sess-bind3'), { text: '把 README 版本号改成 0.1.6' }), false));

console.log('# preference split');
freshState();
check('inject 开 enforce 关：仍注入但不硬拦', () => {
  fs.writeFileSync(prefFile, JSON.stringify({ schema: 1, inject: true, enforce: false }));
  assert.strictEqual(core.kickoffInjectEnabled(), true);
  assert.strictEqual(core.kickoffEnforceEnabled(), false);
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-split1', prompt: '修复登录按钮的文案', cwd: process.cwd() }).skip, false);
});
check('inject 关时单独 enforce 无执行路径', () => {
  fs.writeFileSync(prefFile, JSON.stringify({ schema: 1, inject: false, enforce: true }));
  assert.strictEqual(core.kickoffEnforceEnabled(), false);
  assert.strictEqual(core.prepareKickoff({ sessionId: 'sess-split2', prompt: '修复登录按钮的文案', cwd: process.cwd() }).reason, 'USER_DISABLED');
});

console.log('# note size and ledger');
freshState();
delete process.env.KICKOFF_PREFERENCE_FILE;
check('注入块体积受控', () => {
  const result = core.prepareKickoff({ sessionId: 'sess-note', prompt: '修复登录按钮的文案', cwd: process.cwd() });
  const bytes = Buffer.byteLength(result.note);
  assert.ok(bytes < 2200, 'note bytes=' + bytes);
  assert.ok(result.note.includes('KICKOFF_BINDING') && result.note.includes('KICKOFF_COMPOSE_COMMAND'));
});
check('台账 status 列出文件且 gc 默认只预览', () => {
  const oldFile = path.join(STATE, 'pending-old.json');
  const newFile = path.join(STATE, 'pending-new.json');
  fs.writeFileSync(oldFile, JSON.stringify({ schema: 1, context: { schema: 1 }, at: '2020-01-01T00:00:00.000Z' }));
  fs.writeFileSync(newFile, JSON.stringify({ schema: 1, context: { schema: 1 }, at: new Date().toISOString() }));
  assert.ok(core.ledgerStatus(null).files.some((item) => item.name === 'pending-old.json'));
  const preview = core.gcLedger({});
  assert.deepStrictEqual(preview.expired.map((item) => path.basename(item.file)), ['pending-old.json']);
  assert.strictEqual(fs.existsSync(oldFile), true);
  const applied = core.gcLedger({ apply: true });
  assert.strictEqual(applied.deleted, 1);
  assert.strictEqual(fs.existsSync(oldFile), false);
  assert.strictEqual(fs.existsSync(newFile), true);
});

// ── C4：Windows 输入通道（--from-file 一次成功 / 解析失败回显位置与片段）──
console.log('# C4 input channel');
freshState();
const CLI_SCRIPT = path.join(__dirname, 'kickoff-core.cjs');
const C4_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-c4-'));
function runCli(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : stdin, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, KICKOFF_STATE_DIR: STATE, KICKOFF_PREFERENCE_FILE: prefFile },
  });
}
function replaceOnce(source, anchor, replacement) {
  assert.strictEqual(source.split(anchor).length - 1, 1, 'anchor must be unique: ' + anchor);
  return source.replace(anchor, replacement);
}
// 盘符 + 反斜杠：JSON.stringify 写成 \\，正是 Git Bash heredoc 会折叠成 \ 的形态。
const c4Context = core.createKickoffContext({ sessionId: 'sess-c4', prompt: '修复登录按钮的文案', cwd: process.cwd(), requestMessageId: 'msg-c4' });
c4Context.workspaceKey = 'D:\\project\\Qoder-Optimization';
c4Context.binding = core.contextBinding(c4Context);
core.writePending(c4Context);
const composeFile = path.join(C4_DIR, 'compose.json');
fs.writeFileSync(composeFile, JSON.stringify({ schema: 1, context: c4Context, card: simpleCard(c4Context) }));
const composeText = fs.readFileSync(composeFile, 'utf8');
const collapsedText = composeText.split('\\\\').join('\\');

check('夹具确实带转义后的盘符反斜杠', () => {
  assert.ok(composeText.includes('D:\\\\project\\\\'), 'fixture must contain escaped backslashes');
  assert.ok(collapsedText.includes('D:\\project\\'), 'collapsed fixture must contain bare backslashes');
  assert.throws(() => JSON.parse(collapsedText), /escaped character/i);
});
check('compose 经 --from-file 一次成功', () => {
  const run = runCli(CLI_SCRIPT, ['--compose', '--from-file', composeFile, '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.strictEqual(JSON.parse(run.stdout).action, 'ASK_CONFIRMATION');
});
check('含盘符反斜杠的 record JSON 经 --from-file 一次成功', () => {
  const composed = core.composeCard({ schema: 1, context: c4Context, card: simpleCard(c4Context) }, c4Context.binding);
  const recordFile = path.join(C4_DIR, 'record.json');
  fs.writeFileSync(recordFile, JSON.stringify({ schema: 1, context: c4Context, cardDigest: composed.cardDigest, choice: 'proceed' }));
  assert.ok(fs.readFileSync(recordFile, 'utf8').includes('D:\\\\project\\\\'));
  const run = runCli(CLI_SCRIPT, ['--record', '--from-file', recordFile, '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.strictEqual(JSON.parse(run.stdout).action, 'proceed');
  assert.strictEqual(core.readConfirmed('sess-c4').choice, 'proceed');
});
check('负对照：heredoc 折叠后必须回显位置与原始片段', () => {
  const run = runCli(CLI_SCRIPT, ['--compose', '-', '--binding', c4Context.binding, '--json'], collapsedText);
  assert.strictEqual(run.status, 2);
  const out = JSON.parse(run.stdout);
  assert.strictEqual(out.code, 'INVALID_JSON');
  assert.strictEqual(out.source, 'stdin');
  assert.ok(Number.isInteger(out.position.offset) && out.position.offset > 0, 'offset missing');
  assert.ok(Number.isInteger(out.position.line) && out.position.line >= 1, 'line missing');
  assert.ok(Number.isInteger(out.position.column) && out.position.column >= 1, 'column missing');
  assert.ok(out.snippet.includes('\\p'), 'snippet must show the offending escape: ' + out.snippet);
  assert.ok(out.hint && out.hint.includes('--from-file'), 'hint must point at the file channel');
});
check('解析失败不落台账、不留临时文件', () => {
  core.writePending(c4Context);
  const before = fs.readdirSync(STATE).sort();
  const run = runCli(CLI_SCRIPT, ['--record', '-', '--binding', c4Context.binding, '--json'], collapsedText);
  assert.strictEqual(run.status, 2);
  assert.deepStrictEqual(fs.readdirSync(STATE).sort(), before);
});
check('--from-file 缺路径判 USAGE', () => {
  const run = runCli(CLI_SCRIPT, ['--compose', '--from-file', '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 2);
  assert.strictEqual(JSON.parse(run.stdout).code, 'USAGE');
});
check('--from-file 与位置参数互斥判 USAGE', () => {
  const run = runCli(CLI_SCRIPT, ['--compose', composeFile, '--from-file', composeFile, '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 2);
  assert.strictEqual(JSON.parse(run.stdout).code, 'USAGE');
});
check('--from-file 指向不存在的文件判 INPUT_UNREADABLE', () => {
  const run = runCli(CLI_SCRIPT, ['--compose', '--from-file', path.join(C4_DIR, 'absent.json'), '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 2);
  assert.strictEqual(JSON.parse(run.stdout).code, 'INPUT_UNREADABLE');
});
check('三条输入通道等价：--from-file / 位置文件 / stdin 得到同一 cardDigest', () => {
  const digests = [
    runCli(CLI_SCRIPT, ['--compose', '--from-file', composeFile, '--binding', c4Context.binding, '--json']),
    runCli(CLI_SCRIPT, ['--compose', composeFile, '--binding', c4Context.binding, '--json']),
    runCli(CLI_SCRIPT, ['--compose', '-', '--binding', c4Context.binding, '--json'], composeText),
  ].map(run => { assert.strictEqual(run.status, 0, run.stdout + run.stderr); return JSON.parse(run.stdout).cardDigest; });
  assert.strictEqual(new Set(digests).size, 1, digests.join(','));
});
check('文件通道的解析错误标出来源文件', () => {
  const broken = path.join(C4_DIR, 'broken.json');
  fs.writeFileSync(broken, collapsedText);
  const run = runCli(CLI_SCRIPT, ['--compose', '--from-file', broken, '--binding', c4Context.binding, '--json']);
  assert.strictEqual(run.status, 2);
  const out = JSON.parse(run.stdout);
  assert.strictEqual(out.source, 'file:' + broken);
  assert.ok(out.snippet.includes('\\p'));
});
check('变异负对照：退回只给错误码的旧分支后位置回显消失', () => {
  const source = fs.readFileSync(CLI_SCRIPT, 'utf8');
  const mutant = path.join(C4_DIR, 'opaque-error.cjs');
  fs.writeFileSync(mutant, replaceOnce(source,
    'console.log(JSON.stringify(jsonParseError(raw.text, error, raw.source)));',
    "console.log(JSON.stringify({ ok: false, code: 'INVALID_JSON' }));"));
  const real = JSON.parse(runCli(CLI_SCRIPT, ['--compose', '-', '--binding', c4Context.binding, '--json'], collapsedText).stdout);
  const bad = JSON.parse(runCli(mutant, ['--compose', '-', '--binding', c4Context.binding, '--json'], collapsedText).stdout);
  assert.ok(real.position && real.snippet, 'real implementation must echo position and snippet');
  assert.strictEqual(bad.position, undefined);
  assert.strictEqual(bad.snippet, undefined);
});
check('变异负对照：去掉 --from-file 分支后文件通道不再可用', () => {
  const source = fs.readFileSync(CLI_SCRIPT, 'utf8');
  const mutant = path.join(C4_DIR, 'no-from-file.cjs');
  fs.writeFileSync(mutant, replaceOnce(source, 'if (fromFileAt >= 0) {', 'if (false) {'));
  const args = ['--compose', '--from-file', composeFile, '--binding', c4Context.binding, '--json'];
  assert.strictEqual(runCli(CLI_SCRIPT, args).status, 0);
  const bad = runCli(mutant, args);
  assert.strictEqual(bad.status, 2);
  assert.strictEqual(JSON.parse(bad.stdout).code, 'INVALID_JSON');
});
fs.rmSync(C4_DIR, { recursive: true, force: true });

delete process.env.KICKOFF_PREFERENCE_FILE;

fs.rmSync(STATE, { recursive: true, force: true });
if (n) {
  console.log(n + ' FAILURE(S)');
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}
