'use strict';
// 开工确认：除简单纯问答外的任务，先复述理解、列步骤、判断并行，复杂任务同轮确认文档/目标/并行。
// 关键词只做画像召回，模型判断为准；台账只存哈希与选择，不存用户原文。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_STEPS = 7;
const MAX_TEXT = 300;
const MAX_REASON = 300;
const PENDING_MS = 2 * 60 * 60 * 1000;
const CONFIRMED_MS = 24 * 60 * 60 * 1000;

const ACTION_WORDS = /(?:帮我|请帮我|麻烦|给我|把|改|修|做|实现|写|删|加|新增|去掉|替换|优化|调整|重构|迁移|部署|发布|安装|升级|提交|推送|执行|检查|分析|审查|审阅|调研|对比|测试|验证|生成|创建|整理|清理|同步|合并|拆分|设计|搭建|接入|联调|打包|构建|启动|停止|修复|排查|定位|诊断|看下|看看|查一下|查查|列一下|列出|给出|输出|补|完善|简化|收敛|瘦身|对接|切换|回滚|备份|恢复|删除|移动|复制|重命名|更新|修改|引入|移除|启用|关闭|处理|推进|落地)/;
const QUESTION_START = /^(?:请问|请解释|请说明|什么是|为什么|怎么|如何|是否|能否|能不能|可不可以|有没有|多少|哪|谁|何时|哪里)/;
const QUESTION_PHRASE = /(?:做什么|干什么|是什么|怎么写|怎么做|怎么改|怎么修|怎么用|怎么选|怎么弄|怎么处理|如何实现|如何配置|如何设置|为什么|是否|能否|能不能|可不可以|有没有|有什么|什么是|多少|哪里|哪个)/;
const IMPERATIVE_PREFIX = /^(?:帮我|请帮我|麻烦|给我|把)/;
const EXPLICIT_SKIP = /(?:不用|无需|不必|免)(?:再)?(?:确认|问|问我)|直接(?:做|执行|开工|改|处理)|别(?:问|确认)|先(?:做|执行)再说/;
const CONTINUATION = /^(?:继续(?:刚才|之前|上面|原计划)?的?(?:任务|工作|计划)?|接着|按(?:此|计划|刚才|上面|原计划)(?:继续)?|就按(?:这个|此|计划)|开始|执行吧|开工吧|下一步|往下做|继续做|好[的]?[，,]?(?:继续|开工|执行)|可以[，,]?(?:继续|开工|执行)|确认[，,]?(?:继续|执行|开工)|同意[，,]?(?:继续|执行|开工))(?:[。.!！~～]|$)/;
const COMPLEX_MARKERS = /(?:跨模块|跨端|前后端|全链路|全量|重构|迁移|架构|发布|部署|批量|多文件|多模块|多端|系统性|整套|多阶段|长期|长任务|并行|多会话|全部|整体|升级|打包|集成|联调|兼容|回归|灰度|上线|生产|权限|鉴权|计费|安全|性能|并发|缓存|消息队列|分布式|微服务)/g;

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function normalize(prompt) {
  return String(prompt || '')
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function classifyKickoffTask(prompt) {
  const text = normalize(prompt);
  if (!text) return { profile: 'question', signals: [], explicitSkip: false, text };
  if (/^[/!]/.test(text)) return { profile: 'question', signals: ['命令入口'], explicitSkip: false, text };
  if (EXPLICIT_SKIP.test(text)) return { profile: 'simple', signals: ['用户显式跳过'], explicitSkip: true, text };
  const imperative = ACTION_WORDS.test(text);
  const questionForm = QUESTION_START.test(text) || (/[?？]\s*$/.test(text) && QUESTION_PHRASE.test(text));
  if (!imperative) return { profile: 'question', signals: ['纯问答'], explicitSkip: false, text };
  if (questionForm && !IMPERATIVE_PREFIX.test(text)) {
    return { profile: 'question', signals: ['问答式请求'], explicitSkip: false, text };
  }
  const numbered = (text.match(/(?:^|\n)\s*(?:\d+[.、)]|[-*]\s+)/g) || []).length;
  const markers = [...new Set(text.match(COMPLEX_MARKERS) || [])].slice(0, 5);
  if (text.length >= 120) markers.push('长请求');
  if (numbered >= 3) markers.push('多步骤');
  if (markers.length) return { profile: 'complex', signals: markers, explicitSkip: false, text };
  return { profile: 'simple', signals: ['单步任务'], explicitSkip: false, text };
}

function isContinuation(prompt) {
  const text = normalize(prompt);
  return text.length > 0 && text.length <= 40 && CONTINUATION.test(text);
}

function validSession(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function contextBinding(context) {
  return sha256(JSON.stringify([
    context.schema, context.decisionId, context.sessionId, context.workspaceKey,
    context.requestMessageId, context.requestDigest, context.profileHint, context.signals,
  ]));
}

function createKickoffContext({ sessionId, prompt, cwd, requestMessageId, profileHint, signals, decisionId }) {
  if (!validSession(sessionId) || typeof prompt !== 'string' || !prompt.trim()
      || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw fail('INVALID_KICKOFF_CONTEXT', 'session, prompt and absolute cwd are required');
  }
  const classification = classifyKickoffTask(prompt);
  // 同一请求的上下文必须可复现：重试/重放不能换一个 binding，否则 route 隔离与去重都会假失败。
  const digest = sha256(prompt.trim());
  const id = decisionId || sha256([
    sessionId, path.resolve(cwd), String(requestMessageId || ''), digest,
  ].join('|')).slice(0, 32);
  const context = {
    schema: 1,
    decisionId: id,
    sessionId,
    workspaceKey: path.resolve(cwd),
    requestMessageId: String(requestMessageId || id).slice(0, 200),
    requestDigest: digest,
    profileHint: profileHint || classification.profile,
    signals: (signals || classification.signals).slice(0, 5),
  };
  if (!/^[a-f0-9]{64}$/.test(context.requestDigest)) throw fail('INVALID_KICKOFF_CONTEXT', 'request digest is invalid');
  context.binding = contextBinding(context);
  return context;
}

function stateDir() {
  if (process.env.KICKOFF_STATE_DIR) return path.resolve(process.env.KICKOFF_STATE_DIR);
  let root;
  try { root = require('./client-root.js').clientRoot(); }
  catch { root = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qoder'); }
  return path.join(root, 'tmp', 'kickoff');
}

function sessionSlug(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function pendingFile(sessionId) { return path.join(stateDir(), 'pending-' + sessionSlug(sessionId) + '.json'); }
function confirmedFile(sessionId) { return path.join(stateDir(), 'confirmed-' + sessionSlug(sessionId) + '.json'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fresh(at, maxMs) {
  const value = Date.parse(at);
  return Number.isFinite(value) && Date.now() - value <= maxMs;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function appendLog(fields) {
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

function pendingRecord(context) {
  return {
    schema: 1,
    context,
    at: new Date().toISOString(),
  };
}

function writePending(context) {
  writeJson(pendingFile(context.sessionId), pendingRecord(context));
}

function clearPending(sessionId) {
  try { fs.unlinkSync(pendingFile(sessionId)); } catch {}
}

function readPending(sessionId) {
  const pending = readJson(pendingFile(sessionId));
  if (!pending || pending.schema !== 1 || !pending.context || pending.context.schema !== 1) return null;
  if (pending.context.sessionId !== sessionId) return null;
  if (pending.context.binding !== contextBinding(pending.context)) return null;
  if (!fresh(pending.at, PENDING_MS)) return null;
  return pending;
}

function readConfirmed(sessionId) {
  const confirmed = readJson(confirmedFile(sessionId));
  if (!confirmed || confirmed.schema !== 1 || !confirmed.context || confirmed.context.schema !== 1) return null;
  if (confirmed.context.sessionId !== sessionId) return null;
  if (confirmed.context.binding !== contextBinding(confirmed.context)) return null;
  if (!['proceed', 'adjust', 'cancel'].includes(confirmed.choice)) return null;
  if (!fresh(confirmed.at, CONFIRMED_MS)) return null;
  return confirmed;
}

function textValue(value, code, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(code, 'text is missing or too long');
  return value.trim();
}

function validTaskId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function normalizeCard(card, context) {
  if (!card || typeof card !== 'object' || Array.isArray(card) || card.schema !== 1) {
    throw fail('INVALID_KICKOFF_CARD', 'card schema 1 is required');
  }
  if (card.bindingDigest !== context.binding) throw fail('STALE_KICKOFF_CARD', 'card is not bound to this request');
  if (!validTaskId(card.taskId)) throw fail('INVALID_KICKOFF_CARD', 'taskId is invalid');
  if (!['simple', 'complex'].includes(card.profile)) throw fail('INVALID_KICKOFF_CARD', 'profile must be simple or complex');
  const u = card.understanding;
  if (!u || typeof u !== 'object' || Array.isArray(u)) throw fail('INVALID_KICKOFF_CARD', 'understanding is required');
  const understanding = {
    goal: textValue(u.goal, 'INVALID_KICKOFF_CARD'),
    object: textValue(u.object, 'INVALID_KICKOFF_CARD'),
    scope: textValue(u.scope, 'INVALID_KICKOFF_CARD'),
    acceptance: textValue(u.acceptance, 'INVALID_KICKOFF_CARD'),
  };
  if (u.prohibitions !== undefined) {
    if (!Array.isArray(u.prohibitions) || u.prohibitions.length > 6) throw fail('INVALID_KICKOFF_CARD', 'prohibitions must be a bounded array');
    understanding.prohibitions = u.prohibitions.map(item => textValue(item, 'INVALID_KICKOFF_CARD', 200));
  }
  if (!Array.isArray(card.steps) || card.steps.length < 2 || card.steps.length > MAX_STEPS) {
    throw fail('INVALID_KICKOFF_CARD', 'steps must contain 2 to 7 items');
  }
  const steps = card.steps.map(item => textValue(item, 'INVALID_KICKOFF_CARD'));
  const p = card.parallel;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !['serial', 'parallel'].includes(p.mode)) {
    throw fail('INVALID_KICKOFF_CARD', 'parallel mode is required');
  }
  const parallel = {
    mode: p.mode,
    reason: textValue(p.reason, 'INVALID_KICKOFF_CARD', MAX_REASON),
  };
  let documentation;
  if (card.documentation !== undefined) {
    const d = card.documentation;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !['create', 'update', 'none'].includes(d.mode)) {
      throw fail('INVALID_KICKOFF_CARD', 'documentation mode is invalid');
    }
    documentation = {
      mode: d.mode,
      recommend: d.recommend === true,
      reason: textValue(d.reason, 'INVALID_KICKOFF_CARD', MAX_REASON),
    };
    if (d.mode !== 'none') documentation.target = textValue(d.target, 'INVALID_KICKOFF_CARD');
  }
  let goal;
  if (card.goal !== undefined) {
    const g = card.goal;
    if (!g || typeof g !== 'object' || Array.isArray(g) || !['create', 'none'].includes(g.mode)) {
      throw fail('INVALID_KICKOFF_CARD', 'goal mode is invalid');
    }
    goal = {
      mode: g.mode,
      recommend: g.recommend === true,
      reason: textValue(g.reason, 'INVALID_KICKOFF_CARD', MAX_REASON),
    };
    if (g.mode === 'create') goal.title = textValue(g.title, 'INVALID_KICKOFF_CARD', 120);
  }
  if (card.profile === 'simple') {
    if ((documentation && documentation.mode !== 'none') || (goal && goal.mode !== 'none')) {
      throw fail('INVALID_KICKOFF_CARD', 'simple cards must not request documentation or goal creation');
    }
  } else {
    if (!documentation || !goal) throw fail('INVALID_KICKOFF_CARD', 'complex cards must decide documentation and goal');
  }
  return {
    schema: 1,
    taskId: card.taskId,
    profile: card.profile,
    understanding,
    steps,
    parallel,
    documentation,
    goal,
  };
}

function cardDigest(card) {
  return sha256(JSON.stringify({
    schema: card.schema,
    taskId: card.taskId,
    profile: card.profile,
    understanding: card.understanding,
    steps: card.steps,
    parallel: card.parallel,
    documentation: card.documentation || null,
    goal: card.goal || null,
  }));
}

function option(label, description) {
  return { label, description };
}

function buildQuestions(card) {
  const questions = [{
    question: '是否按此理解与步骤开工？',
    header: '开工确认',
    multiSelect: false,
    options: [
      option('按此计划执行（推荐）', '按复述的目标/范围/验收、步骤和并行判断推进；对象、范围或验收变化时重新确认。'),
      option('调整理解或步骤', '先不执行；请指出要修正的对象、范围、步骤或验收，我修订后重新确认。'),
      option('取消本轮', '本轮不执行写入或副作用命令，只保留讨论。'),
    ],
  }];
  if (card.profile !== 'complex') return questions;
  const d = card.documentation;
  questions.push({
    question: '是否创建或更新文档？',
    header: '文档',
    multiSelect: false,
    options: d.recommend
      ? [
        option('创建/更新文档（推荐）', '同批维护 ' + (d.target || '相关文档') + '，便于交接与复查。'),
        option('本轮不成文', '只改代码或配置，不新增、不更新文档。'),
      ]
      : [
        option('本轮不成文（推荐）', '现有文档已覆盖或本轮范围很小，不新增文档。'),
        option('创建/更新文档', '同批更新 ' + (d.target || '相关文档') + '，便于交接与复查。'),
      ],
  });
  const g = card.goal;
  questions.push({
    question: '是否创建目标？',
    header: '目标',
    multiSelect: false,
    options: g.recommend
      ? [
        option('创建目标（推荐）', '创建“' + (g.title || '本轮任务') + '”的带判据目标，逐格推进并落盘。'),
        option('不创建目标', '用任务清单推进，不创建 Goal。'),
      ]
      : [
        option('不创建目标（推荐）', '任务规模可控，用任务清单推进即可。'),
        option('创建目标', '创建“' + (g.title || '本轮任务') + '”的目标，适合跨多回合推进。'),
      ],
  });
  const parallelQuestion = {
    question: '是否启用并行？',
    header: '并行',
    multiSelect: false,
    options: card.parallel.mode === 'parallel'
      ? [
        option('按计划并行（推荐）', '先给出完整并行计划与互斥 ownedPaths；写入仍收敛为单会话顺序执行。'),
        option('串行执行', '本轮单会话顺序执行，不派发并行。'),
      ]
      : [
        option('串行执行（推荐）', '写入任务默认单会话顺序执行，避免共享状态冲突。'),
        option('按计划并行', '需要先补并行计划与互斥 ownedPaths，再单独 opt-in。'),
      ],
  };
  questions.push(parallelQuestion);
  return questions;
}

function composeCard(input, expectedBinding) {
  if (!input || typeof input !== 'object' || input.schema !== 1 || !input.context || !input.card) {
    throw fail('INVALID_KICKOFF_COMPOSE', 'schema 1, context and card are required');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedBinding || '')) throw fail('INVALID_KICKOFF_COMPOSE', 'binding is required');
  const context = input.context;
  if (context.schema !== 1 || context.binding !== expectedBinding || contextBinding(context) !== expectedBinding) {
    throw fail('KICKOFF_SCOPE_MISMATCH', 'context does not match the injected binding');
  }
  const pending = readPending(context.sessionId);
  if (!pending) throw fail('NO_PENDING', 'no active kickoff for this session');
  if (pending.context.decisionId !== context.decisionId || pending.context.binding !== context.binding
      || pending.context.requestDigest !== context.requestDigest) {
    throw fail('KICKOFF_SCOPE_MISMATCH', 'pending kickoff belongs to another request');
  }
  const card = normalizeCard(input.card, context);
  const digest = cardDigest(card);
  const updated = {
    ...pending,
    cardDigest: digest,
    profile: card.profile,
    stepsCount: card.steps.length,
    cardAt: new Date().toISOString(),
    modes: {
      documentation: card.documentation ? card.documentation.mode : 'none',
      goal: card.goal ? card.goal.mode : 'none',
      parallel: card.parallel.mode,
    },
  };
  writeJson(pendingFile(context.sessionId), updated);
  appendLog([new Date().toISOString(), sessionSlug(context.sessionId), String(context.decisionId).slice(0, 8), card.profile, 'compose', card.steps.length, digest.slice(0, 12)]);
  return {
    schema: 1,
    ok: true,
    action: 'ASK_CONFIRMATION',
    binding: context.binding,
    cardDigest: digest,
    profile: card.profile,
    questions: buildQuestions(card),
  };
}

function validSelection(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

function recordConfirmation(input, expectedBinding) {
  if (!input || typeof input !== 'object' || input.schema !== 1 || !input.context) {
    throw fail('INVALID_KICKOFF_RECORD', 'schema 1 and context are required');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedBinding || '')) throw fail('INVALID_KICKOFF_RECORD', 'binding is required');
  const context = input.context;
  if (context.schema !== 1 || context.binding !== expectedBinding || contextBinding(context) !== expectedBinding) {
    throw fail('KICKOFF_SCOPE_MISMATCH', 'context does not match the injected binding');
  }
  const pending = readPending(context.sessionId);
  if (!pending) throw fail('NO_PENDING', 'no active kickoff for this session');
  if (pending.context.decisionId !== context.decisionId || pending.context.binding !== context.binding
      || pending.context.requestDigest !== context.requestDigest) {
    throw fail('KICKOFF_SCOPE_MISMATCH', 'pending kickoff belongs to another request');
  }
  if (!pending.cardDigest || !/^[a-f0-9]{64}$/.test(pending.cardDigest)) throw fail('CARD_NOT_COMPOSED', 'compose the card before recording a confirmation');
  if (input.cardDigest !== pending.cardDigest) throw fail('STALE_KICKOFF_CARD', 'confirmation belongs to a different card');
  if (!['proceed', 'adjust', 'cancel'].includes(input.choice)) throw fail('INVALID_KICKOFF_CHOICE', 'choice must be proceed, adjust or cancel');
  const modes = pending.modes || {};
  let selections = null;
  if (input.choice === 'proceed') {
    const given = input.selections || {};
    selections = {
      documentation: given.documentation || (modes.documentation === 'create' || modes.documentation === 'update' ? modes.documentation : 'none'),
      goal: given.goal || (modes.goal === 'create' ? 'create' : 'none'),
      parallel: given.parallel || modes.parallel || 'serial',
    };
    if (!validSelection(selections.documentation, ['create', 'update', 'none'])
        || !validSelection(selections.goal, ['create', 'none'])
        || !validSelection(selections.parallel, ['serial', 'parallel'])) {
      throw fail('INVALID_KICKOFF_SELECTION', 'selections contain unsupported values');
    }
  }
  const confirmed = {
    schema: 1,
    context,
    cardDigest: pending.cardDigest,
    profile: pending.profile || context.profileHint,
    choice: input.choice,
    selections,
    at: new Date().toISOString(),
  };
  writeJson(confirmedFile(context.sessionId), confirmed);
  appendLog([confirmed.at, sessionSlug(context.sessionId), String(context.decisionId).slice(0, 8), confirmed.profile, input.choice, selections ? [selections.documentation, selections.goal, selections.parallel].join(',') : '-', pending.cardDigest.slice(0, 12)]);
  if (input.choice !== 'adjust') clearPending(context.sessionId);
  return {
    schema: 1,
    ok: true,
    action: input.choice === 'proceed' ? 'proceed' : input.choice === 'adjust' ? 'revise' : 'stop',
    decisionId: context.decisionId,
    cardDigest: pending.cardDigest,
  };
}

function quote(value) {
  return process.platform === 'win32'
    ? "'" + String(value).replace(/'/g, "''") + "'"
    : "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function commandFor(mode, binding) {
  const script = path.join(__dirname, 'kickoff-core.cjs');
  const command = { executable: process.execPath, args: [script, '--' + mode, '-', '--binding', binding, '--json'] };
  const shell = (process.platform === 'win32' ? '& ' : '') + [command.executable, ...command.args].map(quote).join(' ');
  return { command, shell };
}

function buildKickoffNote(result) {
  const context = result.context;
  const profile = context.profileHint;
  const signals = context.signals.length ? '信号：' + context.signals.join('、') : '画像：模型判断';
  const compose = commandFor('compose', context.binding);
  const record = commandFor('record', context.binding);
  const complex = profile === 'complex';
  return '\n【开工确认 · 必要项｜' + profile + '】' + signals + '。除简单纯问答外，先完成确认再写入/执行；纯问答、用户明确说“不用确认”、同一任务已确认的继续执行可豁免。'
    + '\n先在只读范围内辨认任务，再在回复正文写确认卡：理解（目标/对象/范围/验收/禁止项）、步骤（2–7 步，每步可验证）、并行（串行/可并行+理由）、影响与回滚。'
    + (complex
      ? '\n复杂任务同轮另问：文档（创建/更新/不成文）、目标（创建/不创建）、并行（按计划/串行）；验证档沿用现有 B05 必问。'
      : '\n简单任务只问计划确认；并行判断写进卡片，写入任务默认串行。')
    + '\nKICKOFF_CONTEXT ' + JSON.stringify(context)
    + '\nKICKOFF_BINDING ' + context.binding
    + '\nKICKOFF_COMPOSE_COMMAND ' + JSON.stringify(compose.command)
    + '\nKICKOFF_COMPOSE_SHELL ' + JSON.stringify(compose.shell)
    + '\nKICKOFF_RECORD_COMMAND ' + JSON.stringify(record.command)
    + '\nKICKOFF_RECORD_SHELL ' + JSON.stringify(record.shell)
    + '\n结构化输入（compose）：{schema:1,context:<上方 KICKOFF_CONTEXT 原样>,card:{schema:1,bindingDigest:"' + context.binding + '",taskId:"<当前任务ID>",profile:"simple|complex",understanding:{goal:"…",object:"…",scope:"…",acceptance:"…",prohibitions:["…"]},steps:["…","…"],parallel:{mode:"serial|parallel",reason:"…"}'
    + (complex ? ',documentation:{mode:"create|update|none",target:"…",recommend:true|false,reason:"…"},goal:{mode:"create|none",title:"…",recommend:true|false,reason:"…"}' : '')
    + '}}。'
    + '\n流程：① 运行 compose 校验卡片并取得 AskUserQuestion 载荷与 cardDigest；② 用 AskUserQuestion 确认（简单 1 问；复杂计划/文档/目标/并行 4 问，一次问全）；③ 用 cardDigest 运行 record（choice=proceed|adjust|cancel）；④ 确认 proceed 后再写入/执行。未确认前只做只读调查；用户选调整则修订后重问，选取消则停手。台账只存哈希与选择，不存原文；已写入但未确认会被收尾门禁拦下。';
}

function prepareKickoff({ sessionId, prompt, cwd, requestMessageId }) {
  if (!validSession(sessionId)) return { skip: true, reason: 'NO_SESSION' };
  const classification = classifyKickoffTask(prompt);
  if (classification.explicitSkip) return { skip: true, reason: 'USER_SKIP' };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('INVALID_KICKOFF_CONTEXT', 'absolute cwd is required');
  const confirmed = readConfirmed(sessionId);
  if (confirmed && confirmed.choice === 'proceed' && isContinuation(prompt)) {
    return { skip: true, reason: 'CONTINUATION', continuation: confirmed };
  }
  if (classification.profile === 'question') return { skip: true, reason: 'QUESTION' };
  const context = createKickoffContext({
    sessionId, prompt, cwd, requestMessageId,
    profileHint: classification.profile, signals: classification.signals,
  });
  writePending(context);
  return { skip: false, context, note: buildKickoffNote({ context }) };
}

function buildContinuationNote(confirmed) {
  if (!confirmed) return '';
  const profile = confirmed.profile || (confirmed.context && confirmed.context.profileHint) || 'simple';
  return '\n【开工确认 · 已确认继续】沿用已确认计划 ' + String(confirmed.context.decisionId).slice(0, 8)
    + '（' + profile + '）；不重复建卡。对象、范围、验收或并行计划变化时重新确认。';
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
  const compose = argv.indexOf('--compose');
  const record = argv.indexOf('--record');
  const mode = compose >= 0 ? 'compose' : record >= 0 ? 'record' : null;
  const flag = compose >= 0 ? compose : record;
  if (!mode || flag < 0) {
    console.error('USAGE: kickoff-core.cjs --compose|--record <json|-> --binding <sha256> [--json]');
    process.exitCode = 2;
    return;
  }
  if (argv.indexOf('--compose') >= 0 && argv.indexOf('--record') >= 0) {
    console.log(JSON.stringify({ ok: false, code: 'USAGE' }));
    process.exitCode = 2;
    return;
  }
  const bindingIndex = argv.indexOf('--binding');
  const binding = bindingIndex >= 0 ? argv[bindingIndex + 1] : undefined;
  const source = argv[flag + 1];
  let input;
  try {
    input = JSON.parse(source === '-' || source === undefined ? readStdin() : fs.readFileSync(source, 'utf8'));
  } catch {
    console.log(JSON.stringify({ ok: false, code: 'INVALID_JSON' }));
    process.exitCode = 2;
    return;
  }
  try {
    const result = mode === 'compose' ? composeCard(input, binding) : recordConfirmation(input, binding);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || 'KICKOFF_ERROR', message: error.message }));
    process.exitCode = 2;
  }
}

module.exports = {
  classifyKickoffTask, isContinuation, createKickoffContext, contextBinding,
  prepareKickoff, buildKickoffNote, buildContinuationNote, composeCard, recordConfirmation,
  readPending, readConfirmed, clearPending, writePending, stateDir, cardDigest,
};
if (require.main === module) main(process.argv.slice(2));
