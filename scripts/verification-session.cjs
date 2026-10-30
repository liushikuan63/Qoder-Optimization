#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePolicy, validateScope, fingerprint, POLICY_VERSION } = require('./verification-policy.cjs');
const { auditFile } = require('./evidence-audit.cjs');

const ANSWER_PREFIX = 'Your questions have been answered: ';
const ANSWER_SUFFIX = '. You can now continue with these answers in mind.';
const NO_ANSWER = 'The user did not answer the questions.';
const pairs = new Set(['shadow/shadow-study', 'assisted/isolated-trial', 'assisted/enabled-workflow']);
const union = (...arrays) => [...new Set(arrays.flat())].sort();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function checkActivation(activation) {
  if (!activation || !pairs.has(activation.mode + '/' + activation.activationKind)
      || typeof activation.activationRef !== 'string' || !activation.activationRef.trim()) fail('AUTHORITY_MISMATCH', 'explicit activation context and source reference are required');
  return { mode: activation.mode, activationKind: activation.activationKind, activationRef: activation.activationRef };
}
function createSession(request, activation) {
  const policy = evaluatePolicy(request), context = checkActivation(activation);
  const proposal = { ...policy, ...context, proposalId: crypto.randomUUID(), scopeDigest: fingerprint(validateScope(request)) };
  proposal.proposalDigest = fingerprint(proposal);
  return { schema: 1, state: 'awaiting_choice', proposal, choice: null, run: null };
}
function assertSession(session) {
  if (!session || session.schema !== 1 || !session.proposal) fail('INVALID_SESSION', 'session is required');
  const { proposalDigest, ...body } = session.proposal;
  if (fingerprint(body) !== proposalDigest) fail('PROPOSAL_CHANGED', 'proposal has changed');
  const expected = evaluatePolicy(body.request);
  for (const key of Object.keys(expected)) if (fingerprint(expected[key]) !== fingerprint(body[key])) fail('PROPOSAL_CHANGED', 'policy no longer matches the proposal');
  if (body.policyVersion !== POLICY_VERSION || body.scopeDigest !== fingerprint(validateScope(body.request))) fail('SCOPE_MISMATCH', 'invalid policy or scope');
  checkActivation(body);
  if (session.choice) {
    if (session.choice.proposalDigest !== proposalDigest || !body.options.some(o => o.optionId === session.choice.optionId)) fail('PROPOSAL_CHANGED', 'choice does not match proposal');
  }
  if (session.run && session.choice?.optionId !== 'manual') {
    const { runDigest, ...run } = session.run;
    if (!validDigest(runDigest) || fingerprint(run) !== runDigest || run.proposalDigest !== proposalDigest) fail('RUN_CHANGED', 'the frozen run has changed');
  }
}
function questionFor(session) {
  assertSession(session);
  const p = session.proposal;
  const context = p.mode === 'shadow' ? '影子评估：自动选项仍运行冻结基线与所选清单的并集，人工选项不自动运行。' : '自动选项按所选清单执行，人工选项只交接待验清单。';
  const question = `验证方案 ${p.proposalId}（摘要 ${p.proposalDigest}）：推荐${p.options[0].label}；${context}本任务选择哪种验证方式？`;
  return {
    questions: [{
      header: '验证方式', question, multiSelect: false,
      options: p.options.map(o => ({
        label: o.label,
        description: o.description,
        preview: JSON.stringify({ execution: o.execution, checks: o.execution === 'manual' ? o.manualCheckIds : effectiveFor(p, o), mandatory: p.mandatoryCheckIds, blockers: p.blockers }, null, 2),
      })),
    }],
  };
}
function displayQuestionFor(session) {
  const question = questionFor(session).questions[0];
  return [question.question, ...question.options.map(o => [o.label, o.description, o.preview].join('\n'))].join('\n\n');
}
function effectiveFor(proposal, option) {
  if (option.execution === 'manual') return [];
  return proposal.mode === 'shadow' ? union(proposal.baselineCheckIds, option.checkIds) : [...option.checkIds];
}
function assertAuthority(proposal, resolveAuthority) {
  if (typeof resolveAuthority !== 'function') fail('AUTHORITY_MISMATCH', 'the host must resolve the original user approval');
  const grant = resolveAuthority(proposal.activationRef);
  if (!grant || grant.sourceRef !== proposal.activationRef || grant.scopeDigest !== proposal.scopeDigest
      || grant.mode !== proposal.mode || grant.activationKind !== proposal.activationKind || grant.policyVersion !== POLICY_VERSION) fail('AUTHORITY_MISMATCH', 'approval does not cover this activation and scope');
}
function findMessage(snapshot, session, selector) {
  if (!snapshot || snapshot.kind !== 'qoder.chatSession.read' || snapshot.sessionId !== session.proposal.sessionId || !Array.isArray(snapshot.messages)) fail('SCOPE_MISMATCH', 'snapshot belongs to a different session');
  const messages = snapshot.messages;
  if (messages.some(m => !m || typeof m.id !== 'string' || (m.tools !== undefined && !Array.isArray(m.tools)))) fail('UNTRUSTED_ANSWER', 'snapshot messages are incomplete');
  const anchors = messages.map((m, i) => m.id === session.proposal.requestMessageId ? i : -1).filter(i => i >= 0);
  const found = messages.map((m, i) => m.id === selector.messageId ? i : -1).filter(i => i >= 0);
  if (anchors.length !== 1 || found.length !== 1 || found[0] <= anchors[0]) fail('SCOPE_MISMATCH', 'request or answer is missing, stale or ambiguous');
  if (messages[anchors[0]].role !== 'user' || messages[anchors[0]].status !== 'completed') fail('SCOPE_MISMATCH', 'request anchor is not a completed user message');
  const message = messages[found[0]];
  if (message.status !== 'completed' && !(message.role === 'assistant' && message.status === 'streaming')) fail('UNTRUSTED_ANSWER', 'answer has not completed');
  return { message, index: found[0], anchor: anchors[0], messages };
}
function displayedQuestions(messages, anchor) {
  return messages.flatMap((message, index) => {
    if (index <= anchor || message.role !== 'assistant' || typeof message.text !== 'string') return [];
    return [...message.text.matchAll(/(?:^|\n)(验证方案 [^\n]*)/g)].map(match => ({
      message, index, question: match[1], text: message.text.slice(match.index + match[0].length - match[1].length),
    }));
  });
}
function explicitOption(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim().replace(/[。.!！]$/, '');
  if (/^(?:采用|选择|用)?(?:强化|强化验证|deep)$/.test(value)) return 'deep';
  if (/^(?:采用|选择|用)?(?:标准|标准验证|standard)$/.test(value)) return 'standard';
  if (/^(?:采用|选择|用)?(?:轻量|轻量验证|light)$/.test(value)) return 'light';
  if (/^(?:采用|选择)?(?:交由人工验证|人工验证|不验证由人工验证|manual)$/.test(value)) return 'manual';
  return null;
}
function readChoice(session, snapshot, selector) {
  const { message, messages, index, anchor } = findMessage(snapshot, session, selector);
  const question = questionFor(session).questions[0].question;
  const prefix = ANSWER_PREFIX + JSON.stringify(question) + '=';
  const events = messages.flatMap((m, i) => i > anchor && m.role === 'assistant'
    ? (m.tools || []).filter(t => t?.name === 'AskUserQuestion').map(tool => ({ tool, message: m, index: i })) : []);
  const latest = events.at(-1), shown = displayedQuestions(messages, anchor).at(-1);
  if (selector.kind === 'explicit-current-user-request') {
    if (message.role !== 'user' || message.status !== 'completed' || messages.slice(index + 1).some(m => m.role === 'user')) fail('UNTRUSTED_ANSWER', 'not the current real user message');
    if (messages.slice(anchor + 1, index).some(m => m.role === 'user' && !explicitOption(m.text))) fail('SCOPE_MISMATCH', 'a new user request invalidated the decision window');
    const display = displayQuestionFor(session);
    if (!shown || shown.index >= index || !['completed', 'streaming'].includes(shown.message.status)
        || !shown.text.startsWith(display) || (shown.text.length > display.length && shown.text[display.length] !== '\n')) fail('UNTRUSTED_ANSWER', 'the current complete proposal was not displayed before this reply');
    if (latest && latest.index >= shown.index) {
      const matchingQuestion = typeof latest.tool.output === 'string' && latest.tool.output.startsWith(prefix) && latest.tool.output.endsWith(ANSWER_SUFFIX);
      const unansweredDisplay = latest.index === shown.index && latest.tool.output === NO_ANSWER;
      if (latest.index >= index || latest.tool.status !== 'completed' || (!matchingQuestion && !unansweredDisplay)) {
        fail('UNTRUSTED_ANSWER', 'another question superseded the displayed proposal');
      }
    }
    const optionId = explicitOption(message.text);
    if (!optionId) fail('UNKNOWN_OPTION', 'user text does not unambiguously select an option');
    return { optionId, sourceRef: message.id, sourceKind: selector.kind, questionSourceRef: shown.message.id };
  }
  if (selector.kind !== 'native-answer' || message.role !== 'assistant' || !Array.isArray(message.tools)) fail('UNTRUSTED_ANSWER', 'not a native question result');
  if (messages.slice(index + 1).some(m => m.role === 'user') || messages.slice(anchor + 1, index).some(m => m.role === 'user' && !explicitOption(m.text))) fail('SCOPE_MISMATCH', 'a new user request or later answer invalidated the native answer');
  if (!latest || latest.message !== message || latest.tool.status !== 'completed' || typeof latest.tool.output !== 'string') fail('UNTRUSTED_ANSWER', 'this is not the latest completed question event');
  if (shown && (shown.index > index || shown.question !== question)) fail('UNTRUSTED_ANSWER', 'a different displayed proposal superseded this answer');
  if (latest.tool.output === NO_ANSWER) {
    if (message.tools.some(t => typeof t?.output === 'string' && t.output.startsWith(prefix))) fail('UNTRUSTED_ANSWER', 'a later unanswered question invalidated the earlier result');
    return null;
  }
  const previous = events.at(-2);
  if (!latest.tool.output.startsWith(prefix) || !latest.tool.output.endsWith(ANSWER_SUFFIX)
      || (previous?.message === message && previous.tool.status === 'completed' && previous.tool.output === latest.tool.output)) fail('UNTRUSTED_ANSWER', 'native answer is missing, ambiguous or truncated');
  let label;
  try { label = JSON.parse(latest.tool.output.slice(prefix.length, -ANSWER_SUFFIX.length)); }
  catch { fail('UNTRUSTED_ANSWER', 'native answer is not a single complete selection'); }
  const option = session.proposal.options.find(o => o.label === label);
  if (!option) fail('UNKNOWN_OPTION', 'selected label is not part of this proposal');
  return { optionId: option.optionId, sourceRef: message.id + '/question/' + fingerprint(question) + '/event/' + message.tools.indexOf(latest.tool), sourceKind: selector.kind };
}
function applyChoice(session, snapshot, selector, resolveAuthority) {
  assertSession(session);
  if (!selector || typeof selector.messageId !== 'string') fail('UNTRUSTED_ANSWER', 'explicit answer source is required');
  assertAuthority(session.proposal, resolveAuthority);
  const result = readChoice(session, snapshot, selector);
  if (!result) return { ...session, state: 'awaiting_choice', choice: null, run: null };
  const choice = { ...result, proposalDigest: session.proposal.proposalDigest };
  if (session.choice && fingerprint(session.choice) === fingerprint(choice)) return session;
  const option = session.proposal.options.find(o => o.optionId === result.optionId);
  return { ...session, state: option.execution === 'manual' ? 'awaiting_manual' : 'confirmed', choice, run: null };
}
function selectedPlan(session) {
  assertSession(session);
  if (!session.choice) return { state: 'awaiting_choice', execution: null, checkIds: [], manualChecklist: [], verdict: 'INCOMPLETE' };
  const option = session.proposal.options.find(o => o.optionId === session.choice.optionId);
  const manual = option.execution === 'manual';
  return {
    state: manual ? 'awaiting_manual' : session.state, execution: option.execution, selectedTier: option.tier,
    checkIds: effectiveFor(session.proposal, option),
    manualChecklist: manual ? session.proposal.checks.filter(c => option.manualCheckIds.includes(c.id)) : [],
    mandatoryCheckIds: session.proposal.mandatoryCheckIds,
    omittedComparedToRecommended: option.omittedComparedToRecommended,
    verdict: 'INCOMPLETE',
  };
}
function stateFile(stateDir, scope, create) {
  validateScope(scope);
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('STATE_PATH', 'an explicit absolute state directory is required');
  const rootStat = fs.lstatSync(stateDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('STATE_PATH', 'state root must be a real directory');
  let dir = fs.realpathSync(stateDir);
  for (const id of [scope.sessionId, scope.taskId]) {
    const next = path.join(dir, id);
    if (!fs.existsSync(next) && create) fs.mkdirSync(next, { mode: 0o700 });
    const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('STATE_PATH', 'state directory cannot redirect outside the task');
    dir = next;
  }
  const file = path.join(dir, 'session.json');
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry && (entry.isSymbolicLink() || !entry.isFile())) fail('STATE_PATH', 'state must be a regular file');
  return file;
}
const byteHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stateBytes(file) {
  if (fs.statSync(file).size > 2 * 1024 * 1024) fail('INVALID_SESSION', 'state exceeds 2MiB');
  const bytes = fs.readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024) fail('INVALID_SESSION', 'state exceeds 2MiB');
  return bytes;
}
function saveSession(stateDir, session, expectedDigest = null) {
  assertSession(session);
  const file = stateFile(stateDir, session.proposal, true), lock = file + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('STATE_BUSY', 'another writer holds this task state'); throw error; }
  const temporary = path.join(path.dirname(file), 'state-' + crypto.randomUUID() + '.json');
  let written = false;
  try {
    stateFile(stateDir, session.proposal, false);
    const current = fs.existsSync(file) ? byteHash(stateBytes(file)) : null;
    if (current !== expectedDigest) fail('STATE_CHANGED', 'state changed since the caller read it');
    const record = { schema: 1, state: session.state, proposal: session.proposal, choice: session.choice, run: session.run };
    const bytes = Buffer.from(JSON.stringify(record, null, 2));
    if (bytes.length > 2 * 1024 * 1024) fail('INVALID_SESSION', 'state exceeds 2MiB');
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    written = true;
    fs.renameSync(temporary, file);
    written = false;
    return { file, cacheDigest: byteHash(bytes) };
  } finally {
    if (written) fs.unlinkSync(temporary);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function loadSession(stateDir, scope) {
  const file = stateFile(stateDir, scope, false);
  const bytes = stateBytes(file), saved = JSON.parse(bytes.toString('utf8'));
  assertSession(saved);
  if (saved.proposal.scopeDigest !== fingerprint(validateScope(scope))) fail('SCOPE_MISMATCH', 'cached state belongs to another scope');
  return {
    session: { schema: 1, state: 'awaiting_choice', proposal: saved.proposal, choice: null, run: null },
    cacheDigest: byteHash(bytes), previousSelection: saved.choice?.optionId || null,
    reason: 'Cached choice is not authority; re-read the real answer and resolve current approval.',
  };
}
function validDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function reassessSession(session, request, contentDigest) {
  assertSession(session);
  if (!validDigest(contentDigest)) fail('INVALID_REVISION', 'a current content SHA256 is required');
  const next = evaluatePolicy(request);
  if (next.policyDigest !== session.proposal.policyDigest) return createSession(request, session.proposal);
  if (session.run && session.run.contentDigest !== contentDigest) return { ...session, state: session.choice ? (selectedPlan(session).execution === 'manual' ? 'awaiting_manual' : 'confirmed') : 'awaiting_choice', run: null };
  return session;
}
function normalizeExpectation(value, label) {
  if (!value || !Number.isInteger(value.exitCode)) fail('INVALID_REVISION', label + ' must freeze an integer exit code');
  const out = value.stdoutIncludes === undefined ? [] : value.stdoutIncludes;
  const err = value.stderrIncludes === undefined ? [] : value.stderrIncludes;
  if (![out, err].every(a => Array.isArray(a) && a.every(s => typeof s === 'string' && s.trim().length > 0)) || out.length + err.length === 0) {
    fail('INVALID_REVISION', label + ' must freeze at least one concrete observation');
  }
  return Object.freeze({ exitCode: value.exitCode, stdoutIncludes: Object.freeze([...out]), stderrIncludes: Object.freeze([...err]) });
}
function normalizedOrNull(value) {
  try { return normalizeExpectation(value, 'expectation'); } catch { return null; }
}
function freezeExpectations(proposal, plan, supplied) {
  const { checkIds } = plan;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || fingerprint(Object.keys(supplied).sort()) !== fingerprint([...checkIds].sort())) {
    fail('EXPECTATION_MISMATCH', 'frozen expectations must cover exactly the selected checks');
  }
  const frozen = {}, single = plan.selectedTier === 'light' && checkIds.length === 1;
  for (const id of checkIds) {
    const check = proposal.checks.find(c => c.id === id);
    const item = supplied[id];
    if (!item || typeof item !== 'object' || item.expectedOutcomeRef !== check.expectedOutcomeRef) {
      fail('EXPECTATION_MISMATCH', id + ': frozen expectations must cite the planned outcome reference');
    }
    const positive = normalizeExpectation(item.positive, id + '/positive');
    if (item.negative === undefined && !single) fail('EXPECTATION_MISMATCH', id + ': a paired report needs a negative expectation');
    const negative = item.negative === undefined ? undefined : normalizeExpectation(item.negative, id + '/negative');
    if (negative && fingerprint(positive) === fingerprint(negative)) fail('EXPECTATION_MISMATCH', id + ': positive and negative expectations must differ');
    frozen[id] = Object.freeze({ expectedOutcomeRef: check.expectedOutcomeRef, positive, ...(negative ? { negative } : {}) });
  }
  return Object.freeze(frozen);
}
function beginVerification(session, run, resolveAuthority) {
  assertSession(session);
  const plan = selectedPlan(session);
  if (plan.execution === 'manual') return { ...session, state: 'awaiting_manual', run: null };
  if (!session.choice) fail('NO_CHOICE', 'verification needs a real user choice');
  assertAuthority(session.proposal, resolveAuthority);
  if (!run || !validDigest(run.contentDigest) || typeof run.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(run.runId)
      || typeof run.cwd !== 'string' || !path.isAbsolute(run.cwd)) fail('INVALID_REVISION', 'run ID, absolute cwd and content SHA256 are required');
  if (run.satisfiedPreconditions !== undefined && (!Array.isArray(run.satisfiedPreconditions) || !run.satisfiedPreconditions.every(p => typeof p === 'string' && p.length > 0))) fail('INVALID_REVISION', 'satisfiedPreconditions must be an explicit string list');
  if (!plan.checkIds.length) fail('EMPTY_PLAN', 'an automatic verification plan cannot be empty');
  if (session.proposal.blockers.length) fail('PRECONDITIONS_MISSING', 'resolve current facts before starting verification');
  const expectations = freezeExpectations(session.proposal, plan, run.expectations);
  const resolved = new Set(run.satisfiedPreconditions || []);
  const missing = session.proposal.checks.filter(c => plan.checkIds.includes(c.id)).flatMap(c => c.preconditions).filter(p => !resolved.has(p));
  if (missing.length) fail('PRECONDITIONS_MISSING', 'resolve the selected check preconditions first');
  const cwd = fs.realpathSync(run.cwd);
  if (!fs.statSync(cwd).isDirectory()) fail('INVALID_REVISION', 'cwd must be a directory');
  const frozen = { runId: run.runId, cwd, contentDigest: run.contentDigest, proposalDigest: session.proposal.proposalDigest,
    choiceDigest: fingerprint(session.choice), checkIds: Object.freeze([...plan.checkIds]), expectations };
  return { ...session, state: 'verifying', run: Object.freeze({ ...frozen, runDigest: fingerprint(frozen) }) };
}
function incomplete(code, message, verdict = 'INCOMPLETE') {
  return { verdict, exitCode: verdict === 'ERROR' ? 2 : 1, code, issues: [message], selectedChecksVerified: false };
}
function auditVerification(session, evidence, current, resolveAuthority) {
  try {
    assertSession(session);
    const plan = selectedPlan(session);
    if (plan.execution === 'manual') return { ...incomplete('AWAITING_MANUAL', 'Manual verification is pending; no automatic checks ran.'), state: 'awaiting_manual', manualChecklist: plan.manualChecklist };
    if (!session.choice || !session.run) return incomplete('NO_RUN', 'a selected plan and this run are required');
    assertAuthority(session.proposal, resolveAuthority);
    if (!current || fingerprint(validateScope(current)) !== session.proposal.scopeDigest) return incomplete('SCOPE_MISMATCH', 'current scope differs from the selected proposal', 'FAIL');
    if (!validDigest(current.contentDigest) || current.contentDigest !== session.run.contentDigest || evidence?.contentDigest !== session.run.contentDigest) return incomplete('STALE_EVIDENCE', 'evidence is not for the current content revision');
    if (fs.realpathSync(current.cwd) !== session.run.cwd) return incomplete('SCOPE_MISMATCH', 'current cwd changed', 'FAIL');
    if (session.run.choiceDigest !== fingerprint(session.choice) || fingerprint(session.run.checkIds) !== fingerprint(plan.checkIds)) return incomplete('PLAN_CHANGED', 'the selected check set changed after the run began', 'FAIL');
    if (evidence.direct) return auditSingleCheck(session, evidence, plan);
    if (typeof evidence.reportFile !== 'string' || !path.isAbsolute(evidence.reportFile)) return incomplete('MISSING_REPORT', 'an absolute report file is required');
    const bytes = stateBytes(evidence.reportFile), report = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(report.checks)) return incomplete('INVALID_REPORT', 'report checks must be an array', 'ERROR');
    const ids = report.checks.map(c => c?.id);
    if (new Set(ids).size !== ids.length || fingerprint([...ids].sort()) !== fingerprint(plan.checkIds)) return incomplete('CHECK_SET_MISMATCH', 'actual report must contain exactly the selected checks', 'FAIL');
    if (report.runId !== session.run.runId || report.task !== session.proposal.taskId || path.resolve(report.cwd || '') !== session.run.cwd) return incomplete('SCOPE_MISMATCH', 'report belongs to another task, run or cwd', 'FAIL');
    if (report.proposalDigest !== session.proposal.proposalDigest || report.choiceDigest !== session.run.choiceDigest || report.contentDigest !== session.run.contentDigest) {
      return incomplete('STALE_REPORT', 'report is not bound to this proposal, choice and content revision', 'FAIL');
    }
    const definitions = new Map(session.proposal.checks.map(c => [c.id, c]));
    if (report.checks.some(c => c.requiredLevel !== definitions.get(c.id).evidenceType)) return incomplete('EVIDENCE_TYPE_MISMATCH', 'report evidence types differ from the chosen requirements', 'FAIL');
    const frozen = session.run.expectations || {};
    for (const check of report.checks) {
      if (check.status !== 'verified') continue;
      const planned = frozen[check.id];
      const positive = normalizedOrNull(check.positive?.expect), negative = normalizedOrNull(check.negative?.expect);
      if (!planned?.negative || !positive || !negative || fingerprint(positive) !== fingerprint(planned.positive) || fingerprint(negative) !== fingerprint(planned.negative)) {
        return incomplete('EXPECTATION_MISMATCH', 'report expectations differ from the frozen independent expectations', 'FAIL');
      }
    }
    const result = auditFile(evidence.reportFile);
    if (byteHash(stateBytes(evidence.reportFile)) !== byteHash(bytes)) return incomplete('REPORT_CHANGED', 'report changed while it was being audited', 'FAIL');
    return { ...result, selectedChecksVerified: result.verdict === 'PASS', verifiedScope: result.verdict === 'PASS' ? 'selected' : null, unexecutedOptional: session.proposal.options.find(o => o.tier === 'deep').checkIds.filter(id => !plan.checkIds.includes(id)) };
  } catch (error) {
    return incomplete(error.code || 'INVALID_REPORT', error.message, error.code === 'ENOENT' ? 'INCOMPLETE' : error.code === 'RUN_CHANGED' ? 'FAIL' : 'ERROR');
  }
}
function auditSingleCheck(session, evidence, plan) {
  if (plan.selectedTier !== 'light' || plan.checkIds.length !== 1) return incomplete('SINGLE_CHECK_ONLY', 'direct evidence is only for one light check', 'FAIL');
  const check = session.proposal.checks.find(c => c.id === plan.checkIds[0]);
  const record = evidence.direct;
  if (evidence.checkId !== check.id || evidence.expectedOutcomeRef !== check.expectedOutcomeRef) return incomplete('EXPECTATION_MISMATCH', 'independent expectation reference does not match the planned check', 'FAIL');
  if (!record || record.schema !== 1 || record.termination !== 'completed' || !Number.isInteger(record.exitCode) || typeof record.stdout !== 'string' || typeof record.stderr !== 'string') return incomplete('INCOMPLETE_RECORD', 'direct check did not complete normally');
  if (record.runId !== session.run.runId || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd) || path.resolve(record.cwd) !== session.run.cwd || record.level !== check.evidenceType) return incomplete('SCOPE_MISMATCH', 'direct evidence has the wrong scope or type', 'FAIL');
  if (record.proposalDigest !== session.proposal.proposalDigest || record.choiceDigest !== session.run.choiceDigest || record.contentDigest !== session.run.contentDigest) return incomplete('STALE_RECORD', 'direct record is not bound to this proposal, choice and content revision', 'FAIL');
  const frozen = session.run.expectations?.[check.id]?.positive, supplied = normalizedOrNull(evidence.expect);
  if (!frozen || !supplied || fingerprint(supplied) !== fingerprint(frozen)) return incomplete('EXPECTATION_MISMATCH', 'direct expectation differs from the independent expectation frozen before the run', 'FAIL');
  if (record.exitCode !== frozen.exitCode || !frozen.stdoutIncludes.every(s => record.stdout.includes(s)) || !frozen.stderrIncludes.every(s => record.stderr.includes(s))) return incomplete('UNEXPECTED_RESULT', 'direct observation did not match its frozen independent expectation', 'FAIL');
  return { verdict: 'PASS', exitCode: 0, selectedChecksVerified: true, verifiedScope: 'selected', checkIds: plan.checkIds,
    unexecutedOptional: session.proposal.options.find(o => o.tier === 'deep').checkIds.filter(id => !plan.checkIds.includes(id)),
    limits: 'Only this one current observation is verified; origin and expectation independence still need host verification.' };
}
module.exports = { createSession, questionFor, displayQuestionFor, applyChoice, selectedPlan, assertSession, saveSession, loadSession, reassessSession, beginVerification, auditVerification };
if (require.main === module) {
  console.error('verification-session is a library, not a CLI check; import its functions or run node --test scripts/verification-session.test.js');
  process.exitCode = 2;
}
