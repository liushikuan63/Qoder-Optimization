'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const AMB = fs.mkdtempSync(path.join(os.tmpdir(), 'ambiguity-test-'));
process.env.AMBIGUITY_STATE_DIR = AMB;
const core = require('./ambiguity-core.cjs');
const { classifyAmbiguity, buildAmbiguityNote } = core;
after(() => { try { fs.rmSync(AMB, { recursive: true, force: true }); } catch {} });

const HIGH = [
  '帮我优化一下',
  '这个改一下',
  '优化一下',
  '随便弄一下就行',
  '需求有点含糊，帮我理一下',
  '帮我梳理下需求，我不太确定要什么',
  '你看下这个提需求怎么改比较好',
  '你看怎么弄',
  '帮我看看怎么弄',
];
const MEDIUM = ['看看这个', '看下这个'];
const CLEAR = [
  '把 src/auth.ts 的 login 改成返回 401',
  '解释一下 JWT 是什么',
  '跑 npm test',
  '修复登录页点击无响应',
  '这个按钮改成蓝色',
  '看下这个报错：TypeError: x is undefined',
  '确认之前提示词优化技能是否能稳定触发，给出用户选择空间',
  '/clarify 帮我优化一下',
  '把导出改成 CSV',
  '帮我优化一下提示词技能的描述长度',
];

function missed(list, expected) {
  return list.filter((text) => classifyAmbiguity(text).level !== expected);
}

test('高置信含混请求必须命中', () => {
  assert.deepEqual(missed(HIGH, 'high'), []);
});
test('中置信短句必须命中', () => {
  assert.deepEqual(missed(MEDIUM, 'medium'), []);
});
test('带对象、路径、报错、命令或元讨论的明确请求不得误报', () => {
  const wrong = CLEAR.filter((text) => classifyAmbiguity(text).level !== null);
  assert.deepEqual(wrong, []);
});
test('负对照：判定被掏空时正向断言必须失败', () => {
  const hollow = (text) => ({ level: null, signals: [], text });
  const high = HIGH.filter((text) => hollow(text).level !== 'high');
  assert.equal(high.length, HIGH.length);
});
test('高置信提示要求弹窗给备选且禁止猜测开工', () => {
  const note = buildAmbiguityNote({ level: 'high', signals: ['光杆动作'] });
  for (const phrase of ['AskUserQuestion', '2–4 个真实备选', '推荐项在前', '不得凭猜测直接开工', '只问一个核心问题']) {
    assert.ok(note.includes(phrase), phrase);
  }
});
test('初筛必须声明不是结论，并要求模型三档判别与 clear 证据门槛', () => {
  for (const level of ['high', 'medium']) {
    const note = buildAmbiguityNote({ level, signals: ['泛化动作'] });
    for (const phrase of ['规则初筛', '不是结论', '模型判别', 'clear', 'assumption', 'clarify']) {
      assert.ok(note.includes(phrase), level + ' 缺少 ' + phrase);
    }
  }
  const high = buildAmbiguityNote({ level: 'high', signals: ['光杆动作'] });
  assert.ok(high.includes('写明对象与验收依据'));
  assert.ok(high.includes('不得先猜着执行再补问'));
});
test('中置信提示允许可逆默认值推进，但不得制造确认门', () => {
  const note = buildAmbiguityNote({ level: 'medium', signals: ['空指代短句'] });
  assert.ok(note.includes('说明假设后推进'));
  assert.ok(note.includes('不要为内部命名或参数增加确认门'));
});
test('无信号时不注入', () => {
  assert.equal(buildAmbiguityNote({ level: null, signals: [] }), '');
  assert.equal(buildAmbiguityNote(null), '');
});
test('判别记录：合法 clear 落盘、清 pending、写审计日志', () => {
  const context = core.createAmbiguityContext({ sessionId: 's-clear', decisionId: 'd-clear', level: 'high', signals: ['光杆动作'] });
  core.writePending(context);
  const result = core.evaluateDecision({
    schema: 1, sessionId: 's-clear', decisionId: 'd-clear', verdict: 'clear',
    reason: '对象是 src/auth.ts 的 login，验收是返回 401', sourceRefs: ['src/auth.ts login', '验收：返回 401'],
  }, context.binding);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'proceed');
  assert.equal(core.readPending('s-clear'), null);
  assert.ok(fs.readFileSync(path.join(AMB, 'decisions.log'), 'utf8').includes('|clear|'));
});
test('判别记录：错误 binding、证据不足、决策 id 不符必须拒绝', () => {
  const context = core.createAmbiguityContext({ sessionId: 's-bad', decisionId: 'd-bad', level: 'high', signals: ['空指代'] });
  core.writePending(context);
  assert.equal(core.evaluateDecision({ schema: 1, sessionId: 's-bad', decisionId: 'd-bad', verdict: 'clear', reason: 'x', sourceRefs: ['ab'] }, 'wrong').code, 'BINDING_MISMATCH');
  assert.equal(core.evaluateDecision({ schema: 1, sessionId: 's-bad', decisionId: 'd-bad', verdict: 'clear', reason: 'x', sourceRefs: ['ab'] }, context.binding).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(core.evaluateDecision({ schema: 1, sessionId: 's-bad', decisionId: 'd-bad', verdict: 'clear', reason: 'x', sourceRefs: ['a'] }, context.binding).code, 'INVALID_SOURCE_REFS');
  assert.equal(core.evaluateDecision({ schema: 1, sessionId: 's-bad', decisionId: 'other', verdict: 'clear', reason: 'x', sourceRefs: ['abcdefgh'] }, context.binding).code, 'DECISION_ID_MISMATCH');
  assert.ok(core.readPending('s-bad'));
});
test('判别记录：clarify 保留 pending，交由门禁确认弹窗', () => {
  const context = core.createAmbiguityContext({ sessionId: 's-clarify', decisionId: 'd-clarify', level: 'high', signals: ['空指代'] });
  core.writePending(context);
  const result = core.evaluateDecision({
    schema: 1, sessionId: 's-clarify', decisionId: 'd-clarify', verdict: 'clarify',
    reason: '缺少操作对象', sourceRefs: ['用户只说“这个改一下”'],
  }, context.binding);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'ask');
  assert.ok(core.readPending('s-clarify'));
});
test('判别记录：CLI 可用 stdin 提交并返回 proceed', () => {
  const context = core.createAmbiguityContext({ sessionId: 's-cli', decisionId: 'd-cli', level: 'high', signals: ['光杆动作'] });
  core.writePending(context);
  const { spawnSync } = require('child_process');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'ambiguity-core.cjs'), '--decision', '-', '--binding', context.binding], {
    input: JSON.stringify({ schema: 1, sessionId: 's-cli', decisionId: 'd-cli', verdict: 'assumption', reason: '按现有格式先用 CSV', sourceRefs: ['现有 CSV 组件'] }),
    encoding: 'utf8',
    env: { ...process.env, AMBIGUITY_STATE_DIR: AMB },
  });
  assert.equal(run.status, 0);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'proceed');
});
