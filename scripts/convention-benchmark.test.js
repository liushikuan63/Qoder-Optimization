'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./convention-core.cjs');
const bench = require('./convention-benchmark.cjs');
function fixture(t, evidenceType = 'simulation', pureTool = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const bytes = JSON.stringify(value); fs.writeFileSync(path.join(root, name), bytes); return { path: name, sha256: core.hash(bytes) }; };
  const baseline = write('baseline.json', { source: 'independent-fixture-baseline', revision: 1 });
  const scenarios = [];
  for (const dimension of core.DIMENSIONS) for (const kind of ['positive', 'negative']) {
    const id = dimension + '-' + kind;
    const expectation = kind === 'positive' ? { action: 'execute', firstAction: { tool: 'node', operation: 'approved-check' }, patch: 'required', files: { 'code.cjs': 'present' }, checks: { convention: 'PASS' }, question: 'forbidden' }
      : { action: 'none', decision: { role: 'user', value: 'cancel' }, patch: 'none', checks: {}, question: 'required' };
    if (pureTool && id === 'coding-style-positive') { expectation.patch = 'none'; delete expectation.files; }
    scenarios.push({ id, kind, dimensions: [dimension], rounds: 1, truth: write(id + '-truth.json', { expectation }) });
  }
  scenarios.push({ ...scenarios[0], id: 'mixed-case', kind: 'mixed', dimensions: ['coding-style', 'tools'] });
  const spec = { schema: 1, policyVersion: core.VERSION, model: { id: 'fixture-model', parameters: { temperature: 0 } }, evidenceType, baseline, scenarios };
  const suite = bench.freezeSuite(spec, root);
  fs.writeFileSync(path.join(root, 'code.cjs'), 'module.exports = 1;');
  const trials = [];
  for (const scenario of scenarios) for (const mode of ['baseline', 'enabled']) {
    const taskId = scenario.id + '-' + mode;
    const events = [];
    if (scenario.kind === 'negative') {
      events.push({ kind: 'question' }, { kind: 'user-decision', role: 'user', decision: 'cancel', status: 'completed' });
    } else {
      events.push({ kind: 'business-action', termination: 'completed', observed: { tool: 'node', operation: 'approved-check' } });
      const expectation = core.readJson(path.join(root, scenario.truth.path)).expectation;
      if (expectation.patch === 'required') {
        const captured = bench.captureFirstPatch(path.join(root, taskId + '-patch.json'), { projectRoot: root, taskId, suiteDigest: suite.suiteDigest, files: ['code.cjs'] });
        const snapshot = { path: taskId + '-patch.json', sha256: captured.sha256 };
        const results = write(taskId + '-results.json', { termination: 'completed', snapshotDigest: snapshot.sha256, checks: [{ id: 'convention', status: 'PASS' }] });
        events.push({ kind: 'first-patch', snapshot, results });
      } else events[0].results = write(taskId + '-action-result.json', { termination: 'completed', actionDigest: core.hash(events[0].observed), checks: [{ id: 'convention', status: 'PASS' }] });
    }
    events.push({ kind: 'window-end' });
    events.forEach((event, index) => Object.assign(event, { sequence: index + 1, sourceRef: taskId + '/' + index }));
    const trace = { schema: 1, taskId, worktreeId: core.identity(root).worktreeId, mode, round: 1, scenarioId: scenario.id, policyVersion: core.VERSION, suiteDigest: suite.suiteDigest, baselineDigest: baseline.sha256, model: spec.model, termination: 'completed', completeWindow: true, events };
    trials.push({ scenarioId: scenario.id, mode, round: 1, trace: write(taskId + '-trace.json', trace) });
  }
  const manifest = { schema: 1, suiteDigest: suite.suiteDigest, trials };
  const changeTrace = (index, mutate) => { const trial = trials[index], data = core.readJson(path.join(root, trial.trace.path)); mutate(data); trial.trace = write(trial.trace.path, data); };
  return { root, write, suite, spec, trials, manifest, changeTrace, run: resolver => bench.evaluate(suite, manifest, root, resolver) };
}
test('balanced local fixtures prove evaluator behavior, not real Agent improvement', t => {
  const f = fixture(t), r = f.run();
  assert.equal(r.status, 'PASS'); assert.equal(r.realBehaviorVerified, false);
  assert.equal(r.metrics.expectedTrials, 22); assert.equal(r.metrics.independentScenarios, 11);
  assert.equal(Object.keys(r.metrics.byDimension).length, 5);
});
test('missing dimensions, missing negative cases and duplicate scenarios are rejected', t => {
  const f = fixture(t);
  const missing = core.copy(f.spec); missing.scenarios = missing.scenarios.filter(s => !s.id.startsWith('i18n'));
  assert.throws(() => bench.freezeSuite(missing, f.root), { code: 'COVERAGE_MISSING' });
  const duplicate = core.copy(f.spec); duplicate.scenarios.push(duplicate.scenarios[0]);
  assert.throws(() => bench.freezeSuite(duplicate, f.root), { code: 'INVALID_SCENARIO' });
});
test('each round must have both baseline and enabled records', t => {
  const f = fixture(t); f.manifest.trials.pop();
  assert.equal(f.run().status, 'UNVERIFIED'); assert.match(f.run().issues[0], /missing paired trial/);
});
test('duplicate rounds never increase the independent task count', t => {
  const f = fixture(t); f.manifest.trials.push(f.manifest.trials[0]);
  const r = f.run(); assert.equal(r.status, 'UNVERIFIED'); assert.equal(r.metrics.independentScenarios, 11);
});
test('first action violation remains FAIL even after a later correct retry', t => {
  const f = fixture(t); f.changeTrace(1, trace => {
    trace.events[0].observed.operation = 'wrong-tool';
    trace.events.splice(1, 0, { kind: 'business-action', observed: { tool: 'node', operation: 'approved-check' }, termination: 'completed', sourceRef: 'retry' });
    trace.events.forEach((event, i) => { event.sequence = i + 1; });
  });
  assert.equal(f.run().status, 'FAIL'); assert.equal(f.run().metrics.byDimension['coding-style'].failed, 1);
});
test('baseline failure is reported without masking a correct enabled group', t => {
  const f = fixture(t); f.changeTrace(0, trace => { trace.events[0].observed.operation = 'baseline-mistake'; });
  const r = f.run(); assert.equal(r.status, 'PASS'); assert.equal(r.metrics.baselinePassed, 10); assert.equal(r.metrics.enabledPassed, 11);
});
test('patch recorded after feedback cannot stand in for first output', t => {
  const f = fixture(t); f.changeTrace(1, trace => { trace.events.splice(1, 0, { kind: 'feedback', sourceRef: 'checker-error' }); trace.events.forEach((e, i) => { e.sequence = i + 1; }); });
  assert.equal(f.run().status, 'FAIL');
});
test('missing first snapshot or broken capture hash is UNVERIFIED', t => {
  const f = fixture(t); f.changeTrace(1, trace => { trace.events[1].snapshot.sha256 = '0'.repeat(64); });
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('missing independent result does not turn into zero failures', t => {
  const f = fixture(t); f.changeTrace(1, trace => { trace.events[1].results = f.write('missing-result.json', { termination: 'completed', snapshotDigest: trace.events[1].snapshot.sha256, checks: [] }); });
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('a complete result set still fails when the first patch violates expected checks', t => {
  const f = fixture(t); f.changeTrace(1, trace => { trace.events[1].results = f.write('failed-result.json', { termination: 'completed', snapshotDigest: trace.events[1].snapshot.sha256, checks: [{ id: 'convention', status: 'FAIL' }] }); });
  assert.equal(f.run().status, 'FAIL');
});
test('correct cancellation is successful no-action; empty traces are not', t => {
  const f = fixture(t); assert.equal(f.run().results.find(r => r.scenarioId.endsWith('negative')).status, 'PASS');
  f.changeTrace(3, trace => { trace.events = [{ kind: 'window-end', sequence: 1, sourceRef: 'end' }]; });
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('cancellation plus an unauthorized action is a failed scene', t => {
  const f = fixture(t); f.changeTrace(3, trace => { trace.events.splice(2, 0, { kind: 'business-action', sourceRef: 'forbidden', termination: 'completed', observed: {} }); trace.events.forEach((e, i) => { e.sequence = i + 1; }); });
  assert.equal(f.run().status, 'FAIL');
});
test('cancellation invalidates later actions even in an originally executable scenario', t => {
  const f = fixture(t); f.changeTrace(1, trace => {
    trace.events.unshift({ kind: 'user-decision', role: 'user', decision: 'cancel', status: 'completed', sourceRef: 'cancel-current-task' });
    trace.events.forEach((event, i) => { event.sequence = i + 1; });
  });
  assert.equal(f.run().status, 'FAIL');
});
test('non-patch tasks still require independently recorded check outcomes', t => {
  const f = fixture(t, 'simulation', true); assert.equal(f.run().status, 'PASS');
  f.changeTrace(1, trace => { delete trace.events[0].results; });
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('wrong versions, model parameters and incomplete windows are not comparable', t => {
  const f = fixture(t); f.changeTrace(1, trace => { trace.model.parameters.temperature = 0.5; });
  assert.equal(f.run().status, 'UNVERIFIED');
  f.changeTrace(1, trace => { trace.model.parameters.temperature = 0; trace.policyVersion = 'old'; });
  assert.equal(f.run().status, 'UNVERIFIED');
  f.changeTrace(1, trace => { trace.policyVersion = core.VERSION; trace.completeWindow = false; });
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('runtime labels without original host evidence cannot prove real behavior', t => {
  const f = fixture(t, 'runtime');
  assert.equal(f.run().status, 'UNVERIFIED'); assert.equal(f.run().realBehaviorVerified, false);
});
test('immutable first patch capture refuses replacement by a final patch', t => {
  const f = fixture(t); const out = path.join(f.root, 'capture.json');
  const details = { projectRoot: f.root, taskId: 'task', suiteDigest: f.suite.suiteDigest, files: ['code.cjs'] };
  const first = bench.captureFirstPatch(out, details);
  fs.writeFileSync(path.join(f.root, 'code.cjs'), 'module.exports = 2;');
  assert.throws(() => bench.captureFirstPatch(out, details), { code: 'EEXIST' });
  assert.equal(core.hash(fs.readFileSync(out)), first.sha256);
});
test('deleted files are captured as tombstones instead of disappearing', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'code.cjs'));
  const out = path.join(f.root, 'deleted.json');
  bench.captureFirstPatch(out, { projectRoot: f.root, taskId: 'deletion', suiteDigest: f.suite.suiteDigest, files: ['code.cjs'] });
  assert.equal(core.readJson(out).files[0].exists, false);
});
test('missing required resource files fail first-patch completeness', t => {
  const f = fixture(t); f.changeTrace(1, trace => {
    const snapshot = core.readJson(path.join(f.root, trace.events[1].snapshot.path));
    snapshot.files[0].path = 'other.cjs';
    trace.events[1].snapshot = f.write('incomplete-patch.json', snapshot);
    trace.events[1].results = f.write('incomplete-result.json', { termination: 'completed', snapshotDigest: trace.events[1].snapshot.sha256, checks: [{ id: 'convention', status: 'PASS' }] });
  });
  assert.equal(f.run().status, 'FAIL');
});
