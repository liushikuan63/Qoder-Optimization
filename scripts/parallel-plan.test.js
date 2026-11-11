'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluatePlan, validatePlan, digestPlan } = require('./parallel-plan.cjs');

const SCRIPT = path.join(__dirname, 'parallel-plan.cjs');

function base(overrides = {}) {
  return {
    schema: 1,
    taskId: 'TASK-1',
    goal: 'test task',
    mode: 'auto',
    units: [
      { id: 'U1', kind: 'read', title: 'read a', readPaths: ['src/a'], acceptance: ['a is read'], evidence: ['file:line'] },
      { id: 'U2', kind: 'read', title: 'read b', readPaths: ['src/b'], acceptance: ['b is read'], evidence: ['file:line'] },
    ],
    resources: {
      sharedFiles: [],
      sharedServices: [],
      databaseWrites: false,
      production: false,
      destructive: false,
      credentials: false,
      externalSideEffects: false,
    },
    execution: { maxConcurrency: 2, isolation: 'none', workerTool: 'Explore' },
    budget: { maxWorkers: 4, maxRounds: 2 },
    ...overrides,
  };
}

function writePlan(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-plan-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return { dir, file };
}

function runCli(plan) {
  const { dir, file } = writePlan(plan);
  try {
    const result = spawnSync(process.execPath, [SCRIPT, file, '--json', '--preview'], { encoding: 'utf8' });
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    return { status: result.status, output, stderr: result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('independent read units are parallelizable', () => {
  const result = evaluatePlan(base());
  assert.equal(result.verdict, 'PARALLEL_READ');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.waves, [['U1', 'U2']]);
  assert.match(result.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.requiresPlanApproval, true);
  assert.equal(result.requiresUserOptIn, true);
  assert.equal(result.optInKind, 'read-only');
});

test('disjoint write units with worktree are parallelizable', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/b.js'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  }));
  assert.equal(result.verdict, 'PARALLEL_WORKTREE');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.waves, [['U1', 'U2']]);
  assert.equal(result.requiresPlanApproval, true);
  assert.equal(result.requiresUserOptIn, true);
  assert.equal(result.optInKind, 'worktree-write');
});

test('same-file write is rejected', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/a.js'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.equal(result.exitCode, 1);
  assert.ok(result.reasonCodes.includes('OVERLAPPING_OWNED_PATHS'));
});

test('write units require worktree isolation', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/b.js'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'none', workerTool: 'general-purpose' },
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('WORKTREE_REQUIRED'));
});

test('write units require ownedPaths', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', acceptance: ['a'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 1, isolation: 'none', workerTool: 'general-purpose' },
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('MISSING_OWNED_PATHS'));
});

test('read units cannot own write paths', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'read', title: 'read a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['file:line'] },
    ],
    execution: { maxConcurrency: 1, isolation: 'none', workerTool: 'Explore' },
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('READ_OWNED_PATHS'));
});

test('dependency cycles are rejected', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'read', title: 'a', dependsOn: ['U2'], readPaths: ['src/a'], acceptance: ['a'], evidence: ['file:line'] },
      { id: 'U2', kind: 'read', title: 'b', dependsOn: ['U1'], readPaths: ['src/b'], acceptance: ['b'], evidence: ['file:line'] },
    ],
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('DEPENDENCY_CYCLE'));
});

test('sequential dependency chain requires sequential execution', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'read', title: 'a', readPaths: ['src/a'], acceptance: ['a'], evidence: ['file:line'] },
      { id: 'U2', kind: 'read', title: 'b', dependsOn: ['U1'], readPaths: ['src/b'], acceptance: ['b'], evidence: ['file:line'] },
    ],
  }));
  assert.equal(result.verdict, 'SEQUENTIAL_REQUIRED');
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.waves, [['U1'], ['U2']]);
  assert.equal(result.requiresPlanApproval, false);
  assert.equal(result.requiresUserOptIn, false);
  assert.equal(result.optInKind, null);
});

test('production, database, credentials and shared services are hard gates', () => {
  for (const [key, reason] of [
    ['production', 'PRODUCTION'],
    ['databaseWrites', 'DATABASE_WRITES'],
    ['destructive', 'DESTRUCTIVE'],
    ['credentials', 'CREDENTIALS'],
    ['externalSideEffects', 'EXTERNAL_SIDE_EFFECTS'],
  ]) {
    const result = evaluatePlan(base({ resources: { ...base().resources, [key]: true } }));
    assert.equal(result.verdict, 'BLOCKED_HUMAN', key);
    assert.equal(result.exitCode, 2);
    assert.ok(result.reasonCodes.includes(reason), key);
    assert.equal(result.requiresPlanApproval, false, key);
    assert.equal(result.requiresUserOptIn, false, key);
    assert.equal(result.optInKind, null, key);
  }
  const services = evaluatePlan(base({ resources: { ...base().resources, sharedServices: ['payments'] } }));
  assert.equal(services.verdict, 'BLOCKED_HUMAN');
  assert.ok(services.reasonCodes.includes('SHARED_SERVICES'));
});

test('shared files block write parallelism but not read-only parallelism', () => {
  const read = evaluatePlan(base({ resources: { ...base().resources, sharedFiles: ['config/shared.json'] } }));
  assert.equal(read.verdict, 'PARALLEL_READ');
  const write = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 1, isolation: 'none', workerTool: 'general-purpose' },
    resources: { ...base().resources, sharedFiles: ['config/shared.json'] },
  }));
  assert.equal(write.verdict, 'BLOCKED_HUMAN');
  assert.ok(write.reasonCodes.includes('SHARED_FILES_WITH_WRITE'));
});

test('concurrency and budget bounds are enforced', () => {
  const tooHigh = evaluatePlan(base({ execution: { maxConcurrency: 5, isolation: 'none', workerTool: 'Explore' } }));
  assert.equal(tooHigh.verdict, 'INVALID_PLAN');
  assert.ok(tooHigh.reasonCodes.includes('INVALID_CONCURRENCY'));
  const exceedsUnits = evaluatePlan(base({ execution: { maxConcurrency: 3, isolation: 'none', workerTool: 'Explore' } }));
  assert.equal(exceedsUnits.verdict, 'INVALID_PLAN');
  assert.ok(exceedsUnits.reasonCodes.includes('CONCURRENCY_EXCEEDS_UNITS'));
  const exceedsBudget = evaluatePlan(base({ budget: { maxWorkers: 1, maxRounds: 2 } }));
  assert.equal(exceedsBudget.verdict, 'INVALID_PLAN');
  assert.ok(exceedsBudget.reasonCodes.includes('CONCURRENCY_EXCEEDS_BUDGET'));
});

test('mode and worker tool combinations are validated', () => {
  const readWithWrite = evaluatePlan(base({
    mode: 'read',
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 1, isolation: 'none', workerTool: 'general-purpose' },
  }));
  assert.equal(readWithWrite.verdict, 'INVALID_PLAN');
  assert.ok(readWithWrite.reasonCodes.includes('MODE_KIND_MISMATCH'));
  const badTool = evaluatePlan(base({ execution: { maxConcurrency: 2, isolation: 'none', workerTool: 'custom' } }));
  assert.equal(badTool.verdict, 'INVALID_PLAN');
  assert.ok(badTool.reasonCodes.includes('INVALID_WORKER_TOOL'));
});

test('path normalization catches case and separator overlap', () => {
  const result = evaluatePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src\\a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['SRC/A.JS'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  }));
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('OVERLAPPING_OWNED_PATHS'));
});

test('normalization preserves literal path case while overlap checks remain case insensitive', () => {
  const input = base();
  input.units[0].readPaths = ['src/MyComponent.ts'];
  assert.deepEqual(validatePlan(input).units[0].readPaths, ['src/MyComponent.ts']);
});

test('plan digest is stable across key order and rejects mutation', () => {
  const first = validatePlan(base());
  const second = validatePlan(base());
  assert.equal(digestPlan(first), digestPlan(second));
  second.goal = 'changed';
  assert.notEqual(digestPlan(first), digestPlan(second));
});

test('CLI returns documented exit codes and JSON', () => {
  const ok = runCli(base());
  assert.equal(ok.status, 0);
  assert.equal(ok.output.verdict, 'PARALLEL_READ');
  const invalid = runCli(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/a.js'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  }));
  assert.equal(invalid.status, 1);
  assert.equal(invalid.output.verdict, 'INVALID_PLAN');
  const blocked = runCli(base({ resources: { ...base().resources, production: true } }));
  assert.equal(blocked.status, 2);
  assert.equal(blocked.output.verdict, 'BLOCKED_HUMAN');
});

test('approval-required plans need a plan document unless preview is explicit', () => {
  const { dir, file } = writePlan(base());
  try {
    const missing = spawnSync(process.execPath, [SCRIPT, file, '--json'], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    const output = JSON.parse(missing.stdout);
    assert.equal(output.code, 'PLAN_DOC_REQUIRED');
    assert.equal(output.verdict, 'PARALLEL_READ');
    const preview = spawnSync(process.execPath, [SCRIPT, file, '--json', '--preview'], { encoding: 'utf8' });
    assert.equal(preview.status, 0);
    assert.equal(JSON.parse(preview.stdout).verdict, 'PARALLEL_READ');
    assert.equal(JSON.parse(preview.stdout).planDoc, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI writes a reviewable plan document before approval', () => {
  const { dir, file } = writePlan(base());
  const doc = path.join(dir, '.qoder/parallel-plans/TASK-1.md');
  try {
    const result = spawnSync(process.execPath, [SCRIPT, file, '--json', '--markdown', doc], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.planDoc, doc);
    const text = fs.readFileSync(doc, 'utf8');
    assert.match(text, /PENDING_USER_APPROVAL/);
    assert.match(text, /U1/);
    assert.match(text, /src\/a/);
    assert.match(text, /Vibecoding 文档映射/);
    assert.match(text, /用户已确认方案/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid plans never produce an approval document', () => {
  const { dir, file } = writePlan(base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/a.js'], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  }));
  const doc = path.join(dir, 'PLAN.md');
  try {
    const result = spawnSync(process.execPath, [SCRIPT, file, '--json', '--markdown', doc], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(doc), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── T-14（C5）：确认前只读摘要 / 确认后正式文档 / 未答复降级显式落账 ──
const DOWNGRADE_REASONS = ['NO_ANSWER', 'CANCELLED', 'USER_CHOSE_SERIAL', 'PLAN_REJECTED'];
function downgradeCli(file, args) {
  return spawnSync(process.execPath, [SCRIPT, file, '--json', ...args], { encoding: 'utf8', timeout: 15000 });
}
function readLedger(state) {
  const file = path.join(state, 'downgrades.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('T-14 preview is a read-only pre-confirmation draft and writes nothing', () => {
  const { dir, file } = writePlan(base());
  try {
    const before = fs.readdirSync(dir).sort();
    const run = spawnSync(process.execPath, [SCRIPT, file, '--json', '--preview'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.stage, 'PRE_CONFIRMATION_DRAFT');
    assert.equal(out.planDoc, undefined);
    assert.equal(out.requiresPlanApproval, true);
    assert.match(out.previewNotice, /不得据此派发/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 the formal document is a distinct post-confirmation stage', () => {
  const { dir, file } = writePlan(base());
  const doc = path.join(dir, '.qoder/parallel-plans/TASK-1.md');
  try {
    const run = spawnSync(process.execPath, [SCRIPT, file, '--json', '--markdown', doc], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.stage, 'FORMAL_PLAN_DOC');
    assert.equal(out.planDoc, doc);
    assert.equal(out.requiresPlanApproval, true);
    assert.equal(out.previewNotice, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 an unanswered plan records one downgrade entry with a coverage gap list', () => {
  const { dir, file } = writePlan(base());
  const state = path.join(dir, 'state');
  try {
    const run = downgradeCli(file, ['--record-downgrade', 'NO_ANSWER', '--state-dir', state]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.downgrade.reason, 'NO_ANSWER');
    assert.equal(out.downgrade.dispatched, false);
    assert.equal(out.downgrade.fallback, 'serial');
    assert.equal(out.downgrade.taskId, 'TASK-1');
    assert.equal(out.downgrade.planDigest, digestPlan(validatePlan(base())));
    const records = readLedger(state);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].coverageGaps.map(gap => gap.unitId), ['U1', 'U2']);
    assert.deepEqual(records[0].coverageGaps.map(gap => gap.readPaths), [['src/a'], ['src/b']]);
    for (const gap of records[0].coverageGaps) {
      assert.equal(gap.status, 'not-dispatched');
      assert.ok(gap.acceptance.length > 0 && gap.evidence.length > 0);
    }
    // 只写台账：不建运行目录、不建 worktree、不派发。
    assert.deepEqual(fs.readdirSync(state), ['downgrades.jsonl']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['plan.json', 'state']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 the downgrade ledger is append-only across reasons', () => {
  const { dir, file } = writePlan(base());
  const state = path.join(dir, 'state');
  try {
    for (const reason of ['NO_ANSWER', 'USER_CHOSE_SERIAL']) {
      assert.equal(downgradeCli(file, ['--record-downgrade', reason, '--state-dir', state]).status, 0);
    }
    const records = readLedger(state);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(record => record.reason), ['NO_ANSWER', 'USER_CHOSE_SERIAL']);
    assert.ok(records.every(record => record.coverageGaps.length === 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 a write plan keeps its opt-in and worktree requirements in the downgrade record', () => {
  const plan = base({
    units: [
      { id: 'U1', kind: 'write', title: 'write a', ownedPaths: ['src/a.js'], readPaths: [], acceptance: ['a'], evidence: ['diff'] },
      { id: 'U2', kind: 'write', title: 'write b', ownedPaths: ['src/b.js'], readPaths: [], acceptance: ['b'], evidence: ['diff'] },
    ],
    execution: { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' },
  });
  const { dir, file } = writePlan(plan);
  const state = path.join(dir, 'state');
  try {
    const run = downgradeCli(file, ['--record-downgrade', 'NO_ANSWER', '--state-dir', state]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const record = readLedger(state)[0];
    assert.equal(record.optInKind, 'worktree-write');
    assert.equal(record.requiresUserOptIn, true);
    assert.equal(record.isolation, 'worktree');
    assert.equal(record.dispatched, false);
    assert.deepEqual(record.coverageGaps.map(gap => gap.ownedPaths), [['src/a.js'], ['src/b.js']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 an unknown downgrade reason is rejected without writing a ledger', () => {
  const { dir, file } = writePlan(base());
  const state = path.join(dir, 'state');
  try {
    const run = downgradeCli(file, ['--record-downgrade', 'MAYBE_LATER', '--state-dir', state]);
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).code, 'INVALID_DOWNGRADE_REASON');
    assert.equal(fs.existsSync(state), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 an invalid plan cannot be downgraded into a silent pass', () => {
  const plan = base();
  plan.units[1].ownedPaths = ['src/a.js'];
  plan.units[0].ownedPaths = ['src/a.js'];
  plan.units.forEach(unit => { unit.kind = 'write'; });
  plan.execution = { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' };
  const { dir, file } = writePlan(plan);
  const state = path.join(dir, 'state');
  try {
    const run = downgradeCli(file, ['--record-downgrade', 'NO_ANSWER', '--state-dir', state]);
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).verdict, 'INVALID_PLAN');
    assert.equal(fs.existsSync(state), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 every documented downgrade reason is accepted', () => {
  const { dir, file } = writePlan(base());
  const state = path.join(dir, 'state');
  try {
    for (const reason of DOWNGRADE_REASONS) {
      assert.equal(downgradeCli(file, ['--record-downgrade', reason, '--state-dir', state]).status, 0, reason);
    }
    assert.deepEqual(readLedger(state).map(record => record.reason), DOWNGRADE_REASONS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-14 mutation: dropping the coverage gap list is killed', () => {
  const { dir, file } = writePlan(base());
  const state = path.join(dir, 'state');
  const mutant = path.join(dir, 'mutant.cjs');
  try {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const anchor = 'coverageGaps: coverageGaps(plan),';
    assert.equal(source.split(anchor).length - 1, 1);
    fs.writeFileSync(mutant, source.replace(anchor, 'coverageGaps: [],'));
    const real = downgradeCli(file, ['--record-downgrade', 'NO_ANSWER', '--state-dir', state]);
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.equal(readLedger(state)[0].coverageGaps.length, 2);
    const bad = spawnSync(process.execPath, [mutant, file, '--json', '--record-downgrade', 'NO_ANSWER', '--state-dir', path.join(dir, 'mutant-state')], { encoding: 'utf8' });
    assert.equal(bad.status, 0, bad.stdout + bad.stderr);
    assert.equal(readLedger(path.join(dir, 'mutant-state'))[0].coverageGaps.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
