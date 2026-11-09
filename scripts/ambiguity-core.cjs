'use strict';
// 需求含混的确定性初筛：只产信号与提示文本，不拦截、不改变授权。
// 目标是让"帮我优化一下"这类请求每轮都被点名，而不是等模型自己想起来。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONCRETE = /(?:[A-Za-z]:[\\/]|(?:^|\s)\.{0,2}[\\/][^\s]+|[\w-]+\.(?:tsx?|jsx?|vue|java|py|go|rs|md|json|ya?ml|xml|sql|css|html|sh|bat|cmd|ps1)|https?:\/\/|(?:报错|错误|异常|堆栈|日志|截图)\s*[:：]|(?:TypeError|ReferenceError|SyntaxError|Exception|Error:)|(?:^|\s)(?:npm|pnpm|yarn|git|node|python|pip|docker|kubectl|curl|ssh|scp)\s)/i;
const NAMED_DEMONSTRATIVE = /这(?:个|块|部分|边|里)?\s*(?:按钮|页面|文件|函数|接口|字段|列|表|菜单|模块|服务|组件|样式|配置|方法|类|脚本|任务|需求|技能|命令|规则|文档|项目|仓库|流程|提示词|代码|问题|功能|逻辑|布局|文案|参数|返回值|测试|用例|卡片|批次|图|截图|视频|报告|方案|计划|清单)/;
const GENERAL_NOUN = /(?:提示词|技能|规则|文档|代码|配置|脚本|接口|模块|页面|项目|表|字段)\s*(?:的)?\s*(?:描述|长度|结构|格式|内容|文案|命名|顺序|布局|颜色|宽度|高度|性能|日志|测试|注释|版本|依赖|索引|权限)/;
const DEMONSTRATIVE = /(?:这个|那个|这块|那部分|这边|那边|它|上面那个|下面那个)/;
const WEAK_ACTION = /(?:优化|调整|弄|搞|整|看看|看下|处理|梳理|完善|美化|改|调)(?:一下|下|一?下吧|一下吧|吧)/;
const BARE_ACTION = /^(?:帮我|请|麻烦|给我|再)?\s*(?:优化|看看|看下|弄|搞|整|处理|梳理|完善|改改|调整)(?:一下|下|一?下)?\s*[。.!！~～]?$/;
const UNCERTAIN = /(?:随便|都行|都可以|你看着办|你决定|由你定|不(?:太|是很)?确定|不太清楚|不清楚|没(?:太)?想好|拿不准|含糊|模糊|说不清|帮我理一下|理一理|猜一下|你猜)/;
const SELF_UNCLEAR = /(?:指令|需求|意图|表述|说法|要求|提法)\s*(?:本身)?\s*(?:不清|不明|含糊|模糊)/;
const ASK_ADVICE = /(?:怎么|如何)(?:改|弄|搞|做|整|处理|优化)|有什么(?:好)?(?:建议|办法|思路)|你看怎么(?:弄|办|搞)/;
const META = /(?:技能|规则|提示词|hook|门禁).{0,12}(?:触发|生效|命中|能不能|是否|怎么改|怎么写|如何改)/;

function normalize(prompt) {
  return String(prompt || '')
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyAmbiguity(prompt) {
  const text = normalize(prompt);
  if (!text || text.length > 200) return { level: null, signals: [], text };
  if (/^[/!]/.test(text)) return { level: null, signals: [], text };
  if (CONCRETE.test(text) || NAMED_DEMONSTRATIVE.test(text) || GENERAL_NOUN.test(text) || META.test(text)) {
    return { level: null, signals: [], text };
  }
  const signals = [];
  if (UNCERTAIN.test(text)) signals.push('显式不确定');
  if (SELF_UNCLEAR.test(text)) signals.push('显式指令不清');
  if (BARE_ACTION.test(text)) signals.push('光杆动作');
  if (DEMONSTRATIVE.test(text) && WEAK_ACTION.test(text)) signals.push('空指代+泛化动作');
  if (ASK_ADVICE.test(text)) signals.push('求建议但无对象');
  if (signals.length) return { level: 'high', signals, text };
  if (DEMONSTRATIVE.test(text) && text.length <= 20) return { level: 'medium', signals: ['空指代短句'], text };
  if (WEAK_ACTION.test(text)) return { level: 'medium', signals: ['泛化动作'], text };
  return { level: null, signals: [], text };
}

function buildAmbiguityNote(result, context) {
  if (!result || !result.level) return '';
  const signal = result.signals[0] || '泛化请求';
  const base = result.level === 'high'
    ? '\n【需求含混 · 规则初筛命中（高）】信号：' + signal + '。初筛只负责高召回，不是结论：请结合完整请求与会话上下文做模型判别。'
      + '\n- clear：能指出具体对象、范围与验收依据 → 可直接做；绝大多数场景可在开工前用一句话确认理解（至多一次），确认后直接推进；'
      + '\n- assumption：对象明确但实现细节未定 → 说明可逆假设后推进；'
      + '\n- clarify：目标、对象或验收仍无法确定 → 只问一个核心问题，并用 AskUserQuestion 给 2–4 个真实备选（推荐项在前、写清各自代价与影响），不得凭猜测直接开工。'
      + '\n- 提示词纠正：请求本身缺对象、范围或验收时，可先按 /clarify 给 1 条保留原意的纠正稿（补全对象、范围、验收与禁止项），用 AskUserQuestion 让用户在「按纠正稿执行 / 继续澄清 / 取消」中选择；纠正稿只是建议，不构成执行授权，不得借改写扩大范围。'
      + '\n判为 clear 时须在回复中写明对象与验收依据；判为 clarify 时不得先猜着执行再补问；与答案无关且已获授权的部分可继续。'
    : '\n【需求含混 · 规则初筛命中（中）】信号：' + signal + '。初筛不是结论：先做模型判别。'
      + '\n对象或目标能从上下文定位 → 按 clear 直接做，可在开工前用一句话确认理解（至多一次）；只需定实现细节 → 按 assumption 说明假设后推进（可逆默认值）；仍无法定位对象或验收 → 按 clarify 问一个核心问题并给真实备选。不要为内部命名或参数增加确认门。'
      + '\n表述不全时可给 1 条保留原意的提示词纠正稿供用户选择（/clarify）；纠正稿只是建议，不构成执行授权。';
  const protocol = context && context.binding
    ? '\n【判别记录 · 可审计】开工前运行（纯讨论可跳过）：node ~/.qoder/scripts/ambiguity-core.cjs --decision - --binding ' + context.binding
      + ' --json，stdin 传 {"schema":1,"sessionId":"' + context.sessionId + '","decisionId":"' + context.decisionId
      + '","verdict":"clear|assumption|clarify","reason":"…","sourceRefs":["对象/验收证据"]}。'
      + '判 clear/assumption 至少给 1 条证据；判 clarify 同时用 AskUserQuestion 给 2–4 个备选。未判别就写入会被收尾门禁拦下。'
    : '';
  return base + protocol;
}

function stateDir() {
  if (process.env.AMBIGUITY_STATE_DIR) return path.resolve(process.env.AMBIGUITY_STATE_DIR);
  let root;
  try { root = require('./client-root.js').clientRoot(); }
  catch { root = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qoder'); }
  return path.join(root, 'tmp', 'ambiguity');
}

function sessionSlug(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function contextBinding(context) {
  return crypto.createHash('sha256').update(JSON.stringify([
    context.schema, context.decisionId, context.sessionId, context.level, context.signals,
  ])).digest('hex');
}

function createAmbiguityContext({ sessionId, decisionId, level, signals }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof decisionId !== 'string' || !decisionId
      || !['high', 'medium'].includes(level) || !Array.isArray(signals)) {
    throw new Error('INVALID_AMBIGUITY_CONTEXT');
  }
  const context = { schema: 1, decisionId, sessionId, level, signals: signals.slice(0, 3), at: new Date().toISOString() };
  context.binding = contextBinding(context);
  return context;
}

function pendingFile(sessionId) { return path.join(stateDir(), 'pending-' + sessionSlug(sessionId) + '.json'); }
function resolvedFile(sessionId) { return path.join(stateDir(), 'resolved-' + sessionSlug(sessionId) + '.json'); }

function writePending(context) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(pendingFile(context.sessionId), JSON.stringify(context) + '\n', { mode: 0o600 });
  return pendingFile(context.sessionId);
}

function clearPending(sessionId) {
  try { fs.unlinkSync(pendingFile(sessionId)); } catch {}
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function appendDecisionLog(fields) {
  const file = path.join(stateDir(), 'decisions.log');
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200);
      fs.writeFileSync(file, kept.join('\n') + '\n');
    }
    fs.appendFileSync(file, fields.join('|') + '\n');
  } catch {}
}

function evaluateDecision(input, binding) {
  if (!input || typeof input !== 'object' || input.schema !== 1) return { ok: false, code: 'INVALID_SCHEMA' };
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const pending = readJson(pendingFile(sessionId));
  if (!pending || pending.schema !== 1) return { ok: false, code: 'NO_PENDING' };
  if (pending.binding !== contextBinding(pending)) return { ok: false, code: 'PENDING_TAMPERED' };
  if (input.decisionId !== pending.decisionId) return { ok: false, code: 'DECISION_ID_MISMATCH' };
  if (binding !== undefined && binding !== pending.binding) return { ok: false, code: 'BINDING_MISMATCH' };
  if (!['clear', 'assumption', 'clarify'].includes(input.verdict)) return { ok: false, code: 'INVALID_VERDICT' };
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) return { ok: false, code: 'INVALID_REASON' };
  const refs = input.sourceRefs;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 8
      || refs.some(item => typeof item !== 'string' || item.trim().length < 2 || item.length > 300)) {
    return { ok: false, code: 'INVALID_SOURCE_REFS' };
  }
  const evidence = refs.join(' ').trim();
  if ((input.verdict === 'clear' || input.verdict === 'assumption') && evidence.length < 8) {
    return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
  }
  const at = new Date().toISOString();
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(resolvedFile(sessionId), JSON.stringify({
      schema: 1, decisionId: pending.decisionId, verdict: input.verdict, at, binding: pending.binding, refsCount: refs.length,
    }) + '\n', { mode: 0o600 });
  } catch { return { ok: false, code: 'WRITE_FAILED' }; }
  appendDecisionLog([
    at, sessionSlug(sessionId), String(pending.decisionId).slice(0, 8), pending.level,
    input.verdict, pending.signals.join(','), refs.length,
    crypto.createHash('sha256').update(input.reason).digest('hex').slice(0, 8),
  ]);
  // clarify 保留 pending，由收尾门禁确认是否真的弹窗；clear/assumption 直接销账。
  if (input.verdict !== 'clarify') clearPending(sessionId);
  return { schema: 1, ok: true, verdict: input.verdict, action: input.verdict === 'clarify' ? 'ask' : 'proceed', decisionId: pending.decisionId };
}

function readPending(sessionId) {
  const pending = readJson(pendingFile(sessionId));
  return pending && pending.schema === 1 && pending.binding === contextBinding(pending) ? pending : null;
}

function readResolved(sessionId) {
  const resolved = readJson(resolvedFile(sessionId));
  return resolved && resolved.schema === 1 ? resolved : null;
}

function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  try {
    let read;
    while ((read = fs.readSync(0, buffer, 0, buffer.length, null)) > 0) chunks.push(Buffer.from(buffer.subarray(0, read)));
  } catch {}
  return Buffer.concat(chunks).toString('utf8');
}

function main(argv) {
  const flag = argv.indexOf('--decision');
  if (flag < 0) {
    console.error('USAGE: ambiguity-core.cjs --decision <json|-> [--binding <sha256>] [--json]');
    process.exitCode = 2;
    return;
  }
  const source = argv[flag + 1];
  const bindingIndex = argv.indexOf('--binding');
  const binding = bindingIndex >= 0 ? argv[bindingIndex + 1] : undefined;
  let input;
  try {
    input = JSON.parse(source === '-' || source === undefined ? readStdin() : fs.readFileSync(source, 'utf8'));
  } catch {
    console.log(JSON.stringify({ ok: false, code: 'INVALID_JSON' }));
    process.exitCode = 2;
    return;
  }
  const result = evaluateDecision(input, binding);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

module.exports = {
  classifyAmbiguity, buildAmbiguityNote, normalize,
  createAmbiguityContext, writePending, clearPending, evaluateDecision, readPending, readResolved, contextBinding,
};
if (require.main === module) main(process.argv.slice(2));
