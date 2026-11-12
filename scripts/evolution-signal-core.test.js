#!/usr/bin/env node
// evolution-signal-core.js 的隔离自测：正例必命中、负对照必静默、提醒正文逐字节不变、
// 以及"故意改坏判据必红"的变异自检（防止测试自己变成假绿）。
// 用法: node scripts/evolution-signal-core.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE_PATH = path.join(__dirname, 'evolution-signal-core.js');
const core = require(CORE_PATH);
const SRC = fs.readFileSync(CORE_PATH, 'utf8');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-signal-'));

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fail++;
};
const kindsOf = result => result.signals.map(s => s.kind);

// —— 提醒层正文的历史基线（2026-11-02 版 rules-reminder.js 的 EVOLUTION_NOTE 原文）。
// 抽核只允许改实现位置，不允许改注入字节；这段写死在测试里，改文案必红。
const LEGACY_NOTE = '\n【自进化采集 · 本轮疑似纠正/长期偏好】检测到纠正或长期要求。收尾前按 self-evolution 证据门槛判断：用户明确长期偏好一次即可采纳；推断习惯需 ≥3 个独立任务、跨 ≥2 会话；单次任务约束只作用本轮。采纳则落到最窄载体并说明作用范围；临时要求明确说明不沉淀。';

const PREF_POSITIVE = [
  ['以后一律用简体中文回复', core.KINDS.LONG_TERM],
  ['从现在开始必须先查记忆', core.KINDS.LONG_TERM],
  ['记住：改配置前先备份', core.KINDS.EXPLICIT],
  ['把这个结论沉淀下来', core.KINDS.EXPLICIT],
  ['你怎么又忘了先备份', core.KINDS.REPEAT],
  ['说了多少次要先查记忆', core.KINDS.REPEAT],
];
// 采集层加宽召回：历史动词表漏掉的真实长期要求。默认口径必须仍静默（提醒层/门禁行为不变）。
const EXTENDED_ONLY = [
  '从现在开始提交只加明确路径',
  '以后默认走 D 盘临时目录',
  '下次先跑只读预览',
];
// 加宽后仍不能命中的拖延语与单次约束（防止为了召回把噪声也收进来）。
const EXTENDED_NEGATIVE = [
  ['以后再说', '拖延语，无祈使尾词'],
  ['下次再看这个日志', '拖延语'],
  ['这次不要修改任何文件，只给建议', '单次任务约束'],
  ['当我说“以后默认走 D 盘”时你怎么处理', '元提及'],
  ['规则要求以后一律备份', '引用规则原文'],
];
const PREF_NEGATIVE = [
  ['这次不要修改任何文件，只给建议', '单次任务约束'],
  ['当我说“以后都用中文”时你会怎么处理', '元提及（教学式假设）'],
  ['如果我说记住这件事，是否就会写记忆', '元提及'],
  ['规则里写着以后要备份，这条怎么理解', '引用规则原文'],
  ['AGENTS.md 要求先查记忆', '引用规则原文'],
  ['这个函数是做什么的？', '纯问答'],
  ['帮我把这段日志按时间排序', '普通行动请求'],
  ['', '空串'],
];
const PROBLEM_POSITIVE = [
  ['找不到对应的 MCP 工具', core.KINDS.TOOL_GAP],
  ['本机没装这个依赖', core.KINDS.TOOL_GAP],
  ['command not found: pwsh', core.KINDS.TOOL_GAP],
  ["Cannot find module 'left-pad'", core.KINDS.TOOL_GAP],
  ['这个脚本又失败了', core.KINDS.REPEATED_FAILURE],
  ['改完还是没生效', core.KINDS.REPEATED_FAILURE],
  ['接口超时多次', core.KINDS.REPEATED_FAILURE],
];
const PROBLEM_NEGATIVE = [
  ['工具都装好了，继续下一步', '能力已就绪'],
  ['这次一次就跑通了', '一次成功'],
  ['当我说“找不到工具”时你怎么处理', '元提及'],
  ['文档要求写清缺失的能力', '引用规则原文'],
  ['帮我写一个查询用户列表的接口', '普通行动请求'],
  ['', '空串'],
];

// 断言集：同一套判据同时用于基线与变异体，确保变异自检真的能红。
function assertions(mod) {
  const list = [];
  const add = (label, ok, detail) => list.push({ label, ok, detail });

  for (const [text, kind] of PREF_POSITIVE) {
    const r = mod.classifyPreference(text);
    add(`偏好正例命中 ${kind} :: ${text}`, r.matched && kindsOf(r).includes(kind), JSON.stringify(kindsOf(r)));
  }
  for (const [text, why] of PREF_NEGATIVE) {
    const r = mod.classifyPreference(text);
    add(`偏好负对照静默（${why}）:: ${text || '(空)'}`, !r.matched && r.signals.length === 0, JSON.stringify(kindsOf(r)));
  }
  for (const text of EXTENDED_ONLY) {
    const wide = mod.classifyPreference(text, { extended: true });
    const narrow = mod.classifyPreference(text);
    add(`采集加宽召回命中 :: ${text}`, wide.matched && kindsOf(wide).includes(mod.KINDS.LONG_TERM), JSON.stringify(kindsOf(wide)));
    add(`默认口径仍静默（模式隔离）:: ${text}`, !narrow.matched, JSON.stringify(kindsOf(narrow)));
  }
  for (const [text, why] of EXTENDED_NEGATIVE) {
    const r = mod.classifyPreference(text, { extended: true });
    add(`加宽后负对照静默（${why}）:: ${text}`, !r.matched && r.signals.length === 0, JSON.stringify(kindsOf(r)));
  }
  for (const [text, kind] of PROBLEM_POSITIVE) {
    const r = mod.classifyProblem(text);
    add(`问题正例命中 ${kind} :: ${text}`, r.matched && kindsOf(r).includes(kind), JSON.stringify(kindsOf(r)));
  }
  for (const [text, why] of PROBLEM_NEGATIVE) {
    const r = mod.classifyProblem(text);
    add(`问题负对照静默（${why}）:: ${text || '(空)'}`, !r.matched && r.signals.length === 0, JSON.stringify(kindsOf(r)));
  }
  add('提醒正文与历史基线逐字节一致', mod.PREFERENCE_NOTE === LEGACY_NOTE);
  add('提醒正例注入历史正文', mod.preferenceNote('以后一律用简体中文回复') === LEGACY_NOTE);
  add('提醒负对照零注入', mod.preferenceNote('这次不要修改任何文件，只给建议') === '' && mod.preferenceNote('') === '');
  add('提醒层不掺入过程问题族', mod.preferenceNote('找不到对应的 MCP 工具') === '');
  const sigX = mod.classifyPreference('以后一律用简体中文回复').signals[0];
  const sigY = mod.classifyPreference('以后   一律用简体中文回复').signals[0];
  add('空白差异不改变 topic', Boolean(sigX) && Boolean(sigY) && mod.topicFor(sigX) === mod.topicFor(sigY), `${mod.topicFor(sigX)} vs ${mod.topicFor(sigY)}`);
  // —— 收尾建议弹窗判据（采集层写 pending、门禁 R19 读；2026-11-12 用户明确要求）——
  const popupPref = { kind: mod.KINDS.LONG_TERM, family: 'preference', evidence: {} };
  const popupGap1 = { kind: mod.KINDS.TOOL_GAP, family: 'problem', evidence: { occurrences: 1 } };
  const popupGap2 = { kind: mod.KINDS.TOOL_GAP, family: 'problem', evidence: { occurrences: 2 } };
  const popupExp = { kind: mod.KINDS.DISPROVEN, family: 'experience', evidence: {} };
  add('弹窗够格：明确长期偏好一次即可', mod.popupWorthy(popupPref, 1) === true);
  add('弹窗不够格：单次能力缺口且单会话', mod.popupWorthy(popupGap1, 1) === false);
  add('弹窗够格：同一错误 2 次', mod.popupWorthy(popupGap2, 1) === true);
  add('弹窗够格：跨 2 会话的单次缺口', mod.popupWorthy(popupGap1, 2) === true);
  add('弹窗不够格：助手自述经验只进月报', mod.popupWorthy(popupExp, 3) === false);
  add('弹窗判据空输入不抛错', mod.popupWorthy(null, 1) === false && mod.popupWorthy(undefined) === false);
  add('自进化卡算已问建议', mod.isEvolutionAsk('AskUserQuestion', { questions: [{ question: '这条自进化候选要不要采纳？' }] }) === true);
  add('开工卡不冒充建议弹窗', mod.isEvolutionAsk('AskUserQuestion', { questions: [{ question: '开工确认：理解与步骤是否合适？' }] }) === false);
  add('清理卡不冒充建议弹窗', mod.isEvolutionAsk('AskUserQuestion', { questions: [{ question: '本轮临时文件清理范围？' }] }) === false);
  // 真实清理卡正文含「可清理候选 N 项」——旧判据 /候选|载体|采纳/ 会把它当成已问过建议，
  // 于是 R19 放行并清掉 pending。上面那条负对照卡面没有「候选」二字，所以恒绿（假绿）。
  const CLEANUP_CARD_REAL = { questions: [{ question: '本轮临时产物清理范围？可清理候选 142 项（含日志与探针），保留已登记证据 104 项', header: '清理', options: [{ label: '清理本轮产物（推荐）' }, { label: '全部保留' }] }] };
  add('清理卡（真实卡面含「候选」）不冒充建议弹窗', mod.isEvolutionAsk('AskUserQuestion', CLEANUP_CARD_REAL) === false);
  add('只提候选/载体/采纳但无自进化专有词的卡不算', mod.isEvolutionAsk('AskUserQuestion', { questions: [{ question: '这些候选载体要不要采纳？' }] }) === false);
  add('沉淀卡算已问建议', mod.isEvolutionAsk('AskUserQuestion', { questions: [{ question: '要不要把这条经验沉淀成规则？' }] }) === true);
  // 非空转证明：旧判据确实会误认这张真实清理卡（这条比的是旧正则文本，不是实现）。
  add('负对照非空转：旧判据确实会误认真实清理卡', /自进化|沉淀|候选|载体|采纳|学到的/.test(JSON.stringify(CLEANUP_CARD_REAL)) === true);
  add('非弹窗工具不算已问建议', mod.isEvolutionAsk('Bash', { command: 'echo 自进化' }) === false);
  // —— 运行中插话：真实用户指令的第二种宿主形态（2026-11-12 现役实测，attachment/queued_command）——
  const q = (text, mode = 'prompt') => ({
    type: 'attachment',
    attachment: mode === 'prompt'
      ? { type: 'queued_command', commandMode: mode, prompt: [{ type: 'text', text }], origin: { kind: 'bridge' } }
      : { type: 'queued_command', commandMode: mode, prompt: text },
  });
  add('插话正例：prompt 模式取回原文', mod.queuedUserTextOf(q('以后一律用简体中文回复')) === '以后一律用简体中文回复');
  add('插话正例：字符串 prompt 也认', mod.queuedUserTextOf({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '记住：改配置前先备份' } }) === '记住：改配置前先备份');
  add('插话负对照：task-notification 不认', mod.queuedUserTextOf(q('后台任务已完成，请继续实施', 'task-notification')) === '');
  add('插话负对照：其他 commandMode 不认', mod.queuedUserTextOf(q('以后一律用中文', 'slash-command')) === '');
  add('插话负对照：缺 commandMode 不认', mod.queuedUserTextOf({ type: 'attachment', attachment: { type: 'queued_command', prompt: '以后一律用中文' } }) === '');
  add('插话负对照：别的 attachment 类型不认', mod.queuedUserTextOf({ type: 'attachment', attachment: { type: 'goal_state', commandMode: 'prompt', prompt: '以后一律用中文' } }) === '');
  add('插话负对照：system-reminder 剥完为空', mod.queuedUserTextOf(q('<system-reminder>宿主上下文</system-reminder>')) === '');
  add('插话负对照：注入件前缀不认', mod.queuedUserTextOf(q('[stop-gate] 续跑提示')) === '' && mod.queuedUserTextOf(q('<task-notification>x</task-notification>')) === '');
  add('插话负对照：压缩摘要标记不认', mod.queuedUserTextOf(Object.assign({}, q('以后一律用中文'), { isCompactSummary: true })) === '');
  add('插话负对照：isMeta 不认', mod.queuedUserTextOf(Object.assign({}, q('以后一律用中文'), { isMeta: true })) === '');
  add('插话负对照：助手条目里的同形结构不认', mod.queuedUserTextOf({ type: 'assistant', message: { role: 'assistant', content: [] }, attachment: q('以后一律用中文').attachment }) === '');
  add('插话空输入不抛错', mod.queuedUserTextOf(null) === '' && mod.queuedUserTextOf(undefined) === '' && mod.queuedUserTextOf({}) === '');
  add('插话识别后 scope 照常生效', mod.captureScope(mod.queuedUserTextOf(q('只读审阅这个方案，不要修改任何文件'))).readOnly === true);
  return list;
}

const base = assertions(core);
for (const item of base) check(item.label, item.ok, item.ok ? undefined : item.detail);
check('基线断言集全部通过', base.every(i => i.ok), `${base.filter(i => !i.ok).length} 条未通过`);

// —— 助手前缀笔记：只认行首前缀，且不当成用户偏好 ——
check('已否证前缀 → disproven-prescription', kindsOf(core.classifyAssistantNote('已否证：改执行策略 × 本机 A/B 对照')).includes(core.KINDS.DISPROVEN));
check('验证结论前缀 → verified-conclusion', kindsOf(core.classifyAssistantNote('验证结论：node --test 12/12 通过')).includes(core.KINDS.VERIFIED));
check('决策前缀不进自进化候选', !core.classifyAssistantNote('决策：采用方案 A').matched);
check('正文中间出现前缀不算（须行首）', !core.classifyAssistantNote('这段文字里提到已否证：某处方').matched);
check('空/非字符串助手笔记静默', !core.classifyAssistantNote('').matched && !core.classifyAssistantNote(null).matched && !core.classifyAssistantNote(42).matched);
check('助手笔记不冒充用户偏好', !core.classifyPreference('已否证：某处方无效').matched);

// —— 采集范围：只读 / 仅交接 / 禁记忆 ——
const scopeCases = [
  ['只读审阅，给建议就行', { readOnly: true }],
  ['不要修改任何文件', { readOnly: true }],
  ['在更改任何文件之前先问我', { readOnly: true }],
  ['只给我开工提示词，我自己新开会话', { handoffOnly: true }],
  ['本轮不要写入记忆', { noMemory: true }],
  ['不要记住这件事', { noMemory: true }],
];
for (const [text, expect] of scopeCases) {
  const scope = core.captureScope(text);
  const ok = Object.entries(expect).every(([k, v]) => scope[k] === v);
  check(`采集范围 ${JSON.stringify(expect)} :: ${text}`, ok, JSON.stringify(scope));
}
const plainScope = core.captureScope('帮我改一下这个脚本并跑测试');
check('普通行动请求三项范围均 false', !plainScope.readOnly && !plainScope.handoffOnly && !plainScope.noMemory, JSON.stringify(plainScope));
check('非字符串范围输入不抛错', JSON.stringify(core.captureScope(undefined)) === '{"readOnly":false,"handoffOnly":false,"noMemory":false}');

// —— 载体路由：能力缺口指向 MCP，纪律缺口指向 hook ——
check('capability-gap 路由含 mcp', core.suggestCarriers(core.KINDS.TOOL_GAP).includes('mcp'));
check('repeat-correction 路由含 hook', core.suggestCarriers(core.KINDS.REPEAT).includes('hook'));
check('discipline-gap 路由为 hook+rules', JSON.stringify(core.suggestCarriers(core.KINDS.DISCIPLINE)) === '["hook","rules"]');
check('long-term-preference 路由含 rules', core.suggestCarriers(core.KINDS.LONG_TERM).includes('rules'));
check('未知 kind 兜底 memory', JSON.stringify(core.suggestCarriers('no-such-kind')) === '["memory"]');
const routed = core.suggestCarriers(core.KINDS.TOOL_GAP);
routed.push('tampered');
check('路由返回副本，调用方改不动真源', !core.CARRIER_ROUTE[core.KINDS.TOOL_GAP].includes('tampered'));
check('每个 kind 都有路由', Object.values(core.KINDS).every(k => Array.isArray(core.CARRIER_ROUTE[k]) && core.CARRIER_ROUTE[k].length > 0));

// —— topic 稳定性：同主题去重、不同主题不互相吞并 ——
const sigA = core.classifyPreference('以后一律用简体中文回复').signals[0];
const sigB = core.classifyPreference('以后   一律用简体中文回复').signals[0];
check('空白差异不改变 topic', core.topicFor(sigA) === core.topicFor(sigB), `${core.topicFor(sigA)} vs ${core.topicFor(sigB)}`);
check('topic 带 kind 前缀', core.topicFor(sigA).startsWith(core.KINDS.LONG_TERM + ':'));
const gapTopic = core.topicFor(core.classifyProblem('找不到对应的 MCP 工具').signals[0]);
check('不同 kind 的 topic 不碰撞', gapTopic !== core.topicFor(sigA));
check('topic slug 长度受控', core.topicFor({ kind: 'k', match: '很长的'.repeat(60) }).split(':')[1].length <= 40);
check('缺信号时 topic 兜底 unknown', core.topicFor(null) === 'unknown' && core.topicFor({}) === 'unknown');
check('topic 不含空白与换行', !/\s/.test(core.topicFor({ kind: 'k', match: '带\n换行 和\t制表' })));

// —— 纯函数边界：核内不做 IO、不改状态、不联网 ——
check('核不 require 任何模块', !/\brequire\s*\(/.test(SRC));
check('核不含写文件/进程退出/网络调用', !/writeFileSync|appendFileSync|process\.exit|fetch\(|https?:\/\//.test(SRC));
check('核不含硬编码凭据或内网地址', !/(?:password|secret|token)\s*[:=]\s*['"][^'"]{6,}/i.test(SRC) && !/\b10\.\d+\.\d+\.\d+\b/.test(SRC));

// —— 变异自检：故意改坏判据，断言集必须变红（否则测试是假绿）——
function mutate(label, from, to, expectFailLabelPart) {
  if (!SRC.includes(from)) { check(`变异体可构造 :: ${label}`, false, '锚点未命中，变异自检无效'); return; }
  const file = path.join(SB, `mutant-${label.replace(/[^\w-]/g, '_')}.js`);
  fs.writeFileSync(file, SRC.replace(from, to), 'utf8');
  delete require.cache[file];
  const mutant = require(file);
  const results = assertions(mutant);
  const broken = results.filter(i => !i.ok);
  const hitExpected = broken.some(i => i.label.includes(expectFailLabelPart));
  check(`改坏判据必红 :: ${label}`, broken.length > 0 && hitExpected, `${broken.length} 条红；期望命中「${expectFailLabelPart}」`);
}
mutate('long-term-neutered', 'const LONG_TERM = /(?:以后', 'const LONG_TERM = /(?!)(?:以后', '偏好正例命中 long-term-preference');
mutate('meta-exclusion-removed', 'return META.test(text) || RULE_QUOTE.test(text);', 'return RULE_QUOTE.test(text);', '元提及');
mutate('note-text-changed', '检测到纠正或长期要求。', '检测到纠正或长期要求!!', '提醒正文与历史基线逐字节一致');
mutate('tool-gap-neutered', 'const TOOL_GAP = /(?:找不到', 'const TOOL_GAP = /(?!)(?:找不到', '问题正例命中 capability-gap');
mutate('repeat-failure-neutered', 'const REPEATED_FAILURE = /(?:又', 'const REPEATED_FAILURE = /(?!)(?:又', '问题正例命中 repeated-failure');
mutate('rule-quote-exclusion-removed', 'return META.test(text) || RULE_QUOTE.test(text);', 'return META.test(text);', '引用规则原文');
mutate('broad-recall-neutered', 'const LONG_TERM_BROAD = /(?:以后', 'const LONG_TERM_BROAD = /(?!)(?:以后', '采集加宽召回命中');
mutate('extended-flag-ignored', 'const extended = Boolean(options && options.extended);', 'const extended = false;', '采集加宽召回命中');
mutate('topic-whitespace-unstable', ".replace(/\\s+/g, '');", '.trim();', '空白差异不改变 topic');
mutate('popup-threshold-neutered', 'if ([KINDS.TOOL_GAP, KINDS.REPEATED_FAILURE].includes(candidate.kind)) return occurrences >= 2;', 'if ([KINDS.TOOL_GAP, KINDS.REPEATED_FAILURE].includes(candidate.kind)) return true;', '弹窗不够格：单次能力缺口且单会话');
mutate('experience-popup-allowed', "if (!candidate || candidate.family === 'experience') return false;", 'if (!candidate) return false;', '弹窗不够格：助手自述经验只进月报');
mutate('evolution-ask-too-wide', 'try { return EVOLUTION_ASK.test(JSON.stringify(input || {})); } catch { return false; }', 'try { return true; } catch { return false; }', '开工卡不冒充建议弹窗');
mutate('queued-mode-discriminator-removed', "if (!att || att.type !== 'queued_command' || att.commandMode !== 'prompt') return '';", "if (!att || att.type !== 'queued_command') return '';", '插话负对照：task-notification 不认');
mutate('queued-recognition-neutered', '  const att = entry.attachment;\n', '  const att = null;\n', '插话正例：prompt 模式取回原文');

// —— 跨文件漂移断言：核声明"与门禁同源"就必须真的逐字一致，且这条断言要能失败 ——
const gateSrc = fs.readFileSync(path.join(__dirname, 'stop-gate.js'), 'utf8');
const captureSrc = fs.readFileSync(path.join(__dirname, 'evolution-capture.cjs'), 'utf8');
const scopeBlock = gateSrc.slice(gateSrc.indexOf('function taskScope('), gateSrc.indexOf('function toolName('));
for (const [key, re] of [['readOnly', core.READ_ONLY], ['handoffOnly', core.HANDOFF_ONLY], ['noMemory', core.NO_MEMORY]]) {
  check(`门禁 taskScope 兜底与核 ${key} 逐字同源`, scopeBlock.includes(re.source));
}
check('漂移断言能失败（改一个字就不认）', !scopeBlock.replace('不要记住', '不要记得').includes(core.NO_MEMORY.source));
check('门禁 R19 复用核的 EVOLUTION_ASK（不另抄一份）', gateSrc.includes('R19-evolution-suggestion-not-asked') && gateSrc.includes('askedAbout(ctx, evolutionSignal.EVOLUTION_ASK)'));
const stateDirExpr = "process.env.EVOLUTION_CAPTURE_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'evolution-capture')";
check('采集与门禁的 pending 目录解析口径一致', captureSrc.includes(stateDirExpr) && gateSrc.includes(stateDirExpr));
check('采集与门禁的 pending 有效期一致（24h）', captureSrc.includes('PENDING_TTL_MS = 24 * 60 * 60 * 1000') && gateSrc.includes('PENDING_TTL_MS = 24 * 60 * 60 * 1000'));
check('采集 hook 自己永不拦截（强制弹窗只由门禁承担）', !/decision\s*:\s*['"]block/.test(captureSrc));
check('采集与门禁都复用核的插话识别（判据只有一份）',
  captureSrc.includes('signal.queuedUserTextOf(entry)') && gateSrc.includes("require('./evolution-signal-core.js').queuedUserTextOf"));
check('同源断言能失败（抹掉调用点就不认）',
  !captureSrc.replace('signal.queuedUserTextOf(entry)', '').includes('signal.queuedUserTextOf(entry)'));

// 变异自检本身的负对照：未改动的副本必须全绿（证明红来自变异，不是harness恒红）。
const cleanCopy = path.join(SB, 'clean-copy.js');
fs.writeFileSync(cleanCopy, SRC, 'utf8');
const cleanResults = assertions(require(cleanCopy));
check('未改动副本全绿（变异 harness 负对照）', cleanResults.every(i => i.ok), `${cleanResults.filter(i => !i.ok).length} 条红`);

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);