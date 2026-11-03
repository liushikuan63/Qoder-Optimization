'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redact, findSensitive, selectRecall } = require('./parallel-context.cjs');

const SCRIPT = path.join(__dirname, 'parallel-context.cjs');
const fakeToken = 'gh' + 'p_' + 'A'.repeat(36);
const fakeIp = ['10', '23', '45', '67'].join('.');
const fakePassword = ['pass', 'word'].join('') + '=' + ['S3cr3t', 'Value9x77'].join('');

function basePlan() {
  return {
    schema: 1,
    taskId: 'CTX-1',
    goal: 'context test',
    mode: 'auto',
    constraints: ['read-only pilot'],
    units: [
      { id: 'U1', kind: 'read', title: 'read a', readPaths: ['src/a'], acceptance: ['a'], evidence: ['file:line'] },
      { id: 'U2', kind: 'read', title: 'read b', readPaths: ['src/b'], acceptance: ['b'], evidence: ['file:line'] },
    ],
    resources: {
      sharedFiles: [], sharedServices: [], databaseWrites: false,
      production: false, destructive: false, credentials: false, externalSideEffects: false,
    },
    execution: { maxConcurrency: 2, isolation: 'none', workerTool: 'Explore' },
    budget: { maxWorkers: 4, maxRounds: 2 },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-context-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--json'], { encoding: 'utf8' });
  let output = null;
  try { output = result.stdout ? JSON.parse(result.stdout) : null; } catch {}
  return { status: result.status, output, stdout: result.stdout, stderr: result.stderr };
}

function initRun() {
  const dir = tempDir();
  const planFile = path.join(dir, 'input-plan.json');
  const runDir = path.join(dir, 'run');
  writeJson(planFile, basePlan());
  const result = run(['init', '--plan', planFile, '--out', runDir]);
  assert.equal(result.status, 0, result.stderr);
  return { dir, runDir, planFile, result };
}

test('init creates context, mirror and a clean check', () => {
  const { runDir, result } = initRun();
  assert.equal(result.output.ok, true);
  assert.equal(result.output.context.version, 1);
  assert.match(result.output.context.planDigest, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(runDir, 'plan.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'context.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'context.md')));
  const checked = run(['check', '--run', runDir]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.output.ok, true);
  assert.equal(checked.output.units, 2);
});

test('init records the user opt-in decision with source metadata', () => {
  const dir = tempDir();
  const planFile = path.join(dir, 'input-plan.json');
  const runDir = path.join(dir, 'run');
  writeJson(planFile, basePlan());
  const result = run(['init', '--plan', planFile, '--out', runDir, '--decision', '用户同意启用只读并行']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output.context.decisions.map(item => ({ id: item.id, text: item.text, source: item.source })), [
    { id: 'D1', text: '用户同意启用只读并行', source: 'user' },
  ]);
  const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
  assert.equal(context.decisions[0].source, 'user');
  assert.match(context.decisions[0].asOf, /^\d{4}-\d{2}-\d{2}T/);
});

test('init refuses to overwrite an existing context without force', () => {
  const { planFile, runDir } = initRun();
  const again = run(['init', '--plan', planFile, '--out', runDir]);
  assert.equal(again.status, 1);
  assert.equal(again.output.code, 'CONTEXT_EXISTS');
  const forced = run(['init', '--plan', planFile, '--out', runDir, '--force']);
  assert.equal(forced.status, 0);
});

test('pack selects path-relevant recall, redacts secrets and carries source metadata', () => {
  const { dir, runDir } = initRun();
  const recallFile = path.join(dir, 'recall.json');
  writeJson(recallFile, {
    refs: [
      { source: 'project', ref: 'M1', asOf: '2026-01-01', confidence: 'high', paths: ['src/a'], excerpt: 'src/a caveat ' + fakeToken },
      { source: 'project', ref: 'M2', asOf: '2026-01-01', confidence: 'low', paths: ['src/z'], excerpt: 'unrelated note '.repeat(30) },
      { source: 'continuity', ref: 'M3', asOf: '2026-01-02', confidence: 'medium', paths: [], excerpt: 'general note' },
    ],
  });
  const packFile = path.join(runDir, 'packs', 'U1.json');
  const result = run(['pack', '--context', path.join(runDir, 'context.json'), '--unit', 'U1', '--recall', recallFile, '--out', packFile, '--max-chars', '120']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.ok, true);
  const packData = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  assert.equal(packData.unitId, 'U1');
  assert.equal(packData.contextVersion, 1);
  assert.equal(packData.memoryRefs[0].ref, 'M1');
  assert.equal(packData.memoryRefs[0].redacted, true);
  assert.ok(!JSON.stringify(packData).includes(fakeToken));
  assert.ok(packData.memoryRefs[0].excerpt.includes('[REDACTED_TOKEN]'));
  assert.ok(packData.memoryRefs[0].asOf);
});

test('pack rejects unknown units and invalid recall', () => {
  const { dir, runDir } = initRun();
  const recallFile = path.join(dir, 'recall.json');
  writeJson(recallFile, { refs: [] });
  const missing = run(['pack', '--context', path.join(runDir, 'context.json'), '--unit', 'NOPE', '--recall', recallFile]);
  assert.equal(missing.status, 1);
  assert.equal(missing.output.code, 'UNKNOWN_UNIT');
  writeJson(recallFile, { refs: [{ source: 'project' }] });
  const invalid = run(['pack', '--context', path.join(runDir, 'context.json'), '--unit', 'U1', '--recall', recallFile]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.output.code, 'INVALID_RECALL');
});

test('merge appends deltas, bumps version and updates the mirror', () => {
  const { dir, runDir } = initRun();
  const deltaFile = path.join(dir, 'delta.json');
  writeJson(deltaFile, {
    unitId: 'U1',
    contextVersion: 1,
    status: 'done',
    findings: ['found a'],
    evidence: [{ ref: 'src/a.js:12', summary: 'line evidence' }],
    recallRequests: [{ query: 'past decision on src/a', reason: 'need context' }],
  });
  const merged = run(['merge', '--context', path.join(runDir, 'context.json'), '--delta', deltaFile]);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(merged.output.context.version, 2);
  const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
  assert.equal(context.units.find(unit => unit.id === 'U1').status, 'done');
  assert.equal(context.findings[0].text, 'found a');
  assert.equal(context.evidence[0].ref, 'src/a.js:12');
  assert.equal(context.recallRequests[0].status, 'open');
  assert.match(fs.readFileSync(path.join(runDir, 'context.md'), 'utf8'), /version: 2/);
  const checked = run(['check', '--run', runDir]);
  assert.equal(checked.status, 0, checked.stdout);
});

test('merge rejects stale versions and canonical writes', () => {
  const { dir, runDir } = initRun();
  const stale = path.join(dir, 'stale.json');
  writeJson(stale, { unitId: 'U1', contextVersion: 0, findings: ['stale'] });
  const staleResult = run(['merge', '--context', path.join(runDir, 'context.json'), '--delta', stale]);
  assert.equal(staleResult.status, 1);
  assert.equal(staleResult.output.code, 'STALE_CONTEXT');
  const canonical = path.join(dir, 'canonical.json');
  writeJson(canonical, { unitId: 'U1', contextVersion: 1, goal: 'overwrite' });
  const canonicalResult = run(['merge', '--context', path.join(runDir, 'context.json'), '--delta', canonical]);
  assert.equal(canonicalResult.status, 1);
  assert.equal(canonicalResult.output.code, 'INVALID_DELTA');
  const verified = path.join(dir, 'verified.json');
  writeJson(verified, { unitId: 'U1', contextVersion: 1, status: 'verified' });
  const verifiedResult = run(['merge', '--context', path.join(runDir, 'context.json'), '--delta', verified]);
  assert.equal(verifiedResult.status, 1);
  assert.equal(verifiedResult.output.code, 'INVALID_STATUS');
  const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
  assert.equal(context.version, 1);
});

test('check reports stale and sensitive packs without modifying them', () => {
  const { dir, runDir } = initRun();
  const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
  fs.mkdirSync(path.join(runDir, 'packs'), { recursive: true });
  writeJson(path.join(runDir, 'packs', 'stale.json'), { contextVersion: 0, planDigest: context.planDigest });
  const stale = run(['check', '--run', runDir]);
  assert.equal(stale.status, 1);
  assert.ok(stale.output.issues.some(issue => issue.startsWith('STALE_PACK:')));
  fs.rmSync(path.join(runDir, 'packs', 'stale.json'));
  writeJson(path.join(runDir, 'packs', 'leak.json'), { contextVersion: context.version, planDigest: context.planDigest, note: fakeToken });
  const leak = run(['check', '--run', runDir]);
  assert.equal(leak.status, 1);
  assert.ok(leak.output.issues.some(issue => issue.startsWith('SENSITIVE_CONTENT:')));
  assert.ok(fs.existsSync(path.join(dir, 'run', 'packs', 'leak.json')));
});

test('check reports missing context files', () => {
  const dir = tempDir();
  const result = run(['check', '--run', dir]);
  assert.equal(result.status, 1);
  assert.ok(result.output.issues.includes('PLAN_MISSING'));
  assert.ok(result.output.issues.includes('CONTEXT_MISSING'));
});

test('redaction covers tokens, IPs and URL queries but leaves public URLs', () => {
  const dirty = ['token ' + fakeToken, 'host ' + fakeIp, 'https://example.com/x?token=' + fakeToken, fakePassword].join(' ');
  const clean = redact(dirty);
  assert.ok(!clean.includes(fakeToken));
  assert.ok(!clean.includes(fakeIp));
  assert.ok(clean.includes('[REDACTED_TOKEN]'));
  assert.ok(clean.includes('[REDACTED_IP]'));
  assert.ok(clean.includes('[REDACTED_QUERY]'));
  assert.ok(clean.includes('[REDACTED]'));
  const hits = findSensitive(dirty);
  assert.ok(hits.includes('TOKEN'));
  assert.ok(hits.includes('INTERNAL_IP'));
  assert.ok(hits.includes('URL'));
  assert.equal(redact('https://example.com/docs'), 'https://example.com/docs');
  assert.deepEqual(findSensitive('https://example.com/docs'), []);
});

test('selectRecall prioritizes path matches and enforces the character cap', () => {
  const unit = { id: 'U1', readPaths: ['src/a'], ownedPaths: [] };
  const refs = [
    { source: 'project', ref: 'unrelated', excerpt: 'x'.repeat(200), paths: ['src/z'], confidence: 'low' },
    { source: 'project', ref: 'relevant', excerpt: 'src/a note', paths: ['src/a'], confidence: 'high' },
  ];
  const selected = selectRecall(unit, refs, 40);
  assert.equal(selected.refs[0].ref, 'relevant');
  assert.equal(selected.omitted, 1);
  assert.ok(selected.chars <= 40);
});
