#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePlan, evaluatePlan, digestPlan, stable } = require('./parallel-plan.cjs');
const { clientRoot, counterpart } = require('./client-root.js');

const SCHEMA = 1;
const UNIT_STATUSES = new Set(['planned', 'dispatched', 'running', 'done', 'failed', 'blocked', 'verified', 'merged']);
const WORKER_STATUSES = new Set(['dispatched', 'running', 'done', 'failed', 'blocked']);
const DELTA_KEYS = new Set(['unitId', 'contextVersion', 'planDigest', 'findings', 'evidence', 'recallRequests', 'status']);
const MAX_RECALL_CHARS = 2000;

const SECRET_PATTERNS = [
  { label: 'PRIVATE_KEY', regex: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { label: 'TOKEN', regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_TOKEN]' },
  { label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  { label: 'CREDENTIAL', regex: /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|密钥|口令|密码)["']?\s*[:=]\s*)(["']?)(?!\[REDACTED(?:_[A-Z]+)?\])([^\s"',;)}\]]{6,})\2/gi, replacement: '$1$2[REDACTED]$2' },
  { label: 'BEARER', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED]' },
  { label: 'INTERNAL_IP', regex: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g, replacement: '[REDACTED_IP]' },
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    fail('INVALID_JSON', path.basename(file) + ': ' + error.message);
  }
}

function atomicWrite(file, text) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function snapshot(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_CONTEXT_FILE', path.basename(file) + ' must be an ordinary file');
  return { ino: stat.ino, dev: stat.dev, bytes: fs.readFileSync(file) };
}

function sameSnapshot(a, b) {
  return !a || !b ? a === b : a.ino === b.ino && a.dev === b.dev && a.bytes.equals(b.bytes);
}

function withRunLock(contextFile, action, create = false) {
  const dir = path.dirname(path.resolve(contextFile));
  if (create) fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.context-write.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('CONTEXT_BUSY', 'another context writer owns the run lock; preserve inputs and retry after it finishes'); throw error; }
  const identity = fs.fstatSync(fd);
  const body = Buffer.from(JSON.stringify({ schema: 1, pid: process.pid, token: crypto.randomUUID(), createdAt: new Date().toISOString() }) + '\n');
  let written = false;
  const ownsLock = () => {
    try {
      const current = snapshot(lock);
      return current && current.ino === identity.ino && current.dev === identity.dev && (!written || current.bytes.equals(body));
    } catch { return false; }
  };
  const assertOwner = () => { if (!ownsLock()) fail('CONTEXT_LOCK_CHANGED', 'run lock ownership changed; refusing to publish'); };
  try {
    fs.writeFileSync(fd, body); fs.fsyncSync(fd); written = true;
    return action(assertOwner);
  } finally {
    fs.closeSync(fd);
    if (ownsLock()) fs.unlinkSync(lock);
  }
}

function commitContext(context, file, assertOwner, expected, plan) {
  const target = path.resolve(file), dir = path.dirname(target);
  const changes = [
    ...(plan ? [{ file: path.join(dir, 'plan.json'), text: JSON.stringify(plan, null, 2) + '\n' }] : []),
    { file: path.join(dir, 'context.md'), text: renderContextMd(context) },
    // Canonical JSON is the final publication point; inputs are never consumed.
    { file: target, text: JSON.stringify(context, null, 2) + '\n' },
  ];
  const stage = fs.mkdtempSync(path.join(dir, '.context-txn-'));
  const published = [];
  let preserve = false;
  try {
    changes.forEach((change, index) => {
      change.before = expected.has(change.file) ? expected.get(change.file) : snapshot(change.file);
      change.staged = path.join(stage, 'next-' + index);
      atomicWrite(change.staged, change.text);
      change.owned = snapshot(change.staged);
      if (change.before) atomicWrite(path.join(stage, 'before-' + index), change.before.bytes);
    });
    atomicWrite(path.join(stage, 'RECOVERY.json'), JSON.stringify({ schema: 1, files: changes.map((change, index) => ({ file: path.basename(change.file), backup: change.before ? 'before-' + index : null, next: 'next-' + index })) }, null, 2));
    for (const [file, before] of expected) if (!sameSnapshot(snapshot(file), before)) fail('CONTEXT_CHANGED', 'context or plan changed during merge; no results were committed');
    for (const change of changes) if (!sameSnapshot(snapshot(change.file), change.before)) fail('CONTEXT_CHANGED', 'run files changed during preparation; no results were committed');
    for (const change of changes) {
      assertOwner();
      fs.renameSync(change.staged, change.file);
      published.push(change);
      if (!sameSnapshot(snapshot(change.file), change.owned)) fail('CONTEXT_CHANGED', 'published file ownership changed; retaining recovery data');
    }
  } catch (error) {
    for (const change of published.reverse()) {
      try {
        assertOwner();
        if (!sameSnapshot(snapshot(change.file), change.owned)) throw new Error('published file was changed by another writer');
        if (change.before) atomicWrite(change.file, change.before.bytes);
        else fs.unlinkSync(change.file);
      } catch { preserve = true; }
    }
    if (preserve) fail('CONTEXT_RECOVERY_REQUIRED', 'context publication could not be fully restored; inputs and recovery files remain at ' + stage);
    throw error;
  } finally {
    if (!preserve) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* A leftover owned stage does not invalidate a committed canonical file. */ } }
  }
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
      return '[REDACTED_URL]';
    }
    if (url.search || url.hash) return url.origin + url.pathname + '[REDACTED_QUERY]';
    return raw;
  } catch {
    return '[REDACTED_URL]';
  }
}

function redact(text) {
  let value = String(text);
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern.regex, pattern.replacement);
  return value.replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, redactUrl);
}

function findSensitive(text) {
  const value = String(text);
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(value)) hits.push(pattern.label);
    pattern.regex.lastIndex = 0;
  }
  const urls = value.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];
  if (urls.some(url => redactUrl(url) !== url)) hits.push('URL');
  return [...new Set(hits)];
}

function isText(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function stringArray(value, name, maxItems = 20) {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => !isText(item, 500))) {
    fail('INVALID_' + name, name + ' must be an array of non-empty strings');
  }
  return value.map(item => item.trim());
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '').toLowerCase();
}

function intersects(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

function unitPaths(unit) {
  return [...(unit.readPaths || []), ...(unit.ownedPaths || [])];
}

function recallScore(unit, ref) {
  let score = 0;
  for (const refPath of Array.isArray(ref.paths) ? ref.paths : []) {
    if (unitPaths(unit).some(unitPath => intersects(unitPath, refPath))) score = Math.max(score, 3);
  }
  const excerpt = String(ref.excerpt || '').toLowerCase();
  if (unitPaths(unit).some(unitPath => excerpt.includes(normalizePath(unitPath)))) score = Math.max(score, 2);
  if (ref.confidence === 'high') score = Math.max(score, 1);
  return score;
}

function selectRecall(unit, refs, maxChars) {
  if (!Array.isArray(refs)) fail('INVALID_RECALL', 'recall refs must be an array');
  const candidates = [];
  refs.forEach((ref, index) => {
    if (!ref || typeof ref !== 'object') fail('INVALID_RECALL', 'recall ref ' + index + ' must be an object');
    if (!isText(ref.source, 100) || !isText(ref.ref, 500) || !isText(ref.excerpt, 4000)) {
      fail('INVALID_RECALL', 'recall ref ' + index + ' needs source, ref and excerpt');
    }
    const clean = redact(ref.excerpt);
    if (!clean.trim()) return;
    candidates.push({
      index,
      score: recallScore(unit, ref),
      source: ref.source.trim(),
      ref: ref.ref.trim(),
      asOf: isText(ref.asOf, 100) ? ref.asOf.trim() : 'unknown',
      confidence: ['high', 'medium', 'low'].includes(ref.confidence) ? ref.confidence : 'low',
      excerpt: clean,
      redacted: clean !== ref.excerpt,
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  let omitted = 0;
  for (const item of candidates) {
    if (used + item.excerpt.length > maxChars) {
      omitted++;
      continue;
    }
    selected.push(item);
    used += item.excerpt.length;
  }
  return { refs: selected, omitted, chars: used };
}

const MEMORY_INDEX = 'MEMORY.md';
const MEMORY_MAX_FILES = 300;

function projectSlug(dir) {
  // Qoder 的项目目录名：每个非字母数字（除连字符）都替换成 '-'，连续分隔符不折叠。
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-');
}

function clientRoots() {
  const roots = [];
  try {
    const primary = clientRoot();
    roots.push(primary);
    const other = counterpart(primary);
    if (other) roots.push(other);
  } catch { /* Fall back to cwd-only project memory. */ }
  return roots;
}

function defaultMemoryDirs() {
  const candidates = [];
  const roots = clientRoots();
  for (const root of roots) candidates.push(path.join(root, 'memory'));
  candidates.push(path.join(process.cwd(), '.qoder', 'memory'));
  for (const root of roots) candidates.push(path.join(root, 'projects', projectSlug(process.cwd()), 'memory'));
  const dirs = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const resolved = path.resolve(dir);
    if (!dirs.some(existing => path.resolve(existing).toLowerCase() === resolved.toLowerCase())) dirs.push(resolved);
  }
  return dirs;
}

function memoryLabel(dir) {
  const resolved = path.resolve(dir).toLowerCase();
  for (const root of clientRoots()) {
    if (resolved === path.resolve(root, 'memory').toLowerCase()) return 'user-memory';
  }
  return 'project-memory';
}

function memoryFiles(dir) {
  const files = [];
  const walk = (current, depth) => {
    if (files.length >= MEMORY_MAX_FILES || depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MEMORY_MAX_FILES) return;
      if (entry.name.startsWith('.') || /\.bak(?:[.-]|$)/i.test(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(file);
    }
  };
  walk(dir, 0);
  return files;
}

function queryTerms(query) {
  const raw = String(query).normalize('NFKC').toLowerCase();
  const terms = raw.split(/[\s,，。；;、:：/\\|()（）\[\]【】{}"'“”‘’<>]+/)
    .map(term => term.trim()).filter(term => term.length >= 2 && term.length <= 40);
  return [...new Set(terms)].slice(0, 16);
}

function termHits(text, terms) {
  const hay = String(text).toLowerCase();
  return terms.reduce((count, term) => count + (hay.includes(term) ? 1 : 0), 0);
}

function markdownSections(text) {
  const sections = [];
  let heading = '';
  let body = [];
  const flush = () => {
    if (body.some(line => line.trim())) sections.push({ heading, text: body.join('\n') });
    body = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) { flush(); heading = match[2].trim(); }
    else body.push(line);
  }
  flush();
  return sections;
}

function parseMemoryIndex(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)\s*(.*)$/.exec(line);
    if (!match) continue;
    const link = match[2].trim();
    if (!link || /^[a-z]+:/i.test(link) || link.startsWith('#')) continue;
    entries.push({ title: match[1].trim(), link: link.split('#')[0], hook: match[3].trim() });
  }
  return entries;
}

function memoryExcerpt(text, terms, maxChars) {
  const sections = markdownSections(text);
  let best = null, bestScore = 0;
  for (const section of sections) {
    const score = termHits(section.heading, terms) * 2 + termHits(section.text, terms);
    if (score > bestScore) { best = section; bestScore = score; }
  }
  const source = best || { heading: '', text: String(text) };
  let excerpt = (source.heading ? source.heading + '\n' : '') + source.text.trim();
  excerpt = redact(excerpt).trim();
  if (!excerpt || findSensitive(excerpt).length) return { excerpt: '', score: 0 };
  if (excerpt.length > maxChars) excerpt = excerpt.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
  return { excerpt, score: bestScore };
}

function extractPaths(text) {
  return [...new Set((String(text).match(/\b(?:src|app|packages|scripts|docs|skills|\.qoder)\/[A-Za-z0-9._\/-]+/g) || [])
    .map(normalizePath).filter(Boolean))].slice(0, 20);
}

function recall(options) {
  if (!isText(options.query, 500)) fail('USAGE', 'recall needs --query');
  const terms = queryTerms(options.query);
  if (!terms.length) fail('INVALID_QUERY', 'query needs at least one term of 2+ characters');
  const dirs = (Array.isArray(options.memory) && options.memory.length ? options.memory : defaultMemoryDirs())
    .map(dir => path.resolve(dir)).filter((dir, index, list) => list.indexOf(dir) === index);
  const maxItems = options['max-items'] === undefined ? 5 : Number(options['max-items']);
  const maxChars = options['max-chars'] === undefined ? 1200 : Number(options['max-chars']);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) fail('INVALID_MAX_ITEMS', 'max-items must be 1..20');
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 8000) fail('INVALID_MAX_CHARS', 'max-chars must be 200..8000');
  const candidates = new Map();
  for (const dir of dirs) {
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const source = memoryLabel(dir);
    const files = memoryFiles(dir);
    const indexFile = path.join(dir, MEMORY_INDEX);
    const hooks = new Map();
    if (fs.existsSync(indexFile)) {
      for (const entry of parseMemoryIndex(fs.readFileSync(indexFile, 'utf8'))) {
        const file = path.resolve(dir, entry.link);
        if (!file.startsWith(path.resolve(dir) + path.sep)) continue;
        hooks.set(file, entry);
      }
    }
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const hook = hooks.get(file);
      const sections = markdownSections(text);
      const candidatesInFile = [];
      if (hook) candidatesInFile.push({ heading: hook.title, text, boost: termHits(hook.title + ' ' + hook.hook, terms) * 3, lead: hook.hook });
      else for (const section of sections) candidatesInFile.push({ heading: section.heading, text: section.text, boost: 0, lead: '' });
      for (const section of candidatesInFile) {
        const contextScore = termHits(section.heading, terms) * 2 + termHits(section.text, terms) + (section.boost || 0);
        if (!contextScore) continue;
        const rendered = memoryExcerpt(section.heading ? section.heading + '\n' + section.text : section.text, terms, maxChars);
        if (!rendered.excerpt) continue;
        const relative = path.relative(dir, file).replace(/\\/g, '/');
        const heading = section.heading && !hook ? '#' + section.heading : (hook ? '#' + hook.title : '');
        const ref = relative + heading;
        if (findSensitive(ref).length || findSensitive(source).length) continue;
        let excerpt = section.lead ? redact(section.lead + '\n' + rendered.excerpt).trim() : rendered.excerpt;
        if (excerpt.length > maxChars) excerpt = excerpt.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
        if (!excerpt || findSensitive(excerpt).length) continue;
        const item = {
          source,
          ref,
          asOf: fs.statSync(file).mtime.toISOString(),
          confidence: contextScore + rendered.score >= 6 ? 'high' : contextScore + rendered.score >= 3 ? 'medium' : 'low',
          paths: extractPaths(excerpt),
          excerpt,
          score: contextScore + rendered.score,
        };
        // Synced user-memory directories contain the same note; dedupe by
        // visible reference + excerpt, not by the physical root path.
        const key = ref + '\u0000' + excerpt;
        const previous = candidates.get(key);
        if (!previous || item.score > previous.score) candidates.set(key, item);
      }
    }
  }
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  const refs = sorted.slice(0, maxItems).map(({ score, ...item }) => item);
  const result = {
    schema: SCHEMA,
    query: options.query.trim(),
    refs,
    omitted: Math.max(0, sorted.length - refs.length),
    sources: dirs,
    notice: refs.length ? '记忆是某时刻的快照；使用前用当前代码/测试复核，冲突以现场为准。' : '记忆无此项',
  };
  if (options.out) {
    atomicWrite(options.out, JSON.stringify(result, null, 2) + '\n');
    return { ok: true, out: path.resolve(options.out), recall: result };
  }
  return { ok: true, recall: result };
}

function renderContextMd(context) {
  const lines = [
    '# Parallel run context',
    '',
    '- task: ' + context.taskId,
    '- version: ' + context.version,
    '- planDigest: ' + context.planDigest,
    '- goal: ' + context.goal,
    '',
    '## Constraints',
    ...(context.constraints.length ? context.constraints.map(item => '- ' + item) : ['- none']),
    '',
    '## Units',
    '| ID | Kind | Status | Owned paths | Read paths |',
    '|---|---|---|---|---|',
    ...context.units.map(unit => '| ' + [unit.id, unit.kind, unit.status, (unit.ownedPaths || []).join(', ') || '-', (unit.readPaths || []).join(', ') || '-'].join(' | ') + ' |'),
    '',
    '## Decisions',
    ...(context.decisions.length ? context.decisions.map(item => '- ' + item.id + ': ' + item.text + ' (' + item.source + ', ' + item.asOf + ')') : ['- none']),
    '',
    '## Open questions',
    ...(context.openQuestions.length ? context.openQuestions.map(item => '- ' + item.id + ': ' + item.text + ' [' + item.status + ']') : ['- none']),
    '',
    '## Memory refs',
    ...(context.memoryRefs.length ? context.memoryRefs.map(item => '- ' + item.source + ' / ' + item.ref + ' (as of ' + item.asOf + ')') : ['- none']),
    '',
    '## Conflicts',
    ...(context.conflicts.length ? context.conflicts.map(item => '- ' + item.memoryRef + ' -> ' + item.resolution + ' (' + item.current + ')') : ['- none']),
    '',
    '## Evidence',
    ...(context.evidence.length ? context.evidence.map(item => '- ' + item.unitId + ': ' + item.ref + ' — ' + item.summary) : ['- none']),
    '',
    '## Recall requests',
    ...(context.recallRequests.length ? context.recallRequests.map(item => '- ' + item.unitId + ': ' + item.query + ' [' + item.status + ']') : ['- none']),
    '',
  ];
  return lines.join('\n');
}

function contextIssues(context, plan) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return ['INVALID_CONTEXT'];
  const issues = [];
  if (context.schema !== SCHEMA) issues.push('INVALID_CONTEXT_SCHEMA');
  if (context.taskId !== plan.taskId) issues.push('TASK_ID_MISMATCH');
  if (context.planDigest !== digestPlan(plan)) issues.push('PLAN_DIGEST_MISMATCH');
  if (!Number.isSafeInteger(context.version) || context.version < 1) issues.push('INVALID_CONTEXT_VERSION');
  for (const key of ['constraints', 'decisions', 'units', 'interfaces', 'openQuestions', 'recallRequests', 'memoryRefs', 'conflicts', 'findings', 'evidence']) {
    if (!Array.isArray(context[key]) || context[key].some(item => key === 'constraints' ? typeof item !== 'string' : !item || typeof item !== 'object' || Array.isArray(item))) issues.push('INVALID_CONTEXT_FIELD:' + key);
  }
  if (issues.some(issue => issue.startsWith('INVALID_CONTEXT_FIELD:'))) return issues;
  if (context.goal !== plan.goal || stable(context.constraints) !== stable(plan.constraints)) issues.push('CONTEXT_PLAN_MISMATCH:goal');
  const byId = new Map(plan.units.map(unit => [unit.id, unit]));
  const seen = new Set();
  for (const unit of context.units) {
    const planned = byId.get(unit.id);
    if (!planned || seen.has(unit.id)) issues.push('CONTEXT_PLAN_MISMATCH:' + unit.id);
    else if (Object.keys(planned).filter(key => key !== 'dependsOn').some(key => stable(unit[key]) !== stable(planned[key]))) issues.push('CONTEXT_PLAN_MISMATCH:' + unit.id);
    seen.add(unit.id);
    if (!UNIT_STATUSES.has(unit.status)) issues.push('UNKNOWN_STATUS:' + unit.id + ':' + unit.status);
  }
  for (const unit of plan.units) if (!seen.has(unit.id)) issues.push('UNIT_MISSING:' + unit.id);
  return issues;
}

function readRun(file) {
  const contextFile = path.resolve(file), planFile = path.join(path.dirname(contextFile), 'plan.json');
  const contextSnapshot = snapshot(contextFile), planSnapshot = snapshot(planFile);
  if (!contextSnapshot || !planSnapshot) fail('INVALID_CONTEXT', 'context and its adjacent plan.json must exist');
  let context, plan;
  try { context = JSON.parse(contextSnapshot.bytes.toString('utf8')); plan = validatePlan(JSON.parse(planSnapshot.bytes.toString('utf8'))); }
  catch (error) { fail('INVALID_CONTEXT', error.message); }
  const issues = contextIssues(context, plan);
  if (issues.length) fail('INVALID_CONTEXT', issues.join('; '));
  return { context, plan, expected: new Map([[contextFile, contextSnapshot], [planFile, planSnapshot]]) };
}

function readContext(file) { return readRun(file).context; }

function sensitiveValueHits(value) {
  const hits = new Set(findSensitive(JSON.stringify(value)));
  function inspect(item) {
    if (typeof item === 'string') for (const hit of findSensitive(item)) hits.add(hit);
    else if (Array.isArray(item)) item.forEach(inspect);
    else if (item && typeof item === 'object') Object.values(item).forEach(inspect);
  }
  // Inspect raw strings too: JSON serialization escapes quoted credentials inside excerpts.
  inspect(value);
  return [...hits];
}

function assertNoSensitive(value) {
  if (sensitiveValueHits(value).length) fail('SENSITIVE_OUTPUT', 'context contains sensitive content; remove or redact it before continuing');
}

function init(options) {
  if (!options.plan || !options.out) fail('USAGE', 'init needs --plan and --out');
  const input = readJson(options.plan);
  const result = evaluatePlan(input);
  if (result.verdict === 'INVALID_PLAN') {
    fail('INVALID_PLAN', (result.problems || []).map(problem => problem.code + ': ' + problem.message).join('; '));
  }
  if (!['PARALLEL_READ', 'PARALLEL_WORKTREE'].includes(result.verdict)) fail('PLAN_NOT_PARALLEL', 'cannot initialize a parallel run for ' + result.verdict + ': ' + result.reasonCodes.join(', '));
  if (options.decision === undefined && !options.preview) fail('DECISION_REQUIRED', 'init needs --decision after user confirmation; use --preview only for tooling or tests');
  const plan = validatePlan(input);
  const contextFile = path.join(path.resolve(options.out), 'context.json');
  if (options.decision !== undefined && !isText(options.decision, 500)) fail('INVALID_DECISION', 'decision must be non-empty text');
  assertNoSensitive({ plan, decision: options.decision });
  return withRunLock(contextFile, assertOwner => {
    const expected = new Map([[contextFile, snapshot(contextFile)], [path.join(path.dirname(contextFile), 'plan.json'), snapshot(path.join(path.dirname(contextFile), 'plan.json'))]]);
    let version = 1;
    if (expected.get(contextFile)) {
      if (!options.force) fail('CONTEXT_EXISTS', 'run context already exists; pass --force to replace it');
      const previous = JSON.parse(expected.get(contextFile).bytes.toString('utf8'));
      if (!previous || !Number.isSafeInteger(previous.version) || previous.version < 1 || previous.version === Number.MAX_SAFE_INTEGER) fail('INVALID_CONTEXT_VERSION', 'cannot safely advance the existing context version');
      // Force replaces content, not run history: old same-plan deltas must stay stale.
      version = previous.version + 1;
    }
    const now = new Date().toISOString();
    const context = {
      schema: SCHEMA,
      taskId: plan.taskId,
      version,
      planDigest: digestPlan(plan),
      goal: plan.goal,
      constraints: plan.constraints,
      decisions: options.decision ? [{ id: 'D1', text: options.decision.trim(), source: 'user', asOf: now }] : [],
      units: plan.units.map(unit => ({
        id: unit.id,
        kind: unit.kind,
        title: unit.title,
        owner: null,
        ownedPaths: unit.ownedPaths,
        readPaths: unit.readPaths,
        acceptance: unit.acceptance,
        evidence: unit.evidence,
        status: 'planned',
      })),
      interfaces: [],
      openQuestions: [],
      recallRequests: [],
      memoryRefs: [],
      conflicts: [],
      findings: [],
      evidence: [],
      updatedAt: now,
    };
    assertNoSensitive(context);
    const dir = path.resolve(options.out);
    commitContext(context, contextFile, assertOwner, expected, plan);
    return { ok: true, dir, verdict: result.verdict, context };
  }, true);
}

function pack(options) {
  if (!options.context || !options.unit) fail('USAGE', 'pack needs --context and --unit');
  if (options.out) {
    const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
    const reserved = new Set(['context.json', 'plan.json', 'context.md', '.context-write.lock']);
    const physical = file => {
      let existing = path.resolve(file);
      const missing = [];
      while (true) {
        try { return path.resolve(fs.realpathSync(existing), ...missing.reverse()); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          missing.push(path.basename(existing)); existing = parent;
        }
      }
    };
    // Reserved names stay unavailable even in another run, and aliases must
    // not turn an ordinary pack filename into a canonical writer bypass.
    const lexical = path.resolve(options.out), actual = physical(options.out);
    if (reserved.has(key(path.basename(lexical))) || reserved.has(key(path.basename(actual))) || key(actual) === key(physical(options.context))) {
      fail('USAGE', 'pack --out cannot replace a canonical context, plan, mirror or run lock; choose a separate pack filename');
    }
  }
  const context = readContext(options.context);
  const unit = (context.units || []).find(item => item.id === options.unit);
  if (!unit) fail('UNKNOWN_UNIT', 'unit not found: ' + options.unit);
  const recall = options.recall ? readJson(options.recall) : { refs: [] };
  const refs = Array.isArray(recall) ? recall : (recall && recall.refs);
  if (!Array.isArray(refs)) fail('INVALID_RECALL', 'recall must be an array or an object with a refs array');
  const maxChars = options['max-chars'] === undefined ? MAX_RECALL_CHARS : Number(options['max-chars']);
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20000) fail('INVALID_MAX_CHARS', 'max-chars must be 100..20000');
  const selected = selectRecall(unit, refs, maxChars);
  const output = {
    schema: SCHEMA,
    taskId: context.taskId,
    unitId: unit.id,
    contextVersion: context.version,
    planDigest: context.planDigest,
    goal: context.goal,
    unit: {
      id: unit.id,
      kind: unit.kind,
      title: unit.title,
      ownedPaths: unit.ownedPaths || [],
      readPaths: unit.readPaths || [],
      acceptance: unit.acceptance || [],
      evidence: unit.evidence || [],
      status: unit.status,
    },
    constraints: context.constraints || [],
    decisions: context.decisions || [],
    interfaces: context.interfaces || [],
    openQuestions: context.openQuestions || [],
    memoryRefs: selected.refs,
    recallOmitted: selected.omitted,
    recallChars: selected.chars,
    generatedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(output, null, 2) + '\n';
  assertNoSensitive(output);
  if (options.out) {
    atomicWrite(options.out, text);
    return { ok: true, out: path.resolve(options.out), pack: output };
  }
  return { ok: true, pack: output };
}

function applyDelta(context, delta, now) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) fail('INVALID_DELTA', 'delta must be an object');
  for (const key of Object.keys(delta)) {
    if (!DELTA_KEYS.has(key)) fail('INVALID_DELTA', 'worker delta cannot write canonical field: ' + key);
  }
  if (!isText(delta.unitId, 64)) fail('INVALID_DELTA', 'unitId is required');
  if (delta.contextVersion !== context.version) fail('STALE_CONTEXT', 'delta contextVersion does not match current context');
  if (delta.planDigest !== context.planDigest) fail('STALE_PLAN', 'delta planDigest is missing or does not match the current plan; obtain a fresh pack and return its planDigest');
  const unit = (context.units || []).find(item => item.id === delta.unitId);
  if (!unit) fail('UNKNOWN_UNIT', 'unit not found: ' + delta.unitId);
  if (delta.findings !== undefined) {
    for (const finding of stringArray(delta.findings, 'FINDINGS', 20)) {
      context.findings.push({ unitId: unit.id, text: finding, at: now });
    }
  }
  if (delta.evidence !== undefined) {
    if (!Array.isArray(delta.evidence) || delta.evidence.length > 20) fail('INVALID_EVIDENCE', 'evidence must be an array');
    for (const item of delta.evidence) {
      if (!item || typeof item !== 'object' || !isText(item.ref, 500) || !isText(item.summary, 1000)) {
        fail('INVALID_EVIDENCE', 'evidence needs ref and summary');
      }
      context.evidence.push({ unitId: unit.id, ref: item.ref.trim(), summary: item.summary.trim(), at: now });
    }
  }
  if (delta.recallRequests !== undefined) {
    if (!Array.isArray(delta.recallRequests) || delta.recallRequests.length > 20) fail('INVALID_RECALL', 'recallRequests must be an array');
    for (const item of delta.recallRequests) {
      if (!item || typeof item !== 'object' || !isText(item.query, 500)) fail('INVALID_RECALL', 'recallRequests need query');
      context.recallRequests.push({ unitId: unit.id, query: item.query.trim(), reason: isText(item.reason, 500) ? item.reason.trim() : '', at: now, status: 'open' });
    }
  }
  if (delta.status !== undefined) {
    if (!WORKER_STATUSES.has(delta.status)) fail('INVALID_STATUS', 'worker status is invalid');
    unit.status = delta.status;
  }
}

function mergeResults(options, files) {
  if (!options.context || !Array.isArray(files) || files.length < 1 || files.length > 8 || files.some(file => !isText(file, 32768))) fail('USAGE', 'merge needs --context and 1..8 delta files');
  if (options.out && path.resolve(options.out) !== path.resolve(options.context)) fail('USAGE', 'merge --out must equal --context; detached copies lose the canonical plan and mirror association');
  return withRunLock(options.context, assertOwner => {
    // Lock before reading: a second writer must observe this commit's new version.
    const { context, expected } = readRun(options.context);
    const baseVersion = context.version, now = new Date().toISOString(), mergedUnits = [];
    const deltas = files.map(file => readJson(file));
    for (const delta of deltas) {
      if (delta && mergedUnits.includes(delta.unitId)) fail('DUPLICATE_DELTA', 'batch contains more than one result for unit ' + delta.unitId);
      applyDelta(context, delta, now);
      mergedUnits.push(delta.unitId);
    }
    context.version += 1;
    if (!Number.isSafeInteger(context.version)) fail('INVALID_CONTEXT_VERSION', 'context version cannot be advanced safely');
    context.updatedAt = now;
    assertNoSensitive(context);
    commitContext(context, options.context, assertOwner, expected);
    return { ok: true, context, out: path.resolve(options.context), baseVersion, mergedUnits };
  });
}

function merge(options) {
  if (typeof options.delta !== 'string') fail('USAGE', 'merge needs one --delta; use merge-batch for multiple results');
  return mergeResults(options, [options.delta]);
}

function mergeBatch(options) {
  return mergeResults(options, Array.isArray(options.delta) ? options.delta : [options.delta]);
}

function check(options) {
  if (!options.run) fail('USAGE', 'check needs --run');
  const dir = path.resolve(options.run);
  const issues = [];
  const planFile = path.join(dir, 'plan.json');
  const contextFile = path.join(dir, 'context.json');
  const mirrorFile = path.join(dir, 'context.md');
  if (!fs.existsSync(planFile)) issues.push('PLAN_MISSING');
  if (!fs.existsSync(contextFile)) issues.push('CONTEXT_MISSING');
  if (!fs.existsSync(mirrorFile)) issues.push('CONTEXT_MIRROR_MISSING');
  if (issues.length) return { ok: false, issues };
  let plan;
  let context;
  try {
    plan = validatePlan(readJson(planFile));
    context = readJson(contextFile);
  } catch (error) {
    return { ok: false, issues: [error.code || 'INVALID_CONTEXT'] };
  }
  issues.push(...contextIssues(context, plan));
  if (!issues.length && fs.readFileSync(mirrorFile, 'utf8') !== renderContextMd(context)) {
    issues.push('CONTEXT_MIRROR_MISMATCH');
  }
  const files = [contextFile, mirrorFile];
  const packsDir = path.join(dir, 'packs');
  if (fs.existsSync(packsDir)) {
    for (const name of fs.readdirSync(packsDir).filter(item => item.endsWith('.json'))) {
      const file = path.join(packsDir, name);
      files.push(file);
      try {
        const packData = readJson(file);
        if (packData.contextVersion !== context.version || packData.planDigest !== context.planDigest) {
          issues.push('STALE_PACK:' + name);
        }
        const unit = (Array.isArray(context.units) ? context.units : []).find(item => item.id === packData.unitId);
        const packedUnit = unit && Object.fromEntries(['id', 'kind', 'title', 'ownedPaths', 'readPaths', 'acceptance', 'evidence', 'status'].map(key => [key, unit[key]]));
        if (packData.schema !== SCHEMA || packData.taskId !== context.taskId || !unit || stable(packData.unit) !== stable(packedUnit) || ['goal', 'constraints', 'decisions', 'interfaces', 'openQuestions'].some(key => stable(packData[key]) !== stable(context[key]))) {
          issues.push('PACK_CONTEXT_MISMATCH:' + name);
        }
      } catch {
        issues.push('INVALID_PACK:' + name);
      }
    }
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let hits = findSensitive(text);
    if (path.extname(file) === '.json') {
      try { hits = [...new Set([...hits, ...sensitiveValueHits(JSON.parse(text))])]; } catch {}
    }
    if (hits.length) issues.push('SENSITIVE_CONTENT:' + path.basename(file) + ':' + hits.join(','));
  }
  return {
    ok: issues.length === 0,
    issues,
    contextVersion: context && context.version,
    planDigest: context && context.planDigest,
    units: context && Array.isArray(context.units) ? context.units.length : 0,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const allowed = {
    init: new Set(['plan', 'out', 'decision', 'force', 'preview', 'json']),
    pack: new Set(['context', 'unit', 'recall', 'out', 'max-chars', 'json']),
    merge: new Set(['context', 'delta', 'out', 'json']),
    'merge-batch': new Set(['context', 'delta', 'json']),
    check: new Set(['run', 'json']),
    recall: new Set(['query', 'memory', 'out', 'max-items', 'max-chars', 'json']),
  }[command];
  if (!allowed) fail('USAGE', 'command must be init, pack, merge, merge-batch, check or recall');
  const values = {};
  const flags = new Set();
  const seen = new Set();
  while (args.length) {
    const arg = args.shift();
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    const repeatable = (command === 'merge-batch' && key === 'delta') || (command === 'recall' && key === 'memory');
    if (!allowed.has(key) || (seen.has(key) && !repeatable)) fail('USAGE', 'unknown or repeated argument: ' + arg);
    seen.add(key);
    if (arg === '--json' || arg === '--force' || arg === '--preview') {
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      const value = args.shift();
      if (!value || !value.trim() || value.startsWith('--')) fail('USAGE', 'missing value for ' + arg);
      if (repeatable) (values[key] ||= []).push(value);
      else values[key] = value;
    } else {
      fail('USAGE', 'unexpected argument: ' + arg);
    }
  }
  return { command, values, flags };
}

function main(argv) {
  const json = argv.includes('--json');
  let parsed;
  try {
    parsed = parseArgs(argv);
    const values = { ...parsed.values, json: parsed.flags.has('--json'), force: parsed.flags.has('--force'), preview: parsed.flags.has('--preview') };
    let result;
    if (parsed.command === 'init') result = init(values);
    else if (parsed.command === 'pack') result = pack(values);
    else if (parsed.command === 'merge') result = merge(values);
    else if (parsed.command === 'merge-batch') result = mergeBatch(values);
    else if (parsed.command === 'check') result = check(values);
    else if (parsed.command === 'recall') result = recall(values);
    else fail('USAGE', 'command must be init, pack, merge, merge-batch, check or recall');
    if (json || (parsed.command === 'pack' && !values.out) || (parsed.command === 'recall' && !values.out)) {
      console.log(JSON.stringify(result, null, 2));
    } else if (parsed.command === 'check') {
      console.log((result.ok ? 'OK' : 'ISSUES') + ' version=' + result.contextVersion + ' units=' + result.units + (result.issues.length ? ' ' + result.issues.join(',') : ''));
    } else if (parsed.command === 'recall') {
      console.log('RECALL OK ' + result.out + ' refs=' + result.recall.refs.length);
    } else {
      console.log(parsed.command.toUpperCase() + ' OK ' + (result.out || result.dir || ''));
    }
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    const code = error.code || 'ERROR';
    if (json) console.log(JSON.stringify({ ok: false, code, message: error.message }, null, 2));
    else console.error(code + ': ' + error.message);
    process.exitCode = ['USAGE', 'DECISION_REQUIRED'].includes(code) ? 2 : 1;
  }
}

module.exports = { init, pack, merge, mergeBatch, check, recall, redact, findSensitive, renderContextMd, selectRecall };
if (require.main === module) main(process.argv.slice(2));
