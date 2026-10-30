#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./convention-core.cjs');

function freezeSuite(spec, evidenceRoot) {
  const root = core.projectRoot(evidenceRoot);
  if (!spec || spec.schema !== 1 || spec.policyVersion !== core.VERSION || !core.text(spec.model?.id) || !spec.model.parameters || !['simulation', 'runtime'].includes(spec.evidenceType)
      || !Array.isArray(spec.scenarios) || !spec.scenarios.length || spec.scenarios.length > 100) core.fail('INVALID_SUITE', 'version, model parameters, evidence type and scenarios are required');
  core.verifySource(root, spec.baseline);
  const ids = new Set(), coverage = new Map(core.DIMENSIONS.map(d => [d, new Set()]));
  let mixed = 0;
  for (const scenario of spec.scenarios) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(scenario?.id || '') || ids.has(scenario.id) || !['positive', 'negative', 'mixed'].includes(scenario.kind)
        || !Number.isInteger(scenario.rounds) || scenario.rounds < 1 || scenario.rounds > 10 || !Array.isArray(scenario.dimensions) || !scenario.dimensions.length
        || new Set(scenario.dimensions).size !== scenario.dimensions.length || scenario.dimensions.some(d => !core.DIMENSIONS.includes(d))) core.fail('INVALID_SCENARIO', 'scenarios need unique IDs, supported dimensions and frozen rounds');
    ids.add(scenario.id);
    if (scenario.kind === 'mixed') { if (scenario.dimensions.length < 2) core.fail('INVALID_SCENARIO', 'mixed scenarios need multiple dimensions'); mixed++; }
    else scenario.dimensions.forEach(d => coverage.get(d).add(scenario.kind));
    core.verifySource(root, scenario.truth);
    const truth = core.readJson(core.projectFile(root, scenario.truth.path));
    if (!truth.expectation || !['execute', 'none'].includes(truth.expectation.action) || !['required', 'none'].includes(truth.expectation.patch) || !['required', 'forbidden', 'optional'].includes(truth.expectation.question)) core.fail('INVALID_TRUTH', 'independent truth needs action, patch and question expectations');
    if (truth.expectation.action === 'execute' && !truth.expectation.firstAction) core.fail('INVALID_TRUTH', 'freeze the expected first action before measurement');
    if (truth.expectation.action === 'none' && (!['cancel', 'denied'].includes(truth.expectation.decision?.value) || !['user', 'host'].includes(truth.expectation.decision?.role))) core.fail('INVALID_TRUTH', 'freeze the scoped no-action decision');
    if (truth.expectation.patch === 'required') {
      if (!truth.expectation.files || !Object.keys(truth.expectation.files).length || Object.values(truth.expectation.files).some(v => !['present', 'absent'].includes(v))) core.fail('INVALID_TRUTH', 'freeze the complete expected patch file set');
      Object.keys(truth.expectation.files).forEach(file => core.relativeName(file));
    }
    const expected = truth.expectation.checks;
    if (truth.expectation.action === 'none' && expected && Object.keys(expected).length) core.fail('INVALID_TRUTH', 'no-action checks must be represented by scoped decision and observation evidence');
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || (truth.expectation.patch === 'required' && !Object.keys(expected).length) || Object.values(expected).some(s => !['PASS', 'FAIL'].includes(s))) core.fail('INVALID_TRUTH', 'freeze concrete expected check results');
  }
  if (!mixed || [...coverage.values()].some(set => !set.has('positive') || !set.has('negative'))) core.fail('COVERAGE_MISSING', 'each of five dimensions needs positive and negative cases, plus a mixed case');
  const body = { schema: 1, policyVersion: core.VERSION, model: core.copy(spec.model), evidenceType: spec.evidenceType, baseline: spec.baseline, scenarios: spec.scenarios, frozenAt: new Date().toISOString() };
  return core.freeze({ ...body, suiteDigest: core.hash(body) });
}
function assertSuite(suite, root) {
  const { suiteDigest, ...body } = suite || {};
  if (!suiteDigest || core.hash(body) !== suiteDigest || suite.policyVersion !== core.VERSION) core.fail('SUITE_CHANGED', 'suite version or frozen content changed');
  const checked = freezeSuite(body, root);
  if (checked.scenarios.length !== suite.scenarios.length) core.fail('SUITE_CHANGED', 'suite scenario count changed');
}
function readEvidence(root, source, suite, resolveEvidence, kind) {
  core.verifySource(root, source);
  const value = core.readJson(core.projectFile(root, source.path));
  if (suite.evidenceType === 'runtime') {
    const trusted = typeof resolveEvidence === 'function' && resolveEvidence(source, kind);
    if (!trusted || core.hash(trusted) !== core.hash(value)) core.fail('ORIGIN_UNVERIFIED', 'runtime evidence requires the original host capture, not a file label');
  }
  return value;
}
function evaluateTrial(suite, scenario, trace, root, resolveEvidence) {
  const reasons = [];
  const truth = readEvidence(root, scenario.truth, suite, resolveEvidence, 'independent-truth').expectation;
  if (trace.schema !== 1 || trace.suiteDigest !== suite.suiteDigest || trace.scenarioId !== scenario.id || trace.baselineDigest !== suite.baseline.sha256
      || core.hash(trace.model || null) !== core.hash(suite.model) || trace.policyVersion !== suite.policyVersion) return { status: 'UNVERIFIED', reasons: ['trace belongs to another suite, model, baseline or policy version'] };
  if (trace.termination !== 'completed' || trace.completeWindow !== true || !Array.isArray(trace.events) || !trace.events.length) return { status: 'UNVERIFIED', reasons: ['trace window did not complete'] };
  const kinds = ['bootstrap', 'question', 'user-decision', 'host-decision', 'business-action', 'first-patch', 'feedback', 'window-end'];
  for (let i = 0; i < trace.events.length; i++) {
    const event = trace.events[i];
    if (!event || event.sequence !== i + 1 || !kinds.includes(event.kind) || !core.text(event.sourceRef)) return { status: 'UNVERIFIED', reasons: ['event sequence or provenance is incomplete'] };
  }
  const events = trace.events;
  if (events.at(-1).kind !== 'window-end' || events.filter(e => e.kind === 'window-end').length !== 1) return { status: 'UNVERIFIED', reasons: ['missing unique terminal observation marker'] };
  const actions = events.filter(e => e.kind === 'business-action');
  const firstAction = actions[0];
  const feedback = events.find(e => e.kind === 'feedback');
  const patch = events.find(e => e.kind === 'first-patch');
  const questions = events.filter(e => e.kind === 'question');
  const revoked = events.find(e => ((e.kind === 'user-decision' && e.role === 'user' && e.decision === 'cancel') || (e.kind === 'host-decision' && e.role === 'host' && e.decision === 'denied')) && e.status === 'completed');
  if (revoked && events.some(e => ['business-action', 'first-patch'].includes(e.kind) && e.sequence > revoked.sequence)) reasons.push('business activity continued after the task decision was cancelled or denied');
  if (truth.action === 'none') {
    const decision = events.find(e => e.kind === truth.decision.role + '-decision' && e.role === truth.decision.role && e.decision === truth.decision.value && e.status === 'completed');
    if (!decision) return { status: 'UNVERIFIED', reasons: ['no-action case lacks the required scoped user or host decision record'] };
    if (actions.length || patch) reasons.push('a prohibited business action or patch occurred');
  } else if (!firstAction) return { status: 'UNVERIFIED', reasons: ['first business action is missing'] };
  else {
    if (firstAction.termination !== 'completed' || core.hash(firstAction.observed || null) !== core.hash(truth.firstAction)) reasons.push('first action violated the frozen independent expectation');
    if (feedback && firstAction.sequence >= feedback.sequence) reasons.push('first action was recorded only after corrective feedback');
  }
  if (truth.question === 'forbidden' && questions.length) reasons.push('unnecessary question');
  if (truth.question === 'required' && !questions.length) reasons.push('required question was omitted');
  if (truth.patch === 'required') {
    if (!patch) return { status: 'UNVERIFIED', reasons: ['first complete patch is missing'] };
    if (feedback && patch.sequence >= feedback.sequence) reasons.push('first patch was frozen after corrective feedback');
    const snapshot = readEvidence(root, patch.snapshot, suite, resolveEvidence, 'first-patch');
    const results = readEvidence(root, patch.results, suite, resolveEvidence, 'independent-check-results');
    if (snapshot.schema !== 1 || snapshot.taskId !== trace.taskId || snapshot.worktreeId !== trace.worktreeId || snapshot.suiteDigest !== suite.suiteDigest || !Array.isArray(snapshot.files) || !snapshot.files.length
        || !snapshot.files.every(f => core.text(f.path) && (f.exists === false ? f.sha256 === null && f.content === null : f.exists === true && /^[a-f0-9]{64}$/.test(f.sha256 || '') && typeof f.content === 'string' && core.hash(f.content) === f.sha256))
        || new Set(snapshot.files.map(f => f.path)).size !== snapshot.files.length) return { status: 'UNVERIFIED', reasons: ['first-patch content or identity is invalid'] };
    if (core.hash(snapshot.files.map(f => f.path).sort()) !== core.hash(Object.keys(truth.files).sort())) reasons.push('first patch omitted or added files outside the frozen task');
    for (const file of snapshot.files) if (truth.files[file.path] && file.exists !== (truth.files[file.path] === 'present')) reasons.push('first patch has the wrong existence state: ' + file.path);
    if (results.termination !== 'completed' || results.snapshotDigest !== patch.snapshot.sha256 || !Array.isArray(results.checks)) return { status: 'UNVERIFIED', reasons: ['results are not bound to the frozen first patch'] };
    const ids = results.checks.map(c => c?.id);
    if (new Set(ids).size !== ids.length || core.hash([...ids].sort()) !== core.hash(Object.keys(truth.checks).sort())) return { status: 'UNVERIFIED', reasons: ['independent result set is incomplete or duplicated'] };
    for (const check of results.checks) {
      if (!['PASS', 'FAIL'].includes(check.status)) return { status: 'UNVERIFIED', reasons: ['a required check has no conclusive observation'] };
      if (check.status !== truth.checks[check.id]) reasons.push('first patch violated expectation: ' + check.id);
    }
  } else {
    if (patch) reasons.push('unexpected code patch in a no-patch task');
    if (Object.keys(truth.checks).length) {
      if (!firstAction?.results) return { status: 'UNVERIFIED', reasons: ['non-patch task is missing independent check results'] };
      const results = readEvidence(root, firstAction.results, suite, resolveEvidence, 'independent-check-results');
      if (results.termination !== 'completed' || results.actionDigest !== core.hash(firstAction.observed) || !Array.isArray(results.checks)) return { status: 'UNVERIFIED', reasons: ['results do not bind the first action'] };
      const ids = results.checks.map(c => c?.id);
      if (new Set(ids).size !== ids.length || core.hash([...ids].sort()) !== core.hash(Object.keys(truth.checks).sort())) return { status: 'UNVERIFIED', reasons: ['non-patch result set is incomplete'] };
      for (const check of results.checks) {
        if (!['PASS', 'FAIL'].includes(check.status)) return { status: 'UNVERIFIED', reasons: ['non-patch check is inconclusive'] };
        if (check.status !== truth.checks[check.id]) reasons.push('first action check violated expectation: ' + check.id);
      }
    }
  }
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons, unnecessaryQuestion: truth.question === 'forbidden' && questions.length > 0, actions: actions.length };
}
function evaluate(suite, manifest, evidenceRoot, resolveEvidence) {
  const root = core.projectRoot(evidenceRoot);
  assertSuite(suite, root);
  if (!manifest || manifest.schema !== 1 || manifest.suiteDigest !== suite.suiteDigest || !Array.isArray(manifest.trials) || manifest.trials.length > 2000) core.fail('INVALID_MANIFEST', 'a matching trial manifest is required');
  const required = new Set();
  for (const scenario of suite.scenarios) for (let round = 1; round <= scenario.rounds; round++) for (const mode of ['baseline', 'enabled']) required.add(scenario.id + '/' + round + '/' + mode);
  const seen = new Set(), results = [], issues = [];
  for (const trial of manifest.trials) {
    const key = trial.scenarioId + '/' + trial.round + '/' + trial.mode;
    if (!required.has(key) || seen.has(key)) { issues.push('unexpected or duplicate trial: ' + key); continue; }
    seen.add(key);
    const scenario = suite.scenarios.find(s => s.id === trial.scenarioId);
    try {
      const trace = readEvidence(root, trial.trace, suite, resolveEvidence, 'host-trace');
      if (trace.mode !== trial.mode || trace.round !== trial.round || !core.text(trace.taskId)) core.fail('TRACE_SCOPE', 'trace mode/round does not match the manifest');
      results.push({ scenarioId: trial.scenarioId, round: trial.round, mode: trial.mode, ...evaluateTrial(suite, scenario, trace, root, resolveEvidence) });
    } catch (error) { results.push({ scenarioId: trial.scenarioId, round: trial.round, mode: trial.mode, status: 'UNVERIFIED', reasons: [error.code || 'EVIDENCE_MISSING'] }); }
  }
  for (const key of required) if (!seen.has(key)) issues.push('missing paired trial: ' + key);
  const enabled = results.filter(r => r.mode === 'enabled'), baseline = results.filter(r => r.mode === 'baseline');
  const byDimension = Object.fromEntries(core.DIMENSIONS.map(dimension => {
    const ids = suite.scenarios.filter(s => s.dimensions.includes(dimension)).map(s => s.id);
    const group = enabled.filter(r => ids.includes(r.scenarioId));
    return [dimension, { independentScenarios: ids.length, rounds: group.length, passed: group.filter(r => r.status === 'PASS').length, failed: group.filter(r => r.status === 'FAIL').length, unverified: group.filter(r => r.status === 'UNVERIFIED').length }];
  }));
  const incomplete = issues.length || results.some(r => r.status === 'UNVERIFIED') || !enabled.length;
  const status = enabled.some(r => r.status === 'FAIL') ? 'FAIL' : incomplete ? 'UNVERIFIED' : 'PASS';
  return { schema: 1, policyVersion: suite.policyVersion, suiteDigest: suite.suiteDigest, evidenceType: suite.evidenceType, status, exitCode: status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2, issues, results,
    metrics: { independentScenarios: suite.scenarios.length, expectedTrials: required.size, observedTrials: seen.size, enabledPassed: enabled.filter(r => r.status === 'PASS').length, baselinePassed: baseline.filter(r => r.status === 'PASS').length, mixedScenarios: suite.scenarios.filter(s => s.kind === 'mixed').length, byDimension },
    realBehaviorVerified: suite.evidenceType === 'runtime' && status === 'PASS', limits: 'Only the frozen provided task set is evaluated. Simulation does not prove real Agent behavior; runtime origin depends on the trusted host resolver. No generalized improvement claim is made.' };
}
function captureFirstPatch(output, details) {
  if (!path.isAbsolute(output) || !fs.existsSync(path.dirname(output)) || fs.lstatSync(path.dirname(output)).isSymbolicLink()) core.fail('STATE_PATH', 'first-patch output requires an explicit real directory');
  if (!details || !core.text(details.taskId) || !/^[a-f0-9]{64}$/.test(details.suiteDigest || '')) core.fail('INVALID_CAPTURE', 'task and frozen suite identity are required');
  const current = core.snapshot(details.projectRoot, details.files, details.snapshotMode || 'working-tree');
  const snapshot = { schema: 1, taskId: details.taskId, suiteDigest: details.suiteDigest, worktreeId: current.worktreeId, capturedAt: new Date().toISOString(), files: current.files };
  if (!snapshot.files.length) core.fail('EMPTY_PATCH', 'first-patch snapshot cannot be empty');
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2));
  if (bytes.length > core.MAX_BYTES) core.fail('CAPTURE_LIMIT', 'first-patch capture exceeds 2MiB');
  fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  return { file: output, sha256: core.hash(bytes), worktreeId: current.worktreeId, limits: 'Immutable content capture only; first-in-time and feedback order require the original host event trace.' };
}
module.exports = { freezeSuite, assertSuite, evaluate, captureFirstPatch };
if (require.main === module) core.cli(args => {
  if (args[0] === 'freeze' && args.length === 3) return freezeSuite(core.readJson(args[1]), args[2]);
  if (args[0] === 'evaluate' && args.length === 4) return evaluate(core.readJson(args[1]), core.readJson(args[2]), args[3]);
  if (args[0] === 'capture' && args.length === 3) return captureFirstPatch(args[2], core.readJson(args[1]));
  core.fail('USAGE', 'node convention-benchmark.cjs freeze <suite-input.json> <evidence-root> | evaluate <suite.json> <manifest.json> <evidence-root> | capture <input.json> <new-output.json>');
});
