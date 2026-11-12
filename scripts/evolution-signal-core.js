'use strict';
// 自进化信号核（单一真源，2026-11-12）。
// 三个消费方共用同一套判据，避免"提醒说一套、采集记一套、门禁拦一套"的漂移：
//   ① rules-reminder.js  → preferenceNote()：每轮注入的采集提示（正文与 2026-11-02 版逐字节一致）
//   ② evolution-capture.cjs → classifyPreference() / classifyProblem()：Stop 时确定性采集候选
//   ③ stop-gate.js       → EVOLUTION_ASK / popupWorthy 同源；范围判据仍是门禁自己的 taskScope
//                          （含 kickoffCore 覆写），其兜底正则与本文件 READ_ONLY/HANDOFF_ONLY/NO_MEMORY
//                          逐字一致，由 evolution-signal-core.test.js 的漂移断言看住。
//   ④ 收尾建议弹窗        → isEvolutionAsk() + popupWorthy()：采集层写 pending，门禁 R19 强制弹给用户拍板
//
// 边界：纯函数、无 fs、无副作用、不联网、不写状态、不改变任何权限。
// 信号只是"值得核对的候选"，不是用户偏好本身，更不是采纳授权；
// 证据门槛（明确偏好一次即可 / 推断习惯 ≥3 独立任务跨 ≥2 会话）由 self-evolution 技能与当前代理判断。

// —— 正向三族：长期要求 / 显式沉淀 / 重复纠正（与提醒层原判据一致，不要为单次约束加正向词）——
const LONG_TERM = /(?:以后|今后|下次|从现在开始|每次|一律|永远|总是).{0,24}(?:都|要|别|不要|必须|记得|记住|用|按)/;
// 采集层专用的加宽召回（extended:true 才生效，提醒层与门禁仍用上面的历史判据，模式隔离）。
// 补的是历史动词表漏掉的祈使尾词，例如「从现在开始提交只加明确路径」——真实长期要求，旧表不命中。
// 仍然要求祈使尾词，「以后再说」「下次再看」这类拖延语不会命中。
const LONG_TERM_BROAD = /(?:以后|今后|下次|从现在开始|每次|一律|永远|总是).{0,24}(?:都|要|别|不要|必须|记得|记住|用|按|只|先|统一|默认|保持|禁止|不得)/;
const EXPLICIT = /(?:记住|记一下|写进记忆|写入记忆|沉淀|固化成规则)/;
const REPEAT = /(?:你又|怎么又|说了(?:多少|几)次|重复(?:犯|出现)|还是没|一直没|每次都)/;
// —— 排除项：元提及（教学式假设）与引用规则原文，都不是真实偏好 ——
const META = /(?:当我说|如果我说|比如我说|这句话|这个词|举个例子).{0,24}(?:触发|处理|怎么|如何|会怎样|是否)/;
const RULE_QUOTE = /(?:规则|AGENTS|提示词|文档).{0,16}(?:说|写着|要求|规定)/;

const PREFERENCE_NOTE = '\n【自进化采集 · 本轮疑似纠正/长期偏好】检测到纠正或长期要求。收尾前按 self-evolution 证据门槛判断：用户明确长期偏好一次即可采纳；推断习惯需 ≥3 个独立任务、跨 ≥2 会话；单次任务约束只作用本轮。采纳则落到最窄载体并说明作用范围；临时要求明确说明不沉淀。';

// —— 过程问题族（只供采集层与晋升扫描使用；提醒层不注入，保持模式隔离）——
// 能力缺口：工具/命令/技能/插件/MCP/依赖明确缺失或不可用。
const TOOL_GAP = /(?:找不到|没有|缺少|缺失|不可用|未安装|没装|不支持|没提供).{0,16}(?:工具|命令|脚本|技能|插件|MCP|依赖|接口|能力)|(?:工具|命令|技能|插件|MCP|依赖).{0,12}(?:找不到|不可用|缺失|没装|未安装)|\b(?:command not found|cannot find module|is not recognized|no such tool|unknown tool|tool not (?:available|found))\b/i;
// 重复失败：同一问题再次失败/仍未生效（用户口述，属待核对材料）。
const REPEATED_FAILURE = /(?:又|再次|还是|仍然|重复|反复).{0,12}(?:失败|报错|超时|崩溃|不行|不对|没生效|不生效)|(?:失败|报错|超时).{0,12}(?:多次|三次|3 ?次|反复)/;
// 助手自述的已否证处方与验证结论：技术经验候选，不是用户偏好，verified 一律 false。
const DISPROVEN_PREFIX = /^已否证[：:]/;
const VERIFIED_PREFIX = /^验证结论[：:]/;

// —— 采集范围（与 stop-gate taskScope 的兜底正则同源）——
const READ_ONLY = /只读|仅(?:提供|做|作)?(?:审阅|审查|评审|分析|建议)|只(?:给|提供)(?:方案|建议)|不(?:要|得)?(?:修改|写入|改动)任何文件|在(?:更改|修改)任何文件之前/;
const HANDOFF_ONLY = /仅做交接|只(?:做交接|给(?:我)?开工提示词)|我自己新开会话/;
const NO_MEMORY = /不(?:要|得)?(?:写入|保存|更新|使用|读取|新增|写)记忆|不要记住/;

const KINDS = {
  LONG_TERM: 'long-term-preference',
  EXPLICIT: 'explicit-sedimentation',
  REPEAT: 'repeat-correction',
  TOOL_GAP: 'capability-gap',
  REPEATED_FAILURE: 'repeated-failure',
  DISPROVEN: 'disproven-prescription',
  VERIFIED: 'verified-conclusion',
  DISCIPLINE: 'discipline-gap',
};

// 载体路由：候选 → 建议落点（只是路由建议，采纳仍需 carrier-preflight + 当轮授权 + 证据门槛）。
const CARRIER_ROUTE = {
  [KINDS.LONG_TERM]: ['memory', 'rules', 'agents'],
  [KINDS.EXPLICIT]: ['memory', 'rules', 'skill'],
  [KINDS.REPEAT]: ['rules', 'hook', 'memory'],
  [KINDS.TOOL_GAP]: ['mcp', 'skill', 'script'],
  [KINDS.REPEATED_FAILURE]: ['skill', 'hook', 'memory'],
  [KINDS.DISPROVEN]: ['skill', 'memory'],
  [KINDS.VERIFIED]: ['skill', 'memory'],
  [KINDS.DISCIPLINE]: ['hook', 'rules'],
};

function normalize(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function isMetaOrQuote(text) {
  return META.test(text) || RULE_QUOTE.test(text);
}

function firstMatch(regex, text) {
  const m = text.match(regex);
  return m ? m[0] : '';
}

// 用户偏好/纠正信号。返回 signals 数组（含命中原文片段，供采集层生成稳定 topic）。
// options.extended=true 时启用采集层加宽召回；默认（提醒层 / 门禁）保持历史判据不变。
function classifyPreference(text, options) {
  const t = normalize(text);
  if (!t || isMetaOrQuote(t)) return { matched: false, signals: [] };
  const extended = Boolean(options && options.extended);
  const signals = [];
  const longTerm = extended ? LONG_TERM_BROAD : LONG_TERM;
  if (longTerm.test(t)) signals.push({ kind: KINDS.LONG_TERM, match: firstMatch(longTerm, t) });
  if (EXPLICIT.test(t)) signals.push({ kind: KINDS.EXPLICIT, match: firstMatch(EXPLICIT, t) });
  if (REPEAT.test(t)) signals.push({ kind: KINDS.REPEAT, match: firstMatch(REPEAT, t) });
  return { matched: signals.length > 0, signals };
}

// 提醒层入口：正文与旧 evolutionNote 逐字节一致（模式隔离，不掺入过程问题族）。
function preferenceNote(text) {
  return classifyPreference(text).matched ? PREFERENCE_NOTE : '';
}

// 过程问题信号。只认明确的能力缺口与重复失败；助手前缀笔记单独归类，不冒充用户偏好。
function classifyProblem(text) {
  const t = normalize(text);
  if (!t || isMetaOrQuote(t)) return { matched: false, signals: [] };
  const signals = [];
  if (TOOL_GAP.test(t)) signals.push({ kind: KINDS.TOOL_GAP, match: firstMatch(TOOL_GAP, t) });
  if (REPEATED_FAILURE.test(t)) signals.push({ kind: KINDS.REPEATED_FAILURE, match: firstMatch(REPEATED_FAILURE, t) });
  return { matched: signals.length > 0, signals };
}

// 助手段落前缀（与 continuity 采集边界同一套前缀），只作技术经验候选。
function classifyAssistantNote(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { matched: false, signals: [] };
  if (DISPROVEN_PREFIX.test(t)) return { matched: true, signals: [{ kind: KINDS.DISPROVEN, match: '已否证' }] };
  if (VERIFIED_PREFIX.test(t)) return { matched: true, signals: [{ kind: KINDS.VERIFIED, match: '验证结论' }] };
  return { matched: false, signals: [] };
}

// —— 真实用户指令的宿主形态（2026-11-12 实测取证，不是猜的）——
// 用户在 Agent 运行中插话时，宿主把这条指令写成 attachment/queued_command，**不是** role=user 条目：
//   {"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt",
//    "prompt":[{"type":"text","text":"…"}],"origin":{"kind":"bridge","sessionId":"…"}}}
// 只认 commandMode==='prompt'：同形态的 task-notification（后台任务完成通知）是系统注入件，
// 当成用户指令会让 scope 与候选双双失真（实测同一会话 15 条通知 vs 1 条真实插话）。
// 漏认这种形态的代价已实测：采集 userText 恒空 → SKIP → 零候选 → 收尾弹窗整轮不出现。
const INJECTED_PREFIX = /^\[stop-gate\b|^\[continuity\b|^Base directory for this skill:|^Note: The file|^\[SYSTEM NOTIFICATION - NOT USER INPUT\]|^<task-notification>/;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

// 注入件与空正文一律不算用户指令；system-reminder 是宿主贴的上下文，先剥掉再判。
function cleanUserText(raw) {
  const text = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || INJECTED_PREFIX.test(text)) return '';
  return text;
}

function queuedUserTextOf(entry) {
  if (!entry || entry.isCompactSummary === true || entry.isMeta === true || entry.isSidechain === true) return '';
  const msg = entry.message || {};
  if (msg.role === 'assistant') return ''; // 助手正文里引用的同形 JSON 不是用户插话
  const att = entry.attachment;
  if (!att || att.type !== 'queued_command' || att.commandMode !== 'prompt') return '';
  if (att.isMeta === true || att.isCompactSummary === true) return '';
  return cleanUserText(textOfContent(att.prompt));
}

function captureScope(userText) {
  const text = typeof userText === 'string' ? userText : '';
  return {
    readOnly: READ_ONLY.test(text),
    handoffOnly: HANDOFF_ONLY.test(text),
    noMemory: NO_MEMORY.test(text),
  };
}

function suggestCarriers(kind) {
  return CARRIER_ROUTE[kind] ? CARRIER_ROUTE[kind].slice() : ['memory'];
}

// —— 收尾建议弹窗（2026-11-12 用户明确要求）：采集层写 pending，门禁 R19 强制弹 ——
// 只认"问的是自进化建议"的弹窗：开工确认卡 / 清理卡也用 AskUserQuestion，不能拿它们冒充已问过建议。
// 判据只用自进化专有词：真实清理卡正文含「可清理候选 N 项」，旧判据里的 /候选|载体|采纳/ 会把它当成
// 已问过建议 → R19 放行并清掉 pending，用户永远看不到建议（2026-11-12 第二轮对抗审查实测复现）。
// 与 R19 提示文案同口径：卡片问题正文必须含「自进化」（或沉淀/学到的这类同义专有词）。
const EVOLUTION_ASK = /自进化|进化建议|沉淀|学到的/;
function isEvolutionAsk(name, input) {
  if (name !== 'AskUserQuestion') return false;
  try { return EVOLUTION_ASK.test(JSON.stringify(input || {})); } catch { return false; }
}

// 哪些候选值得当轮弹窗（其余只进月报，避免每轮打扰）：
//   · 用户明确信号（长期偏好 / 显式沉淀 / 重复纠正）一次即可；
//   · 过程问题（能力缺口 / 重复失败）要同一错误 ≥2 次，或同主题跨 ≥2 会话；
//   · 助手自述的"已否证 / 验证结论"是技术经验候选，不弹窗（verified 一律 false，只进报告）。
function popupWorthy(candidate, sessionCount) {
  if (!candidate || candidate.family === 'experience') return false;
  const occurrences = Number(candidate.evidence && candidate.evidence.occurrences) || 1;
  const sessions = Number(sessionCount) || 1;
  if (sessions >= 2) return true;
  if ([KINDS.LONG_TERM, KINDS.EXPLICIT, KINDS.REPEAT].includes(candidate.kind)) return true;
  if ([KINDS.TOOL_GAP, KINDS.REPEATED_FAILURE].includes(candidate.kind)) return occurrences >= 2;
  return false;
}

// 稳定 topic：同一主题在同一任务内重复出现只算一条候选；不同主题不互相吞并。
// 去掉全部空白后再 slug，保证「以后   一律用」与「以后一律用」是同一条候选。
function topicFor(signal) {
  const raw = normalize(signal && signal.match ? signal.match : '').replace(/\s+/g, '');
  const slug = raw.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (signal && signal.kind ? signal.kind : 'unknown') + (slug ? ':' + slug : '');
}

module.exports = {
  LONG_TERM, LONG_TERM_BROAD, EXPLICIT, REPEAT, META, RULE_QUOTE,
  TOOL_GAP, REPEATED_FAILURE, READ_ONLY, HANDOFF_ONLY, NO_MEMORY,
  PREFERENCE_NOTE, KINDS, CARRIER_ROUTE, EVOLUTION_ASK,
  normalize, isMetaOrQuote, classifyPreference, preferenceNote,
  classifyProblem, classifyAssistantNote, captureScope, suggestCarriers, topicFor,
  isEvolutionAsk, popupWorthy,
  INJECTED_PREFIX, textOfContent, cleanUserText, queuedUserTextOf,
};