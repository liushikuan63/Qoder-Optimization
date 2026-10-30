'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createSession, questionFor, applyChoice, selectedPlan, saveSession, loadSession, reassessSession, beginVerification, auditVerification } = require('./verification-session.cjs');
const { auditFile } = require('./evidence-audit.cjs');
const fixture = require('../skills/verify-before-claim/references/adaptive-verification.cases.json');
const contract = id => fixture.cases.find(c => c.id === id);
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
function setup(mode = 'assisted', activationKind = 'isolated-trial') {
  const request = structuredClone(fixture.base);
  const state = createSession(request, { mode, activationKind, activationRef: 'grant-1' });
  const grant = {
    sourceRef: 'grant-1', scopeDigest: state.proposal.scopeDigest,
    mode, activationKind, policyVersion: state.proposal.policyVersion,
  };
  const resolve = () => grant;
  return { state, grant, resolve, request };
}
function displayedQuestion(state) {
  const question = questionFor(state).questions[0];
  return [question.question, ...question.options.map(o => [o.label, o.description, o.preview].join('\n'))].join('\n\n');
}
function snapshot(state, optionId = 'deep', direct = false) {
  const option = state.proposal.options.find(o => o.optionId === optionId);
  const question = questionFor(state).questions[0].question;
  const output = fixture.protocol.answeredPrefix + JSON.stringify(question) + '=' + JSON.stringify(option.label) + fixture.protocol.answeredSuffix;
  return {
    kind: fixture.protocol.snapshotKind, sessionId: state.proposal.sessionId, hasMoreBefore: true,
    messages: [
      { id: state.proposal.requestMessageId, role: 'user', status: 'completed', turnId: 'same-turn', text: '执行本任务' },
      ...(direct ? [{ id: 'shown-1', role: 'assistant', status: 'completed', text: displayedQuestion(state), tools: [{ name: 'AskUserQuestion', status: 'completed', output: fixture.protocol.unansweredOutput }] }] : []),
      direct
        ? { id: 'answer-1', role: 'user', status: 'completed', turnId: 'same-turn', text: '采用' + option.label.replace(' (Recommended)', '') }
        : { id: 'answer-1', role: 'assistant', status: 'completed', turnId: 'same-turn', tools: [{ name: 'AskUserQuestion', status: 'completed', output }] },
    ],
  };
}
function choose(f, optionId, direct = false) {
  return applyChoice(f.state, snapshot(f.state, optionId, direct), { kind: direct ? 'explicit-current-user-request' : 'native-answer', messageId: 'answer-1' }, f.resolve);
}
function expectationsFor(session, ids = selectedPlan(session).checkIds) {
  const out = {};
  for (const id of ids) {
    const check = session.proposal.checks.find(c => c.id === id);
    out[id] = {
      expectedOutcomeRef: check.expectedOutcomeRef,
      positive: { exitCode: 0, stdoutIncludes: [id + '-positive'] },
      negative: { exitCode: 1, stdoutIncludes: [id + '-negative'] },
    };
  }
  return out;
}

test('A05 question always offers four choices with the recommendation first', () => {
  const f = setup(), q = questionFor(f.state).questions[0];
  assert.equal(q.options.length, contract('A05').positive.expectedCount);
  assert.match(q.options[0].label, /Recommended/);
  assert.equal(q.options.at(-1).label, '交由人工验证');
  assert.equal(q.multiSelect, false);
  assert.ok(q.question.includes(f.state.proposal.proposalId));
  assert.ok(q.options.every(o => o.preview.includes('mandatory')));
});
test('A06 actual native light answer selects the light check set', () => {
  const f = setup(), selected = choose(f, 'light');
  assert.equal(selected.state, 'confirmed');
  assert.deepEqual(selectedPlan(selected).checkIds, contract('A06').positive.expectedCheckIds);
});
test('A07 manual selection is not completion and does not produce automatic work', () => {
  const f = setup(), selected = choose(f, 'manual');
  assert.equal(selected.state, contract('A07').positive.expectedState);
  const plan = selectedPlan(selected);
  assert.deepEqual(plan.checkIds, []);
  assert.ok(plan.manualChecklist.length > 0);
  assert.equal(plan.verdict, 'INCOMPLETE');
});
test('A07 completed tool without an answer never adopts the recommendation', () => {
  const f = setup(), source = snapshot(f.state);
  source.messages[1].tools[0].output = fixture.protocol.unansweredOutput;
  const selected = applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve);
  assert.equal(selected.state, contract('A07').negative.expectedState);
  assert.equal(selected.choice, null);
  assert.deepEqual(selectedPlan(selected).checkIds, []);
});
test('A08 high recommendation does not prevent explicit light choice', () => {
  const f = setup(); f.request.facts.sensitive = true;
  f.state = createSession(f.request, { mode: 'assisted', activationKind: 'isolated-trial', activationRef: 'grant-1' });
  f.grant.scopeDigest = f.state.proposal.scopeDigest;
  assert.equal(f.state.proposal.recommendedTier, 'deep');
  const selected = choose(f, 'light', true);
  assert.equal(selected.state, contract('A08').positive.expectedState);
  assert.equal(selectedPlan(selected).selectedTier, contract('A08').positive.expectedTier);
});
test('A08 unknown labels are rejected instead of silently clamped', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages.at(-1).text = '采用随便验证';
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), contract('A08').negative.expectedError);
});
test('A09 reapplying the same answer is idempotent', () => {
  const f = setup(), source = snapshot(f.state), selector = { kind: 'native-answer', messageId: 'answer-1' };
  const selected = applyChoice(f.state, source, selector, f.resolve);
  assert.equal(applyChoice(selected, source, selector, f.resolve), selected);
});
test('A09 answers from another session or without the original request are rejected', () => {
  const f = setup(), source = snapshot(f.state);
  source.sessionId = 'other-session';
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), contract('A09').negative.expectedError);
  source.sessionId = f.state.proposal.sessionId;
  source.messages.shift();
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'SCOPE_MISMATCH');
});
test('A10 a JSON approval flag is not a host authority resolver', () => {
  const f = setup(), source = snapshot(f.state);
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, { approved: true }), 'AUTHORITY_MISMATCH');
  f.grant.activationKind = 'enabled-workflow';
  rejects(() => choose(f, 'deep'), contract('A10').negative.expectedError);
});
test('A16 shadow keeps baseline checks and respects a manual handoff', () => {
  const f = setup('shadow', 'shadow-study');
  assert.deepEqual(selectedPlan(choose(f, 'light')).checkIds, contract('A16').positive.expectedCheckIds);
  const manual = selectedPlan(choose(f, 'manual'));
  assert.equal(manual.checkIds.length, contract('A16').negative.expectedAutomaticChecks);
  assert.equal(manual.verdict, contract('A16').negative.expectedVerdict);
});
test('A24 changed proposal or options cannot reuse a previous answer', () => {
  const f = setup(), source = snapshot(f.state);
  f.state.proposal.options[0].checkIds = [];
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'PROPOSAL_CHANGED');
});
test('A24 isolated trial approval cannot authorize an enabled workflow', () => {
  const f = setup();
  assert.equal(choose(f, 'deep').state, contract('A24').positive.expectedState);
  const enabled = createSession(f.request, { mode: 'assisted', activationKind: 'enabled-workflow', activationRef: 'grant-1' });
  rejects(() => applyChoice(enabled, snapshot(enabled), { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), contract('A24').negative.expectedError);
});
test('A25 assistant text cannot pretend to be the current user reply', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages.at(-1).role = 'assistant';
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), contract('A25').negative.expectedError);
});
test('same turnId does not permit replay after an intervening user request', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages.splice(1, 0, { id: 'new-request', role: 'user', turnId: 'same-turn', status: 'completed', text: '变更任务范围' });
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'SCOPE_MISMATCH');
});
test('a later unanswered dialog does not resurrect an earlier successful reply', () => {
  const f = setup(), source = snapshot(f.state);
  source.messages[1].tools.push({ name: 'AskUserQuestion', status: 'completed', output: fixture.protocol.unansweredOutput });
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
test('truncated and duplicate native answers do not create consent', () => {
  const f = setup(), source = snapshot(f.state);
  source.messages[1].tools[0].output = source.messages[1].tools[0].output.slice(0, -12);
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
  const duplicated = snapshot(f.state); duplicated.messages[1].tools.push(structuredClone(duplicated.messages[1].tools[0]));
  rejects(() => applyChoice(f.state, duplicated, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
test('A26 manualDone flag alone never makes an unselected session pass', () => {
  const f = setup(); f.state.manualDone = true;
  assert.equal(selectedPlan(f.state).verdict, contract('A26').negative.expectedVerdict);
});
function stateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('A21 persistence is scoped and cached consent must be revalidated from its real source', t => {
  const dir = stateRoot(t), f = setup(), selected = choose(f, 'deep');
  const saved = saveSession(dir, selected);
  const restored = loadSession(dir, f.state.proposal);
  assert.equal(restored.cacheDigest, saved.cacheDigest);
  assert.equal(restored.previousSelection, 'deep');
  assert.equal(restored.session.choice, null);
  assert.equal(selectedPlan(restored.session).verdict, 'INCOMPLETE');
  const confirmed = applyChoice(restored.session, snapshot(restored.session), { kind: 'native-answer', messageId: 'answer-1' }, f.resolve);
  assert.equal(confirmed.state, 'confirmed');
});
test('A21 separate sessions never overwrite a shared latest-choice file', t => {
  const dir = stateRoot(t), first = setup(), secondRequest = structuredClone(fixture.base);
  secondRequest.sessionId = 'session-2';
  const second = createSession(secondRequest, { mode: 'shadow', activationKind: 'shadow-study', activationRef: 'grant-2' });
  const a = saveSession(dir, first.state), b = saveSession(dir, second);
  assert.notEqual(a.file, b.file);
  assert.equal(loadSession(dir, first.state.proposal).cacheDigest, a.cacheDigest);
  rejects(() => loadSession(dir, { ...first.state.proposal, environmentKey: 'another-environment' }), 'SCOPE_MISMATCH');
});
test('A21 compare-and-swap protects an intervening state update', t => {
  const dir = stateRoot(t), f = setup(), saved = saveSession(dir, f.state);
  rejects(() => saveSession(dir, choose(f, 'manual'), 'stale-digest'), 'STATE_CHANGED');
  assert.equal(loadSession(dir, f.state.proposal).cacheDigest, saved.cacheDigest);
  const next = saveSession(dir, choose(f, 'manual'), saved.cacheDigest);
  assert.notEqual(next.cacheDigest, saved.cacheDigest);
});
test('A21 an existing writer lock is not deleted or bypassed', t => {
  const dir = stateRoot(t), f = setup(), saved = saveSession(dir, f.state);
  fs.writeFileSync(saved.file + '.lock', 'another-writer');
  rejects(() => saveSession(dir, f.state, saved.cacheDigest), 'STATE_BUSY');
  assert.equal(fs.readFileSync(saved.file + '.lock', 'utf8'), 'another-writer');
});
test('A21 invalid scope IDs and redirected directories are rejected', t => {
  const dir = stateRoot(t), f = setup();
  rejects(() => loadSession(dir, { ...f.state.proposal, taskId: '../outside' }), 'INVALID_SCOPE_ID');
  const outside = path.join(dir, 'unrelated'), parent = path.join(dir, f.state.proposal.sessionId);
  fs.mkdirSync(outside); fs.mkdirSync(parent);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  fs.symlinkSync(outside, path.join(parent, f.state.proposal.taskId), 'junction');
  rejects(() => saveSession(dir, f.state), 'STATE_PATH');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
});
test('A21 state size is bounded before loading or replacing it', t => {
  const dir = stateRoot(t), f = setup(), saved = saveSession(dir, f.state);
  fs.writeFileSync(saved.file, Buffer.alloc(2 * 1024 * 1024 + 1));
  rejects(() => loadSession(dir, f.state.proposal), 'INVALID_SESSION');
  rejects(() => saveSession(dir, f.state, saved.cacheDigest), 'INVALID_SESSION');
});
function syntheticAudit(t, tier = 'deep') {
  const dir = stateRoot(t), f = setup(), contentDigest = 'a'.repeat(64);
  const selected = choose(f, tier);
  const running = beginVerification(selected, { runId: 'run-1', cwd: dir, contentDigest, expectations: expectationsFor(selected) }, f.resolve);
  const reportFile = path.join(dir, 'report.json');
  const report = {
    schema: 1, task: selected.proposal.taskId, runId: 'run-1', cwd: running.run.cwd,
    proposalDigest: selected.proposal.proposalDigest, choiceDigest: running.run.choiceDigest, contentDigest, checks: [],
  };
  const records = new Map();
  function writeRecord(check, side) {
    const name = check.id + '-' + side + '.json';
    const bytes = Buffer.from(JSON.stringify(records.get(name)));
    fs.writeFileSync(path.join(dir, name), bytes);
    check[side].sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  for (const id of selectedPlan(running).checkIds) {
    const level = running.proposal.checks.find(c => c.id === id).evidenceType;
    const check = { id, claim: 'synthetic ' + id, status: 'verified', requiredLevel: level, changedVariable: 'synthetic negative input' };
    for (const side of ['positive', 'negative']) {
      const exitCode = side === 'positive' ? 0 : 1, marker = id + '-' + side;
      const name = id + '-' + side + '.json';
      records.set(name, { schema: 1, runId: 'run-1', cwd: running.run.cwd, level, termination: 'completed', exitCode, stdout: marker, stderr: '' });
      check[side] = { file: name, sha256: '', expect: { exitCode, stdoutIncludes: [marker] } };
      writeRecord(check, side);
    }
    report.checks.push(check);
  }
  const write = () => fs.writeFileSync(reportFile, JSON.stringify(report));
  write();
  const current = { ...running.proposal, cwd: running.run.cwd, contentDigest };
  const evidence = { reportFile, contentDigest };
  return { ...f, dir, running, selected, report, records, evidence, current, write, writeRecord, audit: () => auditVerification(running, evidence, current, f.resolve) };
}
test('A04/A12 current report matches the full selected plan', t => {
  const f = syntheticAudit(t), result = f.audit();
  assert.equal(result.verdict, contract('A04').positive.expectedVerdict);
  assert.equal(result.selectedChecksVerified, true);
  assert.equal(result.verifiedScope, contract('A15').positive.expectedScope);
});
test('A04 a report without its proposal, choice and content binding is stale', t => {
  const f = syntheticAudit(t);
  f.report.proposalDigest = 'f'.repeat(64);
  f.write();
  assert.equal(f.audit().code, 'STALE_REPORT');
  delete f.report.proposalDigest;
  f.write();
  assert.equal(f.audit().code, 'STALE_REPORT');
});
test('A04 report expectations cannot be rewritten after the run began', t => {
  const f = syntheticAudit(t), check = f.report.checks[0];
  check.positive.expect = { exitCode: 0, stdoutIncludes: ['rewritten'] };
  f.write();
  assert.equal(f.audit().code, 'EXPECTATION_MISMATCH');
});
test('A06 an omitted selected extension fails even when all mandatory checks remain', t => {
  const f = syntheticAudit(t);
  f.report.checks = f.report.checks.filter(c => c.id !== 'review');
  f.write();
  const result = f.audit();
  assert.equal(result.verdict, contract('A06').negative.expectedVerdict);
  assert.equal(result.code, 'CHECK_SET_MISMATCH');
});
test('unselected extra checks are not smuggled into a light report', t => {
  const f = syntheticAudit(t, 'light');
  f.report.checks.push({ ...f.report.checks[0], id: 'extra-check' });
  f.write();
  assert.equal(f.audit().code, 'CHECK_SET_MISMATCH');
});
test('A04 changing both the declared type and records cannot override the planned evidence type', t => {
  const f = syntheticAudit(t, 'light'), check = f.report.checks.find(c => c.id === 'smoke');
  check.requiredLevel = 'static';
  for (const side of ['positive', 'negative']) {
    f.records.get(check[side].file).level = 'static';
    f.writeRecord(check, side);
  }
  f.write();
  assert.equal(auditFile(f.evidence.reportFile).verdict, 'PASS');
  assert.equal(f.audit().code, 'EVIDENCE_TYPE_MISMATCH');
});
test('A12 stale content cannot be validated by a self-consistent old report', t => {
  const f = syntheticAudit(t);
  f.current.contentDigest = 'b'.repeat(64);
  assert.equal(f.audit().verdict, contract('A12').negative.expectedVerdict);
});
test('A14 skipped evidence remains incomplete', t => {
  const f = syntheticAudit(t), check = f.report.checks[0];
  f.records.get(check.negative.file).termination = 'skipped';
  f.writeRecord(check, 'negative'); f.write();
  assert.equal(f.audit().verdict, contract('A14').negative.expectedVerdict);
});
test('A15 exclusions retain the original PARTIAL meaning', t => {
  const f = syntheticAudit(t), check = f.report.checks.find(c => c.id === 'review');
  check.status = 'excluded'; check.reason = 'not performed';
  f.write();
  const result = f.audit();
  assert.equal(result.verdict, contract('A15').negative.expectedVerdict);
  assert.equal(result.selectedChecksVerified, false);
});
test('A11 an unchanged boundary keeps its choice while new content invalidates the old run', t => {
  const f = setup(), selected = choose(f, 'light'), digest = 'a'.repeat(64);
  const running = beginVerification(selected, { runId: 'run-1', cwd: stateRoot(t), contentDigest: digest, expectations: expectationsFor(selected) }, f.resolve);
  const same = reassessSession(running, f.request, digest);
  assert.equal(same, running);
  const repaired = reassessSession(running, f.request, 'b'.repeat(64));
  assert.equal(repaired.state, contract('A11').positive.expectedState);
  assert.equal(repaired.run, null);
  assert.equal(repaired.choice.optionId, 'light');
  const changed = structuredClone(f.request); changed.facts.sourceRefs.push('new-diff');
  assert.equal(reassessSession(running, changed, digest).state, contract('A11').negative.expectedState);
});
test('A11 unresolved facts or missing preconditions cannot start verification', t => {
  const f = setup(), dir = stateRoot(t), selected = choose(f, 'light');
  const unknown = structuredClone(f.request); unknown.facts.uncertainty = 'gaps';
  const blocked = createSession(unknown, { mode: 'assisted', activationKind: 'isolated-trial', activationRef: 'grant-1' });
  blocked.choice = { ...selected.choice, proposalDigest: blocked.proposal.proposalDigest };
  blocked.state = 'confirmed';
  assert.throws(() => beginVerification(blocked, { runId: 'run-2', cwd: dir, contentDigest: 'a'.repeat(64), expectations: expectationsFor(blocked) }, () => ({ ...f.grant, scopeDigest: blocked.proposal.scopeDigest })), error => error.code === 'PRECONDITIONS_MISSING');
});
test('A15 light single-observation path requires its independent expectation', t => {
  const f = setup(), dir = stateRoot(t), data = structuredClone(fixture.base);
  data.userCheckIds = [];
  data.checks = data.checks.filter(c => c.id === 'syntax' || c.id === 'review');
  data.checks.find(c => c.id === 'review').dependencies = ['syntax'];
  data.baselineCheckIds = ['syntax'];
  const state = createSession(data, { mode: 'assisted', activationKind: 'isolated-trial', activationRef: 'grant-1' });
  const grant = { ...f.grant, scopeDigest: state.proposal.scopeDigest };
  const selected = applyChoice(state, snapshot(state, 'light'), { kind: 'native-answer', messageId: 'answer-1' }, () => grant);
  const frozenExpect = { exitCode: 0, stdoutIncludes: ['PASS'] };
  const expectations = {
    syntax: { expectedOutcomeRef: 'syntax-expectation', positive: frozenExpect, negative: { exitCode: 1, stdoutIncludes: ['FAIL'] } },
  };
  const digest = 'a'.repeat(64), running = beginVerification(selected, { runId: 'run-1', cwd: dir, contentDigest: digest, expectations }, () => grant);
  assert.deepEqual(selectedPlan(running).checkIds, ['syntax']);
  const current = { ...running.proposal, cwd: dir, contentDigest: digest };
  const record = { schema: 1, runId: 'run-1', cwd: dir, level: 'static', termination: 'completed', exitCode: 0, stdout: 'PASS', stderr: '',
    proposalDigest: running.proposal.proposalDigest, choiceDigest: running.run.choiceDigest, contentDigest: digest };
  const call = (expect, checkId = 'syntax', direct = record) => auditVerification(running, { contentDigest: digest, checkId, expectedOutcomeRef: 'syntax-expectation', direct, expect }, current, () => grant);
  assert.equal(call(frozenExpect).verdict, 'PASS');
  assert.equal(call(frozenExpect, 'syntax', { ...record, stdout: 'FAIL' }).code, 'UNEXPECTED_RESULT');
  assert.equal(call({ exitCode: 0 }).code, 'EXPECTATION_MISMATCH');
  assert.equal(call({ exitCode: 0, stdoutIncludes: ['FAIL'] }, 'syntax', { ...record, stdout: 'FAIL' }).code, 'EXPECTATION_MISMATCH');
  assert.equal(call(frozenExpect, 'review').code, 'EXPECTATION_MISMATCH');
  const skipped = { ...record, termination: 'skipped' };
  assert.equal(auditVerification(running, { contentDigest: digest, checkId: 'syntax', expectedOutcomeRef: 'syntax-expectation', direct: skipped, expect: frozenExpect }, current, () => grant).code, 'INCOMPLETE_RECORD');
  assert.throws(() => beginVerification(selected, { runId: 'run-2', cwd: dir, contentDigest: digest }, () => grant), error => error.code === 'EXPECTATION_MISMATCH');
});
test('A15 multi-check light plan cannot be proved with one observation', t => {
  const f = setup(), dir = stateRoot(t), data = structuredClone(fixture.base);
  data.userCheckIds = ['syntax', 'smoke'];
  const state = createSession(data, { mode: 'assisted', activationKind: 'isolated-trial', activationRef: 'grant-1' });
  const grant = { ...f.grant, scopeDigest: state.proposal.scopeDigest };
  const selected = applyChoice(state, snapshot(state, 'light'), { kind: 'native-answer', messageId: 'answer-1' }, () => grant);
  const digest = 'a'.repeat(64), running = beginVerification(selected, { runId: 'run-1', cwd: dir, contentDigest: digest, expectations: expectationsFor(selected) }, () => grant);
  const record = { schema: 1, runId: 'run-1', cwd: dir, level: 'static', termination: 'completed', exitCode: 0, stdout: 'PASS', stderr: '' };
  const result = auditVerification(running, { contentDigest: digest, checkId: 'syntax', expectedOutcomeRef: 'syntax-expectation', direct: record, expect: { exitCode: 0, stdoutIncludes: ['SINGLE_POS'] } }, { ...running.proposal, cwd: dir, contentDigest: digest }, () => grant);
  assert.equal(result.code, 'SINGLE_CHECK_ONLY');
  assert.equal(result.selectedChecksVerified, false);
});
test('manual session never runs automatic verification even with a forged run', t => {
  const f = setup(), dir = stateRoot(t), manual = choose(f, 'manual');
  const started = beginVerification({ ...manual, run: { runId: 'fake', cwd: dir, contentDigest: 'a'.repeat(64), choiceDigest: 'x', checkIds: ['syntax'] } }, { runId: 'fake', cwd: dir, contentDigest: 'a'.repeat(64) }, f.resolve);
  assert.equal(started.state, 'awaiting_manual');
  assert.equal(started.run, null);
  const result = auditVerification(manual, {}, { ...manual.proposal, cwd: dir, contentDigest: 'a'.repeat(64) }, f.resolve);
  assert.equal(result.code, 'AWAITING_MANUAL');
  assert.equal(result.verdict, 'INCOMPLETE');
  assert.ok(result.manualChecklist.length > 0);
});

test('audit regression: explicit reply cannot authorize a new proposal under the same request', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  assert.equal(applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve).state, 'confirmed');
  for (const changedPolicy of [false, true]) {
    const request = structuredClone(f.request);
    if (changedPolicy) request.userCheckIds.push('review');
    const next = createSession(request, f.state.proposal);
    rejects(() => applyChoice(next, source, { kind: 'explicit-current-user-request', messageId: 'answer-1', proposalId: next.proposal.proposalId }, f.resolve), 'UNTRUSTED_ANSWER');
    assert.equal(applyChoice(next, snapshot(next, 'light', true), { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve).state, 'confirmed');
  }
});
test('audit regression: explicit answer requires the complete current displayed question', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages[1].text = questionFor(f.state).questions[0].question;
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
  source.messages.splice(1, 1);
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
test('audit regression: another displayed proposal supersedes the old explicit decision window', () => {
  const f = setup(), source = snapshot(f.state, 'light', true), next = createSession(f.request, f.state.proposal);
  source.messages.splice(2, 0, { id: 'shown-2', role: 'assistant', status: 'completed', text: displayedQuestion(next), tools: [] });
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
  assert.equal(applyChoice(next, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve).state, 'confirmed');
});
for (const status of ['completed', 'failed', 'pending']) {
  test('audit regression: a later ' + status + ' dialog in another message invalidates an old native answer', () => {
    const f = setup(), source = snapshot(f.state);
    source.messages.push({ id: 'later-question', role: 'assistant', status: 'completed', tools: [{ name: 'AskUserQuestion', status, output: fixture.protocol.unansweredOutput }] });
    rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
    if (status === 'completed') assert.equal(applyChoice(f.state, source, { kind: 'native-answer', messageId: 'later-question' }, f.resolve).state, 'awaiting_choice');
  });
}
test('audit regression: latest native selection wins across assistant messages', () => {
  const f = setup(), source = snapshot(f.state, 'light');
  source.messages.push({ ...snapshot(f.state, 'manual').messages[1], id: 'answer-2' });
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
  assert.equal(applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-2' }, f.resolve).state, 'awaiting_manual');
});
test('audit regression: completed question output can be read while its assistant turn is streaming', () => {
  const f = setup(), source = snapshot(f.state, 'light');
  source.messages[1].status = 'streaming';
  let selected;
  assert.doesNotThrow(() => { selected = applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve); });
  assert.equal(selected.state, 'confirmed');
  source.messages[1].tools[0].status = 'pending';
  rejects(() => applyChoice(f.state, source, { kind: 'native-answer', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
test('audit regression: begin copies caller arrays and preserves outcome references in storage', t => {
  const f = setup(), selected = choose(f, 'light'), expectations = expectationsFor(selected), dir = stateRoot(t);
  const running = beginVerification(selected, { runId: 'run-1', cwd: dir, contentDigest: 'a'.repeat(64), expectations }, f.resolve);
  expectations.syntax.positive.stdoutIncludes[0] = 'rewritten';
  expectations.syntax.negative.stdoutIncludes.push('extra');
  assert.deepEqual(running.run.expectations.syntax.positive.stdoutIncludes, ['syntax-positive']);
  assert.deepEqual(running.run.expectations.syntax.negative.stdoutIncludes, ['syntax-negative']);
  assert.equal(running.run.expectations.syntax.expectedOutcomeRef, 'syntax-expectation');
  const stored = JSON.parse(fs.readFileSync(saveSession(dir, running).file, 'utf8'));
  assert.equal(stored.run.expectations.syntax.expectedOutcomeRef, 'syntax-expectation');
  assert.ok(Object.isFrozen(running.run.expectations.syntax.positive.stdoutIncludes));
});
test('audit regression: replacing frozen run expectations and matching report cannot rewrite the run', t => {
  const f = syntheticAudit(t), running = structuredClone(f.running), check = f.report.checks[0];
  running.run.expectations[check.id].positive.stdoutIncludes = ['rewritten'];
  check.positive.expect.stdoutIncludes = ['rewritten'];
  f.records.get(check.positive.file).stdout = 'rewritten';
  f.writeRecord(check, 'positive'); f.write();
  assert.equal(auditVerification(running, f.evidence, f.current, f.resolve).code, 'RUN_CHANGED');
  rejects(() => saveSession(f.dir, running), 'RUN_CHANGED');
});
function singleCheck(t, positiveOnly) {
  const f = setup(), request = structuredClone(f.request), dir = stateRoot(t);
  request.userCheckIds = [];
  request.checks = request.checks.filter(c => ['syntax', 'review'].includes(c.id));
  request.checks.find(c => c.id === 'review').dependencies = ['syntax'];
  request.baselineCheckIds = ['syntax'];
  f.state = createSession(request, f.state.proposal);
  const selected = choose(f, 'light'), expectations = expectationsFor(selected);
  if (positiveOnly) delete expectations.syntax.negative;
  let running;
  assert.doesNotThrow(() => { running = beginVerification(selected, { runId: 'one', cwd: dir, contentDigest: 'a'.repeat(64), expectations }, f.resolve); });
  const direct = { schema: 1, runId: 'one', cwd: dir, level: 'static', termination: 'completed', exitCode: 0, stdout: 'syntax-positive', stderr: '',
    proposalDigest: running.proposal.proposalDigest, choiceDigest: running.run.choiceDigest, contentDigest: running.run.contentDigest };
  const evidence = { checkId: 'syntax', expectedOutcomeRef: 'syntax-expectation', direct, expect: expectations.syntax.positive, contentDigest: running.run.contentDigest };
  const current = { ...running.proposal, cwd: dir, contentDigest: running.run.contentDigest };
  return { ...f, running, evidence, current, audit: () => auditVerification(running, evidence, current, f.resolve) };
}
test('audit regression: one light observation does not require an unused negative expectation', t => {
  const f = singleCheck(t, true);
  assert.equal(f.audit().verdict, 'PASS');
  assert.deepEqual(f.audit().unexecutedOptional, ['review']);
  f.evidence.direct.stdout = 'wrong';
  assert.equal(f.audit().code, 'UNEXPECTED_RESULT');
});
for (const key of ['proposalDigest', 'choiceDigest', 'contentDigest']) {
  test('audit regression: direct record rejects stale ' + key + ' even when its wrapper is current', t => {
    const f = singleCheck(t, false);
    assert.equal(f.audit().verdict, 'PASS');
    f.evidence.direct[key] = 'f'.repeat(64);
    assert.equal(f.audit().code, 'STALE_RECORD');
  });
}
test('audit regression: a multi-check plan still requires negative expectations', t => {
  const f = setup(), selected = choose(f, 'light'), expectations = expectationsFor(selected), dir = stateRoot(t);
  delete expectations.syntax.negative;
  assert.throws(() => beginVerification(selected, { runId: 'multi', cwd: dir, contentDigest: 'a'.repeat(64), expectations }, f.resolve));
});
test('audit regression: invoking the library as a CLI is not a successful check', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'verification-session.cjs')], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /library|模块/);
});
test('review regression: an explicit choice can be updated after the current proposal is displayed again', () => {
  const f = setup(), source = snapshot(f.state, 'light', true), selector = { kind: 'explicit-current-user-request', messageId: 'answer-1' };
  const selected = applyChoice(f.state, source, selector, f.resolve);
  source.messages.push({ ...source.messages[1], id: 'shown-2' }, { id: 'answer-2', role: 'user', status: 'completed', text: '采用标准验证' });
  let updated;
  assert.doesNotThrow(() => { updated = applyChoice(selected, source, { ...selector, messageId: 'answer-2' }, f.resolve); });
  assert.equal(updated.choice.optionId, 'standard');
  rejects(() => applyChoice(selected, source, selector, f.resolve), 'UNTRUSTED_ANSWER');
  source.messages[2].text = '变更任务范围';
  rejects(() => applyChoice(selected, source, { ...selector, messageId: 'answer-2' }, f.resolve), 'SCOPE_MISMATCH');
});
test('review regression: native light to manual to light is a new answer rather than a duplicate', () => {
  const f = setup(), source = snapshot(f.state, 'light'), selector = { kind: 'native-answer', messageId: 'answer-1' };
  const selected = applyChoice(f.state, source, selector, f.resolve);
  source.messages[1].tools.push(snapshot(f.state, 'manual').messages[1].tools[0], snapshot(f.state, 'light').messages[1].tools[0]);
  let updated;
  assert.doesNotThrow(() => { updated = applyChoice(selected, source, selector, f.resolve); });
  assert.equal(updated.choice.optionId, 'light');
  assert.notEqual(updated.choice.sourceRef, selected.choice.sourceRef);
  assert.equal(applyChoice(updated, source, selector, f.resolve), updated);
});
for (const status of ['excluded', 'unverified', 'hypothesis']) {
  test('review regression: ' + status + ' with a reason preserves the legacy audit verdict without invented records', t => {
    const f = syntheticAudit(t), check = f.report.checks[0];
    check.status = status; check.reason = 'not executed';
    delete check.positive; delete check.negative; delete check.changedVariable;
    f.write();
    const expected = status === 'excluded' ? 'PARTIAL' : 'INCOMPLETE';
    assert.equal(auditFile(f.evidence.reportFile).verdict, expected);
    assert.equal(f.audit().verdict, expected);
    assert.equal(f.audit().selectedChecksVerified, false);
  });
}
test('review regression: direct scope must be explicit even when run cwd equals the process cwd', t => {
  const f = singleCheck(t, false), cwd = process.cwd();
  const running = beginVerification(f.running, { runId: 'one', cwd, contentDigest: f.running.run.contentDigest, expectations: expectationsFor(f.running) }, f.resolve);
  const current = { ...f.current, cwd }, evidence = { ...f.evidence, direct: { ...f.evidence.direct, cwd } };
  assert.equal(auditVerification(running, evidence, current, f.resolve).verdict, 'PASS');
  for (const value of [undefined, '', '.']) {
    evidence.direct.cwd = value;
    assert.equal(auditVerification(running, evidence, current, f.resolve).code, 'SCOPE_MISMATCH');
  }
});
test('review regression: cancel between two identical native choices is not a duplicate answer', () => {
  const f = setup(), source = snapshot(f.state, 'light'), selector = { kind: 'native-answer', messageId: 'answer-1' };
  const first = applyChoice(f.state, source, selector, f.resolve);
  source.messages[1].tools.push({ name: 'AskUserQuestion', status: 'completed', output: fixture.protocol.unansweredOutput }, snapshot(f.state, 'light').messages[1].tools[0]);
  let selected;
  assert.doesNotThrow(() => { selected = applyChoice(first, source, selector, f.resolve); });
  assert.equal(selected.choice.optionId, 'light');
  assert.notEqual(selected.choice.sourceRef, first.choice.sourceRef);
});
test('review regression: explicit update can follow multiple native answers for the same displayed proposal', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages[1].tools = ['light', 'manual'].map(tier => snapshot(f.state, tier).messages[1].tools[0]);
  source.messages.at(-1).text = '采用标准验证';
  let selected;
  assert.doesNotThrow(() => { selected = applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve); });
  assert.equal(selected.choice.optionId, 'standard');
  const other = createSession(f.request, f.state.proposal);
  source.messages[1].tools.push(snapshot(other, 'deep').messages[1].tools[0]);
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
test('review regression: matching native question in a later assistant message still permits the explicit update', () => {
  const f = setup(), source = snapshot(f.state, 'light', true);
  source.messages[1].tools = [];
  source.messages.splice(2, 0, { ...snapshot(f.state, 'light').messages[1], id: 'native-later' });
  source.messages.at(-1).text = '采用标准验证';
  let selected;
  assert.doesNotThrow(() => { selected = applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve); });
  assert.equal(selected.choice.optionId, 'standard');
  const other = createSession(f.request, f.state.proposal);
  source.messages[2].tools = snapshot(other, 'deep').messages[1].tools;
  rejects(() => applyChoice(f.state, source, { kind: 'explicit-current-user-request', messageId: 'answer-1' }, f.resolve), 'UNTRUSTED_ANSWER');
});
