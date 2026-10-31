#!/usr/bin/env node
'use strict';
// 复核模式的确定性触发与注入文本。纯函数、无 I/O：
// 由 rules-reminder.js 调用，只在用户明确要求复核时追加一段简短协议。

const PHRASES = [
  ...['再', '再次', '重新', '重复', '循环', '反复'].flatMap(prefix =>
    ['检查', '审查', '复核', '复查', '复检', '验证', '确认', '核对'].map(action => prefix + action)),
  '多检查几遍',
  '多核对几遍',
  '再仔细检查',
  '仔细复查',
  '复核一遍',
  '再查一遍',
  '复查',
];

const NEGATION = /(?:不用|不必|无需|不要|不需要|暂不|不想|不再|避免|禁止|(?:^|请(?:你)?|你|您|先|暂时|这次|本次|千万|务必|一定|可|就)别(?!名|的|人|处|样))/;
const META = /(?:当(?:我|用户)说|(?:如果)?(?:我|用户)说|用户要求|用户让|用户提出|(?:如果|假如|假设|要是|若)(?:我|你|用户)(?:请|要求)|关键词|触发词|示例|例句|例如|比如|类似|意思是|是指|指的是|说的是|提到|这个词|这几个词|这句话|解释|讲解|翻译|怎么设计|如何设计|怎么处理|如何处理|(?:文档|规则|日志|教程)(?:里|中)?(?:写着|写的是|说的是))/;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|若)/;
const OUTCOME_NEGATION = /(?:没(?:有)?|尚未|并未|未|不是|并非|不再|不)(?:任何|完全|全部|都|能|已经|成功|再|出现|发生|发现|看到|检测到|新(?:的)?)*\s*$/;

function clean(input) {
  let fence = null;
  const lines = String(input == null ? '' : input).split(/\r?\n/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (/^(?: {4}|\t| {0,3}>)/.test(line)) return '';
    if (marker) { fence = marker[1]; return ''; }
    return line;
  });
  const text = lines.join('\n').replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, ' ');
  let cursor = 0, prefix = '', meta = false;
  return text.replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/g, (quoted, index) => {
    const parts = text.slice(cursor, index).split(/[，,。！？!?；;\n]/);
    prefix = (parts.length > 1 ? '' : prefix) + parts[parts.length - 1];
    meta = (parts.length > 1 ? false : meta) || META.test(prefix);
    const imperative = /(?:请(?:你)?|帮我|麻烦(?:你)?|务必|必须|需要你|继续|先)\s*$/.test(prefix);
    cursor = index + quoted.length;
    prefix = prefix.slice(-32) + ' ';
    return imperative && !meta ? quoted.slice(1, -1) : ' ';
  });
}

function requestIsNegated(before) {
  const scope = before.split(/(?:但是|但|可是|不过|然而|而是|而要)/).pop()
    .replace(/(?:不能不|不得不|不可以不|不是(?:不用|不必|不要|不需要))/g, '');
  return NEGATION.test(scope);
}

function occurrenceIsRequest(clause, index, phrase) {
  const before = clause.slice(0, index);
  const after = clause.slice(index + phrase.length).trimStart();
  if (requestIsNegated(before) || META.test(before)) return false;
  const condition = before.match(HYPOTHETICAL);
  const directive = before.match(/(?:请(?:你)?|帮我|麻烦(?:你)?)[^，,]*$/);
  if (condition && (!directive || directive.index <= condition.index + condition[0].length)) return false;
  if (/^(?:(?:一次|一遍|一下|这个词|一词|四个字|这几个字)\s*)?(?:是什么意思|是指|指的是|的意思|写进|写入|添加到|加入|这个词|一词|四个字|会怎样|会如何|会怎么样)/.test(after)) return false;
  if (/^(?:一次|一遍|一下)?(?:就|也|都)?(?:不用|不必|无需|不需要|没有必要)/.test(after)) return false;
  return true;
}

function disputedOutcome(sentence) {
  const declined = sentence.split(/[，,]/).some(clause =>
    [...clause.matchAll(/(?:复核|复查|复检|检查|核对|验证|确认|审查)/g)]
      .some(match => requestIsNegated(clause.slice(0, match.index))));
  if (declined) return null;
  const isExample = index => {
    const before = sentence.slice(0, index).split(/[，,]/).pop();
    return META.test(before) || HYPOTHETICAL.test(before);
  };
  for (const match of sentence.matchAll(/(?:上次|之前|先前|刚刚)[^，,。！？!?；;\n]{0,24}?(?:说|声称|报告|讲)([^，,。！？!?；;\n]{0,32}?)(?:修好|修复了|完成|解决|验证通过|验证成功|通过|生效)/g)) {
    if (isExample(match.index) || OUTCOME_NEGATION.test(match[1])) continue;
    const after = sentence.slice(match.index + match[0].length);
    const contrast = after.match(/(?:但是|但|可是|不过|然而|却|实际(?:上)?|现在|这次|还是|仍然|依然)/);
    if (!contrast) continue;
    const outcome = after.slice(contrast.index + contrast[0].length);
    for (const failure of outcome.matchAll(/(?:不对|不行|失败|报错|有问题|不正常|未(?:修好|解决|通过|生效)|没(?:有)?(?:修好|解决|通过|生效))/g)) {
      const beforeFailure = outcome.slice(0, failure.index);
      const afterFailure = outcome.slice(failure.index + failure[0].length);
      const caseLabel = /^(?:的)?(?:用例|案例|样例|场景|测试|分支|路径)/.test(afterFailure);
      const existingFailure = /(?:仍有|还有|存在|出现|发现|(?<!现|原|旧|已)有)(?:[0-9一二三两几多]+[个条项]?|部分|一些)?$/.test(beforeFailure);
      if (caseLabel && !existingFailure) continue;
      if (!OUTCOME_NEGATION.test(beforeFailure)) return match[0] + after;
    }
  }
  for (const match of sentence.matchAll(/不是(?:说|讲)([^，,。！？!?；;\n]{0,32}?)(?:修好|修复了|完成|解决|生效|通过)(?:了|的)?[吗么?？]/g)) {
    if (!isExample(match.index) && !OUTCOME_NEGATION.test(match[1])) return match[0];
  }
  return null;
}

function detectRecheck(input) {
  const text = clean(input);
  if (!text.trim()) return { matched: false, phrases: [], kind: null };
  const clauses = text.split(/[，,。！？!?；;\n]|(?:而是|而要)/);
  const hits = PHRASES.filter(phrase => clauses.some(clause => {
    let from = 0;
    while (from <= clause.length - phrase.length) {
      const index = clause.indexOf(phrase, from);
      if (index < 0) return false;
      if (occurrenceIsRequest(clause, index, phrase)) return true;
      from = index + phrase.length;
    }
    return false;
  }));
  if (hits.length) return { matched: true, phrases: hits, kind: 'explicit' };
  for (const sentence of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) || []) {
    const dispute = disputedOutcome(sentence);
    if (dispute) return { matched: true, phrases: [dispute.replace(/\s+/g, ' ').trim()], kind: 'dispute' };
  }
  return { matched: false, phrases: [], kind: null };
}

function buildRecheckNote() {
  return [
    '【复核模式 · 已触发】用户要求再次检查 / 重复检查 / 循环检查。',
    '历史资料分三类：用户要求与有效授权仍是判定依据；旧报告、队列勾选、记忆摘要只作线索，不继承结论；原始记录可标历史证据，但当前运行状态必须本轮重新观测。',
    '按 RECHECK 六步：冻结范围与权限 → 建立待证清单（含旧报告未覆盖项）→ 本轮重新取证 → 关键行为至少两种不同盲区的方法复核（负对照不算独立方法）→ 冲突先归因并扫盲区 → 循环按覆盖收敛并报告。',
    '默认只读；未获授权不修文件、不植入磁盘缺陷、不重启服务。报告写结论、待证清单、差异、未验证项 + 原因、证据入口；只有提示注入成功不算复核已发生。详见 verify-before-claim 技能「复核模式」。',
  ].join('\n');
}

module.exports = { PHRASES, detectRecheck, buildRecheckNote };
