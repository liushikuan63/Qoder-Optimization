#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODES = new Set(['auto', 'read', 'worktree', 'sequential']);
const KINDS = new Set(['read', 'write']);
const ISOLATIONS = new Set(['none', 'worktree']);
const WORKER_TOOLS = new Set(['Explore', 'general-purpose', 'batch', 'session']);
const MAX_UNITS = 8;
const MAX_CONCURRENCY = 4;

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function digestPlan(plan) {
  return crypto.createHash('sha256').update(stable(plan)).digest('hex');
}

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}

function isText(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function textList(value, name, maxItems = 20, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length < 1) || value.some(item => !isText(item, 500))) {
    fail('INVALID_' + name, name + ' must be an array of non-empty strings');
  }
  return value.map(item => item.trim());
}

function safePath(value, name) {
  if (typeof value !== 'string') fail('INVALID_PATH', name + ' must be a string');
  const raw = value.replace(/\\/g, '/').trim();
  // Check rooted paths before stripping the optional relative "./" prefix.
  if (!raw || raw.startsWith('/') || /[:?*[\]{}\x00-\x1f]/.test(raw)) {
    fail('INVALID_PATH', name + ' must be a relative literal path: ' + value);
  }
  const text = raw.replace(/^\.\//, '');
  const parts = text.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.' || /[. ]$/.test(part))) {
    fail('INVALID_PATH', name + ' must not escape the workspace: ' + value);
  }
  return parts.join('/').toLowerCase();
}

function pathList(value, name) {
  if (!Array.isArray(value) || value.length > 50) fail('INVALID_' + name, name + ' must be an array');
  return value.map(item => safePath(item, name));
}

function normalizeUnit(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_UNIT', 'unit ' + index + ' must be an object');
  if (!isText(raw.id, 64) || !SAFE_ID.test(raw.id)) fail('INVALID_UNIT_ID', 'unit id is invalid');
  if (!KINDS.has(raw.kind)) fail('INVALID_UNIT_KIND', 'unit ' + raw.id + ' kind must be read or write');
  if (!isText(raw.title, 200)) fail('INVALID_UNIT_TITLE', 'unit ' + raw.id + ' title is required');
  const dependsOn = raw.dependsOn === undefined ? [] : textList(raw.dependsOn, 'DEPENDS_ON', 20, true);
  for (const id of dependsOn) if (!SAFE_ID.test(id)) fail('INVALID_DEPENDS_ON', 'invalid dependency id: ' + id);
  if (new Set(dependsOn).size !== dependsOn.length) fail('DUPLICATE_DEPENDENCY', 'unit ' + raw.id + ' repeats a dependency');
  const ownedPaths = raw.ownedPaths === undefined ? [] : pathList(raw.ownedPaths, 'OWNED_PATHS');
  const readPaths = raw.readPaths === undefined ? [] : pathList(raw.readPaths, 'READ_PATHS');
  const acceptance = textList(raw.acceptance, 'ACCEPTANCE', 20);
  const evidence = textList(raw.evidence, 'EVIDENCE', 20);
  if (raw.kind === 'read' && ownedPaths.length) fail('READ_OWNED_PATHS', 'read unit ' + raw.id + ' must not own write paths');
  if (raw.kind === 'write' && !ownedPaths.length) fail('MISSING_OWNED_PATHS', 'write unit ' + raw.id + ' needs ownedPaths');
  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title.trim(),
    dependsOn,
    ownedPaths,
    readPaths,
    acceptance,
    evidence,
  };
}

function detectCycle(units) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('DEPENDENCY_CYCLE', 'dependency cycle at ' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id).dependsOn) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const unit of units) visit(unit.id);
}

function topologicalWaves(units) {
  const byId = new Map(units.map((unit, index) => [unit.id, { unit, index }]));
  const indegree = new Map(units.map(unit => [unit.id, unit.dependsOn.length]));
  const waves = [];
  const remaining = new Set(units.map(unit => unit.id));
  while (remaining.size) {
    const wave = [];
    for (const unit of units) {
      if (!remaining.has(unit.id) || indegree.get(unit.id) !== 0) continue;
      wave.push(unit.id);
    }
    if (!wave.length) fail('DEPENDENCY_CYCLE', 'dependency cycle prevents a topological wave');
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const unit of units) {
        if (unit.dependsOn.includes(id)) indegree.set(unit.id, indegree.get(unit.id) - 1);
      }
    }
  }
  return waves;
}

function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema !== SCHEMA) {
    fail('INVALID_SCHEMA', 'schema must be 1');
  }
  if (!isText(input.taskId, 64) || !SAFE_ID.test(input.taskId)) fail('INVALID_TASK_ID', 'taskId is invalid');
  if (!isText(input.goal, 500)) fail('INVALID_GOAL', 'goal is required');
  const mode = input.mode === undefined ? 'auto' : input.mode;
  if (!MODES.has(mode)) fail('INVALID_MODE', 'mode is invalid');
  const constraints = input.constraints === undefined ? [] : textList(input.constraints, 'CONSTRAINTS', 20, true);
  if (!Array.isArray(input.units) || input.units.length < 1 || input.units.length > MAX_UNITS) {
    fail('INVALID_UNITS', 'units must be 1..' + MAX_UNITS);
  }
  const units = input.units.map(normalizeUnit);
  const ids = new Set();
  for (const unit of units) {
    if (ids.has(unit.id)) fail('DUPLICATE_UNIT', 'duplicate unit ' + unit.id);
    ids.add(unit.id);
  }
  for (const unit of units) {
    for (const dep of unit.dependsOn) {
      if (!ids.has(dep)) fail('UNKNOWN_DEPENDENCY', unit.id + ' depends on unknown ' + dep);
      if (dep === unit.id) fail('SELF_DEPENDENCY', unit.id);
    }
  }
  detectCycle(units);
  const writes = units.filter(unit => unit.kind === 'write');
  const owned = new Map();
  for (const unit of writes) {
    for (const ownedPath of unit.ownedPaths) {
      for (const [previousPath, previousUnit] of owned) {
        if (ownedPath === previousPath || (previousUnit !== unit.id && (ownedPath.startsWith(previousPath + '/') || previousPath.startsWith(ownedPath + '/')))) {
          fail('OVERLAPPING_OWNED_PATHS', 'paths ' + previousPath + ' and ' + ownedPath + ' owned by ' + previousUnit + ' and ' + unit.id);
        }
      }
      owned.set(ownedPath, unit.id);
    }
  }
  const resources = input.resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) fail('INVALID_RESOURCES', 'resources is required');
  for (const key of ['databaseWrites', 'production', 'destructive', 'credentials', 'externalSideEffects']) {
    if (typeof resources[key] !== 'boolean') fail('INVALID_RESOURCES', key + ' must be boolean');
  }
  const sharedFiles = resources.sharedFiles === undefined ? [] : textList(resources.sharedFiles, 'SHARED_FILES', 50, true);
  const sharedServices = resources.sharedServices === undefined ? [] : textList(resources.sharedServices, 'SHARED_SERVICES', 50, true);
  const execution = input.execution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) fail('INVALID_EXECUTION', 'execution is required');
  const maxConcurrency = execution.maxConcurrency === undefined ? 3 : execution.maxConcurrency;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
    fail('INVALID_CONCURRENCY', 'maxConcurrency must be 1..' + MAX_CONCURRENCY);
  }
  if (maxConcurrency > units.length) fail('CONCURRENCY_EXCEEDS_UNITS', 'maxConcurrency exceeds units');
  const isolation = execution.isolation === undefined ? 'none' : execution.isolation;
  if (!ISOLATIONS.has(isolation)) fail('INVALID_ISOLATION', 'isolation is invalid');
  const workerTool = execution.workerTool === undefined ? (writes.length ? 'general-purpose' : 'Explore') : execution.workerTool;
  if (!WORKER_TOOLS.has(workerTool)) fail('INVALID_WORKER_TOOL', 'workerTool is invalid');
  const budget = input.budget === undefined ? {} : input.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) fail('INVALID_BUDGET', 'budget must be an object');
  const maxWorkers = budget.maxWorkers === undefined ? 4 : budget.maxWorkers;
  const maxRounds = budget.maxRounds === undefined ? 2 : budget.maxRounds;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) fail('INVALID_BUDGET', 'maxWorkers must be 1..4');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 2) fail('INVALID_BUDGET', 'maxRounds must be 1..2');
  if (maxConcurrency > maxWorkers) fail('CONCURRENCY_EXCEEDS_BUDGET', 'maxConcurrency exceeds maxWorkers');
  if ((writes.length > 1 || (writes.length && maxConcurrency > 1)) && isolation !== 'worktree') fail('WORKTREE_REQUIRED', 'parallel write units require isolation=worktree');
  if (writes.length && workerTool === 'Explore') fail('WORKER_KIND_MISMATCH', 'Explore cannot execute write units');
  if (mode === 'read' && writes.length) fail('MODE_KIND_MISMATCH', 'read mode cannot contain write units');
  if (mode === 'worktree' && !writes.length) fail('MODE_KIND_MISMATCH', 'worktree mode needs write units');
  if (maxConcurrency > 1 && mode !== 'sequential') {
    const byId = new Map(units.map(unit => [unit.id, unit]));
    for (const wave of topologicalWaves(units)) {
      for (const writerId of wave) {
        const writer = byId.get(writerId);
        if (writer.kind !== 'write') continue;
        for (const readerId of wave.filter(id => id !== writerId)) {
          const reader = byId.get(readerId);
          for (const written of writer.ownedPaths) for (const read of reader.readPaths) {
            if (written === read || written.startsWith(read + '/') || read.startsWith(written + '/')) {
              fail('READ_WRITE_CONFLICT', writer.id + ' writes ' + written + ' while same-wave ' + reader.id + ' reads ' + read + '; add dependsOn to serialize them');
            }
          }
        }
      }
    }
  }
  return {
    schema: SCHEMA,
    taskId: input.taskId,
    goal: input.goal.trim(),
    mode,
    constraints,
    units,
    resources: {
      sharedFiles,
      sharedServices,
      databaseWrites: resources.databaseWrites,
      production: resources.production,
      destructive: resources.destructive,
      credentials: resources.credentials,
      externalSideEffects: resources.externalSideEffects,
    },
    execution: { maxConcurrency, isolation, workerTool },
    budget: { maxWorkers, maxRounds },
  };
}

function evaluatePlan(input) {
  let plan;
  try {
    plan = validatePlan(input);
  } catch (error) {
    const code = error.code || 'INVALID_PLAN';
    return {
      schema: SCHEMA,
      verdict: 'INVALID_PLAN',
      exitCode: 1,
      problems: [{ code, message: error.message }],
      reasonCodes: [code],
      planDigest: null,
      waves: [],
      units: [],
    };
  }
  const reasons = [];
  if (plan.resources.production) reasons.push('PRODUCTION');
  if (plan.resources.databaseWrites) reasons.push('DATABASE_WRITES');
  if (plan.resources.destructive) reasons.push('DESTRUCTIVE');
  if (plan.resources.credentials) reasons.push('CREDENTIALS');
  if (plan.resources.externalSideEffects) reasons.push('EXTERNAL_SIDE_EFFECTS');
  if (plan.resources.sharedServices.length) reasons.push('SHARED_SERVICES');
  if (plan.resources.sharedFiles.length && plan.units.some(unit => unit.kind === 'write')) reasons.push('SHARED_FILES_WITH_WRITE');
  const waves = topologicalWaves(plan.units);
  const maxWidth = Math.max(...waves.map(wave => wave.length));
  const parallelizable = maxWidth >= 2 && plan.execution.maxConcurrency >= 2 && plan.mode !== 'sequential';
  const base = {
    schema: SCHEMA,
    taskId: plan.taskId,
    planDigest: digestPlan(plan),
    waves,
    units: plan.units.map(unit => ({ id: unit.id, kind: unit.kind, ownedPaths: unit.ownedPaths })),
    execution: plan.execution,
    budget: plan.budget,
    requiresPlanApproval: false,
    requiresUserOptIn: false,
    optInKind: null,
  };
  if (reasons.length) return { ...base, verdict: 'BLOCKED_HUMAN', exitCode: 2, reasonCodes: reasons };
  if (!parallelizable) {
    return {
      ...base,
      verdict: 'SEQUENTIAL_REQUIRED',
      exitCode: 2,
      reasonCodes: [maxWidth < 2 ? 'NO_INDEPENDENT_WAVE' : 'CONCURRENCY_LIMIT'],
    };
  }
  const hasWrite = plan.units.some(unit => unit.kind === 'write');
  return {
    ...base,
    verdict: hasWrite ? 'PARALLEL_WORKTREE' : 'PARALLEL_READ',
    exitCode: 0,
    reasonCodes: [hasWrite ? 'DISJOINT_WORKTREES' : 'INDEPENDENT_READS'],
    requiresPlanApproval: true,
    requiresUserOptIn: true,
    optInKind: hasWrite ? 'worktree-write' : 'read-only',
  };
}

function render(result) {
  const lines = [
    'verdict: ' + result.verdict,
    'exit: ' + result.exitCode,
    'task: ' + (result.taskId || 'unknown'),
    'planDigest: ' + (result.planDigest || 'null'),
    'waves: ' + (result.waves.length ? result.waves.map(wave => wave.join(',')).join(' -> ') : 'none'),
    'reason: ' + (result.reasonCodes || []).join(', '),
  ];
  for (const problem of result.problems || []) lines.push('problem: ' + problem.code + ': ' + problem.message);
  return lines.join('\n');
}

function main(argv) {
  const args = [...argv];
  const json = args.includes('--json');
  const files = args.filter(arg => arg !== '--json');
  if (files.length !== 1 || files[0].startsWith('-') || args.filter(arg => arg === '--json').length > 1) {
    const message = '用法：node scripts/parallel-plan.cjs <plan.json> [--json]';
    if (json) console.log(JSON.stringify({ ok: false, code: 'USAGE', message }));
    else console.error(message);
    process.exitCode = 2;
    return;
  }
  const file = files[0];
  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    const result = {
      schema: SCHEMA,
      verdict: 'INVALID_PLAN',
      exitCode: 1,
      problems: [{ code: 'INVALID_JSON', message: error.message }],
      reasonCodes: ['INVALID_JSON'],
      planDigest: null,
      waves: [],
      units: [],
    };
    console.log(json ? JSON.stringify(result, null, 2) : render(result));
    process.exitCode = 1;
    return;
  }
  const result = evaluatePlan(input);
  console.log(json ? JSON.stringify(result, null, 2) : render(result));
  process.exitCode = result.exitCode;
}

module.exports = { validatePlan, evaluatePlan, digestPlan, topologicalWaves, stable };
if (require.main === module) main(process.argv.slice(2));
