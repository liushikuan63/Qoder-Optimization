'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { evaluatePlan } = require('../scripts/parallel-plan.cjs');
const { redact, findSensitive } = require('../scripts/parallel-context.cjs');

const planScript = path.resolve(__dirname, '../scripts/parallel-plan.cjs');
const contextScript = path.resolve(__dirname, '../scripts/parallel-context.cjs');
function plan() {
  return {
    schema: 1, taskId: 'REVIEW', goal: 'Review isolated units', mode: 'auto', constraints: [],
    units: [
      { id: 'U1', kind: 'read', title: 'one', readPaths: ['src/a'], acceptance: ['read'], evidence: ['file:line'] },
      { id: 'U2', kind: 'read', title: 'two', readPaths: ['src/b'], acceptance: ['read'], evidence: ['file:line'] },
    ],
    resources: { sharedFiles: [], sharedServices: [], databaseWrites: false, production: false, destructive: false, credentials: false, externalSideEffects: false },
    execution: { maxConcurrency: 2, isolation: 'none', workerTool: 'Explore' },
    budget: { maxWorkers: 4, maxRounds: 2 },
  };
}
function writePlan(paths) {
  const p = plan();
  p.units.forEach((unit, i) => Object.assign(unit, { kind: 'write', ownedPaths: [paths[i]], readPaths: [] }));
  p.execution = { maxConcurrency: 2, isolation: 'worktree', workerTool: 'general-purpose' };
  return p;
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-parallel-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data)); }
function cli(script, args) {
  const result = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8', timeout: 15000 });
  let json;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}
function initContext(t) {
  const dir = fixture(t); const file = path.join(dir, 'input.json'); const runDir = path.join(dir, 'run');
  writeJson(file, plan());
  const run = cli(contextScript, ['init', '--plan', file, '--out', runDir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return { dir, file, runDir, contextFile: path.join(runDir, 'context.json'), context: run.json.context };
}

test('parallel plan rejects absolute paths before relative-prefix normalization', () => {
  for (const item of ['/etc/config', '\\Windows\\config', 'C:/config', '//server/config', 'src/a:stream', 'src/a.', 'src/a /b', 'src/\u0000a']) {
    const p = plan(); p.units[0].readPaths = [item];
    const result = evaluatePlan(p);
    assert.equal(result.verdict, 'INVALID_PLAN', item);
    assert.ok(result.reasonCodes.includes('INVALID_PATH'), item);
  }
  const relative = plan(); relative.units[0].readPaths = ['./src/a'];
  assert.equal(evaluatePlan(relative).verdict, 'PARALLEL_READ');
});

test('parallel write ownership rejects directory and child intersections', () => {
  for (const paths of [['src', 'src/a.js'], ['src/a.js', 'SRC'], ['lib\\nested', 'lib/nested/a']]) {
    const result = evaluatePlan(writePlan(paths));
    assert.equal(result.verdict, 'INVALID_PLAN', paths.join(' / '));
    assert.ok(result.reasonCodes.includes('OVERLAPPING_OWNED_PATHS'));
  }
  assert.equal(evaluatePlan(writePlan(['src/a', 'src/ab'])).verdict, 'PARALLEL_WORKTREE');
});

test('mixed read/write parallelism requires worktree and a write-capable tool', () => {
  const p = plan(); Object.assign(p.units[0], { kind: 'write', ownedPaths: ['src/a'], readPaths: [] });
  assert.ok(evaluatePlan(p).reasonCodes.includes('WORKTREE_REQUIRED'));
  p.execution.isolation = 'worktree';
  assert.ok(evaluatePlan(p).reasonCodes.includes('WORKER_KIND_MISMATCH'));
  p.execution.workerTool = 'general-purpose';
  assert.equal(evaluatePlan(p).verdict, 'PARALLEL_WORKTREE');
});

test('duplicate dependency is a structured invalid plan in API and CLI', t => {
  const p = plan(); p.units[1].dependsOn = ['U1', 'U1'];
  const result = evaluatePlan(p);
  assert.equal(result.verdict, 'INVALID_PLAN');
  assert.ok(result.reasonCodes.includes('DUPLICATE_DEPENDENCY'));
  const dir = fixture(t); const file = path.join(dir, 'plan.json'); writeJson(file, p);
  const run = cli(planScript, [file]);
  assert.equal(run.status, 1); assert.equal(run.json.verdict, 'INVALID_PLAN');
  assert.equal(run.stderr, '');
});

test('parallel plan CLI rejects unknown options and extra input files', t => {
  const dir = fixture(t); const file = path.join(dir, 'plan.json'); writeJson(file, plan());
  for (const args of [[file, '--force'], [file, 'other.json']]) {
    const result = cli(planScript, args);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.json.code, 'USAGE');
  }
});

test('parallel context rejects unknown CLI options before creating a run', t => {
  const dir = fixture(t); const file = path.join(dir, 'plan.json'); const run = path.join(dir, 'run');
  writeJson(file, plan());
  const result = cli(contextScript, ['init', '--plan', file, '--out', run, '--approve', 'yes']);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.json.code, 'USAGE');
  assert.equal(fs.existsSync(run), false);
});

test('worker delta must match the current plan digest before any context write', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  for (const planDigest of [undefined, 'a'.repeat(64)]) {
    writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest, findings: ['old plan result'] });
    const before = fs.readFileSync(f.contextFile);
    const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'STALE_PLAN');
    assert.deepEqual(fs.readFileSync(f.contextFile), before);
  }
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['current result'] });
  const accepted = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(accepted.status, 0, accepted.stdout);
  assert.equal(accepted.json.context.version, 2);
});

test('check and pack reject changed ownership that still carries the old digest', t => {
  const f = initContext(t);
  f.context.units[0].readPaths = ['outside-plan'];
  writeJson(f.contextFile, f.context);
  const checked = cli(contextScript, ['check', '--run', f.runDir]);
  assert.equal(checked.status, 1, checked.stdout);
  assert.ok(checked.json.issues.some(issue => issue.includes('CONTEXT_PLAN_MISMATCH')));
  const packFile = path.join(f.dir, 'pack.json');
  const packed = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', packFile]);
  assert.equal(packed.status, 1, packed.stdout);
  assert.equal(fs.existsSync(packFile), false);
});

test('check rejects a mirror or pack with changed unit scope at the same version', t => {
  const f = initContext(t);
  const packFile = path.join(f.runDir, 'packs', 'U1.json');
  const packed = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', packFile]);
  assert.equal(packed.status, 0, packed.stdout);
  const pack = JSON.parse(fs.readFileSync(packFile)); pack.unit.readPaths = ['outside-plan'];
  writeJson(packFile, pack);
  const checked = cli(contextScript, ['check', '--run', f.runDir]);
  assert.equal(checked.status, 1, checked.stdout);
  assert.ok(checked.json.issues.some(issue => issue.includes('PACK_CONTEXT_MISMATCH')));
  fs.rmSync(packFile);
  fs.appendFileSync(path.join(f.runDir, 'context.md'), '\nwrong instructions\n');
  const mirror = cli(contextScript, ['check', '--run', f.runDir]);
  assert.equal(mirror.status, 1, mirror.stdout);
  assert.ok(mirror.json.issues.includes('CONTEXT_MIRROR_MISMATCH'));
});

test('malformed recall input does not silently generate an empty successful pack', t => {
  const f = initContext(t); const recall = path.join(f.dir, 'recall.json');
  for (const data of [null, {}, { refs: 'bad' }]) {
    writeJson(recall, data);
    const result = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--recall', recall]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'INVALID_RECALL');
  }
});

test('merge rejects sensitive delta text without saving or printing it', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  const fakeToken = 'gh' + 'p_' + 'B'.repeat(36);
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['token ' + fakeToken] });
  const before = fs.readFileSync(f.contextFile);
  const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.json.code, 'SENSITIVE_OUTPUT');
  assert.ok(!result.stdout.includes(fakeToken));
  assert.deepEqual(fs.readFileSync(f.contextFile), before);
});

test('parallel context refuses blocked or sequential plans without creating a run', t => {
  const dir = fixture(t); const file = path.join(dir, 'plan.json');
  const blocked = plan(); blocked.resources.production = true;
  const sequential = plan(); sequential.execution.maxConcurrency = 1;
  for (const [name, data] of [['blocked', blocked], ['sequential', sequential]]) {
    writeJson(file, data); const run = path.join(dir, name);
    const result = cli(contextScript, ['init', '--plan', file, '--out', run]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'PLAN_NOT_PARALLEL');
    assert.equal(fs.existsSync(run), false);
  }
});

test('credential redaction and merge validation include quoted JSON keys', t => {
  const secret = ['example', 'private', 'value'].join('-');
  const excerpt = JSON.stringify({ password: secret });
  assert.ok(!redact(excerpt).includes(secret));
  assert.ok(findSensitive(excerpt).includes('CREDENTIAL'));
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: [excerpt] });
  const before = fs.readFileSync(f.contextFile);
  const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.json.code, 'SENSITIVE_OUTPUT');
  assert.ok(!result.stdout.includes(secret));
  assert.deepEqual(fs.readFileSync(f.contextFile), before);
});

test('redacted JSON recall can be packed and check detects raw-string credentials', t => {
  const f = initContext(t); const recall = path.join(f.dir, 'recall.json');
  const secret = ['test', 'sensitive', 'value'].join('-');
  const excerpt = JSON.stringify({ password: secret });
  writeJson(recall, { refs: [{ source: 'project', ref: 'M1', excerpt }] });
  const packed = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--recall', recall]);
  assert.equal(packed.status, 0, packed.stdout);
  assert.ok(!packed.stdout.includes(secret));
  assert.ok(packed.json.pack.memoryRefs[0].excerpt.includes('[REDACTED]'));
  f.context.findings.push({ unitId: 'U1', text: excerpt }); writeJson(f.contextFile, f.context);
  const checked = cli(contextScript, ['check', '--run', f.runDir]);
  assert.equal(checked.status, 1, checked.stdout);
  assert.ok(checked.json.issues.some(issue => issue.startsWith('SENSITIVE_CONTENT:context.json:')));
});

test('pack rejects quoted credentials in unredacted recall metadata and decisions', t => {
  const f = initContext(t); const recall = path.join(f.dir, 'recall.json'); const out = path.join(f.dir, 'pack.json');
  const secret = ['metadata', 'private', 'value'].join('-'); const dirty = JSON.stringify({ password: secret });
  for (const key of ['source', 'ref']) {
    writeJson(recall, { refs: [{ source: 'project', ref: 'M1', excerpt: 'safe excerpt', [key]: dirty }] });
    const result = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--recall', recall, '--out', out]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'SENSITIVE_OUTPUT');
    assert.ok(!result.stdout.includes(secret)); assert.equal(fs.existsSync(out), false);
  }
  f.context.decisions.push({ id: 'D1', source: 'user', asOf: 'unknown', text: dirty }); writeJson(f.contextFile, f.context);
  const result = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', out]);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.json.code, 'SENSITIVE_OUTPUT');
  assert.ok(!result.stdout.includes(secret)); assert.equal(fs.existsSync(out), false);
});

test('forced reinitialization advances the version and rejects a previous-run delta', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['old run'] });
  const forced = cli(contextScript, ['init', '--plan', f.file, '--out', f.runDir, '--force']);
  assert.equal(forced.status, 0, forced.stdout);
  assert.equal(forced.json.context.version, 2);
  const before = fs.readFileSync(f.contextFile);
  const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.json.code, 'STALE_CONTEXT');
  assert.deepEqual(fs.readFileSync(f.contextFile), before);
});

test('merge refuses a detached output path before publishing a context or mirror', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid finding'] });
  for (const out of [path.join(f.dir, 'detached', 'context.json'), path.join(f.runDir, 'other.json')]) {
    const before = fs.readFileSync(f.contextFile);
    const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta, '--out', out]);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.json.code, 'USAGE');
    assert.equal(fs.existsSync(out), false); assert.deepEqual(fs.readFileSync(f.contextFile), before);
  }
});

test('same-wave readers cannot observe another worker write scope without dependencies', () => {
  const p = writePlan(['src/a', 'src/b']);
  p.units[1].readPaths = ['SRC/A/input.js'];
  assert.ok(evaluatePlan(p).reasonCodes.includes('READ_WRITE_CONFLICT'));
  p.units[1].dependsOn = ['U1'];
  assert.equal(evaluatePlan(p).verdict, 'SEQUENTIAL_REQUIRED');
  delete p.units[1].dependsOn; p.units[0].dependsOn = ['U2'];
  assert.equal(evaluatePlan(p).verdict, 'SEQUENTIAL_REQUIRED');
  const q = writePlan(['src/a', 'src/b']); q.units[1].readPaths = ['src/ab'];
  assert.equal(evaluatePlan(q).verdict, 'PARALLEL_WORKTREE');
});

test('batch merge accepts same-base independent results and advances the context once', t => {
  const f = initContext(t); const a = path.join(f.dir, 'a.json'), b = path.join(f.dir, 'b.json');
  for (const [unitId, file] of [['U1', a], ['U2', b]]) writeJson(file, { unitId, contextVersion: 1, planDigest: f.context.planDigest, status: 'done', findings: [unitId + ' finding'] });
  const result = cli(contextScript, ['merge-batch', '--context', f.contextFile, '--delta', a, '--delta', b]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.context.version, 2);
  assert.deepEqual(result.json.context.findings.map(item => item.unitId), ['U1', 'U2']);
  assert.ok(result.json.context.units.every(unit => unit.status === 'done'));
  assert.equal(cli(contextScript, ['check', '--run', f.runDir]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(a)).contextVersion, 1);
});

test('batch validation is all-or-nothing for duplicate, stale, malformed and sensitive results', t => {
  const f = initContext(t); const a = path.join(f.dir, 'a.json'), b = path.join(f.dir, 'b.json');
  const base = { contextVersion: 1, planDigest: f.context.planDigest, status: 'done' };
  writeJson(a, { ...base, unitId: 'U1', findings: ['valid first result'] });
  const before = [f.contextFile, path.join(f.runDir, 'context.md')].map(file => fs.readFileSync(file));
  for (const invalid of [
    { ...base, unitId: 'U1' },
    { ...base, unitId: 'U2', contextVersion: 0 },
    { ...base, unitId: 'U2', evidence: [{ ref: 'missing summary' }] },
    { ...base, unitId: 'U2', findings: ['gh' + 'p_' + 'C'.repeat(36)] },
  ]) {
    writeJson(b, invalid); const inputBefore = fs.readFileSync(b);
    const result = cli(contextScript, ['merge-batch', '--context', f.contextFile, '--delta', a, '--delta', b]);
    assert.equal(result.status, 1, result.stdout);
    for (const [i, file] of [f.contextFile, path.join(f.runDir, 'context.md')].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
    assert.deepEqual(fs.readFileSync(b), inputBefore);
    assert.equal(fs.existsSync(path.join(f.runDir, '.context-write.lock')), false);
  }
});

test('context writer respects an existing lock and preserves the lock and input', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid'] });
  const lock = path.join(f.runDir, '.context-write.lock'); fs.writeFileSync(lock, 'another writer');
  const before = fs.readFileSync(f.contextFile), input = fs.readFileSync(delta);
  const result = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(result.status, 1, result.stdout); assert.equal(result.json.code, 'CONTEXT_BUSY');
  assert.deepEqual(fs.readFileSync(f.contextFile), before); assert.deepEqual(fs.readFileSync(delta), input);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer');
});

test('publication failure restores the previous canonical and mirror', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid'] });
  const before = [f.contextFile, path.join(f.runDir, 'context.md')].map(file => fs.readFileSync(file));
  const code = `const fs=require('node:fs'),path=require('node:path');
    const original=fs.renameSync;let injected=false;
    fs.renameSync=function(a,b){if(!injected&&path.resolve(b)===path.resolve(process.argv[4])){injected=true;throw Object.assign(new Error('injected publication failure'),{code:'EIO'});}return original.apply(this,arguments);};
    try{require(process.argv[1]).merge({context:process.argv[2],delta:process.argv[3]});process.exitCode=7;}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;}`;
  for (const failedFile of [f.contextFile, path.join(f.runDir, 'context.md')]) {
    const result = spawnSync(process.execPath, ['-e', code, contextScript, f.contextFile, delta, failedFile], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    for (const [i, file] of [f.contextFile, path.join(f.runDir, 'context.md')].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
    assert.equal(fs.existsSync(delta), true); assert.equal(fs.existsSync(path.join(f.runDir, '.context-write.lock')), false);
  }
});

test('force init publication failure restores the previous plan, canonical and mirror', t => {
  const f = initContext(t); const changed = plan(); changed.goal = 'Changed approved plan'; writeJson(f.file, changed);
  const files = ['plan.json', 'context.json', 'context.md'].map(name => path.join(f.runDir, name));
  const before = files.map(file => fs.readFileSync(file));
  const code = `const fs=require('node:fs'),path=require('node:path'),rename=fs.renameSync;
    fs.renameSync=function(a,b){if(path.resolve(b)===path.resolve(process.argv[3]))throw Object.assign(new Error('injected initial publication failure'),{code:'EIO'});return rename.apply(this,arguments);};
    try{require(process.argv[1]).init({plan:process.argv[2],out:path.dirname(process.argv[3]),force:true});process.exitCode=7;}catch(e){console.log(e.code);process.exitCode=1;}`;
  const result = spawnSync(process.execPath, ['-e', code, contextScript, f.file, f.contextFile], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const [i, file] of files.entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
  assert.equal(fs.existsSync(f.file), true); assert.equal(fs.existsSync(path.join(f.runDir, '.context-write.lock')), false);
});

test('changed lock ownership is preserved and prevents any publication', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid'] });
  const before = fs.readFileSync(f.contextFile), lock = path.join(f.runDir, '.context-write.lock');
  const code = `const fs=require('node:fs'),path=require('node:path'),read=fs.readFileSync;let changed=false;
    fs.readFileSync=function(file){const bytes=read.apply(this,arguments);if(!changed&&path.resolve(String(file))===path.resolve(process.argv[3])){changed=true;fs.writeFileSync(process.argv[4],'replacement lock owner');}return bytes;};
    try{require(process.argv[1]).merge({context:process.argv[2],delta:process.argv[3]});process.exitCode=7;}catch(e){console.log(e.code);process.exitCode=1;}`;
  const result = spawnSync(process.execPath, ['-e', code, contextScript, f.contextFile, delta, lock], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout, /CONTEXT_LOCK_CHANGED/);
  assert.deepEqual(fs.readFileSync(f.contextFile), before); assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement lock owner');
  assert.equal(fs.existsSync(delta), true);
});

test('compare-before-publication preserves a noncooperating newer context and inputs', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid'] });
  const beforeMirror = fs.readFileSync(path.join(f.runDir, 'context.md'));
  const code = `const fs=require('node:fs'),path=require('node:path'),read=fs.readFileSync;let changed=false;
    fs.readFileSync=function(file){const bytes=read.apply(this,arguments);if(!changed&&path.resolve(String(file))===path.resolve(process.argv[3])){changed=true;const newer=JSON.parse(read(process.argv[2],'utf8'));newer.version=9;fs.writeFileSync(process.argv[2],JSON.stringify(newer));}return bytes;};
    try{require(process.argv[1]).merge({context:process.argv[2],delta:process.argv[3]});process.exitCode=7;}catch(e){console.log(e.code);process.exitCode=1;}`;
  const result = spawnSync(process.execPath, ['-e', code, contextScript, f.contextFile, delta], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout, /CONTEXT_CHANGED/);
  assert.equal(JSON.parse(fs.readFileSync(f.contextFile)).version, 9);
  assert.deepEqual(fs.readFileSync(path.join(f.runDir, 'context.md')), beforeMirror);
  assert.equal(fs.existsSync(delta), true); assert.equal(fs.existsSync(path.join(f.runDir, '.context-write.lock')), false);
});

test('overlapping writer processes never overwrite a newer context', async t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['winner'] });
  const entered = path.join(f.dir, 'entered'), release = path.join(f.dir, 'release');
  const code = `const fs=require('node:fs'),path=require('node:path');const read=fs.readFileSync;let held=false;
    fs.readFileSync=function(file){if(!held&&path.resolve(String(file))===path.resolve(process.argv[2])){held=true;fs.writeFileSync(process.argv[4],'entered');const end=Date.now()+10000;while(!fs.existsSync(process.argv[5])){if(Date.now()>end)throw new Error('race barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return read.apply(this,arguments);};
    try{const result=require(process.argv[1]).merge({context:process.argv[2],delta:process.argv[3]});console.log(JSON.stringify(result));}catch(e){console.error(e.code+': '+e.message);process.exitCode=1;}`;
  const child = spawn(process.execPath, ['-e', code, contextScript, f.contextFile, delta, entered, release], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise(resolve => child.on('close', (status) => resolve({ status })));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(entered)) { assert.ok(Date.now() < deadline, stderr); await new Promise(resolve => setTimeout(resolve, 10)); }
  const blocked = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  fs.writeFileSync(release, 'release');
  assert.equal(blocked.status, 1, blocked.stdout); assert.equal(blocked.json.code, 'CONTEXT_BUSY');
  const result = await completion; assert.equal(result.status, 0, stderr);
  assert.equal(JSON.parse(stdout).context.version, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.contextFile)).findings.length, 1);
  const retry = cli(contextScript, ['merge', '--context', f.contextFile, '--delta', delta]);
  assert.equal(retry.json.code, 'STALE_CONTEXT');
});

test('pack cannot overwrite canonical, plan, mirror or another writer lock', t => {
  const f = initContext(t); const lock = path.join(f.runDir, '.context-write.lock'); fs.writeFileSync(lock, 'other writer');
  const files = ['context.json', 'plan.json', 'context.md', '.context-write.lock'].map(name => path.join(f.runDir, name));
  const before = files.map(file => fs.readFileSync(file));
  for (const file of files) {
    const result = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', file]);
    assert.equal(result.status, 2, result.stdout); assert.equal(result.json.code, 'USAGE');
    for (const [i, unchanged] of files.entries()) assert.deepEqual(fs.readFileSync(unchanged), before[i]);
  }
});

test('pack reserved output checks follow parent junction aliases and missing lock paths', t => {
  const f = initContext(t); const alias = path.join(f.dir, 'run-alias');
  fs.symlinkSync(f.runDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readFileSync(f.contextFile);
  for (const name of ['context.json', 'plan.json', 'context.md', '.context-write.lock']) {
    const result = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', path.join(alias, name)]);
    assert.equal(result.status, 2, result.stdout); assert.equal(result.json.code, 'USAGE');
  }
  assert.deepEqual(fs.readFileSync(f.contextFile), before);
  assert.equal(fs.existsSync(path.join(f.runDir, '.context-write.lock')), false);
  const ordinary = cli(contextScript, ['pack', '--context', f.contextFile, '--unit', 'U1', '--out', path.join(alias, 'packs', 'U1.json')]);
  assert.equal(ordinary.status, 0, ordinary.stdout);
  assert.equal(fs.existsSync(path.join(f.runDir, 'packs', 'U1.json')), true);
});

test('exported batch API rejects detached out and init still accepts an adjacent source plan', t => {
  const f = initContext(t); const delta = path.join(f.dir, 'delta.json'); const detached = path.join(f.dir, 'elsewhere', 'context.json');
  writeJson(delta, { unitId: 'U1', contextVersion: 1, planDigest: f.context.planDigest, findings: ['valid'] });
  const before = fs.readFileSync(f.contextFile);
  const code = `try{require(process.argv[1]).mergeBatch({context:process.argv[2],delta:[process.argv[3]],out:process.argv[4]});process.exitCode=7;}catch(e){console.log(e.code);process.exitCode=2;}`;
  const rejected = spawnSync(process.execPath, ['-e', code, contextScript, f.contextFile, delta, detached], { encoding: 'utf8', timeout: 15000 });
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr); assert.match(rejected.stdout, /USAGE/);
  assert.deepEqual(fs.readFileSync(f.contextFile), before); assert.equal(fs.existsSync(detached), false);
  const initialized = cli(contextScript, ['init', '--plan', path.join(f.runDir, 'plan.json'), '--out', f.runDir, '--force']);
  assert.equal(initialized.status, 0, initialized.stdout);
  assert.equal(initialized.json.context.version, 2);
  assert.equal(cli(contextScript, ['check', '--run', f.runDir]).status, 0);
});
