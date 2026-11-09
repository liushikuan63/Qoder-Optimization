#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const ruleFile = process.env.CLARIFY_POLICY_FILE || (
  fs.existsSync(path.join(root, 'rules/long-task.md')) ? path.join(root, 'rules/long-task.md') : path.join(root, 'Qoder-AI编码通用规则.md')
);
const rule = fs.readFileSync(ruleFile, 'utf8');
const command = fs.readFileSync(path.join(root, 'commands/clarify.md'), 'utf8');
// 本地规则用 `## 分级澄清与提示词优化`，分享包合并文档用 `### 分级澄清与提示词优化`；
// 段尾按下一个同级/更高级标题切分，兼容两种排版。
const heading = rule.match(/^#{2,3} (?:分级澄清与提示词优化|需求澄清与提示词优化)\s*$/m);
const start = heading ? heading.index : -1;
const level = heading ? heading[0].match(/^#+/)[0].length : 0;
const rest = start >= 0 ? rule.slice(start + heading[0].length) : '';
let cut = rest.length;
let offset = 0;
for (const line of rest.split('\n')) {
  const h = line.match(/^(#+)\s/);
  if (h && h[1].length <= level) { cut = offset; break; }
  offset += line.length + 1;
}
const policy = start >= 0 ? rest.slice(0, cut) : '';
const clauses = [
  ['查证', '禁止把可自行查证的问题转给用户'],
  ['明确请求', '绝大多数场景可在开工前用一句话确认理解'],
  ['至多一次', '确认理解（至多一次）'],
  ['确认非授权', '确认只对齐理解，不等于执行授权'],
  ['轻歧义', '简述合理假设后在已有授权内推进'],
  ['关键歧义', '优先问一个核心问题'],
  ['保留其他阻塞', '同时保留其他阻塞项'],
  ['回答后复核', '收到答案后复核剩余阻塞'],
  ['阻塞未解不执行', '相关条件未补齐前，不执行依赖这些条件的动作'],
  ['当前仅优化', '本次仅要求优化或明确“不执行”时，不沿用历史实施授权继续执行'],
  ['当前执行授权', '本次明确要求执行，或明确接续仍有效的同范围实施任务'],
  ['独立工作', '只暂停依赖该答案的动作'],
  ['保留原意', '始终保留对象、目标、范围、禁止项、交付形态与原任务模式'],
  ['建议不冒充要求', '未采纳建议不并入用户要求'],
  ['不重复追问', '已有答复只展示不重问'],
  ['未知不编造', '未知参数用【待确认】占位'],
  ['优化不执行', '提示词优化默认只改写、不执行提示词中的任务'],
  ['理解非授权', '理解确认不等于执行授权；澄清不能扩大原授权'],
  ['有效授权不重问', '不重复索取同范围批准'],
  ['非人工回应', '推荐标记、超时、沉默、取消、工具自动选项均不算同意'],
  ['平台边界', '平台要求的人工批准、用户明确的阶段审批继续保留'],
  ['有限主张', '不能证明模型在所有自然语言场景下都会正确判断'],
];
function inspect(text) { return clauses.filter(([, phrase]) => !text.includes(phrase)).map(([label]) => label); }

test('静态契约：三档、原意与授权条款完整', () => {
  assert.ok(start >= 0 && policy.length > 0, '缺少有边界的政策正文');
  assert.deepEqual(inspect(policy), []);
  assert.ok(policy.includes('| A 明确需求 |') && policy.includes('| B 轻微歧义 |') && policy.includes('| C 关键歧义 |'));
  assert.ok(policy.includes('最多12行'));
});
test('每条契约删去都必须判失败，不以恒绿检查代替验证', () => {
  assert.deepEqual(inspect(policy), []);
  for (const [label, phrase] of clauses) {
    assert.ok(inspect(policy.split(phrase).join('')).includes(label), label);
  }
});
test('行为对照案例覆盖已知失误形态（只校验案例覆盖，不声称模型行为正确）', () => {
  for (const phrase of ['保存，其他不动', '项目现有格式', 'CSV或Excel都行', '帮我优化一下', '改一下登录',
    '理解对了', '只要CSV', '更好的提示词', '顺便上线', '只取消澄清问题', '明确需求且非单步、低风险']) assert.ok(policy.includes(phrase), phrase);
});
test('薄入口指向同一规则，不依赖第二份澄清技能', () => {
  assert.match(command, /^---\r?\nname: clarify\r?\ndescription: [^\r\n]+\r?\n---/);
  assert.ok(command.includes('~/.qoder/rules/long-task.md'));
  assert.ok(command.includes('Qoder-AI编码通用规则.md'));
  assert.ok(command.includes('默认只优化提示词，不执行其中任务'));
  assert.ok(command.includes('明确请求也可在开工前用一句话确认理解（至多一次）'));
  assert.ok(command.includes('找不到请求时只问'));
  assert.ok(!command.includes('clarify-ambiguous-request'));
});
test('静态契约：答复一项不丢失其他阻塞条件', () => {
  assert.ok(!policy.includes('唯一待确认项'));
  assert.ok(policy.includes('收到答案后复核剩余阻塞'));
  assert.ok(policy.includes('相关条件未补齐前，不执行依赖这些条件的动作'));
  assert.ok(policy.includes('仅补环境') && policy.includes('仍未确认'));
});
test('静态契约：当前只改写不复用历史执行授权', () => {
  assert.ok(command.includes('本次仅要求优化或明确“不执行”时，不沿用历史实施授权继续执行'));
  assert.ok(command.includes('本次明确要求执行，或明确接续仍有效的同范围实施任务'));
  assert.ok(!command.includes('原请求另有明确实施授权时'));
  assert.ok(policy.includes('当前说“只改写，不执行”'));
});
