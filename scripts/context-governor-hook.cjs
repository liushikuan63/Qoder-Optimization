#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const gov = require('./context-governor.cjs');

const DEFAULT_DATA_DIR = gov.DEFAULT_DATA_DIR;
const COOLDOWN_TURNS = 8;
const SOFT_RATIO = 0.65;
const PRESSURE_RATIO = 0.75;
const EMERGENCY_RATIO = 0.88;
const SENTINEL_BYTES = 64;
const SCAN_CHUNK_BYTES = 64 * 1024;
const FALLBACK_WINDOW = 200000;

function dataDir() {
  return path.resolve(process.env.CONTEXT_GOVERNOR_DATA || DEFAULT_DATA_DIR);
}

function safeSession(sessionId) {
  return String(sessionId || 'unknown-session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function stateFile(sessionId) {
  return path.join(dataDir(), 'hook-state', safeSession(sessionId) + '.json');
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeState(sessionId, state) {
  const file = stateFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function logError(sessionId, error) {
  try {
    const dir = path.join(dataDir(), 'hook-state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errors.log'), JSON.stringify({
      at: new Date().toISOString(),
      sessionId: sessionId || null,
      error: error && error.message ? error.message : String(error),
    }) + '\n', 'utf8');
  } catch (err) {
    // fail-open: diagnostics must never break the hook
  }
}

function emit(eventName, additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  }) + '\n');
}

function normalizeEventName(event) {
  const raw = event.hook_event_name || event.hookEventName || event.event || '';
  return String(raw);
}

function sessionIdOf(event) {
  return event.session_id || event.sessionId || 'unknown-session';
}

function transcriptOf(event) {
  return event.transcript_path || event.transcriptPath || null;
}

function injectEnabled() {
  const raw = process.env.CONTEXT_GOVERNOR_INJECT;
  if (raw === '1') return true;
  if (raw === '0') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    return Boolean(cfg) && cfg.inject === true;
  } catch (err) {
    return false;
  }
}

function sentinelAt(fd, position, length) {
  if (position <= 0) return '';
  const start = Math.max(0, position - length);
  const buf = Buffer.alloc(position - start);
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.subarray(0, read).toString('hex');
}

function scanUsages(fd, start, end) {
  const usages = [];
  let tail = Buffer.alloc(0);
  let pos = start;
  while (pos < end) {
    const len = Math.min(SCAN_CHUNK_BYTES, end - pos);
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, pos);
    if (!read) break;
    pos += read;
    const chunk = tail.length ? Buffer.concat([tail, buf.subarray(0, read)]) : buf.subarray(0, read);
    let lineStart = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, lineStart)) !== -1) {
      const text = chunk.subarray(lineStart, nl).toString('utf8').replace(/\r$/, '');
      if (text.trim()) {
        let obj = null;
        try {
          obj = JSON.parse(text);
        } catch (err) {
          obj = null;
        }
        if (obj && typeof obj === 'object') {
          const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
          const usage = gov.extractUsage(obj, msg);
          if (usage) usages.push(usage);
        }
      }
      lineStart = nl + 1;
    }
    tail = chunk.subarray(lineStart);
  }
  return { usages, nextOffset: end - tail.length };
}

function snapshotFor(event, state) {
  const transcript = transcriptOf(event);
  if (!transcript) return null;
  const abs = path.resolve(transcript);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return null;
  }
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    let cache = state.snapshotCache && state.snapshotCache.path === abs ? state.snapshotCache : null;
    let offset = cache ? Number(cache.offset) || 0 : 0;
    let lastUsage = cache ? cache.lastUsage : null;
    let fullScan = false;
    if (cache && stat.size >= offset && offset > 0) {
      const sentinel = sentinelAt(fd, offset, SENTINEL_BYTES);
      if (sentinel !== (cache.sentinel || '')) {
        cache = null;
      }
    }
    if (!cache || stat.size < offset || offset === 0) {
      fullScan = true;
      offset = 0;
      lastUsage = null;
    }
    let nextOffset = offset;
    let scanBytes = 0;
    if (stat.size > offset) {
      const scanned = scanUsages(fd, offset, stat.size);
      scanBytes = stat.size - offset;
      if (scanned.usages.length) lastUsage = scanned.usages[scanned.usages.length - 1];
      nextOffset = scanned.nextOffset;
    }
    const hasTokens = Boolean(lastUsage) && Number.isFinite(lastUsage.inputTokens) && lastUsage.inputTokens > 0;
    const hasRatio = Boolean(lastUsage) && Number.isFinite(lastUsage.ratio);
    const usageBasis = !lastUsage ? 'unknown' : (hasTokens ? 'tokens' : (hasRatio ? 'ratio-only' : 'unknown'));
    const U = lastUsage
      ? (hasRatio
        ? lastUsage.ratio
        : (hasTokens
          ? lastUsage.inputTokens / (Number.isFinite(lastUsage.window) && lastUsage.window > 0 ? lastUsage.window : FALLBACK_WINDOW)
          : null))
      : null;
    const P = hasTokens ? lastUsage.inputTokens : null;
    state.snapshotCache = {
      path: abs,
      size: stat.size,
      offset: nextOffset,
      sentinel: sentinelAt(fd, nextOffset, SENTINEL_BYTES),
      lastUsage: lastUsage || null,
      usageBasis,
      updatedAt: new Date().toISOString(),
    };
    state.lastScanBytes = scanBytes;
    state.lastScanFull = fullScan;
    return { U, P, usageBasis };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        // fail-open: closing a read handle must never break the hook
      }
    }
  }
}

function pointerText() {
  return '[context-governor] 压缩已发生：仅恢复指针，不申报输入减量，也没有 fold 句柄。先核对当前请求/授权；需要原文时用 continuity 档案检索（node "D:/tools/qoder-context-continuity/continuity.cjs" search --cwd <目录> --session <会话> --query "<关键词>"），或直接读取原始 transcript；未核对前不要把摘要当事实。';
}

function injectText(ratio, level) {
  const percent = Math.round(ratio * 100);
  const levelLabel = level >= 3 ? 'emergency' : level >= 2 ? 'pressure' : 'soft';
  return `[context-governor] 上下文使用率约 ${percent}%（${levelLabel}）。先核对下一步信息缺口；复用已读证据/句柄，不自动折叠、不扩权。`;
}

function decideUserPrompt(event) {
  if (!injectEnabled()) return { status: 'disabled' };
  const sessionId = sessionIdOf(event);
  const state = readState(sessionId);
  state.turnsSinceInject = Number.isFinite(state.turnsSinceInject) ? state.turnsSinceInject + 1 : 1;
  const snapshot = snapshotFor(event, state);
  if (snapshot) state.usageBasis = snapshot.usageBasis;
  if (!snapshot || snapshot.U === null || snapshot.U < SOFT_RATIO) {
    writeState(sessionId, state);
    return { status: 'below-threshold' };
  }
  const level = snapshot.U >= EMERGENCY_RATIO ? 3 : snapshot.U >= PRESSURE_RATIO ? 2 : 1;
  const lastLevel = Number.isFinite(state.lastInjectLevel) ? state.lastInjectLevel : 0;
  if (lastLevel > 0 && level <= lastLevel && state.turnsSinceInject < COOLDOWN_TURNS) {
    writeState(sessionId, state);
    return { status: 'cooldown' };
  }
  state.lastInjectLevel = level;
  state.turnsSinceInject = 0;
  state.lastInjectAt = new Date().toISOString();
  writeState(sessionId, state);
  return { status: 'inject', text: injectText(snapshot.U, level), level, ratio: snapshot.U };
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write('context-governor-hook: reads one hook event from stdin and exits 0.\n' +
      'Events: PreCompact, PostCompact, SessionStart, UserPromptSubmit.\n' +
      'Default: zero injection. Enable with CONTEXT_GOVERNOR_INJECT=1 (or 0 to force off) or {"inject":true} in <data-dir>/config.json; env wins.\n');
    return 0;
  }
  let event = {};
  let sessionId = 'unknown-session';
  try {
    const raw = fs.readFileSync(0, 'utf8');
    event = raw.trim() ? JSON.parse(raw) : {};
    sessionId = sessionIdOf(event);
    const name = normalizeEventName(event);
    if (name === 'PreCompact') {
      const state = readState(sessionId);
      const snapshot = snapshotFor(event, state);
      state.lastPreCompactAt = new Date().toISOString();
      state.lastKnownInputTokens = snapshot ? snapshot.P : null;
      state.lastKnownRatio = snapshot ? snapshot.U : null;
      if (snapshot) state.usageBasis = snapshot.usageBasis;
      writeState(sessionId, state);
      return 0;
    }
    if (name === 'PostCompact') {
      const state = readState(sessionId);
      state.pendingRestore = true;
      state.pendingAt = new Date().toISOString();
      writeState(sessionId, state);
      return 0;
    }
    if (name === 'SessionStart') {
      const state = readState(sessionId);
      if (state.pendingRestore) {
        state.pendingRestore = false;
        state.pendingAt = null;
        state.lastRestoreAt = new Date().toISOString();
        writeState(sessionId, state);
        emit('SessionStart', pointerText());
      }
      return 0;
    }
    if (name === 'UserPromptSubmit') {
      const decision = decideUserPrompt(event);
      if (decision.status === 'inject') emit('UserPromptSubmit', decision.text);
      return 0;
    }
    return 0;
  } catch (err) {
    logError(sessionId, err);
    return 0;
  }
}

module.exports = {
  COOLDOWN_TURNS,
  SOFT_RATIO,
  PRESSURE_RATIO,
  EMERGENCY_RATIO,
  pointerText,
  injectText,
  decideUserPrompt,
  main,
};

if (require.main === module) {
  process.exit(main());
}
