#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const DEFAULT_DATA_DIR = 'D:/qoder-data/context-governor';
const FALLBACK_WINDOW = 200000;
const SOFT_SUMMARY_TOKENS = 1500;
const HARD_SUMMARY_TOKENS = 2000;
const RECENT_MESSAGES = 3;
const RECENT_TOKENS = 6000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  task_id TEXT,
  model TEXT,
  window INTEGER,
  window_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  usage_epoch TEXT NOT NULL,
  usage_basis TEXT NOT NULL,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  usage_ratio REAL,
  native_post_tokens INTEGER,
  compact_count INTEGER,
  transcript_bytes INTEGER,
  transcript_path TEXT,
  measured INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  start_uuid TEXT NOT NULL,
  end_uuid TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  start_hash TEXT NOT NULL,
  end_hash TEXT NOT NULL,
  range_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('hot','warm','cold','folded','protected','stale','unrecoverable')),
  fact_state TEXT NOT NULL CHECK (fact_state IN ('current','superseded','historical')),
  resident_epoch TEXT,
  last_used_turn INTEGER,
  protected_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 3),
  phase TEXT NOT NULL CHECK (phase IN ('logical_committed','physical_observed')),
  physical_executor TEXT,
  physical_measurement_ref TEXT,
  physical_savings INTEGER NOT NULL DEFAULT 0,
  segment_ids TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_tokens INTEGER NOT NULL,
  source_range TEXT NOT NULL,
  source_state TEXT NOT NULL,
  handles TEXT NOT NULL,
  cost_estimate TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  integrity TEXT NOT NULL,
  CHECK ((phase = 'logical_committed' AND physical_savings = 0) OR
    (phase = 'physical_observed' AND physical_executor IS NOT NULL AND physical_measurement_ref IS NOT NULL))
);
CREATE VIRTUAL TABLE IF NOT EXISTS folds_fts USING fts5(
  summary,
  content='folds',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);
CREATE INDEX IF NOT EXISTS idx_folds_session ON folds(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

const SECRET_PATTERNS = [
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'password', re: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{6,}/i },
  { name: 'rfc1918', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'loopback', re: /\b127\.0\.0\.1\b/ },
];
const THINKING_KEYS = new Set(['thinking', 'reasoning', 'reasoning_content', 'chain_of_thought', 'hidden_thinking']);
const PROTECT_RE = /(授权|禁止|不得|必须|约束|验收|当前请求|approval|authorization|must\s+not|constraint|acceptance)/i;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text) {
  return sha256(Buffer.from(String(text), 'utf8'));
}

function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function integrityOf(value) {
  return sha256Text(canonicalJson(value));
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== null) return n;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function dataDirOf(opts = {}) {
  return path.resolve(opts.dataDir || process.env.CONTEXT_GOVERNOR_DATA || DEFAULT_DATA_DIR);
}

function safeSessionId(sessionId) {
  const text = String(sessionId || 'unknown-session');
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function ledgerPath(dataDir, sessionId) {
  const dir = path.join(dataDir, 'ledgers');
  return path.join(dir, safeSessionId(sessionId) + '.db');
}

function listLedgers(dataDir) {
  const dir = path.join(dataDir, 'ledgers');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.db')).map((name) => path.join(dir, name));
}

function openLedger(dataDir, sessionId, create = true) {
  const file = ledgerPath(dataDir, sessionId);
  if (!create && !fs.existsSync(file)) return null;
  if (create) ensureDir(path.dirname(file));
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

function hasFts(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folds_fts'").get();
  return Boolean(row);
}

function parseContentBlocks(message) {
  const content = message && message.content;
  if (typeof content === 'string') return { text: content, toolUseIds: [], toolResultIds: [] };
  if (!Array.isArray(content)) return { text: '', toolUseIds: [], toolResultIds: [] };
  const parts = [];
  const toolUseIds = [];
  const toolResultIds = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      if (typeof block === 'string') parts.push(block);
      continue;
    }
    if (block.type === 'tool_use' && block.id) toolUseIds.push(String(block.id));
    if (block.type === 'tool_result' && block.tool_use_id) toolResultIds.push(String(block.tool_use_id));
    if (typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.content === 'string') parts.push(block.content);
    else if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && typeof inner.text === 'string') parts.push(inner.text);
      }
    }
  }
  return { text: parts.filter(Boolean).join('\n'), toolUseIds, toolResultIds };
}

function extractUsage(obj, msg) {
  const usage = (obj && obj.usage) || (msg && msg.usage);
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = firstNumber(usage.input_tokens, usage.prompt_tokens);
  if (inputTokens === null) return null;
  return {
    inputTokens,
    cacheReadTokens: firstNumber(usage.cache_read_input_tokens, usage.cached_tokens, usage.cache_read_tokens) || 0,
    cacheWriteTokens: firstNumber(usage.cache_creation_input_tokens, usage.cache_write_tokens) || 0,
    outputTokens: firstNumber(usage.output_tokens, usage.completion_tokens) || 0,
    ratio: firstNumber(usage.context_usage_ratio, obj && obj.context_usage_ratio, msg && msg.context_usage_ratio),
    window: firstNumber(usage.context_window, usage.window, obj && obj.context_window, msg && msg.context_window),
    model: (obj && obj.model) || (msg && msg.model) || null,
  };
}

function readTranscript(filePath) {
  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);
  const lines = [];
  const usages = [];
  const compacts = [];
  let start = 0;
  let index = 0;
  let invalidLines = 0;
  while (start <= buf.length) {
    if (start === buf.length && index > 0) break;
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    const raw = buf.subarray(start, end);
    const text = raw.toString('utf8').replace(/\r$/, '');
    let obj = null;
    try {
      obj = text.trim() ? JSON.parse(text) : null;
    } catch (err) {
      invalidLines += 1;
    }
    const line = {
      index,
      start,
      end,
      raw,
      text,
      obj,
      isMessage: false,
      role: null,
      uuid: null,
      messageText: '',
      tokens: estimateTokens(text),
      toolUseIds: [],
      toolResultIds: [],
    };
    if (obj && typeof obj === 'object') {
      const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
      const role = obj.type === 'user' || obj.type === 'assistant' ? obj.type : (msg && msg.role) || null;
      const parsed = parseContentBlocks(msg);
      line.isMessage = Boolean(role);
      line.role = role;
      line.uuid = String(obj.uuid || (msg && msg.id) || obj.id || `line-${index}`);
      line.messageText = parsed.text;
      line.toolUseIds = parsed.toolUseIds;
      line.toolResultIds = parsed.toolResultIds;
      line.tokens = estimateTokens(parsed.text || text);
      const usage = extractUsage(obj, msg);
      if (usage) usages.push({ ...usage, lineIndex: index, uuid: line.uuid });
      const compact = (obj.compactMetadata && typeof obj.compactMetadata === 'object')
        ? obj.compactMetadata
        : (msg && msg.compactMetadata && typeof msg.compactMetadata === 'object' ? msg.compactMetadata : null);
      if (compact) compacts.push({ ...compact, lineIndex: index, uuid: line.uuid });
    }
    lines.push(line);
    if (nl === -1) break;
    start = nl + 1;
    index += 1;
  }
  let sessionId = null;
  let cwd = null;
  let model = null;
  for (const line of lines) {
    const obj = line.obj;
    if (!obj) continue;
    const msg = obj.message && typeof obj.message === 'object' ? obj.message : {};
    sessionId = sessionId || obj.sessionId || obj.session_id || msg.session_id || null;
    cwd = cwd || obj.cwd || msg.cwd || null;
    model = model || obj.model || msg.model || null;
  }
  const lastUsage = usages.length ? usages[usages.length - 1] : null;
  if (!model && lastUsage) model = lastUsage.model;
  return {
    filePath: abs,
    bytes: buf.length,
    lines,
    usages,
    compacts,
    invalidLines,
    sessionId: sessionId || 'unknown-session',
    cwd: cwd || process.cwd(),
    model: model || null,
  };
}

function lineByUuid(parsed, uuid) {
  return parsed.lines.find((line) => line.uuid === uuid) || null;
}

function lineTokenTotal(parsed, startIndex, endIndex) {
  let total = 0;
  for (let i = startIndex; i <= endIndex; i += 1) total += parsed.lines[i].tokens;
  return total;
}

function buildToolPairs(parsed) {
  const useById = new Map();
  const resultById = new Map();
  for (const line of parsed.lines) {
    for (const id of line.toolUseIds) useById.set(id, line.index);
    for (const id of line.toolResultIds) resultById.set(id, line.index);
  }
  return { useById, resultById };
}

function findOrphanToolPairs(parsed, startIndex, endIndex) {
  const { useById, resultById } = buildToolPairs(parsed);
  const orphans = [];
  for (const [id, idx] of useById) {
    if (idx >= startIndex && idx <= endIndex) {
      const resultIdx = resultById.get(id);
      if (resultIdx === undefined || resultIdx < startIndex || resultIdx > endIndex) {
        orphans.push({ type: 'tool_use_without_result', id, line: idx, resultLine: resultIdx === undefined ? null : resultIdx });
      }
    }
  }
  for (const [id, idx] of resultById) {
    if (idx >= startIndex && idx <= endIndex) {
      const useIdx = useById.get(id);
      if (useIdx === undefined || useIdx < startIndex || useIdx > endIndex) {
        orphans.push({ type: 'tool_result_without_use', id, line: idx, useLine: useIdx === undefined ? null : useIdx });
      }
    }
  }
  return orphans;
}

function buildProtection(parsed, pins = []) {
  const protectedIndexes = new Set();
  const reasons = new Map();
  const messages = parsed.lines.filter((line) => line.isMessage);
  for (const line of messages.slice(-RECENT_MESSAGES)) {
    protectedIndexes.add(line.index);
    reasons.set(line.index, 'recent-message');
  }
  let recentTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const line = messages[i];
    protectedIndexes.add(line.index);
    if (!reasons.has(line.index)) reasons.set(line.index, 'recent-tokens');
    recentTokens += line.tokens;
    if (recentTokens >= RECENT_TOKENS) break;
  }
  for (const line of messages) {
    if (line.role === 'system') {
      protectedIndexes.add(line.index);
      reasons.set(line.index, 'system');
    } else if (PROTECT_RE.test(line.messageText || '')) {
      protectedIndexes.add(line.index);
      reasons.set(line.index, 'authorization-or-acceptance');
    }
    for (const pin of pins) {
      if (pin.text && line.messageText && line.messageText.includes(pin.text)) {
        protectedIndexes.add(line.index);
        reasons.set(line.index, 'pin');
      }
    }
  }
  return { protectedIndexes, reasons, recentTokens };
}

function inferWindow(latest, windowHint) {
  const hinted = firstNumber(windowHint, latest && latest.window);
  if (hinted && hinted > 0) return { tokens: hinted, source: 'metadata' };
  if (latest && latest.inputTokens > 0 && latest.ratio > 0) {
    const inferred = Math.round(latest.inputTokens / latest.ratio);
    if (inferred >= 1000 && inferred <= 5000000) return { tokens: inferred, source: 'inferred' };
  }
  return { tokens: FALLBACK_WINDOW, source: 'fallback' };
}

function buildSnapshot(parsed, pins = [], options = {}) {
  const latest = parsed.usages.length ? parsed.usages[parsed.usages.length - 1] : null;
  const first = parsed.usages.length ? parsed.usages[0] : null;
  const window = inferWindow(latest, options.window);
  const P = latest ? latest.inputTokens : null;
  const U = latest && latest.ratio !== null ? latest.ratio : (P ? P / window.tokens : null);
  const protection = buildProtection(parsed, pins);
  const threshold = Math.max(8000, Math.ceil(window.tokens * 0.02));
  const candidates = [];
  const messageLines = parsed.lines.filter((line) => line.isMessage);
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const startIndex = group[0].index;
    const endIndex = group[group.length - 1].index;
    const tokens = lineTokenTotal(parsed, startIndex, endIndex);
    const firstLine = parsed.lines[startIndex];
    const lastLine = parsed.lines[endIndex];
    const rangeHash = sha256(parsed.lines.slice(startIndex, endIndex + 1).map((line) => line.raw).reduce((acc, raw) => Buffer.concat([acc, raw, Buffer.from('\n')]), Buffer.alloc(0)).subarray(0, -1));
    candidates.push({
      id: 'cand-' + sha256Text(`${parsed.sessionId}:${startIndex}:${endIndex}:${rangeHash}`).slice(0, 12),
      startUuid: firstLine.uuid,
      endUuid: lastLine.uuid,
      startOffset: firstLine.start,
      endOffset: lastLine.end,
      rangeHash,
      tokens,
      eligible: tokens >= threshold,
      reason: tokens >= threshold ? 'cold-range-above-threshold' : 'below-threshold',
    });
    group = [];
  };
  for (const line of messageLines) {
    if (protection.protectedIndexes.has(line.index)) {
      flush();
      continue;
    }
    if (group.length && line.index !== group[group.length - 1].index + 1) flush();
    group.push(line);
  }
  flush();
  const eligibleCandidates = candidates.filter((candidate) => candidate.eligible);
  const CUncapped = eligibleCandidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
  let protectedTokens = 0;
  for (const index of protection.protectedIndexes) protectedTokens += parsed.lines[index].tokens;
  const C = P !== null ? Math.min(CUncapped, Math.max(0, P - protectedTokens)) : CUncapped;
  const compact = parsed.compacts.length ? parsed.compacts[parsed.compacts.length - 1] : null;
  return {
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    model: parsed.model,
    transcriptPath: parsed.filePath,
    transcriptBytes: parsed.bytes,
    usage: latest ? {
      inputTokens: P,
      cacheReadTokens: latest.cacheReadTokens,
      cacheWriteTokens: latest.cacheWriteTokens,
      outputTokens: latest.outputTokens,
      ratio: latest.ratio,
      source: 'usage',
    } : null,
    window,
    P,
    U,
    B: first ? first.inputTokens : null,
    F: { tokens: protectedTokens, source: 'estimated' },
    compact: compact ? {
      preTokens: firstNumber(compact.preTokens),
      postTokens: firstNumber(compact.postTokens),
      note: 'postTokens is a summary-domain size, not the next full input',
    } : null,
    messages: messageLines.length,
    protected: {
      count: protection.protectedIndexes.size,
      tokens: protectedTokens,
      reasons: Object.fromEntries([...protection.reasons.entries()].map(([idx, reason]) => [parsed.lines[idx].uuid, reason])),
    },
    candidates,
    C,
    CUncapped,
    Capped: CUncapped > C,
    threshold,
    cacheRatio: P ? (latest.cacheReadTokens || 0) / P : null,
  };
}

function listPins(db, sessionId) {
  return db.prepare('SELECT id, text, source, created_at FROM pins WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
    .map((row) => ({ id: row.id, text: row.text, source: row.source, asOf: row.created_at }));
}

function upsertSession(db, snapshot, taskId) {
  const at = nowIso();
  db.prepare(`INSERT INTO sessions (session_id, cwd, task_id, model, window, window_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      task_id = COALESCE(excluded.task_id, sessions.task_id),
      model = COALESCE(excluded.model, sessions.model),
      window = excluded.window,
      window_source = excluded.window_source,
      updated_at = excluded.updated_at`)
    .run(snapshot.sessionId, snapshot.cwd, taskId || null, snapshot.model, snapshot.window.tokens, snapshot.window.source, at, at);
}

function insertSnapshot(db, snapshot) {
  db.prepare(`INSERT INTO snapshots (session_id, at, usage_epoch, usage_basis, input_tokens, cache_read_tokens,
    cache_write_tokens, output_tokens, usage_ratio, native_post_tokens, compact_count, transcript_bytes,
    transcript_path, measured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      snapshot.sessionId,
      nowIso(),
      String(Date.now()),
      'input_tokens_includes_cache',
      snapshot.P,
      snapshot.usage ? snapshot.usage.cacheReadTokens : null,
      snapshot.usage ? snapshot.usage.cacheWriteTokens : null,
      snapshot.usage ? snapshot.usage.outputTokens : null,
      snapshot.U,
      snapshot.compact ? snapshot.compact.postTokens : null,
      snapshot.compact ? 1 : 0,
      snapshot.transcriptBytes,
      snapshot.transcriptPath,
      snapshot.usage ? 1 : 0,
    );
}

function scanForSecrets(value, location = '$', found = []) {
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(value)) found.push({ type: pattern.name, location });
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${location}[${index}]`, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (THINKING_KEYS.has(key)) found.push({ type: 'hidden-thinking-key', location: `${location}.${key}` });
      scanForSecrets(inner, `${location}.${key}`, found);
    }
  }
  return found;
}

function validateSummaryShape(summary) {
  const errors = [];
  if (!summary || typeof summary !== 'object') return ['summary must be an object'];
  if (summary.schema !== SCHEMA_VERSION) errors.push('schema must be 1');
  for (const key of ['sessionId', 'taskId', 'goal']) {
    if (typeof summary[key] !== 'string' || !summary[key].trim()) errors.push(`${key} is required`);
  }
  if (!summary.scope || typeof summary.scope !== 'object' || !summary.scope.mode || !summary.scope.authorityRef) errors.push('scope.mode and scope.authorityRef are required');
  if (!summary.state || typeof summary.state !== 'object') errors.push('state is required');
  if (!summary.sourceRange || typeof summary.sourceRange !== 'object') errors.push('sourceRange is required');
  for (const key of ['startUuid', 'endUuid', 'rangeHash']) {
    if (!summary.sourceRange || typeof summary.sourceRange[key] !== 'string' || !summary.sourceRange[key]) errors.push(`sourceRange.${key} is required`);
  }
  if (!Array.isArray(summary.evidence) || summary.evidence.length === 0) errors.push('evidence must be a non-empty array');
  if (!Array.isArray(summary.handles) || summary.handles.length === 0) errors.push('handles must be a non-empty array');
  if (!Array.isArray(summary.constraints)) errors.push('constraints must be an array');
  if (!Array.isArray(summary.next)) errors.push('next must be an array');
  if (!summary.purpose || typeof summary.purpose !== 'object') errors.push('purpose is required');
  if (summary.purpose && summary.purpose.executor !== 'logical') errors.push('purpose.executor must be logical; physical folds require an independent executor receipt');
  return errors;
}

function summaryRefs(summary) {
  const refs = new Set();
  for (const item of [...(summary.constraints || []), ...(summary.evidence || []), ...(summary.decisions || [])]) {
    if (item && typeof item.ref === 'string' && item.ref) refs.add(item.ref);
  }
  return [...refs];
}

function resolveRef(db, summary, ref, expectedSegmentId) {
  if (ref === 'current-request-id') return true;
  if (ref === summary.sourceRange.startUuid || ref === summary.sourceRange.endUuid) return true;
  if (expectedSegmentId && ref === expectedSegmentId) return true;
  const segment = db.prepare('SELECT id FROM segments WHERE id = ?').get(ref);
  return Boolean(segment);
}

function buildReceipt(foldId, summary, phase, integrity, extra = {}) {
  return {
    id: foldId,
    sessionId: summary.sessionId,
    phase,
    physicalSavings: 0,
    integrity,
    sourceRefs: summaryRefs(summary),
    handles: summary.handles,
    summaryTokens: estimateTokens(JSON.stringify(summary)),
    breakevenTurns: null,
    netProjected: null,
    note: 'logical_committed: original history was not replaced; no physical token savings claimed',
    ...extra,
  };
}

function validateFold(summary, parsed, db, options = {}) {
  const errors = validateSummaryShape(summary);
  if (errors.length) return { code: 1, errors };
  const secrets = scanForSecrets(summary);
  if (secrets.length) return { code: 1, errors: ['secret or internal address in summary: ' + secrets.map((item) => item.type + '@' + item.location).join(', ')] };
  if (summary.sessionId !== parsed.sessionId) return { code: 4, errors: [`session mismatch: summary=${summary.sessionId} transcript=${parsed.sessionId}`] };
  const startLine = lineByUuid(parsed, summary.sourceRange.startUuid);
  const endLine = lineByUuid(parsed, summary.sourceRange.endUuid);
  if (!startLine || !endLine) return { code: 4, errors: ['sourceRange uuid not found in transcript'] };
  if (startLine.index > endLine.index) return { code: 4, errors: ['sourceRange start is after end'] };
  if (Number(summary.sourceRange.startOffset) !== startLine.start || Number(summary.sourceRange.endOffset) !== endLine.end) {
    return { code: 4, errors: ['sourceRange offsets do not match transcript line boundaries'] };
  }
  const rangeBuf = parsed.lines.slice(startLine.index, endLine.index + 1).map((line) => line.raw).reduce((acc, raw) => Buffer.concat([acc, raw, Buffer.from('\n')]), Buffer.alloc(0)).subarray(0, -1);
  const rangeHash = sha256(rangeBuf);
  if (rangeHash !== summary.sourceRange.rangeHash) return { code: 4, errors: ['rangeHash mismatch; source changed or range is not exact'] };
  const startHash = sha256(startLine.raw);
  const endHash = sha256(endLine.raw);
  if (summary.sourceRange.startHash && summary.sourceRange.startHash !== startHash) return { code: 4, errors: ['startHash mismatch'] };
  if (summary.sourceRange.endHash && summary.sourceRange.endHash !== endHash) return { code: 4, errors: ['endHash mismatch'] };
  const pins = listPins(db, parsed.sessionId);
  const snapshot = buildSnapshot(parsed, pins, options);
  const protectedHit = [];
  for (let i = startLine.index; i <= endLine.index; i += 1) {
    if (snapshot.protected.reasons[parsed.lines[i].uuid]) protectedHit.push({ uuid: parsed.lines[i].uuid, reason: snapshot.protected.reasons[parsed.lines[i].uuid] });
  }
  if (protectedHit.length) return { code: 1, errors: ['protected range: ' + protectedHit.slice(0, 5).map((item) => item.uuid + ':' + item.reason).join(', ')] };
  const orphans = findOrphanToolPairs(parsed, startLine.index, endLine.index);
  if (orphans.length) return { code: 1, errors: ['orphan tool pairs: ' + orphans.map((item) => item.type + ':' + item.id).join(', ')] };
  const tokens = lineTokenTotal(parsed, startLine.index, endLine.index);
  const threshold = snapshot.threshold;
  if (tokens < threshold && !options.force) {
    return { code: 2, errors: [`candidate value too low: ${tokens} < ${threshold}`] };
  }
  if (options.force && !options.reason) return { code: 1, errors: ['--force requires --reason'] };
  const expectedSegmentId = 'seg-' + rangeHash.slice(0, 16);
  const expectedFoldId = 'fold-' + integrityOf(summary).slice(0, 16);
  if (db.prepare('SELECT id FROM folds WHERE id = ?').get(expectedFoldId)) {
    return { code: 1, errors: [`fold already exists: ${expectedFoldId}`] };
  }
  if (db.prepare('SELECT id FROM segments WHERE id = ?').get(expectedSegmentId)) {
    return { code: 1, errors: [`segment already exists: ${expectedSegmentId}`] };
  }
  for (const ref of summaryRefs(summary)) {
    if (!resolveRef(db, summary, ref, expectedSegmentId)) return { code: 1, errors: [`unresolved ref: ${ref}`] };
  }
  const summaryTokens = estimateTokens(JSON.stringify(summary));
  if (summaryTokens > HARD_SUMMARY_TOKENS) return { code: 1, errors: [`summary too large: ${summaryTokens} > ${HARD_SUMMARY_TOKENS} estimated tokens`] };
  return {
    code: 0,
    startLine,
    endLine,
    rangeHash,
    startHash,
    endHash,
    tokens,
    threshold,
    summaryTokens,
    rangeBuf,
    snapshot,
    forced: Boolean(options.force),
    forceReason: options.reason || null,
  };
}

function insertFoldLedger(db, summary, validation, options = {}) {
  const at = nowIso();
  const segmentId = 'seg-' + validation.rangeHash.slice(0, 16);
  const foldId = 'fold-' + integrityOf(summary).slice(0, 16);
  const existing = db.prepare('SELECT id FROM folds WHERE id = ?').get(foldId);
  if (existing) return { code: 1, errors: [`fold already exists: ${foldId}`] };
  const existingSegment = db.prepare('SELECT id FROM segments WHERE id = ?').get(segmentId);
  if (existingSegment) return { code: 1, errors: [`segment already exists: ${segmentId}`] };
  const handles = [...new Set([...(summary.handles || []), segmentId])];
  const storedSummary = { ...summary, handles, tokenEstimate: validation.summaryTokens };
  const integrity = integrityOf(storedSummary);
  const sourceRange = {
    ...summary.sourceRange,
    startHash: validation.startHash,
    endHash: validation.endHash,
    rangeHash: validation.rangeHash,
  };
  const costEstimate = { summary: 0, retrieve: 0, inject: 0, handoff: 0, workers: 0, total: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO segments (id, session_id, source_path, start_uuid, end_uuid, start_offset, end_offset,
      start_hash, end_hash, range_hash, token_estimate, kind, state, fact_state, resident_epoch, last_used_turn,
      protected_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(segmentId, summary.sessionId, validation.startLine ? path.resolve(summary.transcriptPath || options.transcriptPath) : null,
        summary.sourceRange.startUuid, summary.sourceRange.endUuid, Number(summary.sourceRange.startOffset),
        Number(summary.sourceRange.endOffset), validation.startHash, validation.endHash, validation.rangeHash,
        validation.tokens, 'transcript-range', 'folded', 'current', null, null, null, at);
    db.prepare(`INSERT INTO folds (id, session_id, generation, phase, physical_executor, physical_measurement_ref,
      physical_savings, segment_ids, summary, summary_tokens, source_range, source_state, handles, cost_estimate,
      model, created_at, integrity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(foldId, summary.sessionId, 1, 'logical_committed', null, null, 0, JSON.stringify([segmentId]),
        JSON.stringify(storedSummary), validation.summaryTokens, JSON.stringify(sourceRange), 'verified',
        JSON.stringify(handles), JSON.stringify(costEstimate), validation.snapshot.model, at, integrity);
    if (hasFts(db)) {
      const row = db.prepare('SELECT rowid FROM folds WHERE id = ?').get(foldId);
      db.prepare('INSERT INTO folds_fts(rowid, summary) VALUES (?, ?)').run(row.rowid, JSON.stringify(storedSummary));
    }
    db.prepare('INSERT INTO events (session_id, at, kind, detail, exit_code) VALUES (?, ?, ?, ?, ?)')
      .run(summary.sessionId, at, 'fold_committed', JSON.stringify({ foldId, segmentId, forced: validation.forced, reason: validation.forceReason }), 0);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { code: 1, errors: [err.message] };
  }
  return { code: 0, foldId, segmentId, handles, integrity, storedSummary, sourceRange };
}

function parseTerms(query) {
  return String(query || '').split(/\s+/).map((term) => term.trim()).filter(Boolean);
}

function queryFolds(db, query, limit) {
  const terms = parseTerms(query);
  if (!terms.length) return [];
  if (hasFts(db) && terms.every((term) => term.length >= 3)) {
    const match = terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' AND ');
    try {
      const rows = db.prepare(`SELECT f.id, f.session_id, f.summary, f.handles, f.source_range, f.created_at,
        f.source_state, f.phase, f.physical_savings, bm25(folds_fts) AS rank
        FROM folds_fts JOIN folds f ON f.rowid = folds_fts.rowid
        WHERE folds_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit);
      if (rows.length) return rows;
    } catch (err) {
      // fall through to LIKE
    }
  }
  const clauses = terms.map(() => 'summary LIKE ?').join(' AND ');
  const params = terms.map((term) => '%' + term + '%');
  return db.prepare(`SELECT id, session_id, summary, handles, source_range, created_at, source_state, phase,
    physical_savings FROM folds WHERE ${clauses} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

function snippetFor(summaryText, terms, maxChars = 1200) {
  const text = String(summaryText || '');
  let index = -1;
  for (const term of terms) {
    const found = text.toLowerCase().indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - 200);
  return text.slice(start, start + maxChars);
}

function cmdReport(args) {
  if (!args.transcript) return { code: 1, error: '--transcript is required' };
  let parsed;
  try {
    parsed = readTranscript(args.transcript);
  } catch (err) {
    return { code: 1, error: err.message };
  }
  if (!parsed.usages.length) return { code: 2, error: 'no usage data in transcript' };
  const dataDir = dataDirOf(args);
  const db = openLedger(dataDir, parsed.sessionId, true);
  const pins = listPins(db, parsed.sessionId);
  const snapshot = buildSnapshot(parsed, pins, { window: args.window });
  upsertSession(db, snapshot, args.task || null);
  insertSnapshot(db, snapshot);
  const participants = [];
  if (args.participants) {
    let manifest;
    try {
      manifest = readJson(args.participants);
    } catch (err) {
      return { code: 1, error: 'participants manifest: ' + err.message };
    }
    const paths = Array.isArray(manifest) ? manifest : manifest.participants;
    if (!Array.isArray(paths)) return { code: 1, error: 'participants manifest must be an array or {participants: []}' };
    const seen = new Set();
    for (const item of paths) {
      const file = typeof item === 'string' ? item : item.transcript || item.path;
      if (!file) continue;
      const abs = path.resolve(file);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const p = readTranscript(abs);
        const s = buildSnapshot(p, [], { window: args.window });
        participants.push({
          transcript: abs,
          sessionId: p.sessionId,
          P: s.P,
          outputTokens: s.usage ? s.usage.outputTokens : null,
          cacheReadTokens: s.usage ? s.usage.cacheReadTokens : null,
          messages: s.messages,
          measured: Boolean(s.usage),
        });
      } catch (err) {
        participants.push({ transcript: abs, error: err.message, measured: false });
      }
    }
  }
  const participantsTotal = participants.reduce((total, item) => {
    if (!item.error) {
      total.P += item.P || 0;
      total.outputTokens += item.outputTokens || 0;
      total.cacheReadTokens += item.cacheReadTokens || 0;
      total.messages += item.messages || 0;
    }
    return total;
  }, { P: 0, outputTokens: 0, cacheReadTokens: 0, messages: 0 });
  const cost = {
    inputFreshTokens: snapshot.P !== null && snapshot.usage
      ? Math.max(0, snapshot.P - (snapshot.usage.cacheReadTokens || 0) - (snapshot.usage.cacheWriteTokens || 0))
      : null,
    cacheReadTokens: snapshot.usage ? snapshot.usage.cacheReadTokens : null,
    cacheWriteTokens: snapshot.usage ? snapshot.usage.cacheWriteTokens : null,
    outputTokens: snapshot.usage ? snapshot.usage.outputTokens : null,
    prices: 'UNKNOWN_COST',
    note: 'token buckets only; no dollar estimate without a verified price source',
  };
  const report = {
    schema: SCHEMA_VERSION,
    generatedAt: nowIso(),
    transcript: parsed.filePath,
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    model: snapshot.model,
    usage: snapshot.usage,
    window: snapshot.window,
    P: snapshot.P,
    U: snapshot.U,
    B: snapshot.B,
    F: snapshot.F,
    compact: snapshot.compact,
    cacheRatio: snapshot.cacheRatio,
    messages: snapshot.messages,
    protected: snapshot.protected,
    candidates: snapshot.candidates,
    C: snapshot.C,
    CUncapped: snapshot.CUncapped,
    Capped: snapshot.Capped,
    threshold: snapshot.threshold,
    S: null,
    potentialDelta: null,
    expectedDelta: 0,
    K: { summary: 0, retrieve: 0, inject: 0, handoff: 0, workers: 0, total: 0 },
    H: null,
    netProjected: null,
    breakevenTurns: null,
    cost,
    participants,
    participantsTotal,
    flags: [
      'measured_usage',
      snapshot.window.source === 'inferred' ? 'estimated_window' : 'window_' + snapshot.window.source,
      snapshot.Capped ? 'candidate_estimate_capped_to_measured_input' : 'candidate_estimate_within_input',
      'logical_backup_only',
      'physical_savings_not_observed',
    ],
    recommendations: snapshot.C >= snapshot.threshold ? [{
      type: 'logical_backup',
      why: 'cold range is recoverable and above threshold',
      candidateIds: snapshot.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.id),
      physicalSavings: 0,
      note: 'prepare a summary and evidence refs; do not claim request-byte reduction',
    }] : [],
  };
  writeJsonAtomic(path.join(dataDir, 'reports', safeSessionId(parsed.sessionId) + '-' + Date.now() + '.json'), report);
  db.close();
  return { code: 0, report };
}

function cmdSnapshot(args) {
  if (!args.transcript) return { code: 1, error: '--transcript is required' };
  let parsed;
  try {
    parsed = readTranscript(args.transcript);
  } catch (err) {
    return { code: 1, error: err.message };
  }
  const snapshot = buildSnapshot(parsed, [], { window: args.window });
  return { code: 0, snapshot: { ...snapshot, lines: parsed.lines.map((line) => ({
    index: line.index,
    uuid: line.uuid,
    role: line.role,
    start: line.start,
    end: line.end,
    tokens: line.tokens,
    startHash: sha256(line.raw),
  })) } };
}

function cmdFold(args) {
  if (!args.summary) return { code: 1, error: '--summary is required' };
  let summary;
  try {
    summary = readJson(args.summary);
  } catch (err) {
    return { code: 1, error: err.message };
  }
  const transcriptPath = args.transcript || summary.transcriptPath;
  if (!transcriptPath) return { code: 1, error: '--transcript is required (or set transcriptPath in summary)' };
  let parsed;
  try {
    parsed = readTranscript(transcriptPath);
  } catch (err) {
    return { code: 4, error: err.message };
  }
  summary.transcriptPath = path.resolve(transcriptPath);
  const dataDir = dataDirOf(args);
  let db;
  if (args.dryRun) {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const existing = ledgerPath(dataDir, parsed.sessionId);
    if (fs.existsSync(existing)) {
      const sourceDb = new DatabaseSync(existing, { readOnly: true });
      try {
        // Validate against one existing snapshot, including recoverable refs and
        // duplicate receipts. All copies remain in the in-memory preview ledger.
        sourceDb.exec('BEGIN');
        for (const table of ['pins', 'segments', 'folds']) {
          const rows = sourceDb.prepare(`SELECT * FROM ${table}`).all();
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]);
          const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
          for (const row of rows) insert.run(...columns.map((column) => row[column]));
        }
      } finally {
        sourceDb.close();
      }
    }
  } else {
    db = openLedger(dataDir, parsed.sessionId, true);
    upsertSession(db, buildSnapshot(parsed, listPins(db, parsed.sessionId), { window: args.window }), summary.taskId || args.task || null);
  }
  const validation = validateFold(summary, parsed, db, {
    window: args.window,
    force: Boolean(args.force),
    reason: args.reason,
  });
  if (validation.code !== 0) {
    if (!args.dryRun) {
      db.prepare('INSERT INTO events (session_id, at, kind, detail, exit_code) VALUES (?, ?, ?, ?, ?)')
        .run(summary.sessionId || parsed.sessionId, nowIso(), 'fold_rejected', JSON.stringify({ code: validation.code, errors: validation.errors }), validation.code);
    }
    db.close();
    return validation;
  }
  const receiptPreview = buildReceipt(
    'dry-run',
    summary,
    'logical_committed',
    integrityOf(summary),
    { dryRun: true, wouldWrite: true, segmentPreview: 'seg-' + validation.rangeHash.slice(0, 16), candidateTokens: validation.tokens, threshold: validation.threshold, forced: validation.forced },
  );
  if (args.dryRun) {
    db.close();
    return { code: 0, receipt: receiptPreview };
  }
  const inserted = insertFoldLedger(db, summary, validation, { transcriptPath });
  if (inserted.code !== 0) {
    db.close();
    return { code: inserted.code, errors: inserted.errors };
  }
  db.close();
  return {
    code: 0,
    receipt: buildReceipt(inserted.foldId, inserted.storedSummary, 'logical_committed', inserted.integrity, {
      segmentIds: [inserted.segmentId],
      sourceRefs: summaryRefs(inserted.storedSummary),
      candidateTokens: validation.tokens,
      threshold: validation.threshold,
      forced: validation.forced,
      forceReason: validation.forceReason,
    }),
  };
}

function cmdSearch(args) {
  if (!args.query) return { code: 1, error: '--query is required' };
  const dataDir = dataDirOf(args);
  const limit = Math.min(5, Math.max(1, Number(args.limit) || 3));
  const ledgers = args.session ? [ledgerPath(dataDir, args.session)] : listLedgers(dataDir);
  const terms = parseTerms(args.query);
  const results = [];
  for (const file of ledgers) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      const rows = queryFolds(db, args.query, limit);
      for (const row of rows) {
        let sourceRange = {};
        let handles = [];
        try { sourceRange = JSON.parse(row.source_range || '{}'); } catch (err) {}
        try { handles = JSON.parse(row.handles || '[]'); } catch (err) {}
        let firstSegment = null;
        for (const handle of handles) {
          firstSegment = db.prepare('SELECT fact_state FROM segments WHERE id = ?').get(handle);
          if (firstSegment) break;
        }
        results.push({
          id: row.id,
          kind: 'fold',
          source: 'ledger',
          sessionId: row.session_id,
          asOf: row.created_at,
          sourceState: row.source_state,
          factState: firstSegment ? firstSegment.fact_state : 'current',
          factStateNote: firstSegment ? 'from first segment' : 'not recorded on fold',
          snippet: snippetFor(row.summary, terms),
          handle: handles[0] || null,
          coveredRange: { startOffset: sourceRange.startOffset, endOffset: sourceRange.endOffset, startUuid: sourceRange.startUuid, endUuid: sourceRange.endUuid },
          sourceHash: sourceRange.rangeHash || null,
          phase: row.phase,
          physicalSavings: row.physical_savings,
        });
      }
    } finally {
      db.close();
    }
  }
  results.sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)));
  const limited = results.slice(0, limit);
  if (!limited.length) return { code: 3, status: 'NOT_FOUND', error: 'no matching fold in scope', query: args.query };
  return { code: 0, status: 'OK', results: limited, total: limited.length, note: 'ledger search only; code/memory/continuity adapters are not implemented in this slice' };
}

function cmdShow(args) {
  if (Boolean(args.id) === Boolean(args.range)) return { code: 1, error: 'use exactly one of --id or --range' };
  const dataDir = dataDirOf(args);
  const ledgers = args.session ? [ledgerPath(dataDir, args.session)] : listLedgers(dataDir);
  for (const file of ledgers) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      if (args.id) {
        const row = db.prepare('SELECT * FROM folds WHERE id = ?').get(args.id);
        if (!row) continue;
        return {
          code: 0,
          result: {
            type: 'fold',
            id: row.id,
            sessionId: row.session_id,
            phase: row.phase,
            physicalSavings: row.physical_savings,
            integrity: row.integrity,
            summary: JSON.parse(row.summary),
            sourceRange: JSON.parse(row.source_range),
            handles: JSON.parse(row.handles),
          },
        };
      }
      const segment = db.prepare('SELECT * FROM segments WHERE id = ?').get(args.range);
      if (!segment) continue;
      let source;
      try {
        source = fs.readFileSync(segment.source_path);
      } catch (err) {
        return { code: 4, status: 'UNRECOVERABLE', error: 'source file missing: ' + segment.source_path };
      }
      const rangeBuf = source.subarray(segment.start_offset, segment.end_offset);
      if (sha256(rangeBuf) !== segment.range_hash) return { code: 4, status: 'STALE', error: 'rangeHash mismatch; source changed' };
      if (args.full && !args.ackCost) return { code: 1, error: '--full requires --ack-cost' };
      const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return { code: 1, error: 'cursor must be a non-negative integer byte offset' };
      if (cursor > rangeBuf.length) return { code: 1, error: 'cursor is beyond range' };
      if (cursor < rangeBuf.length && (rangeBuf[cursor] & 0xc0) === 0x80) return { code: 1, error: 'cursor must be at a UTF-8 character boundary' };
      let end = args.full ? rangeBuf.length : Math.min(rangeBuf.length, cursor + 8000);
      // nextCursor is a byte offset, but each response must contain whole UTF-8
      // characters so concatenating text pages also recovers the exact bytes.
      while (end > cursor && end < rangeBuf.length && (rangeBuf[end] & 0xc0) === 0x80) end -= 1;
      while (!args.full && end > cursor + 1 && estimateTokens(rangeBuf.subarray(cursor, end).toString('utf8')) > 2000) {
        end = cursor + Math.floor((end - cursor) * 0.8);
        while (end > cursor && (rangeBuf[end] & 0xc0) === 0x80) end -= 1;
      }
      const excerpt = rangeBuf.subarray(cursor, end);
      return {
        code: 0,
        result: {
          type: 'segment',
          id: segment.id,
          sessionId: segment.session_id,
          coveredRange: { startOffset: segment.start_offset, endOffset: segment.end_offset },
          excerptRange: { startOffset: cursor, endOffset: end },
          totalBytes: rangeBuf.length,
          rangeHash: segment.range_hash,
          excerptHash: sha256(excerpt),
          nextCursor: end < rangeBuf.length ? end : null,
          text: excerpt.toString('utf8'),
          note: 'excerptHash covers only the returned bytes; rangeHash covers the whole original range',
        },
      };
    } finally {
      db.close();
    }
  }
  return { code: 1, error: 'target not found' };
}

function renderHandoff(input, sources, dropped) {
  const lines = [];
  lines.push(`# Handoff: ${input.taskId}`);
  lines.push('');
  lines.push(`- taskId: ${input.taskId}`);
  lines.push(`- cwd: ${input.cwd}`);
  lines.push(`- ownerSession: ${input.ownerSession}`);
  lines.push('');
  lines.push('## 当前请求');
  lines.push(input.currentRequest);
  lines.push('');
  lines.push('## 批准范围');
  lines.push(input.approvalScope);
  lines.push('');
  lines.push('## 状态');
  lines.push(`- done: ${(input.state.done || []).join('; ') || '(none)'}`);
  lines.push(`- inProgress: ${(input.state.inProgress || []).join('; ') || '(none)'}`);
  lines.push(`- notStarted: ${(input.state.notStarted || []).join('; ') || '(none)'}`);
  lines.push('');
  lines.push('## 关键约束');
  for (const item of input.constraints) lines.push(`- ${item.text} (source: ${item.source || 'unknown'})`);
  lines.push('');
  lines.push('## 决策');
  for (const item of input.decisions || []) lines.push(`- ${item.text} — reason: ${item.reason || 'n/a'} — ref: ${item.ref || 'n/a'}`);
  if (!(input.decisions || []).length) lines.push('- (none recorded)');
  lines.push('');
  lines.push('## 原文来源');
  for (const item of sources) {
    const body = item.bodyOmitted ? `[body omitted; use ${item.handle}]` : item.text;
    lines.push(`- ${item.handle}: ${body}`);
  }
  lines.push('');
  lines.push('## 开放问题');
  for (const item of input.open || []) lines.push(`- ${item}`);
  if (!(input.open || []).length) lines.push('- (none)');
  lines.push('');
  lines.push('## 下一步及验收');
  for (const item of input.next) lines.push(`- ${item.action} — acceptance: ${item.acceptance}`);
  if (dropped.length) {
    lines.push('');
    lines.push('## 已裁剪');
    for (const item of dropped) lines.push(`- ${item}`);
  }
  return lines.join('\n') + '\n';
}

function validateHandoffInput(input) {
  const errors = [];
  for (const key of ['taskId', 'cwd', 'ownerSession', 'currentRequest', 'approvalScope']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) errors.push(`${key} is required`);
  }
  if (!input.state || typeof input.state !== 'object') errors.push('state is required');
  if (!Array.isArray(input.constraints) || !input.constraints.length) errors.push('constraints must be non-empty');
  if (!Array.isArray(input.next) || !input.next.length) errors.push('next must be non-empty');
  for (const [index, item] of (input.next || []).entries()) {
    if (!item || !item.action || !item.acceptance) errors.push(`next[${index}] requires action and acceptance`);
  }
  if (!Array.isArray(input.sources) || !input.sources.length) errors.push('sources must be non-empty');
  for (const [index, item] of (input.sources || []).entries()) {
    if (!item || !item.handle) errors.push(`sources[${index}] requires a handle`);
  }
  return errors;
}

function cmdHandoff(args) {
  if (!args.task) return { code: 1, error: '--task is required' };
  const dataDir = dataDirOf(args);
  const inputPath = args.input || path.join(dataDir, 'handoff', safeSessionId(args.task) + '.json');
  if (!fs.existsSync(inputPath)) return { code: 1, error: 'handoff input not found: ' + inputPath };
  let raw;
  try {
    raw = readJson(inputPath);
  } catch (err) {
    return { code: 1, error: err.message };
  }
  const input = { ...raw, taskId: raw.taskId || args.task };
  const errors = validateHandoffInput(input);
  if (errors.length) return { code: 2, error: 'handoff evidence insufficient', errors };
  const secrets = scanForSecrets(input);
  if (secrets.length) return { code: 2, error: 'secret or internal address in handoff', errors: secrets };
  const seen = new Set();
  let sources = (input.sources || []).filter((item) => {
    const key = item.handle + '|' + sha256Text(item.text || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dropped = [];
  const superseded = sources.filter((item) => item.status === 'superseded');
  if (superseded.length) {
    sources = sources.filter((item) => item.status !== 'superseded');
    dropped.push(...superseded.map((item) => `superseded source ${item.handle}`));
  }
  const ledgerFile = ledgerPath(dataDir, input.ownerSession);
  if (fs.existsSync(ledgerFile)) {
    const ledger = new DatabaseSync(ledgerFile);
    try {
      for (const item of sources) {
        if (!String(item.handle || '').startsWith('seg-')) continue;
        const segment = ledger.prepare('SELECT id, range_hash FROM segments WHERE id = ?').get(item.handle);
        if (!segment) return { code: 2, error: 'handoff source handle not found: ' + item.handle };
        if (item.sourceHash && item.sourceHash !== segment.range_hash) {
          return { code: 2, error: 'handoff source hash mismatch: ' + item.handle };
        }
      }
    } finally {
      ledger.close();
    }
  }
  let text = renderHandoff(input, sources, dropped);
  let tokens = estimateTokens(text);
  if (tokens > 4096) {
    sources = sources.map((item) => ({ ...item, bodyOmitted: true, text: '' }));
    text = renderHandoff(input, sources, dropped);
    tokens = estimateTokens(text);
  }
  if (tokens > 4096) {
    return { code: 2, error: `handoff exceeds 4096 estimated tokens (${tokens}); key items cannot be dropped`, dropped };
  }
  const out = path.resolve(args.out || path.join(dataDir, 'handoff', safeSessionId(args.task) + '.md'));
  writeTextAtomic(out, text);
  return {
    code: 0,
    handoff: {
      taskId: input.taskId,
      out,
      estimatedTokens: tokens,
      createdSession: false,
      keyItems: {
        currentRequest: Boolean(input.currentRequest),
        approvalScope: Boolean(input.approvalScope),
        constraints: input.constraints.length,
        decisions: (input.decisions || []).length,
        sources: sources.length,
        open: (input.open || []).length,
        next: input.next.length,
      },
      dropped,
    },
  };
}

function cmdPin(args) {
  if (!args.session) return { code: 1, error: '--session is required' };
  if (!args.text) return { code: 1, error: '--text is required' };
  if (!args.source) return { code: 1, error: '--source is required' };
  const secrets = scanForSecrets({ text: args.text, source: args.source });
  if (secrets.length) return { code: 1, error: 'secret or internal address in pin', errors: secrets };
  const dataDir = dataDirOf(args);
  const db = openLedger(dataDir, args.session, true);
  const id = 'pin-' + sha256Text(args.session + '|' + args.source + '|' + args.text).slice(0, 16);
  db.prepare('INSERT INTO pins (id, session_id, text, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, source = excluded.source')
    .run(id, args.session, args.text, args.source, nowIso());
  db.close();
  return { code: 0, pin: { id, sessionId: args.session, text: args.text, source: args.source } };
}

function cmdVerify(args) {
  const dataDir = dataDirOf(args);
  const ledgers = args.session ? [ledgerPath(dataDir, args.session)] : listLedgers(dataDir);
  const errors = [];
  let foldCount = 0;
  let segmentCount = 0;
  for (const file of ledgers) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      const folds = db.prepare('SELECT * FROM folds').all();
      for (const fold of folds) {
        foldCount += 1;
        if (fold.phase === 'logical_committed' && fold.physical_savings !== 0) errors.push({ fold: fold.id, error: 'logical fold claims physical savings' });
        if (fold.phase === 'physical_observed' && (!fold.physical_executor || !fold.physical_measurement_ref)) errors.push({ fold: fold.id, error: 'physical fold lacks executor or measurement ref' });
        if (!['logical_committed', 'physical_observed'].includes(fold.phase)) errors.push({ fold: fold.id, error: 'invalid phase' });
        try {
          const storedSummary = JSON.parse(fold.summary);
          if (integrityOf(storedSummary) !== fold.integrity) errors.push({ fold: fold.id, error: 'summary integrity mismatch' });
        } catch (err) {
          errors.push({ fold: fold.id, error: 'summary is not valid JSON' });
        }
        if (hasFts(db)) {
          const row = db.prepare('SELECT rowid FROM folds WHERE id = ?').get(fold.id);
          const fts = db.prepare('SELECT summary FROM folds_fts WHERE rowid = ?').get(row.rowid);
          if (!fts) errors.push({ fold: fold.id, error: 'FTS row missing' });
        }
        const segmentIds = JSON.parse(fold.segment_ids || '[]');
        for (const segmentId of segmentIds) {
          segmentCount += 1;
          const segment = db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId);
          if (!segment) {
            errors.push({ fold: fold.id, segment: segmentId, error: 'segment missing' });
            continue;
          }
          if (segment.state === 'unrecoverable' || segment.state === 'stale') errors.push({ fold: fold.id, segment: segmentId, error: 'segment state is ' + segment.state });
          if (!['current', 'superseded', 'historical'].includes(segment.fact_state)) errors.push({ fold: fold.id, segment: segmentId, error: 'invalid fact_state' });
          let source;
          try {
            source = fs.readFileSync(segment.source_path);
          } catch (err) {
            errors.push({ fold: fold.id, segment: segmentId, error: 'source missing: ' + segment.source_path });
            continue;
          }
          const rangeBuf = source.subarray(segment.start_offset, segment.end_offset);
          if (sha256(rangeBuf) !== segment.range_hash) errors.push({ fold: fold.id, segment: segmentId, error: 'rangeHash mismatch' });
        }
      }
    } finally {
      db.close();
    }
  }
  return { code: errors.length ? 4 : 0, status: errors.length ? 'FAIL' : 'OK', folds: foldCount, segments: segmentCount, errors };
}

function cmdPrune(args) {
  const dataDir = dataDirOf(args);
  const ledgers = args.session ? [ledgerPath(dataDir, args.session)] : listLedgers(dataDir);
  const preview = [];
  for (const file of ledgers) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare(`SELECT s.id, s.session_id, s.token_estimate, s.source_path FROM segments s
        WHERE s.state = 'stale' AND NOT EXISTS (SELECT 1 FROM folds f WHERE f.segment_ids LIKE '%' || s.id || '%')`).all();
      preview.push(...rows.map((row) => ({ id: row.id, sessionId: row.session_id, tokens: row.token_estimate, sourcePath: row.source_path })));
    } finally {
      db.close();
    }
  }
  if (!args.apply) return { code: 0, mode: 'preview', candidates: preview, count: preview.length, note: 'no files deleted' };
  const ids = String(args.ids || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return { code: 1, error: '--apply requires --ids with exact segment ids; no broad deletion is allowed', candidates: preview };
  const allowed = new Set(preview.map((item) => item.id));
  const rejected = ids.filter((id) => !allowed.has(id));
  if (rejected.length) return { code: 1, error: 'ids are not stale unreferenced segments: ' + rejected.join(',') };
  let deleted = 0;
  for (const file of ledgers) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      const stmt = db.prepare("DELETE FROM segments WHERE id = ? AND state = 'stale'");
      for (const id of ids) deleted += stmt.run(id).changes;
    } finally {
      db.close();
    }
  }
  return { code: 0, mode: 'apply', deleted, ids };
}

function cmdLoadManifest(args) {
  if (!args.input) return { code: 1, error: '--input is required' };
  let input;
  try {
    input = readJson(args.input);
  } catch (err) {
    return { code: 1, error: err.message };
  }
  if (!input || typeof input !== 'object') return { code: 1, error: 'manifest input must be an object' };
  if (typeof input.taskId !== 'string' || !input.taskId.trim()) return { code: 1, error: 'taskId is required' };
  if (!Array.isArray(input.activeACs)) return { code: 1, error: 'activeACs must be an array' };
  if (!Array.isArray(input.sources)) return { code: 1, error: 'sources must be an array' };
  const active = new Set(input.activeACs);
  const seen = new Set();
  const decisions = [];
  for (const source of input.sources) {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id) {
      decisions.push({ sourceId: null, decision: 'omit', reason: 'missing-id' });
      continue;
    }
    if (seen.has(source.id)) {
      decisions.push({ sourceId: source.id, decision: 'omit', reason: 'duplicate-id' });
      continue;
    }
    seen.add(source.id);
    const base = {
      sourceId: source.id,
      coveredRange: source.coveredRange || null,
      asOf: source.asOf || null,
      sourceHash: source.sourceHash || null,
    };
    const acs = Array.isArray(source.acs) ? source.acs : [];
    if (acs.length && !acs.some((ac) => active.has(ac))) {
      decisions.push({ ...base, decision: 'omit', reason: 'not-active' });
      continue;
    }
    if (!source.path) {
      decisions.push({ ...base, decision: 'pointer', reason: 'no-path' });
      continue;
    }
    if (source.pointerOnly) {
      decisions.push({ ...base, decision: 'pointer', reason: 'pointer-only' });
      continue;
    }
    if (!source.sourceHash) {
      decisions.push({ ...base, decision: 'pointer', reason: 'no-source-hash' });
      continue;
    }
    if (source.currentHash && source.currentHash !== source.sourceHash) {
      decisions.push({ ...base, decision: 'read', reason: 'source-changed' });
      continue;
    }
    if (source.resident) {
      decisions.push({ ...base, decision: 'reuse', reason: 'resident-unchanged' });
      continue;
    }
    decisions.push({ ...base, decision: 'read', reason: 'needed-and-verified' });
  }
  const counts = decisions.reduce((total, item) => {
    total[item.decision] = (total[item.decision] || 0) + 1;
    return total;
  }, { read: 0, reuse: 0, pointer: 0, omit: 0 });
  const manifest = { taskId: input.taskId, activeACs: input.activeACs, sources: input.sources.length, decisions, counts };
  if (args.record) {
    const out = path.join(dataDirOf(args), 'load-manifests', safeSessionId(input.taskId) + '-' + Date.now() + '.json');
    writeJsonAtomic(out, manifest);
    manifest.recorded = out;
  }
  return { code: 0, manifest };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function toBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function normalizeArgs(raw) {
  const args = { ...raw };
  for (const key of ['json', 'dryRun', 'force', 'full', 'ackCost', 'apply', 'all', 'record']) args[key] = toBool(raw[key]);
  if (raw['dry-run'] !== undefined) args.dryRun = toBool(raw['dry-run']);
  if (raw['ack-cost'] !== undefined) args.ackCost = toBool(raw['ack-cost']);
  if (raw['data-dir']) args.dataDir = raw['data-dir'];
  return args;
}

function printResult(result, args) {
  const json = args.json || !process.stdout.isTTY;
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.code !== 0) {
    process.stdout.write(`ERROR ${result.code}: ${result.error || ''}\n`);
    if (result.errors) for (const item of result.errors) process.stdout.write(`- ${typeof item === 'string' ? item : JSON.stringify(item)}\n`);
    return;
  }
  if (result.receipt) process.stdout.write(`fold ${result.receipt.id} ${result.receipt.phase} physicalSavings=${result.receipt.physicalSavings}\n`);
  else if (result.results) for (const item of result.results) process.stdout.write(`- ${item.id} ${item.asOf} ${item.snippet.slice(0, 160)}\n`);
  else if (result.handoff) process.stdout.write(`handoff ${result.handoff.out} (~${result.handoff.estimatedTokens} tokens)\n`);
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function main(argv = process.argv.slice(2)) {
  const args = normalizeArgs(parseArgs(argv));
  const command = args._[0] || 'help';
  if (command === 'help' || args.help) {
    process.stdout.write(`context-governor ${SCHEMA_VERSION}\n\n` +
      'Commands:\n' +
      '  report --transcript <p> [--participants <manifest>] [--json]\n' +
      '  snapshot --transcript <p> [--json]\n' +
      '  fold --summary <p> [--transcript <p>] [--dry-run] [--force --reason <text>] [--json]\n' +
      '  search --query <q> [--session <id>] [--limit 3] [--json]\n' +
      '  show --id <fold-id> | --range <segment-id> [--cursor n] [--full --ack-cost] [--json]\n' +
      '  handoff --task <id> [--input <p>] --out <p> [--json]\n' +
      '  pin --session <id> --text <t> --source <ref> [--json]\n' +
      '  verify [--session <id>] [--json]\n' +
      '  prune [--apply --ids <id,id>] [--json]\n' +
      '  load-manifest --input <p> [--record] [--json]\n');
    return 0;
  }
  const handlers = {
    report: cmdReport,
    snapshot: cmdSnapshot,
    fold: cmdFold,
    search: cmdSearch,
    show: cmdShow,
    handoff: cmdHandoff,
    pin: cmdPin,
    verify: cmdVerify,
    prune: cmdPrune,
    'load-manifest': cmdLoadManifest,
  };
  const handler = handlers[command];
  if (!handler) {
    printResult({ code: 1, error: 'unknown command: ' + command }, args);
    return 1;
  }
  let result;
  try {
    result = handler(args);
  } catch (err) {
    result = { code: 1, error: err && err.stack ? err.stack : String(err) };
  }
  printResult(result, args);
  return result.code;
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_DATA_DIR,
  estimateTokens,
  canonicalJson,
  integrityOf,
  readTranscript,
  buildSnapshot,
  buildProtection,
  validateSummaryShape,
  validateFold,
  cmdReport,
  cmdSnapshot,
  cmdFold,
  cmdSearch,
  cmdShow,
  cmdHandoff,
  cmdPin,
  cmdVerify,
  cmdPrune,
  cmdLoadManifest,
  main,
};

if (require.main === module) {
  process.exit(main());
}
