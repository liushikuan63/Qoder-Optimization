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
// C1：验证四档与 verification-policy 的 optionId 一致，卡内一次问全，不另弹窗。
const VERIFICATION_IDS = ['light', 'standard', 'deep', 'manual'];
const VERIFICATION_LABELS = { light: '轻量验证', standard: '标准验证', deep: '强化验证', manual: '交由人工验证' };
const VERIFICATION_DESCRIPTIONS = {
  light: '只跑必需检查与轻量项；省略的标准/强化项会在汇报里列为缺口。',
  standard: '必需检查加标准项；比轻量多覆盖回归与边界，暂无可靠估时。',
  deep: '必需检查加标准与强化项；对外动作与高风险改动的完整检验，暂无可靠估时。',
  manual: '不自动运行测试或审查；提供人工步骤与预期，保持待人工验证，不视为通过或发布许可。',
};

const ACTION_WORDS = /(?:帮我|请帮我|麻烦|给我|把|改|修|做|实现|写|删|加|新增|去掉|替换|优化|调整|重构|迁移|部署|发布|安装|升级|提交|推送|执行|检查|分析|审查|审阅|调研|对比|测试|验证|生成|创建|整理|清理|同步|合并|拆分|设计|搭建|接入|联调|打包|构建|启动|停止|修复|排查|定位|诊断|看下|看看|查一下|查查|列一下|列出|给出|输出|补|完善|简化|收敛|瘦身|对接|切换|回滚|备份|恢复|删除|移动|复制|重命名|更新|修改|引入|移除|启用|关闭|处理|推进|落地)/;
const QUESTION_START = /^(?:请问|请解释|请说明|什么是|为什么|怎么|如何|是否|能否|能不能|可不可以|有没有|多少|哪|谁|何时|哪里|在哪个|哪些|在哪里|在哪儿|有哪些)/;
const ACTION_START = /^(?:帮我|请帮我|麻烦|给我|把|改|修|做|实现|写|删|加|新增|去掉|替换|优化|调整|重构|迁移|部署|发布|安装|升级|提交|推送|执行|检查|分析|审查|审阅|调研|对比|测试|验证|生成|创建|整理|清理|同步|合并|拆分|设计|搭建|接入|联调|打包|构建|启动|停止|修复|排查|定位|诊断|看下|看看|查一下|查查|列一下|列出|给出|输出|补|完善|简化|收敛|瘦身|对接|切换|回滚|备份|恢复|删除|移动|复制|重命名|更新|修改|引入|移除|启用|关闭|处理|推进|落地)/;
const QUESTION_PHRASE = /(?:做什么|干什么|是什么|怎么写|怎么做|怎么改|怎么修|怎么用|怎么选|怎么弄|怎么处理|如何实现|如何配置|如何设置|为什么|是否|能否|能不能|可不可以|有没有|有什么|什么是|多少|哪里|哪个)/;
const IMPERATIVE_PREFIX = /^(?:帮我|请帮我|麻烦|给我|把)/;
const EXPLICIT_SKIP = /(?:不用|无需|不必|免)(?:再)?(?:确认|问|问我)|直接(?:做|执行|开工|改|处理)|别(?:问|确认)|先(?:做|执行)再说/;
const CONTINUATION = /^(?:继续(?:刚才|之前|上面|原计划)?的?(?:任务|工作|计划)?|接着|按(?:此|计划|刚才|上面|原计划)(?:继续)?|就按(?:这个|此|计划)|开始|执行吧|开工吧|下一步|往下做|继续做|好[的]?[，,]?(?:继续|开工|执行)|可以[，,]?(?:继续|开工|执行)|确认[，,]?(?:继续|执行|开工)|同意[，,]?(?:继续|执行|开工))(?:[。.!！~～]|$)/;
const COMPLEX_MARKERS = /(?:跨模块|跨端|前后端|全链路|全量|重构|迁移|架构|发布|部署|批量|多文件|多模块|多端|系统性|整套|多阶段|长期|长任务|并行|多会话|全部|整体|升级|打包|集成|联调|兼容|回归|灰度|上线|生产|权限|鉴权|计费|安全|性能|并发|缓存|消息队列|分布式|微服务)/g;
const READONLY_EXPLICIT = /(?:只读|仅(?:提供|做|作)?(?:审阅|审查|评审|分析|建议)|只(?:给|提供)(?:方案|建议)|不(?:要|得)?(?:修改|写入|改动)任何文件)/;
const READONLY_REVIEW = /(?:审阅|审查|评审|评估|复盘|分析|诊断|排查|对比|梳理|检视)/;
const READONLY_OUTPUT = /(?:建议|结论|意见|方案|推荐|判断|报告|评估)/;
const MUTATION_INTENT = /(?<!的)(?:修改|改动|改成|修复|实现|新增|添加|删除|移除|部署|发布|上线|提交|推送|写入|重构|迁移|安装|升级|替换|更新|优化|调整|执行|落地|开工|改一|改下|做一个|写一个|生成)/;

// 纯审阅/分析且没有变更动词时，不要求开工确认；显式"只读"优先，但带明确
// 先后顺序或祈使动作（"先只读检查，然后执行""帮我改…"）时仍按执行任务处理。
function isReadOnlyRequest(prompt) {
  const text = normalize(prompt);
  if (!text) return false;
  if (/不(?:要|得)?(?:修改|写入|改动)任何文件/.test(text)) return true;
  if (READONLY_EXPLICIT.test(text)) {
    if (/(?:然后|接着|之后|再|并|同时|随后)[^，。；]{0,16}(?:修改|改动|修复|实现|写入|新增|删除|移除|部署|发布|提交|推送|优化|调整|更新|安装|升级|执行|落地)/.test(text)) return false;
    if (/(?:帮我|请帮我|麻烦|给我|需要你|要你)[^，。；]{0,10}(?:修改|改动|修复|实现|写入|新增|删除|移除|部署|发布|提交|推送|优化|调整|更新|安装|升级|执行|落地|做一个|写一个)/.test(text)) return false;
    return true;
  }
  if (MUTATION_INTENT.test(text)) return false;
  return READONLY_REVIEW.test(text) && READONLY_OUTPUT.test(text);
}

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

// 请求锚点：前缀 + 长度，避免 transcript 尾部截断导致整段摘要失配。
function requestKey(prompt) {
  const text = normalize(prompt);
  return sha256(text.slice(0, 160) + '|' + text.length);
}

function matchesRequest(context, candidate) {
  if (!context) return false;
  const id = candidate && candidate.requestMessageId;
  if (id && context.requestMessageId && String(id) === String(context.requestMessageId)) return true;
  const text = candidate && typeof candidate.text === 'string' ? candidate.text : '';
  if (text) {
    if (sha256(text.trim()) === context.requestDigest) return true;
    if (context.promptKey && requestKey(text) === context.promptKey) return true;
  }
  const digest = candidate && candidate.digest;
  return Boolean(digest && digest === context.requestDigest);
}

function classifyKickoffTask(prompt) {
  const text = normalize(prompt);
  if (!text) return { profile: 'question', signals: [], explicitSkip: false, text };
  if (/^[/!]/.test(text)) return { profile: 'question', signals: ['命令入口'], explicitSkip: false, text };
  if (EXPLICIT_SKIP.test(text)) return { profile: 'simple', signals: ['用户显式跳过'], explicitSkip: true, text };
  if (isReadOnlyRequest(text)) return { profile: 'simple', signals: ['只读审阅'], explicitSkip: false, readOnly: true, text };
  const imperative = ACTION_WORDS.test(text);
  const clauses = text.split(/[，,。；;！!？?\n]/).map((part) => part.trim()).filter(Boolean);
  const tail = clauses[clauses.length - 1] || text;
  // 业务名词常含动作词（如“诱导发布”），整句含“发布”不等于要执行发布；末句是疑问且不是动作开头时按问答处理。
  const tailQuestion = /(?:如何(?:设置|配置|实现|使用|操作|查看)|怎么(?:设置|配置|实现|使用|操作|查看)|在?哪(?:个|些|里|儿)|有哪些|有什么|是什么|是多少|为什么|是否)/.test(tail)
    && !ACTION_START.test(text);
  const questionForm = QUESTION_START.test(text)
    || (/[?？]\s*$/.test(text) && QUESTION_PHRASE.test(text))
    || (tailQuestion && !IMPERATIVE_PREFIX.test(text));
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
    promptKey: requestKey(prompt),
    profileHint: profileHint || classification.profile,
    signals: (signals || classification.signals).slice(0, 5),
  };
  if (!/^[a-f0-9]{64}$/.test(context.requestDigest)) throw fail('INVALID_KICKOFF_CONTEXT', 'request digest is invalid');
  context.binding = contextBinding(context);
  return context;
}

function clientDirectory() {
  try { return require('./client-root.js').clientRoot(); }
  catch { return path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qoder'); }
}

function stateDir() {
  if (process.env.KICKOFF_STATE_DIR) return path.resolve(process.env.KICKOFF_STATE_DIR);
  return path.join(clientDirectory(), 'tmp', 'kickoff');
}

// 分享包安装时问一次"是否常驻开工提示卡"；选否就只关闭这一块的自动注入与
// R16/R17 门禁，提醒、能力自检等其他注入保持原样。
function preferenceFile() {
  if (process.env.KICKOFF_PREFERENCE_FILE) return path.resolve(process.env.KICKOFF_PREFERENCE_FILE);
  return path.join(clientDirectory(), 'kickoff-preference.json');
}

function readPreference() {
  const file = preferenceFile();
  const data = readJson(file);
  const split = data && data.schema === 1 && (typeof data.inject === 'boolean' || typeof data.enforce === 'boolean');
  if (!data || data.schema !== 1 || (typeof data.resident !== 'boolean' && !split)) {
    return { schema: 1, resident: true, inject: true, enforce: true, file, configured: false };
  }
  const resident = typeof data.resident === 'boolean' ? data.resident : data.inject !== false && data.enforce !== false;
  const inject = typeof data.inject === 'boolean' ? data.inject : resident;
  // 不注入就无从确认，单独的 enforce 没有可执行路径；它只在 inject 开启时生效。
  const enforce = inject && (typeof data.enforce === 'boolean' ? data.enforce : resident);
  return { schema: 1, resident, inject, enforce, file, configured: true };
}

function kickoffResidentEnabled() {
  return readPreference().inject !== false;
}

function kickoffInjectEnabled() {
  return readPreference().inject !== false;
}

function kickoffEnforceEnabled() {
  return readPreference().enforce !== false;
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

function ledgerFiles() {
  const dir = stateDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^(?:pending|confirmed)-[A-Za-z0-9._-]+\.json$/.test(name)); } catch {}
  return names.map((name) => {
    const file = path.join(dir, name);
    let at = null;
    try { at = JSON.parse(fs.readFileSync(file, 'utf8')).at || null; } catch {}
    if (!at) { try { at = fs.statSync(file).mtime.toISOString(); } catch {} }
    return { name, file, at, kind: name.startsWith('pending-') ? 'pending' : 'confirmed' };
  });
}

function ledgerStatus(sessionId) {
  const pref = readPreference();
  const status = {
    schema: 1,
    stateDir: stateDir(),
    preference: { resident: pref.resident, inject: pref.inject, enforce: pref.enforce, configured: pref.configured, file: pref.file },
    files: ledgerFiles(),
  };
  if (sessionId) {
    const pending = readPending(sessionId);
    const confirmed = readConfirmed(sessionId);
    status.session = sessionId;
    status.pending = pending ? { at: pending.at, decisionId: pending.context.decisionId, cardDigest: pending.cardDigest || null, steps: pending.stepsCount || null } : null;
    status.confirmed = confirmed ? { at: confirmed.at, choice: confirmed.choice, decisionId: confirmed.context.decisionId, selections: confirmed.selections || null } : null;
  }
  return status;
}

function gcLedger({ apply = false, days, now = Date.now() } = {}) {
  const pendingMs = days ? days * 86400000 : PENDING_MS;
  const confirmedMs = days ? days * 86400000 : CONFIRMED_MS;
  const expired = ledgerFiles().filter((item) => {
    const ts = Date.parse(item.at);
    if (!Number.isFinite(ts)) return false;
    return now - ts > (item.kind === 'pending' ? pendingMs : confirmedMs);
  });
  if (apply) for (const item of expired) { try { fs.unlinkSync(item.file); } catch {} }
  return { schema: 1, apply, days: days || null, expired: expired.map((item) => ({ kind: item.kind, file: item.file, at: item.at })), deleted: apply ? expired.length : 0 };
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
  // C1：并行计划审批折进计划问，不再单独弹窗。写并行的 opt-in 仍是一个独立选项，
  // 且推荐默认恒为串行——没有任何路径能让并行写入被默认启用。
  if (p.optInKind !== undefined) {
    if (!['read-only', 'worktree-write'].includes(p.optInKind)) throw fail('INVALID_KICKOFF_CARD', 'parallel optInKind is invalid');
    parallel.optInKind = p.optInKind;
  }
  if (p.planDigest !== undefined) {
    if (typeof p.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(p.planDigest)) throw fail('INVALID_KICKOFF_CARD', 'parallel planDigest is invalid');
    parallel.planDigest = p.planDigest;
  }
  if (p.planRef !== undefined) parallel.planRef = textValue(p.planRef, 'INVALID_KICKOFF_CARD');
  let interpretations;
  if (card.interpretations !== undefined) {
    if (!Array.isArray(card.interpretations) || card.interpretations.length < 2 || card.interpretations.length > 4) {
      throw fail('INVALID_KICKOFF_CARD', 'interpretations must contain 2 to 4 items');
    }
    interpretations = card.interpretations.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('INVALID_KICKOFF_CARD', 'interpretation is invalid');
      return {
        label: textValue(item.label, 'INVALID_KICKOFF_CARD', 60),
        description: textValue(item.description, 'INVALID_KICKOFF_CARD', 240),
      };
    });
  }
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
  let verification;
  if (card.verification !== undefined) {
    const v = card.verification;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !VERIFICATION_IDS.includes(v.tier)) {
      throw fail('INVALID_KICKOFF_CARD', 'verification tier must be light, standard, deep or manual');
    }
    verification = { tier: v.tier, reason: textValue(v.reason, 'INVALID_KICKOFF_CARD', MAX_REASON) };
    if (v.policyDigest !== undefined) {
      if (typeof v.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.policyDigest)) throw fail('INVALID_KICKOFF_CARD', 'verification policyDigest is invalid');
      verification.policyDigest = v.policyDigest;
    }
    if (v.options !== undefined) {
      if (!Array.isArray(v.options) || v.options.length !== VERIFICATION_IDS.length) throw fail('INVALID_KICKOFF_CARD', 'verification must keep all four options');
      const ids = v.options.map(item => item && typeof item === 'object' ? item.optionId : null);
      if (!VERIFICATION_IDS.every(id => ids.includes(id))) throw fail('INVALID_KICKOFF_CARD', 'verification options must not hide a tier');
      verification.options = VERIFICATION_IDS.map(id => {
        const item = v.options.find(entry => entry.optionId === id);
        return { optionId: id, description: textValue(item.description, 'INVALID_KICKOFF_CARD', MAX_REASON) };
      });
    }
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
    interpretations,
    steps,
    parallel,
    documentation,
    goal,
    verification,
  };
}

function cardDigest(card) {
  return sha256(JSON.stringify({
    schema: card.schema,
    taskId: card.taskId,
    profile: card.profile,
    understanding: card.understanding,
    interpretations: card.interpretations || null,
    steps: card.steps,
    parallel: card.parallel,
    documentation: card.documentation || null,
    goal: card.goal || null,
    verification: card.verification || null,
  }));
}

function option(label, description, value) {
  return value ? { label, description, value } : { label, description };
}

// C1：并行折进计划问。写并行的推荐默认恒为串行，opt-in 只能由用户显式选中，
// 因此"少一次弹窗"不会变成"少一次必需确认"。
function recommendedParallel(card) {
  if (card.parallel.mode !== 'parallel') return 'serial';
  return card.parallel.optInKind === 'worktree-write' ? 'serial' : 'parallel';
}

function parallelNote(card) {
  if (card.parallel.mode !== 'parallel') return '本轮单会话顺序执行。';
  if (card.parallel.optInKind === 'worktree-write') {
    return '计划含并行写入（' + (card.parallel.planRef || 'worktree + 互斥 ownedPaths') + '），默认串行，启用须显式选中 opt-in。';
  }
  return '只读调查按计划并行，写入仍收敛为单会话顺序执行。';
}

function planQuestion(card) {
  const writeOptIn = card.parallel.mode === 'parallel' && card.parallel.optInKind === 'worktree-write';
  if (card.interpretations) {
    // 理解选项已占满 4 个位置：并行折为推荐默认，异议走「都不对，我来补充」这一次机会。
    return {
      question: '按哪种理解开工？' + parallelNote(card),
      header: '开工确认',
      multiSelect: false,
      options: [
        ...card.interpretations.map((item, index) => option(index === 0 ? item.label + '（推荐）' : item.label, item.description, 'interpretation:' + index)),
        ...(card.interpretations.length < 4 ? [option('都不对，我来补充', '先不执行；请补充或修正理解，也可在此要求改串行或启用并行写入，我修订后重新确认。', 'clarify')] : []),
      ],
    };
  }
  const options = [];
  if (card.parallel.mode !== 'parallel') {
    options.push(option('按此计划执行（推荐）', '按复述的目标/范围/验收与步骤推进；' + parallelNote(card) + '对象、范围或验收变化时重新确认。', 'proceed'));
  } else if (writeOptIn) {
    options.push(option('本轮串行执行（推荐）', '单会话顺序执行，不派发并行写入；' + parallelNote(card), 'serial'));
    options.push(option('启用并行写入（显式 opt-in）', '按互斥 ownedPaths 在 worktree 内并行；未显式选中不启用。choice 可直接回传 parallel。', 'parallel'));
  } else {
    options.push(option('按计划并行执行（推荐）', '按复述的目标/范围/验收与步骤推进；' + parallelNote(card) + 'choice 可直接回传 parallel。', 'parallel'));
    options.push(option('改为串行执行', '本轮单会话顺序执行，不派发并行。choice 可直接回传 serial。', 'serial'));
  }
  options.push(option('调整理解或步骤', '先不执行；请指出要修正的对象、范围、步骤或验收，我修订后重新确认。', 'adjust'));
  options.push(option('取消本轮', '本轮不执行写入或副作用命令，只保留讨论。', 'cancel'));
  return { question: '是否按此理解与步骤开工？', header: '开工确认', multiSelect: false, options };
}

function verificationQuestion(card) {
  const v = card.verification;
  const supplied = Object.fromEntries((v.options || []).map(item => [item.optionId, item.description]));
  const ordered = [v.tier, ...VERIFICATION_IDS.filter(id => id !== v.tier && id !== 'manual'), ...(v.tier === 'manual' ? [] : ['manual'])];
  return {
    question: '本轮用哪一档验证？',
    header: '验证档',
    multiSelect: false,
    options: ordered.map(id => option(VERIFICATION_LABELS[id] + (id === v.tier ? '（推荐）' : ''), supplied[id] || VERIFICATION_DESCRIPTIONS[id], id)),
  };
}

function buildQuestions(card) {
  const questions = [planQuestion(card)];
  if (card.profile !== 'complex') {
    if (card.verification) questions.push(verificationQuestion(card));
    return questions;
  }
  const d = card.documentation;
  questions.push({
    question: '是否创建或更新文档？',
    header: '文档',
    multiSelect: false,
    options: d.recommend
      ? [
        option('创建/更新文档（推荐）', '同批维护 ' + (d.target || '相关文档') + '，便于交接与复查。', d.mode === 'update' ? 'update' : 'create'),
        option('本轮不成文', '只改代码或配置，不新增、不更新文档。', 'none'),
      ]
      : [
        option('本轮不成文（推荐）', '现有文档已覆盖或本轮范围很小，不新增文档。', 'none'),
        option('创建/更新文档', '同批更新 ' + (d.target || '相关文档') + '，便于交接与复查。', d.mode === 'update' ? 'update' : 'create'),
      ],
  });
  const g = card.goal;
  questions.push({
    question: '是否创建目标？',
    header: '目标',
    multiSelect: false,
    options: g.recommend
      ? [
        option('创建目标（推荐）', '创建“' + (g.title || '本轮任务') + '”的带判据目标，逐格推进并落盘。', 'create'),
        option('不创建目标', '用任务清单推进，不创建 Goal。', 'none'),
      ]
      : [
        option('不创建目标（推荐）', '任务规模可控，用任务清单推进即可。', 'none'),
        option('创建目标', '创建“' + (g.title || '本轮任务') + '”的目标，适合跨多回合推进。', 'create'),
      ],
  });
  // C1：验证档与文档/目标同卡一次问全（复杂卡最多 4 问），不再单独弹窗。
  if (card.verification) questions.push(verificationQuestion(card));
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
      parallel: recommendedParallel(card),
      parallelOffered: card.parallel.mode === 'parallel',
      verification: card.verification ? card.verification.tier : 'none',
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
  // 计划问里的并行选项可以直接回传 value（serial/parallel）：等价于 proceed + 显式并行选择，
  // 少一次往返就少一次弹窗，但落账仍是 proceed 与一条明确选择。
  const parallelOverride = ['serial', 'parallel'].includes(input.choice) ? input.choice : null;
  const choice = parallelOverride ? 'proceed' : input.choice;
  if (!['proceed', 'adjust', 'cancel'].includes(choice)) throw fail('INVALID_KICKOFF_CHOICE', 'choice must be proceed, adjust or cancel');
  const modes = pending.modes || {};
  let selections = null;
  if (choice === 'proceed') {
    const given = input.selections || {};
    // 复杂卡必须按选项 value 显式回传，避免"不创建目标"被默认成 create。
    if (pending.profile === 'complex' && (!given.documentation || !given.goal)) {
      throw fail('MISSING_KICKOFF_SELECTION', 'complex cards require explicit documentation and goal selections');
    }
    if (modes.verification && modes.verification !== 'none' && !given.verification) {
      throw fail('MISSING_KICKOFF_SELECTION', 'a card that asks for a verification tier requires an explicit tier selection');
    }
    selections = {
      documentation: given.documentation || (modes.documentation === 'create' || modes.documentation === 'update' ? modes.documentation : 'none'),
      goal: given.goal || (modes.goal === 'create' ? 'create' : 'none'),
      parallel: parallelOverride || given.parallel || modes.parallel || 'serial',
    };
    if (modes.verification && modes.verification !== 'none') selections.verification = given.verification;
    if (!validSelection(selections.documentation, ['create', 'update', 'none'])
        || !validSelection(selections.goal, ['create', 'none'])
        || !validSelection(selections.parallel, ['serial', 'parallel'])
        || (selections.verification !== undefined && !validSelection(selections.verification, VERIFICATION_IDS))) {
      throw fail('INVALID_KICKOFF_SELECTION', 'selections contain unsupported values');
    }
    // 卡里没计划并行时不接受并行选择：opt-in 只能针对已展示的计划，不能凭空启用。
    if (selections.parallel === 'parallel' && modes.parallelOffered !== true) {
      throw fail('INVALID_KICKOFF_SELECTION', 'parallel was not offered by this card');
    }
  }
  const confirmed = {
    schema: 1,
    context,
    cardDigest: pending.cardDigest,
    profile: pending.profile || context.profileHint,
    choice,
    selections,
    at: new Date().toISOString(),
  };
  writeJson(confirmedFile(context.sessionId), confirmed);
  appendLog([confirmed.at, sessionSlug(context.sessionId), String(context.decisionId).slice(0, 8), confirmed.profile, choice, selections ? [selections.documentation, selections.goal, selections.parallel, selections.verification || '-'].join(',') : '-', pending.cardDigest.slice(0, 12)]);
  if (choice !== 'adjust') clearPending(context.sessionId);
  return {
    schema: 1,
    ok: true,
    action: choice === 'proceed' ? 'proceed' : choice === 'adjust' ? 'revise' : 'stop',
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
  return '\n【开工确认 · 必要项｜' + profile + '】' + signals + '。除纯问答外，先只读检查，并在收尾前完成：正文确认卡（理解/步骤/并行/影响与回滚）→ AskUserQuestion → record；未确认前不写入、不执行副作用。'
    + '\n若存在多种合理理解，card.interpretations 列 2–4 种（首个推荐）。'
    + '\n一张卡一次问全（≤4问、只弹1次）：计划（含并行）' + (complex ? '/文档/目标' : '') + '/验证档；advisor 裁决只作卡内预填推荐。'
    + '\n写并行默认串行，启用须显式选 opt-in（optInKind=worktree-write）；验证档＝card.verification{tier,reason,options?}。'
    + '\nKICKOFF_CONTEXT ' + JSON.stringify(context)
    + '\nKICKOFF_BINDING ' + context.binding
    + '\nKICKOFF_COMPOSE_COMMAND ' + JSON.stringify(compose.command)
    + '\nKICKOFF_RECORD_COMMAND ' + JSON.stringify(record.command)
    + '\n流程：--compose → AskUserQuestion → --record（choice=proceed|adjust|cancel，计划问的 serial/parallel 可直接回传；复杂卡 selections 必填文档/目标，带验证档必填 verification）→ 执行；字段见 rules/long-task.md。'
    + '\n盘符反斜杠 JSON 先落盘再 --from-file <path>（等价 stdin）。';
}

function prepareKickoff({ sessionId, prompt, cwd, requestMessageId }) {
  if (!kickoffInjectEnabled()) return { skip: true, reason: 'USER_DISABLED' };
  if (!validSession(sessionId)) return { skip: true, reason: 'NO_SESSION' };
  const classification = classifyKickoffTask(prompt);
  if (classification.explicitSkip) return { skip: true, reason: 'USER_SKIP' };
  if (classification.readOnly) return { skip: true, reason: 'READ_ONLY' };
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

// C4：解析失败必须回显位置与原始片段，否则调用方只看到 INVALID_JSON 无从下手。
// 片段只回显到 stdout，绝不写进台账（台账仍只存哈希与选择）。
function jsonParseError(text, error, source) {
  const message = String((error && error.message) || error);
  const at = /at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(message);
  const offset = at ? Number(at[1]) : null;
  let line = at && at[2] ? Number(at[2]) : null;
  let column = at && at[3] ? Number(at[3]) : null;
  if (offset !== null && (line === null || column === null)) {
    const before = text.slice(0, offset);
    line = before.split('\n').length;
    column = offset - before.lastIndexOf('\n');
  }
  const snippet = offset === null ? text.slice(0, 80) : text.slice(Math.max(0, offset - 40), offset + 40);
  const out = { ok: false, code: 'INVALID_JSON', source, message, position: { offset, line, column }, snippet };
  if (/bad escaped character|invalid unicode escape|bad unicode escape/i.test(message)) {
    out.hint = 'JSON 字符串里的反斜杠必须双写（\\\\）或改用正斜杠；shell heredoc 会折叠反斜杠，改用 --from-file <path> 传文件可避免';
  }
  return out;
}

function readInput(argv, flag) {
  const fromFileAt = argv.indexOf('--from-file');
  const positional = argv[flag + 1];
  const positionalIsValue = positional !== undefined && !positional.startsWith('--');
  if (fromFileAt >= 0) {
    const file = argv[fromFileAt + 1];
    if (!file || file.startsWith('--')) { const e = new Error('--from-file 需要文件路径'); e.code = 'USAGE'; throw e; }
    if (positionalIsValue) { const e = new Error('--from-file 与位置参数只能给一个'); e.code = 'USAGE'; throw e; }
    return { text: fs.readFileSync(file, 'utf8'), source: 'file:' + file };
  }
  if (positionalIsValue && positional !== '-') return { text: fs.readFileSync(positional, 'utf8'), source: 'file:' + positional };
  return { text: readStdin(), source: 'stdin' };
}

function main(argv) {
  if (argv.includes('--status')) {
    const at = argv.indexOf('--session');
    const sessionId = at >= 0 ? argv[at + 1] : null;
    if (sessionId !== null && !validSession(sessionId)) {
      console.log(JSON.stringify({ ok: false, code: 'INVALID_SESSION' }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(ledgerStatus(sessionId), null, 2));
    return;
  }
  if (argv.includes('--gc')) {
    const at = argv.indexOf('--days');
    const days = at >= 0 ? Number(argv[at + 1]) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
      console.log(JSON.stringify({ ok: false, code: 'INVALID_DAYS' }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(gcLedger({ apply: argv.includes('--apply'), days }), null, 2));
    return;
  }
  const compose = argv.indexOf('--compose');
  const record = argv.indexOf('--record');
  const mode = compose >= 0 ? 'compose' : record >= 0 ? 'record' : null;
  const flag = compose >= 0 ? compose : record;
  if (!mode || flag < 0) {
    console.error('USAGE: kickoff-core.cjs --compose|--record <json|-|file> [--from-file <path>] --binding <sha256> [--json] | --status [--session <id>] [--json] | --gc [--days N] [--apply]');
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
  let raw;
  try { raw = readInput(argv, flag); }
  catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code === 'USAGE' ? 'USAGE' : 'INPUT_UNREADABLE', message: error.message }));
    process.exitCode = 2;
    return;
  }
  let input;
  try { input = JSON.parse(raw.text); }
  catch (error) {
    console.log(JSON.stringify(jsonParseError(raw.text, error, raw.source)));
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
  isReadOnlyRequest, requestKey, matchesRequest,
  prepareKickoff, buildKickoffNote, buildContinuationNote, composeCard, recordConfirmation,
  readPending, readConfirmed, clearPending, writePending, stateDir, cardDigest,
  ledgerStatus, gcLedger, jsonParseError, readInput,
  buildQuestions, recommendedParallel, VERIFICATION_IDS,
  preferenceFile, readPreference, kickoffResidentEnabled, kickoffInjectEnabled, kickoffEnforceEnabled,
};
if (require.main === module) main(process.argv.slice(2));
