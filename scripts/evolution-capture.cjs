#!/usr/bin/env node
'use strict';
// 自进化确定性采集（Stop hook，2026-11-12）。
//
// 解决的问题：自进化以前只靠"模型在收尾时想起来"，真实台账两周零记录、958 行违规日志无人读。
// 这个 hook 把"过程中的问题与用户习惯"在每次 Stop 时确定性地落成候选，交给晋升扫描与人工采纳。
//
// 边界（写死，改这些需要用户明确批准）：
//   · 只写 <客户端>/evolution/inbox.jsonl、机制心跳与收尾建议 pending 状态；绝不写规则/技能/settings/memory/MCP 配置。
//   · 永不拦截：hook 模式下总是 exit 0、不输出 decision，fail-open。强制弹窗由 stop-gate R19 承担（本脚本只写 pending）。
//   · 只读轮 / 仅交接轮 / 明确禁记忆轮：不写候选（只留不含正文的心跳）。
//   · 暂停开关（evolution/control.json 的 enabled）关闭时不采集；开关损坏时停止采集并告警，不重置。
//   · 入库前脱敏（复用 parallel-context-redact.cjs），只存片段，不存完整对话、不存工具原始输出。
//   · 候选一律 verified:false —— 助手自己的"验证结论"也只是待核对材料。
//
// 用法：
//   Stop hook（读 stdin JSON）: node evolution-capture.cjs
//   只读体检:                   node evolution-capture.cjs --report [--json]
//   隔离演算（零写入）:          node evolution-capture.cjs --dry-run --transcript <file> [--session id] [--cwd dir]
//   登记用户拒绝（不再重复弹）:   node evolution-capture.cjs --decline <topic> [--decline <topic> ...]
if (!['--report', '--dry-run', '--decline'].includes(process.argv[2])) require('./hook-crash-guard.js').install('evolution-capture');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clientRoot } = require('./client-root.js');
const signal = require('./evolution-signal-core.js');
const { redact, findSensitive } = require('./parallel-context-redact.cjs');

const CLIENT_ROOT = clientRoot();
const EVOLUTION_DIR = path.join(CLIENT_ROOT, 'evolution');
const INBOX = path.join(EVOLUTION_DIR, 'inbox.jsonl');
const LOCK = path.join(EVOLUTION_DIR, 'inbox.lock');
const CONTROL = path.join(EVOLUTION_DIR, 'control.json');
const CONFIG = path.join(CLIENT_ROOT, 'evolution-capture.json');
const STATE_DIR = process.env.EVOLUTION_CAPTURE_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'evolution-capture');
const HEARTBEAT = path.join(STATE_DIR, 'heartbeat.log');
// 收尾建议 pending：采集层写、门禁 R19 读。放机制状态目录，不与 inbox（证据数据）混在一起。
const DECLINED = path.join(EVOLUTION_DIR, 'suggestions-declined.json');
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 超过 24 小时没问出口的建议作废，避免陈年候选突然弹窗
const MAX_PENDING_ITEMS = 6;
const sessionKey = session => String(session || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 8);
const pendingFile = session => path.join(STATE_DIR, `pending-${sessionKey(session)}.json`);

const DEFAULTS = { enabled: true, tailBytes: 1024 * 1024, backtrackBytes: 8 * 1024 * 1024, maxPerTurn: 8, rotateBytes: 4 * 1024 * 1024, excerptChars: 240 };
const SHA = value => crypto.createHash('sha256').update(value).digest('hex');
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function config() {
  const loaded = readJson(CONFIG, {});
  const raw = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof raw[key] === typeof DEFAULTS[key]) merged[key] = raw[key];
  }
  return merged;
}

// 暂停开关：缺文件=启用；enabled 非布尔=损坏，停止采集且不重置（与 evolution.js isEnabled 同口径）。
function captureEnabled() {
  if (!fs.existsSync(CONTROL)) return { ok: true };
  let value;
  try { value = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return { ok: false, reason: 'CONTROL_INVALID' }; }
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') return { ok: false, reason: 'CONTROL_INVALID' };
  return value.enabled ? { ok: true } : { ok: false, reason: 'PAUSED' };
}

function heartbeat(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(HEARTBEAT, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// —— 转录读取：只取本轮需要的三样东西（用户正文 / 助手前缀笔记 / 失败工具）。
// 比 stop-gate 的 scanTranscript 窄：门禁要完整工具台账与成功判定，采集只要"值得核对的信号"。
// 两者共用的是判据（evolution-signal-core.js），不是这段 IO。

// 一条 transcript 行是不是"用户本轮的指令"。注入件、工具回执、压缩续接摘要都不算。
// isCompactSummary 是宿主给压缩摘要打的标记（与 continuity.cjs 同一口径）：它是**上下文摘要**，
// 不是用户指令。2026-11-12 现役实测：摘要里引用了规则原文"先只读预览命中范围"，被 READ_ONLY 命中
// → 整个压缩后会话判成只读轮、零采集（SKIP_READ_ONLY），而真实指令在 7.2MB 之外。
// 同日第二处实测：用户运行中插话被宿主写成 attachment/queued_command(commandMode=prompt)，
// 只认 role=user 会整条漏读（本会话 6450 行里只认出 1 条指令，真实插话在第 1698 行）。
// 注入件前缀与正文清洗统一由 signal-core 提供，避免两处口径漂移。
function userInstructionOf(entry) {
  if (!entry || entry.isCompactSummary === true || entry.isSidechain === true) return '';
  const queued = signal.queuedUserTextOf(entry);
  if (queued) return queued;
  const msg = entry.message || entry;
  if (msg.isCompactSummary === true) return '';
  const role = msg.role || entry.type;
  if (role !== 'user') return '';
  const content = msg.content;
  if (Array.isArray(content) && content.some(x => x && x.type === 'tool_result')) return '';
  if (entry.isMeta || msg.isMeta) return '';
  return signal.cleanUserText(signal.textOfContent(content));
}

// 尾窗里没有真实指令时（长回合、刚压缩过），有界回溯找**最后一条**真实用户指令：
// 它就是当前仍在生效的那条指令，不是"上一轮的旧话"。分块从后往前读，命中即停；
// 跨块半行用 carry 拼回，边界上不丢消息。
// 块边界一律对齐到换行字节：0x0A 不会出现在多字节 UTF-8 序列内部，所以按行切不会把汉字劈成两半。
// （旧写法按固定字节切 + 字符串 carry，缝落在汉字中间时两侧各得一个 U+FFFD，JSON 仍解析成功 → 关键词静默失配。）
const BACKTRACK_CHUNK = 512 * 1024;
function lastUserTextBefore(file, end, limit) {
  const floor = Math.max(0, end - limit);
  let carryBytes = null; // 更靠后那块开头那半行的字节，等更早的块补齐
  let stop = end;
  const fd = (() => { try { return fs.openSync(file, 'r'); } catch { return null; } })();
  if (fd === null) return '';
  try {
    while (stop > floor) {
      const from = Math.max(floor, stop - BACKTRACK_CHUNK);
      const buf = Buffer.alloc(stop - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const whole = carryBytes ? Buffer.concat([buf, carryBytes]) : buf;
      let body = whole;
      if (from > floor) {
        const nl = whole.indexOf(0x0a);
        if (nl < 0) { carryBytes = whole; stop = from; continue; } // 整块都是半行，继续往前接
        carryBytes = whole.subarray(0, nl + 1); // 这半行的头在更早的块里，留给下一轮拼
        body = whole.subarray(nl + 1);
      } else {
        carryBytes = null; // floor>0 时首行可能不完整，JSON.parse 失败即跳过（诚实有界）
      }
      // carry 覆盖 [from, from+nl+1)，所以下一块必须**止于 from** 才首尾相接：
      // 写成 from+nl+1 会重复读同一段字节（JSON 必坏），且当换行正好是块末字节时 stop 不前进 → 死循环。
      stop = from;
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const text = userInstructionOf(entry);
        if (text) return text;
      }
    }
  } catch { return ''; } finally { try { fs.closeSync(fd); } catch {} }
  return '';
}

function readTurn(file, tailBytes, backtrackBytes) {
  const out = { exists: false, userText: '', assistantTexts: [], failures: [], askedEvolution: false, parsed: 0 };
  if (!file) return out;
  let st;
  try { st = fs.statSync(file); } catch { return out; }
  out.exists = true;
  const rawStart = Math.max(0, st.size - tailBytes);
  let start = rawStart;
  let lines;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - rawStart);
    fs.readSync(fd, buf, 0, buf.length, rawStart);
    fs.closeSync(fd);
    // 尾窗起点同样对齐到行边界，避免首个汉字被切成半个（U+FFFD）后关键词静默失配。
    let body = buf;
    if (rawStart > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { lines = []; start = st.size; body = null; } // 尾窗内无完整行：交给有界回溯
      else { start = rawStart + nl + 1; body = buf.subarray(nl + 1); }
    }
    if (body) lines = body.toString('utf8').split('\n').filter(x => x.trim());
  } catch { return out; }
  const uses = new Map();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message || entry;
    // 子代理（sidechain）条目整条不算本轮：与 continuity.cjs selected() 同口径。否则子代理提示词会被
    // 当用户指令（含"只读"就整轮 SKIP_READ_ONLY），它的失败工具与笔记也会算到本轮名下。
    // 诚实边界：本会话真实 transcript 8810 行实测 sidechainUser=0（宿主把子代理提示词写在 Agent 入参里），
    // 这是防御性对齐，不是已复现的现役缺陷；判据由合成夹具的正例/负对照保证能失败。
    if (entry.isSidechain === true || msg.isSidechain === true) continue;
    const role = msg.role || entry.type;
    const content = msg.content;
    if (role === 'user') {
      if (Array.isArray(content)) {
        for (const result of content.filter(x => x && x.type === 'tool_result')) {
          const use = uses.get(result.tool_use_id);
          if (!use) continue;
          const body = typeof result.content === 'string'
            ? result.content
            : Array.isArray(result.content) ? result.content.map(x => (x && x.text) || '').join('\n') : JSON.stringify(result.content || '');
          const failed = result.is_error === true || /"success"\s*:\s*false|"isError"\s*:\s*true|"error"\s*:\s*"[^"\n]+"/.test(body || '');
          if (failed) out.failures.push({ name: use.name, excerpt: String(body || '').slice(0, 600) });
        }
      }
    } else if (role === 'assistant') {
      if (typeof content === 'string' && content.trim()) out.assistantTexts.push(content);
      else if (Array.isArray(content)) {
        const text = content.filter(x => x && x.type === 'text' && x.text).map(x => x.text).join('\n');
        if (text.trim()) out.assistantTexts.push(text);
        for (const item of content) {
          if (!item || item.type !== 'tool_use') continue;
          uses.set(item.id, { name: item.name });
          // 本轮已经就自进化建议弹过窗 → 收尾建议视为已交用户拍板（开工卡/清理卡不算）。
          if (signal.isEvolutionAsk(item.name, item.input)) out.askedEvolution = true;
        }
      }
    }
    // 指令判定统一放在分支之后：user 条目与运行中插话（attachment/queued_command，没有 role=user）
    // 走同一条口径，插话同样重置轮次归属——否则插话之后的助手笔记与失败工具会算到上一条指令名下。
    const instruction = userInstructionOf(entry);
    if (instruction) {
      out.userText = instruction;
      out.assistantTexts = [];
      out.failures = [];
      out.askedEvolution = false;
      uses.clear();
    }
    out.parsed++;
  }
  // 尾窗只有工具回执 / 注入件 / 压缩摘要时，回溯取仍在生效的那条真实指令；
  // 只补 userText，本轮的助手笔记与失败工具仍来自尾窗（不清空、不重置）。
  if (!out.userText && start > 0) out.userText = lastUserTextBefore(file, start, backtrackBytes);
  return out;
}

// 命中片段窗口：只存信号附近的一小段，避免把整轮正文搬进候选。
function window(text, match, limit) {
  const normalized = signal.normalize(text);
  if (!match) return normalized.slice(0, limit);
  const at = normalized.indexOf(match);
  if (at < 0) return normalized.slice(0, limit);
  const from = Math.max(0, at - Math.floor(limit / 3));
  return normalized.slice(from, from + limit);
}

function safeExcerpt(text, limit) {
  const cleaned = String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const value = redact(cleaned).replace(/\s+/g, ' ').trim().slice(0, limit);
  return value;
}

function failureSignature(text) {
  // 签名也要脱敏：它被写进 inbox 的 evidence.signature，只把数字换成 # 会让 token / 内网地址 /
  // URL 查询参数原样入库（2026-11-12 第二轮对抗审查实测：findSensitive 命中 CREDENTIAL+URL）。
  // 先脱敏再归一化，分组键因此也更稳（只差凭据取值的同一错误会归到一组）。
  return redact(String(text || '')).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase();
}

// —— 候选生成（纯计算，不写盘）——
function candidatesFromTurn(turn, ctx) {
  const limit = ctx.excerptChars;
  const found = [];
  const push = (sig, family, excerpt, evidence) => {
    const topic = signal.topicFor(sig);
    found.push({
      schema: 1,
      kind: sig.kind,
      family,
      topic,
      carriers: signal.suggestCarriers(sig.kind),
      source: 'stop-hook',
      excerpt: safeExcerpt(excerpt, limit),
      redacted: findSensitive(String(excerpt || '')).length > 0,
      evidence: evidence || {},
      verified: false,
      status: 'candidate',
    });
  };

  for (const sig of signal.classifyPreference(turn.userText, { extended: true }).signals) {
    push(sig, 'preference', window(turn.userText, sig.match, limit));
  }
  for (const sig of signal.classifyProblem(turn.userText).signals) {
    push(sig, 'problem', window(turn.userText, sig.match, limit));
  }

  // 工具失败：只认明确的能力缺口原文，避免把任意堆栈都当成经验。
  const groups = new Map();
  for (const failure of turn.failures) {
    const key = `${failure.name}|${failureSignature(failure.excerpt)}`;
    const group = groups.get(key) || { name: failure.name, excerpt: failure.excerpt, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const gap = signal.classifyProblem(group.excerpt).signals.find(s => s.kind === signal.KINDS.TOOL_GAP);
    if (gap) push(gap, 'problem', group.excerpt, { tool: group.name, occurrences: group.count });
    if (group.count >= 2) {
      push({ kind: signal.KINDS.REPEATED_FAILURE, match: `${group.name} 同一错误重复失败` }, 'problem', group.excerpt,
        { tool: group.name, occurrences: group.count, signature: failureSignature(group.excerpt) });
    }
  }

  // 助手自述的已否证处方 / 验证结论：技术经验候选，不是用户偏好，也不当成已验证事实。
  for (const text of turn.assistantTexts) {
    for (const line of String(text).split('\n')) {
      const note = signal.classifyAssistantNote(line);
      if (!note.matched) continue;
      push(note.signals[0], 'experience', line.trim(), { origin: 'assistant-note' });
    }
  }

  // 同一轮内同 kind+topic 只留一条（跨轮/跨会话去重在写盘前用 dedupKey 再做一次）。
  const seen = new Set();
  const unique = [];
  for (const item of found) {
    const key = `${item.kind}|${item.topic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, ctx.maxPerTurn);
}

function withIdentity(candidate, ctx) {
  const dedupKey = [ctx.session, ctx.task, candidate.kind, candidate.topic].join('|');
  return { ...candidate, id: SHA(dedupKey).slice(0, 16), dedupKey, at: new Date().toISOString(), session: ctx.session, task: ctx.task, cwd: ctx.cwd };
}

function readInboxKeys(files) {
  const keys = new Set();
  const sessions = new Map(); // topic → Set(session)，用于"跨会话才够格弹窗"的判定
  let records = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        records++;
        if (record && record.dedupKey) keys.add(record.dedupKey);
        if (record && record.topic && record.session) {
          if (!sessions.has(record.topic)) sessions.set(record.topic, new Set());
          sessions.get(record.topic).add(record.session);
        }
      } catch {}
    }
  }
  return { keys, records, sessions };
}

// —— 收尾建议 pending（采集写、门禁 R19 读；本脚本自己永不拦截）——
function readDeclined() {
  const value = readJson(DECLINED, null);
  const list = value && Array.isArray(value.declined) ? value.declined : [];
  return new Set(list.map(x => (typeof x === 'string' ? x : x && x.topic)).filter(x => typeof x === 'string' && x));
}

function readPending(session) {
  const value = readJson(pendingFile(session), null);
  if (!value || !Array.isArray(value.items) || !value.items.length) return null;
  const at = Date.parse(value.at);
  if (!Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS) return null; // 过期作废，不弹陈年候选
  return value;
}

function clearPending(session) {
  try { fs.unlinkSync(pendingFile(session)); return true; } catch { return false; }
}

// 只把"够格当轮弹"的新候选写成建议；已拒绝的主题不再提，助手自述经验只进月报。
function writePending(session, ctx, fresh, sessions) {
  const declined = readDeclined();
  const items = fresh
    .filter(c => !declined.has(c.topic))
    .filter(c => signal.popupWorthy(c, sessions.get(c.topic) ? sessions.get(c.topic).size : 1))
    .map(c => ({ kind: c.kind, topic: c.topic, carriers: c.carriers, excerpt: c.excerpt, evidence: c.evidence || {} }));
  if (!items.length) return { pending: 0 };
  const previous = readPending(session);
  const merged = new Map();
  // 新项优先：旧项先入 Map 时插入序＝旧项在前，slice(0,6) 会把本轮新候选全截掉 ——
  // 满 6 条后新建议永久饿死，而 at 每轮刷新让 TTL 也清不掉旧项（2026-11-12 第二轮对抗审查实测）。
  // 同主题以本轮的新片段/新证据为准，旧项只填余位。
  for (const item of items.concat(previous ? previous.items : [])) {
    if (!merged.has(item.topic)) merged.set(item.topic, item);
  }
  const list = [...merged.values()].slice(0, MAX_PENDING_ITEMS);
  const payload = {
    schema: 1, session: ctx.session, task: ctx.task, cwd: ctx.cwd,
    at: new Date().toISOString(),
    askKey: SHA(ctx.session + '|' + list.map(x => x.topic).sort().join('|')).slice(0, 16),
    items: list,
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pendingFile(session), JSON.stringify(payload, null, 2));
    return { pending: list.length, askKey: payload.askKey };
  } catch { return { pending: 0 }; }
}

// 用户选"跳过/不采纳"时登记：同主题不再重复弹（inbox 里的原始证据保留，可查可恢复）。
function declineTopics(topics) {
  const current = readJson(DECLINED, null);
  const list = current && Array.isArray(current.declined) ? current.declined.slice() : [];
  const known = new Set(list.map(x => (typeof x === 'string' ? x : x && x.topic)));
  const added = [];
  for (const topic of topics) {
    if (typeof topic !== 'string' || !topic.trim() || known.has(topic)) continue;
    known.add(topic);
    added.push(topic);
    list.push({ topic, at: new Date().toISOString() });
  }
  if (added.length) {
    fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
    fs.writeFileSync(DECLINED, JSON.stringify({ schema: 1, declined: list }, null, 2));
  }
  return added;
}

function acquireLock() {
  fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); return true; } catch (error) {
      if (error.code !== 'EEXIST') return false;
      try {
        // 陈旧锁（进程被掐断）不永久堵住采集：10 秒以上视为陈旧并接管。
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) { fs.unlinkSync(LOCK); continue; }
      } catch {}
      sleepSync(25);
    }
  }
  return false;
}

function inboxFiles() {
  let names = [];
  try { names = fs.readdirSync(EVOLUTION_DIR); } catch { return []; }
  return names.filter(n => n === 'inbox.jsonl' || /^inbox\.archive-\d{8}T\d{6}Z?\.jsonl$/.test(n))
    .map(n => path.join(EVOLUTION_DIR, n)).sort();
}

// 写盘：仅 inbox.jsonl（超阈值先轮转成归档，保证采集不会因体积上限静默停摆）。
function appendCandidates(candidates, cfg) {
  if (!candidates.length) return { written: 0, duplicates: 0, fresh: [], sessions: new Map() };
  if (!acquireLock()) return { written: 0, duplicates: 0, fresh: [], sessions: new Map(), reason: 'LOCK_BUSY' };
  try {
    let size = 0;
    try { size = fs.statSync(INBOX).size; } catch {}
    if (size > cfg.rotateBytes) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      fs.renameSync(INBOX, path.join(EVOLUTION_DIR, `inbox.archive-${stamp}.jsonl`));
    }
    const { keys, sessions } = readInboxKeys(inboxFiles());
    const fresh = candidates.filter(c => !keys.has(c.dedupKey));
    if (fresh.length) fs.appendFileSync(INBOX, fresh.map(c => JSON.stringify(c)).join('\n') + '\n');
    // 本轮新写入的主题也要计入会话数：同一主题第一次出现在第二个会话时，本轮就该够格弹窗。
    for (const c of fresh) {
      if (!sessions.has(c.topic)) sessions.set(c.topic, new Set());
      sessions.get(c.topic).add(c.session);
    }
    return { written: fresh.length, duplicates: candidates.length - fresh.length, fresh, sessions };
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

function taskName(cwd, session) {
  const base = cwd ? path.basename(String(cwd)) : '';
  return base || `session-${String(session || 'unknown').slice(0, 8)}`;
}

function contextFrom(input, cfg) {
  const cwd = input.cwd || input.workspace || process.cwd();
  const session = String(input.session_id || input.sessionId || 'unknown');
  return { session, task: taskName(cwd, session), cwd: String(cwd), excerptChars: cfg.excerptChars, maxPerTurn: cfg.maxPerTurn };
}

// —— 只读体检：给周检与人工用，不写任何文件 ——
function pendingSessions() {
  let names = [];
  try { names = fs.readdirSync(STATE_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^pending-.*\.json$/.test(name)) continue;
    const value = readJson(path.join(STATE_DIR, name), null);
    if (!value || !Array.isArray(value.items) || !value.items.length) continue;
    const at = Date.parse(value.at);
    out.push({ session: value.session, task: value.task, items: value.items.length, expired: !Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS });
  }
  return out;
}

function report(asJson) {
  const files = inboxFiles();
  const { keys, records } = readInboxKeys(files);
  const byKind = {};
  const bySession = new Map();
  const topics = new Map();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      byKind[record.kind] = (byKind[record.kind] || 0) + 1;
      if (!bySession.has(record.topic)) bySession.set(record.topic, new Set());
      bySession.get(record.topic).add(record.session);
      topics.set(record.topic, (topics.get(record.topic) || 0) + 1);
    }
  }
  const crossSession = [...bySession.entries()].filter(([, set]) => set.size >= 2).map(([topic, set]) => ({ topic, sessions: set.size }));
  const result = {
    schema: 1, inbox: INBOX, files: files.length, records, uniqueKeys: keys.size,
    byKind, crossSessionTopics: crossSession.sort((a, b) => b.sessions - a.sessions).slice(0, 20),
    topTopics: [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([topic, count]) => ({ topic, count })),
    capture: captureEnabled(),
    declined: readDeclined().size,
    pending: pendingSessions(),
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`inbox=${INBOX}`);
    console.log(`files=${result.files} records=${records} unique=${keys.size} capture=${result.capture.ok ? 'ENABLED' : result.capture.reason}`);
    console.log(`待弹窗建议=${result.pending.length} 个会话；已拒绝主题=${result.declined}`);
    for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`);
    if (crossSession.length) console.log(`跨会话主题（≥2 会话，晋升候选）: ${crossSession.length}`);
    else console.log('跨会话主题（≥2 会话，晋升候选）: 0');
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--report')) { report(args.includes('--json')); return 0; }

  if (args.includes('--decline')) {
    const topics = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--decline' && args[i + 1]) topics.push(args[i + 1]);
    if (!topics.length) { console.error('DECLINE_NEEDS_TOPIC'); return 2; }
    let added;
    try { added = declineTopics(topics); } catch (error) { console.error('DECLINE_FAILED ' + String((error && error.message) || error)); return 2; }
    // 已拒绝的主题从 pending 撤下；撤空就删文件，门禁不再为已拒绝的建议拦人。
    let removed = 0;
    try {
      for (const name of fs.readdirSync(STATE_DIR)) {
        if (!/^pending-.*\.json$/.test(name)) continue;
        const file = path.join(STATE_DIR, name);
        const value = readJson(file, null);
        if (!value || !Array.isArray(value.items)) continue;
        const kept = value.items.filter(x => !topics.includes(x.topic));
        if (kept.length === value.items.length) continue;
        removed += value.items.length - kept.length;
        if (kept.length) fs.writeFileSync(file, JSON.stringify({ ...value, items: kept }, null, 2));
        else fs.unlinkSync(file);
      }
    } catch {}
    console.log(`declined=${added.length} removed_from_pending=${removed} total=${readDeclined().size}`);
    for (const topic of added) console.log(`  - ${topic}`);
    return 0;
  }

  const cfg = config();
  if (args.includes('--dry-run')) {
    const at = args.indexOf('--transcript');
    const file = at >= 0 ? args[at + 1] : '';
    if (!file) { console.error('DRY_RUN_NEEDS_TRANSCRIPT'); return 2; }
    const sessionAt = args.indexOf('--session');
    const cwdAt = args.indexOf('--cwd');
    const input = {
      session_id: sessionAt >= 0 ? args[sessionAt + 1] : 'dry-run',
      cwd: cwdAt >= 0 ? args[cwdAt + 1] : process.cwd(),
    };
    const ctx = contextFrom(input, cfg);
    const turn = readTurn(path.resolve(file), cfg.tailBytes, cfg.backtrackBytes);
    const scope = signal.captureScope(turn.userText);
    const candidates = candidatesFromTurn(turn, ctx).map(c => withIdentity(c, ctx));
    const { sessions } = readInboxKeys(inboxFiles());
    const declined = readDeclined();
    const popup = candidates
      .filter(c => !declined.has(c.topic))
      .filter(c => signal.popupWorthy(c, sessions.get(c.topic) ? sessions.get(c.topic).size : 1))
      .map(c => c.topic);
    console.log(JSON.stringify({ dryRun: true, writes: 0, exists: turn.exists, userTextLen: String(turn.userText || '').length, parsed: turn.parsed, scope, askedEvolution: turn.askedEvolution, wouldPopup: popup, candidates }, null, 2));
    return 0;
  }

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const event = input.hook_event_name || input.event || '';
  if (event !== 'Stop') return 0; // 非 Stop 事件：零写入、零心跳

  const ctx = contextFrom(input, cfg);
  const shortSession = ctx.session.slice(0, 8);
  if (!cfg.enabled) { heartbeat(`SKIP_DISABLED session=${shortSession}`); return 0; }
  const enabled = captureEnabled();
  if (!enabled.ok) { heartbeat(`SKIP_${enabled.reason} session=${shortSession}`); return 0; }

  const turn = readTurn(input.transcript_path || input.transcriptPath, cfg.tailBytes, cfg.backtrackBytes);
  if (!turn.exists) { heartbeat(`SKIP_NO_TRANSCRIPT session=${shortSession} exists=false`); return 0; }
  // 文件在、但尾窗 + 有界回溯里没有真实指令：这是**可诊断的有界跳过**，不能谎报成"没有 transcript"。
  // 2026-11-12 实测教训：两种原因混用一个 SKIP_NO_TRANSCRIPT，排查时误以为是路径问题，绕了一大圈。
  if (!turn.userText) {
    heartbeat(`SKIP_NO_USER_TEXT session=${shortSession} parsed=${turn.parsed} tail=${cfg.tailBytes} back=${cfg.backtrackBytes}`);
    return 0;
  }

  const scope = signal.captureScope(turn.userText);
  if (scope.readOnly || scope.handoffOnly || scope.noMemory) {
    const reason = scope.readOnly ? 'READ_ONLY' : scope.handoffOnly ? 'HANDOFF_ONLY' : 'NO_MEMORY';
    heartbeat(`SKIP_${reason} session=${shortSession}`);
    return 0;
  }

  const candidates = candidatesFromTurn(turn, ctx).map(c => withIdentity(c, ctx));
  // 本轮已就自进化建议弹过窗 → 建议已交用户拍板，清掉 pending（门禁 R19 随之放行）。
  if (turn.askedEvolution && clearPending(ctx.session)) heartbeat(`ASKED session=${shortSession} pending=cleared`);
  if (!candidates.length) { heartbeat(`NO_SIGNAL session=${shortSession} failures=${turn.failures.length}`); return 0; }
  const result = appendCandidates(candidates, cfg);
  if (result.reason) { heartbeat(`SKIP_${result.reason} session=${shortSession} candidates=${candidates.length}`); return 0; }
  // 只有**本轮新增**且够格的候选才形成收尾建议；重复证据不再弹，助手自述经验只进月报。
  // 本轮已经弹过建议卡就不再追加（每轮最多问一次），避免"刚问完又拦一次"。
  const suggestion = result.written && !turn.askedEvolution ? writePending(ctx.session, ctx, result.fresh, result.sessions) : { pending: 0 };
  const kinds = [...new Set(candidates.map(c => c.kind))].join(',');
  heartbeat(`CAPTURE session=${shortSession} task=${ctx.task} written=${result.written} dup=${result.duplicates} kinds=${kinds} pending=${suggestion.pending}`);
  return 0;
}

// 被 require 时只暴露函数，绝不执行 hook 主体（否则单测一 require 就会去读 stdin）。
if (require.main === module) {
  try { process.exitCode = main(); } catch (error) {
    // fail-open：采集失败不影响会话收尾，但必须留痕给周检。
    heartbeat(`ERROR ${String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 160)}`);
    process.exitCode = 0;
  }
}

module.exports = { readTurn, candidatesFromTurn, withIdentity, captureEnabled, config, report, inboxFiles, readInboxKeys, safeExcerpt, failureSignature, INBOX, HEARTBEAT };