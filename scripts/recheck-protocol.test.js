#!/usr/bin/env node
'use strict';
// recheck-protocol.cjs 的正负例自测。判据：每个样例的 matched 必须等于预期；
// 检测器坏了、误触发或漏触发都会让本套件转红。
const { detectRecheck, buildRecheckNote, PHRASES } = require('./recheck-protocol.cjs');

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fail++;
};

const positives = [
  ['再次检查这个修复', 'explicit'],
  ['重新检查配置', 'explicit'],
  ['再检查一遍', 'explicit'],
  ['重复检查测试结果', 'explicit'],
  ['循环检查直到没问题', 'explicit'],
  ['反复检查这个路径', 'explicit'],
  ['帮我复查一下', 'explicit'],
  ['再复核一遍', 'explicit'],
  ['重新复核', 'explicit'],
  ['再验证一次', 'explicit'],
  ['重新验证结果', 'explicit'],
  ['再确认一下', 'explicit'],
  ['重新确认', 'explicit'],
  ['再核对数据', 'explicit'],
  ['重新核对', 'explicit'],
  ['再查一遍', 'explicit'],
  ['多检查几遍', 'explicit'],
  ['多核对几遍', 'explicit'],
  ['再仔细检查', 'explicit'],
  ['仔细复查', 'explicit'],
  ['请“再次检查”这个修复', 'explicit'],
  ['不要只检查文档，要再次检查运行结果', 'explicit'],
  ['再次检查 A，B 不要动', 'explicit'],
  ['如果发现配置不对，请再次检查', 'explicit'],
  ['上次说修好了但还是不对', 'dispute'],
  ['这不是说已经解决了吗', 'dispute'],
  ['多次循环审查新增福建能力，修复发现的问题，直到确保无缺漏，进行推送和发布', 'explicit'],
  ['请再次审查这个修复', 'explicit'],
  ['请再检查是否有遗漏', 'explicit'],
  ['重新验证能不能登录', 'explicit'],
  ['再确认是否生效', 'explicit'],
  ['再核对这个字段是否正确', 'explicit'],
  ['不要停，再次检查这个修复', 'explicit'],
  ['文档里有错，请再次检查', 'explicit'],
  ['例如文档可以稍后看，现在请再次检查运行结果', 'explicit'],
  ['如果方便，请再次检查', 'explicit'],
  ['不用改代码，再次检查运行结果', 'explicit'],
  ['不能不再次检查这个修复', 'explicit'],
  ['再检查“是否通过”这个分支', 'explicit'],
  ['```text\n再次检查\n```\n请再核对当前结果', 'explicit'],
  ['~~~text\n再次检查\n~~~\n再次检查运行结果', 'explicit'],
  ['你上次说已经修好了，实际还是不对', 'dispute'],
  ['上次说修好了但还是失败，怎么排查', 'dispute'],
  ['之前声称完成了，现在仍然报错', 'dispute'],
  ['刚刚报告通过了，可是还是失败', 'dispute'],
  ['例如上次说修好了但失败。你上次说修好了但还是不对', 'dispute'],
  ['请分别再次检查A和B', 'explicit'],
  ['请特别再次检查这一项', 'explicit'],
  ['如果方便请再次检查', 'explicit'],
  ['如果你方便请再次检查', 'explicit'],
  ['如果需要请再次检查是否有遗漏', 'explicit'],
  ['如果方便请对当前模块再次检查', 'explicit'],
  ['请“再次检查\n当前修复”', 'explicit'],
  ['不要改代码但请再次检查接口', 'explicit'],
  ['无需修改配置可是请重新核对结果', 'explicit'],
  ['请再次复核当前修复', 'explicit'],
  ['请再次核对数据', 'explicit'],
  ['请反复核对数据', 'explicit'],
  ['请循环复核当前修复', 'explicit'],
  ['请再次验证当前修复', 'explicit'],
  ['请重复复检当前修复', 'explicit'],
  ['上次说修好了，现在仍有失败用例', 'dispute'],
  ['上次说修好了，现在存在3条失败用例', 'dispute'],
  ['上次说修好了，现在失败用例仍然失败', 'dispute'],
  ['上次说修好了但还是失败，分别核对相关日志', 'dispute'],
  ['上次说修好了但还是失败，请分别检查相关日志', 'dispute'],
  ['上次说修好了但还是失败，不要改代码但请核对日志', 'dispute'],
];

const negatives = [
  '检查一下这个文件',
  '帮我看看',
  '不用再次检查',
  '无需复核',
  '不必重复检查',
  '不要再次检查',
  '当我说“再次检查”时应该怎么处理',
  '如果用户说再次检查，应该如何设计',
  '这个规则说的是重复检查，请改写',
  '关键词是再次检查',
  '按文档进行实施',
  '分析完善刚刚生成的方案',
  '只重新跑一次测试',
  '如果再检查一次会怎样',
  '再次检查是什么意思',
  '循环检查是指反复确认同一对象',
  '如果上次说修好了但没生效，怎么排查',
  '检查',
  '',
  null,
  '```\n再次检查\n```',
  '`再次检查`',
  '暂时不要对这个模块再次检查',
  '无需对现有实现再次检查',
  '别再帮我重新验证',
  '不想再检查',
  '请不要再次检查',
  '再次检查就不必了',
  '把再次检查写进规则',
  '将“再次检查”添加到触发词列表',
  '解释一下“再次检查”的意思',
  '“再次检查”这个词是什么意思',
  '给文档添加复查一词',
  '这份文档包含再次检查四个字',
  '他说“再次检查”',
  '"请再次检查这个修复"',
  '> 请再次检查这个修复',
  '~~~text\n请再次检查这个修复\n~~~',
  '```text\n请再次检查这个修复',
  '    请再次检查这个修复',
  '\t请再次检查这个修复',
  '````text\n```\n请再次检查这个修复\n````',
  '上次说修好了，但这次只写文档，不用复核',
  '文档写着：上次说修好了但还是不对',
  '示例：“不是说已经解决了吗”',
  '示例：不是说已经解决了吗',
  '上次说修好了，但还需要补充文档',
  '上次说没有修好，但这次可以了',
  '上次说没修好，但仍然失败',
  '上次说修好了，但并没有失败',
  '上次说修好了但仍然失败，不用复核',
  '不是说未解决吗',
  '翻译：“正文\n再次检查”',
  '翻译："正文\n再次检查"',
  "解释：'正文\n再次检查'",
  '复查是指再验证',
  '上次说修好了，但现在没有任何报错',
  '上次说修好了，但现在没有再出现报错',
  '如果我请再次检查会怎样',
  '如果你请再次检查会怎样',
  '如果请再次检查会怎样',
  '请别对现有实现重新核对',
  '例如不要改代码但请再次检查接口',
  '上次说修好了，现在失败用例全部通过',
  '上次说修好了，现在失败的用例全部通过',
  '上次说修好了，现在报错场景已经通过',
  '上次说修好了，现在现有失败用例全部通过',
  '上次说修好了，现在没有任何失败用例',
  '不用再次复核当前修复',
  '翻译：“请循环复核当前修复”',
  '审查当前修复',
  '核对当前数据',
  '验证当前修复',
  '上次说修好了但还是失败，别核对了',
  '上次说修好了但还是失败，这次不要分别核对',
  '上次说修好了但还是失败，不用检查日志',
];

for (const [text, kind] of positives) {
  const got = detectRecheck(text);
  check('正例 ' + JSON.stringify(text), got.matched === true && got.kind === kind, `matched=${got.matched} kind=${got.kind}`);
}
for (const text of negatives) {
  const got = detectRecheck(text);
  check('负例 ' + JSON.stringify(text), got.matched === false, `matched=${got.matched} phrases=${got.phrases.join('|')}`);
}

const note = buildRecheckNote();
const markers = ['【复核模式 · 已触发】', '历史资料分三类', 'RECHECK 六步', '负对照不算独立方法', '默认只读', '未验证项', '提示注入成功不算复核已发生'];
const missing = markers.filter((m) => !note.includes(m));
check('注入了协议摘要且含全部必需标记', missing.length === 0 && note.length <= 900, `缺失=${missing.join(',')} 长度=${note.length}`);
check('触发词表不含裸词“检查”', !PHRASES.includes('检查'));
check('触发词表无重复', new Set(PHRASES).size === PHRASES.length, `数量=${PHRASES.length}`);

const started = process.hrtime.bigint();
const quoted = detectRecheck('"x",'.repeat(32768));
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
check('密集引用输入不会反复扫描完整前缀', !quoted.matched && elapsed < 1500, `ms=${elapsed.toFixed(1)}`);
console.log(`CASES=${positives.length + negatives.length + 4} FAILURES=${fail}`);
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
