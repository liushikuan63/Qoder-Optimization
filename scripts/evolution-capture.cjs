#!/usr/bin/env node
'use strict';
// 自进化确定性采集（Stop hook，2026-11-12）。
//
// 解决的问题：自进化以前只靠"模型在收尾时想起来"，真实台账两周零记录、958 行违规日志无人读。
// 这个 hook 把"过程中的问题与用户习惯"在每次 Stop 时确定性地落成候选，交给晋升扫描与人工采纳。
//
// 边界（写死，改这些需要用户明确批准）：
//   · 只写 <客户端>/evolution/inbox.jsonl 与机制心跳；绝不写规则/技能/settings/memory/MCP 配置。
//   · 永不拦截：hook 模式下总是 exit 0、不输出 decision，fail-open。
//   · 只读轮 / 仅交接轮 / 明确禁记忆轮：不写候选（只留不含正文的心跳）。
//   · 暂停开关（evolution/control.json 的 enabled）关闭时不采集；开关损坏时停止采集并告警，不重置。
//   · 入库前脱敏（复用 parallel-context-redact.cjs），只存片段，不存完整对话、不存工具原始输出。
//   · 候选一律 verified:false —— 助手自己的"验证结论"也只是待核对材料。
//
// 用法：
//   Stop hook（读 stdin JSON）: node evolution-capture.cjs
//   只读体检:                   node evolution-capture.cjs --report [--json]
//   隔离演算（零写入）:          node evolution-capture.cjs --dry-run --transcript <file> [--session id] [--cwd dir]
if (process.argv[2] !== '--report' && process.argv[2] !== '--dry-run') require('./hook-crash-guard.js').install('evolution-capture');
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

const DEFAULTS = { enabled: true, tailBytes: 1024 * 1024, maxPerTurn: 8, rotateBytes: 4 * 1024 * 1024, excerptChars: 240 };
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
function readTurn(file, tailBytes) {
  const out = { exists: false, userText: '', assistantTexts: [], failures: [], parsed: 0 };
  if (!file) return out;
  let st;
  try { st = fs.statSync(file); } catch { return out; }
  out.exists = true;
  const start = Math.max(0, st.size - tailBytes);
  let lines;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n').filter(x => x.trim());
  } catch { return out; }
  if (start > 0) lines.shift(); // 首行可能被截断
  const uses = new Map();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message || entry;
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
      const raw = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '';
      const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      const toolReturn = Array.isArray(content) && content.some(x => x && x.type === 'tool_result');
      if (text && !toolReturn && !entry.isMeta && !msg.isMeta
        && !/^\[stop-gate\b|^\[continuity\b|^Base directory for this skill:|^Note: The file|^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/.test(text)) {
        out.userText = text;
        out.assistantTexts = [];
        out.failures = [];
        uses.clear();
      }
    } else if (role === 'assistant') {
      if (typeof content === 'string' && content.trim()) out.assistantTexts.push(content);
      else if (Array.isArray(content)) {
        const text = content.filter(x => x && x.type === 'text' && x.text).map(x => x.text).join('\n');
        if (text.trim()) out.assistantTexts.push(text);
        for (const item of content) if (item && item.type === 'tool_use') uses.set(item.id, { name: item.name });
      }
    }
    out.parsed++;
  }
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
  return String(text || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase();
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
      } catch {}
    }
  }
  return { keys, records };
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
  if (!candidates.length) return { written: 0, duplicates: 0 };
  if (!acquireLock()) return { written: 0, duplicates: 0, reason: 'LOCK_BUSY' };
  try {
    let size = 0;
    try { size = fs.statSync(INBOX).size; } catch {}
    if (size > cfg.rotateBytes) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      fs.renameSync(INBOX, path.join(EVOLUTION_DIR, `inbox.archive-${stamp}.jsonl`));
    }
    const { keys } = readInboxKeys(inboxFiles());
    const fresh = candidates.filter(c => !keys.has(c.dedupKey));
    if (fresh.length) fs.appendFileSync(INBOX, fresh.map(c => JSON.stringify(c)).join('\n') + '\n');
    return { written: fresh.length, duplicates: candidates.length - fresh.length };
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
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`inbox=${INBOX}`);
    console.log(`files=${result.files} records=${records} unique=${keys.size} capture=${result.capture.ok ? 'ENABLED' : result.capture.reason}`);
    for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`);
    if (crossSession.length) console.log(`跨会话主题（≥2 会话，晋升候选）: ${crossSession.length}`);
    else console.log('跨会话主题（≥2 会话，晋升候选）: 0');
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--report')) { report(args.includes('--json')); return 0; }

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
    const turn = readTurn(path.resolve(file), cfg.tailBytes);
    const scope = signal.captureScope(turn.userText);
    const candidates = candidatesFromTurn(turn, ctx).map(c => withIdentity(c, ctx));
    console.log(JSON.stringify({ dryRun: true, writes: 0, exists: turn.exists, scope, candidates }, null, 2));
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

  const turn = readTurn(input.transcript_path || input.transcriptPath, cfg.tailBytes);
  if (!turn.exists || !turn.userText) { heartbeat(`SKIP_NO_TRANSCRIPT session=${shortSession} exists=${turn.exists}`); return 0; }

  const scope = signal.captureScope(turn.userText);
  if (scope.readOnly || scope.handoffOnly || scope.noMemory) {
    const reason = scope.readOnly ? 'READ_ONLY' : scope.handoffOnly ? 'HANDOFF_ONLY' : 'NO_MEMORY';
    heartbeat(`SKIP_${reason} session=${shortSession}`);
    return 0;
  }

  const candidates = candidatesFromTurn(turn, ctx).map(c => withIdentity(c, ctx));
  if (!candidates.length) { heartbeat(`NO_SIGNAL session=${shortSession} failures=${turn.failures.length}`); return 0; }
  const result = appendCandidates(candidates, cfg);
  if (result.reason) { heartbeat(`SKIP_${result.reason} session=${shortSession} candidates=${candidates.length}`); return 0; }
  const kinds = [...new Set(candidates.map(c => c.kind))].join(',');
  heartbeat(`CAPTURE session=${shortSession} task=${ctx.task} written=${result.written} dup=${result.duplicates} kinds=${kinds}`);
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