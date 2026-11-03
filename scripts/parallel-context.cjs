#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validatePlan, evaluatePlan, digestPlan } = require('./parallel-plan.cjs');

const SCHEMA = 1;
const UNIT_STATUSES = new Set(['planned', 'dispatched', 'running', 'done', 'failed', 'blocked', 'verified', 'merged']);
const WORKER_STATUSES = new Set(['dispatched', 'running', 'done', 'failed', 'blocked']);
const DELTA_KEYS = new Set(['unitId', 'contextVersion', 'findings', 'evidence', 'recallRequests', 'status']);
const MAX_RECALL_CHARS = 2000;

const SECRET_PATTERNS = [
  { label: 'PRIVATE_KEY', regex: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { label: 'TOKEN', regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_TOKEN]' },
  { label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  { label: 'CREDENTIAL', regex: /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|密钥|口令|密码)\s*[:=]\s*)(["']?)([^\s"',;)}\]]{6,})\2/gi, replacement: '$1[REDACTED]' },
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

function writeContext(context, file) {
  const target = path.resolve(file);
  atomicWrite(target, JSON.stringify(context, null, 2) + '\n');
  atomicWrite(path.join(path.dirname(target), 'context.md'), renderContextMd(context));
}

function init(options) {
  if (!options.plan || !options.out) fail('USAGE', 'init needs --plan and --out');
  const input = readJson(options.plan);
  const result = evaluatePlan(input);
  if (result.verdict === 'INVALID_PLAN') {
    fail('INVALID_PLAN', (result.problems || []).map(problem => problem.code + ': ' + problem.message).join('; '));
  }
  const plan = validatePlan(input);
  if (!options.force && fs.existsSync(path.join(path.resolve(options.out), 'context.json'))) {
    fail('CONTEXT_EXISTS', 'run context already exists; pass --force to replace it');
  }
  const now = new Date().toISOString();
  if (options.decision !== undefined && !isText(options.decision, 500)) fail('INVALID_DECISION', 'decision must be non-empty text');
  const context = {
    schema: SCHEMA,
    taskId: plan.taskId,
    version: 1,
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
  const dir = path.resolve(options.out);
  atomicWrite(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeContext(context, path.join(dir, 'context.json'));
  return { ok: true, dir, verdict: result.verdict, context };
}

function pack(options) {
  if (!options.context || !options.unit) fail('USAGE', 'pack needs --context and --unit');
  const context = readJson(options.context);
  if (context.schema !== SCHEMA) fail('INVALID_CONTEXT', 'context schema must be 1');
  const unit = (context.units || []).find(item => item.id === options.unit);
  if (!unit) fail('UNKNOWN_UNIT', 'unit not found: ' + options.unit);
  const recall = options.recall ? readJson(options.recall) : { refs: [] };
  const refs = Array.isArray(recall) ? recall : (Array.isArray(recall.refs) ? recall.refs : []);
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
  if (findSensitive(text).length) fail('SENSITIVE_OUTPUT', 'context pack still contains sensitive content after redaction');
  if (options.out) {
    atomicWrite(options.out, text);
    return { ok: true, out: path.resolve(options.out), pack: output };
  }
  return { ok: true, pack: output };
}

function merge(options) {
  if (!options.context || !options.delta) fail('USAGE', 'merge needs --context and --delta');
  const context = readJson(options.context);
  const delta = readJson(options.delta);
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) fail('INVALID_DELTA', 'delta must be an object');
  for (const key of Object.keys(delta)) {
    if (!DELTA_KEYS.has(key)) fail('INVALID_DELTA', 'worker delta cannot write canonical field: ' + key);
  }
  if (!isText(delta.unitId, 64)) fail('INVALID_DELTA', 'unitId is required');
  if (delta.contextVersion !== context.version) fail('STALE_CONTEXT', 'delta contextVersion does not match current context');
  const unit = (context.units || []).find(item => item.id === delta.unitId);
  if (!unit) fail('UNKNOWN_UNIT', 'unit not found: ' + delta.unitId);
  const now = new Date().toISOString();
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
  context.version += 1;
  context.updatedAt = now;
  const target = options.out || options.context;
  writeContext(context, target);
  return { ok: true, context, out: path.resolve(target) };
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
  if (context.schema !== SCHEMA) issues.push('INVALID_CONTEXT_SCHEMA');
  if (context.taskId !== plan.taskId) issues.push('TASK_ID_MISMATCH');
  if (context.planDigest !== digestPlan(plan)) issues.push('PLAN_DIGEST_MISMATCH');
  if (!Number.isInteger(context.version) || context.version < 1) issues.push('INVALID_CONTEXT_VERSION');
  const contextUnits = new Map((context.units || []).map(unit => [unit.id, unit]));
  for (const unit of plan.units) if (!contextUnits.has(unit.id)) issues.push('UNIT_MISSING:' + unit.id);
  for (const unit of context.units || []) {
    if (!UNIT_STATUSES.has(unit.status)) issues.push('UNKNOWN_STATUS:' + unit.id + ':' + unit.status);
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
      } catch {
        issues.push('INVALID_PACK:' + name);
      }
    }
  }
  for (const file of files) {
    const hits = findSensitive(fs.readFileSync(file, 'utf8'));
    if (hits.length) issues.push('SENSITIVE_CONTENT:' + path.basename(file) + ':' + hits.join(','));
  }
  return {
    ok: issues.length === 0,
    issues,
    contextVersion: context.version,
    planDigest: context.planDigest,
    units: (context.units || []).length,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const values = {};
  const flags = new Set();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json' || arg === '--force') {
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args.shift();
      if (!value || value.startsWith('--')) fail('USAGE', 'missing value for ' + arg);
      values[key] = value;
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
    const values = { ...parsed.values, json: parsed.flags.has('--json'), force: parsed.flags.has('--force') };
    let result;
    if (parsed.command === 'init') result = init(values);
    else if (parsed.command === 'pack') result = pack(values);
    else if (parsed.command === 'merge') result = merge(values);
    else if (parsed.command === 'check') result = check(values);
    else fail('USAGE', 'command must be init, pack, merge or check');
    if (json || (parsed.command === 'pack' && !values.out)) {
      console.log(JSON.stringify(result, null, 2));
    } else if (parsed.command === 'check') {
      console.log((result.ok ? 'OK' : 'ISSUES') + ' version=' + result.contextVersion + ' units=' + result.units + (result.issues.length ? ' ' + result.issues.join(',') : ''));
    } else {
      console.log(parsed.command.toUpperCase() + ' OK ' + (result.out || result.dir || ''));
    }
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    const code = error.code || 'ERROR';
    if (json) console.log(JSON.stringify({ ok: false, code, message: error.message }, null, 2));
    else console.error(code + ': ' + error.message);
    process.exitCode = code === 'USAGE' ? 2 : 1;
  }
}

module.exports = { init, pack, merge, check, redact, findSensitive, renderContextMd, selectRecall };
if (require.main === module) main(process.argv.slice(2));
