#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./convention-core.cjs');
const engineering = require('./convention-engineering.cjs');
const i18n = require('./convention-i18n.cjs');

const RANGES = { local: '本地实现', isolated: '隔离试点', project: '指定项目试点', staged: '逐段选择' };
const METHODS = { automated: '自动验证', split: '分工验证', manual: '交由用户验证' };
const PHASES = ['local', 'isolated', 'project'];
const ANSWER_PREFIX = 'Your questions have been answered: ';
const ANSWER_SUFFIX = '. You can now continue with these answers in mind.';
const NO_ANSWER = 'The user did not answer the questions.';
const issuedReceipts = new Set();
function seal(value, key) { const body = core.copy(value); body[key] = core.hash(body); return core.freeze(body); }
function assertSealed(value, key) { const { [key]: digest, ...body } = value || {}; if (!digest || core.hash(body) !== digest) core.fail('STATE_CHANGED', key + ' does not match current data'); }
function prepare(bundle, definition) {
  core.assertPackage(bundle);
  if (!definition || !core.text(definition.requestMessageId) || !Array.isArray(definition.checks) || definition.checks.length > 100) core.fail('INVALID_PLAN', 'request source and check definitions are required');
  const ids = new Set();
  for (const check of definition.checks) {
    if (!core.CHECKS.includes(check?.id) || ids.has(check.id) || !PHASES.includes(check.phase) || !['static', 'runtime', 'review', 'artifact'].includes(check.level)
        || !check.input || !core.text(check.expectationRef)) core.fail('INVALID_PLAN', 'each check needs a unique trusted ID, phase, input, evidence type and independent expectation reference');
    ids.add(check.id);
    if (core.projectRoot(check.input.projectRoot) !== bundle.project.root || (check.input.snapshotMode || 'working-tree') !== bundle.snapshotMode) core.fail('SCOPE_MISMATCH', 'checker root or snapshot mode differs from the task');
    const inputIds = [check.input.style ? 'style.syntax' : null, check.input.dependencies ? 'dependencies.lock' : null, check.input.versions ? 'versions.range' : null,
      ...(check.input.commands || []).map(c => c.id), ...(check.input.reviews || []).map(c => c.id)].filter(Boolean);
    if (check.id === 'i18n.catalog' ? inputIds.length !== 0 : inputIds.length !== 1 || inputIds[0] !== check.id) core.fail('CHECK_SET_CHANGED', 'each plan input must request exactly its own check before execution');
    if ((check.input.files || []).some(file => !bundle.files.some(f => f.path === file))) core.fail('SCOPE_MISMATCH', 'checker files are outside the planned task');
    const bindings = bundle.decisions.flatMap(d => d.bindings || []).filter(b => b.checkIds.includes(check.id));
    const checkedFiles = check.id === 'i18n.catalog'
      ? [...i18n.sourceFiles(bundle.project.root, check.input.sourceRoots, bundle.snapshotMode), ...Object.values(check.input.catalog?.namespaces || {}).flatMap(Object.values)]
      : check.input.files || [];
    if (checkedFiles.some(file => !bundle.files.some(f => f.path === file)) || bindings.some(b => !checkedFiles.includes(b.file))) core.fail('SCOPE_MISMATCH', 'checker scope differs from the task or omitted a required convention file');
    if (check.id.endsWith('.review')) {
      if (bindings.length && check.input.reviews[0].requirementsDigest !== core.hash(bindings)) core.fail('EXPECTATION_MISMATCH', 'review must bind the resolved requirements');
    } else for (const binding of bindings) {
      let observed;
      if (binding.key === 'commandDigest' && check.input.commands?.length === 1) observed = engineering.commandDigest(check.input.commands[0]);
      else {
        const config = check.id === 'style.syntax' ? check.input.style : check.id === 'dependencies.lock' ? check.input.dependencies : check.id === 'versions.range' ? check.input.versions : check.id === 'i18n.catalog' ? check.input.catalog : null;
        if (!config || !Object.hasOwn(config, binding.key)) core.fail('EXPECTATION_MISMATCH', 'checker does not implement the resolved requirement: ' + binding.key);
        observed = config[binding.key];
      }
      if (core.hash(observed) !== core.hash(binding.value)) core.fail('EXPECTATION_MISMATCH', 'checker input contradicts the resolved convention');
    }
  }
  if (bundle.requiredCheckIds.some(id => !ids.has(id))) core.fail('REQUIRED_CHECK_MISSING', 'plan lost a required convention check');
  const proposal = seal({ schema: 1, version: core.VERSION, proposalId: crypto.randomUUID(), packageDigest: bundle.packageDigest, scopeDigest: bundle.scopeDigest, taskId: bundle.taskId, sessionId: bundle.sessionId, requestMessageId: definition.requestMessageId, checks: definition.checks }, 'proposalDigest');
  return core.freeze({ schema: 1, state: 'awaiting_selection', bundle, proposal, selection: null });
}
function assertSession(session) {
  core.assertPackage(session?.bundle); assertSealed(session.proposal, 'proposalDigest');
  if (session.proposal.packageDigest !== session.bundle.packageDigest || session.proposal.scopeDigest !== session.bundle.scopeDigest) core.fail('SCOPE_MISMATCH', 'proposal and convention package differ');
  if (session.selection) {
    assertSealed(session.selection, 'selectionDigest');
    if (session.selection.proposalDigest !== session.proposal.proposalDigest) core.fail('STALE_SELECTION', 'selection belongs to another proposal');
  }
}
function questions(session) {
  assertSession(session);
  const id = session.proposal.proposalId;
  return { questions: [
    { header: '试点范围', question: `方案 ${id}：本轮推进到哪个试点范围？`, multiSelect: false, options: [
      { label: RANGES['local'], description: '只做本仓库实现及本地检查，不运行真实前端或 Agent 试点。' },
      { label: RANGES.isolated, description: '增加独立目录内的隔离试点，不触及业务项目与现役环境。' },
      { label: RANGES.project, description: '仅在另外明确的项目路径与读写范围内试点，不自动部署。' },
      { label: RANGES.staged, description: '先到本地阶段，进入下一段前重新选择；现役启用始终单独批准。' },
    ] },
    { header: '验证方式', question: `方案 ${id}：由谁执行所选范围的验证？`, multiSelect: false, options: [
      { label: METHODS.automated, description: '自动运行获准清单；授权和证据条件仍独立保留。' },
      { label: METHODS.split, description: '本地检查自动执行，其余已选试点由用户验证并分别登记。' },
      { label: METHODS.manual, description: '不自动运行检查，交付步骤、独立预期与反例；保持未验证。' },
    ] },
  ] };
}
function parseAnswer(output, requested) {
  if (output === NO_ANSWER) return null;
  if (!output.startsWith(ANSWER_PREFIX) || !output.endsWith(ANSWER_SUFFIX)) core.fail('ANSWER_INCOMPLETE', 'native answer is incomplete');
  let body = output.slice(ANSWER_PREFIX.length, -ANSWER_SUFFIX.length);
  const pairs = new Map();
  while (body.length) {
    const pair = body.match(/^\s*("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*|$)/);
    if (!pair) core.fail('ANSWER_INCOMPLETE', 'native answer has an unsupported format');
    const key = JSON.parse(pair[1]);
    if (pairs.has(key)) core.fail('ANSWER_AMBIGUOUS', 'duplicate question answer');
    pairs.set(key, JSON.parse(pair[2])); body = body.slice(pair[0].length);
  }
  if (pairs.size !== requested.length || requested.some(q => !pairs.has(q.question))) core.fail('STALE_SELECTION', 'answer is not for this complete proposal');
  return requested.map(q => { const label = pairs.get(q.question); if (!q.options.some(o => o.label === label)) core.fail('UNKNOWN_CHOICE', 'answer label was not offered'); return label; });
}
function select(session, snapshot, answerMessageId, resolveApproval) {
  assertSession(session);
  if (snapshot?.kind !== 'qoder.chatSession.read' || snapshot.sessionId !== session.bundle.sessionId || !Array.isArray(snapshot.messages)) core.fail('SCOPE_MISMATCH', 'answer snapshot belongs to another session');
  const messages = snapshot.messages;
  if (new Set(messages.map(m => m?.id)).size !== messages.length) core.fail('ANSWER_AMBIGUOUS', 'message IDs are not unique');
  const anchor = messages.findIndex(m => m.id === session.proposal.requestMessageId && m.role === 'user' && m.status === 'completed');
  const answerIndex = messages.findIndex(m => m.id === answerMessageId);
  if (anchor < 0 || answerIndex <= anchor || messages[answerIndex].role !== 'assistant') core.fail('ANSWER_UNTRUSTED', 'request or native answer anchor is missing');
  if (messages.slice(anchor + 1).some(m => m.role === 'user')) core.fail('STALE_SELECTION', 'a newer user request invalidated the selection window');
  const tools = messages.slice(anchor + 1).flatMap((m, offset) => (m.tools || []).filter(t => t.name === 'AskUserQuestion').map(t => ({ ...t, messageId: m.id, messageIndex: anchor + 1 + offset })));
  const last = tools.at(-1);
  if (!last || last.messageId !== answerMessageId || last.status !== 'completed' || typeof last.output !== 'string' || !['completed', 'streaming'].includes(messages[answerIndex].status)) core.fail('ANSWER_UNTRUSTED', 'selection is not the latest completed native question');
  const labels = parseAnswer(last.output, questions(session).questions);
  if (!labels) return core.freeze({ ...session, state: 'awaiting_selection', selection: null });
  const range = Object.keys(RANGES).find(k => RANGES[k] === labels[0]), method = Object.keys(METHODS).find(k => METHODS[k] === labels[1]);
  const sourceRef = answerMessageId + '/' + core.hash(last.output);
  const selection = seal({ proposalDigest: session.proposal.proposalDigest, range, method, sourceRef }, 'selectionDigest');
  if (method !== 'manual') assertApproval(session, selection, resolveApproval);
  return core.freeze({ ...session, state: method === 'manual' ? 'awaiting_manual' : 'selected', selection });
}
function assertApproval(session, selection, resolveApproval) {
  const grant = typeof resolveApproval === 'function' && resolveApproval(selection.sourceRef);
  if (!grant || grant.sourceRef !== selection.sourceRef || grant.proposalDigest !== session.proposal.proposalDigest || grant.packageDigest !== session.bundle.packageDigest
      || grant.range !== selection.range || grant.method !== selection.method || grant.taskId !== session.bundle.taskId || grant.worktreeId !== session.bundle.project.worktreeId) core.fail('APPROVAL_MISSING', 'current host approval must bind the answer, task, proposal and selected range');
  return grant;
}
function selectedPlan(session) {
  assertSession(session);
  if (!session.selection) return { automatic: [], manual: [], unselected: session.proposal.checks.map(c => c.id), state: 'awaiting_selection' };
  const { range, method } = session.selection;
  const max = range === 'staged' ? 0 : PHASES.indexOf(range);
  const chosen = session.proposal.checks.filter(c => PHASES.indexOf(c.phase) <= max);
  const automatic = method === 'manual' ? [] : chosen.filter(c => method === 'automated' || c.phase === 'local');
  return { automatic, manual: chosen.filter(c => !automatic.includes(c)), unselected: session.proposal.checks.filter(c => !chosen.includes(c)).map(c => c.id), state: method === 'manual' ? 'awaiting_manual' : 'selected' };
}
function environment() {
  const dependencies = core.dependencies();
  const sources = ['convention-core.cjs', 'convention-engineering.cjs', 'convention-i18n.cjs', 'convention-session.cjs', 'convention-runtime/index.cjs', 'convention-runtime/package-lock.json'].map(file => ({ file, sha256: core.hash(fs.readFileSync(path.join(__dirname, file))) }));
  function installed(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.bin') continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) core.fail('DEPENDENCY_CHANGED', 'runtime dependency redirects are not supported');
      if (entry.isDirectory()) installed(file);
      else if (/\.(?:cjs|mjs|js|json|node|wasm)$/.test(entry.name)) sources.push({ file: path.relative(__dirname, file), sha256: core.hash(fs.readFileSync(file)) });
    }
  }
  installed(path.join(__dirname, 'convention-runtime/node_modules'));
  const actual = { node: process.version, executable: fs.realpathSync.native(process.execPath), executableDigest: core.hash(fs.readFileSync(process.execPath)), acorn: dependencies.acorn.version, paths: core.hash({ PATH: process.env.PATH || process.env.Path || '', NODE_PATH: process.env.NODE_PATH || '' }), sources };
  return { ...actual, digest: core.hash(actual) };
}
function currentState(session) {
  const root = session.bundle.project.root;
  if (core.identity(root).worktreeId !== session.bundle.project.worktreeId) core.fail('SCOPE_MISMATCH', 'worktree identity changed');
  for (const source of session.bundle.sources) core.verifySource(root, source);
  for (const check of selectedPlan(session).automatic.filter(c => c.id === 'i18n.catalog')) {
    const input = check.input;
    const sources = i18n.sourceFiles(root, input.sourceRoots, input.snapshotMode || 'working-tree');
    const catalogs = Object.values(input.catalog?.namespaces || {}).flatMap(Object.values);
    if ([...sources, ...catalogs].some(file => !session.bundle.files.some(f => f.path === file))) core.fail('SCOPE_MISMATCH', 'source reference closure expanded; refresh the task package');
  }
  const files = session.bundle.files.map(f => f.path);
  const current = core.snapshot(root, files, session.bundle.snapshotMode);
  const commands = selectedPlan(session).automatic.filter(c => c.phase === 'local').flatMap(c => c.input.commands || []).map(command => {
    const commandDigest = engineering.commandDigest(command);
    try {
      if (!path.isAbsolute(command.executable || '') || !Array.isArray(command.inputs)) return { commandDigest, error: 'INVALID_COMMAND' };
      const executable = fs.realpathSync.native(command.executable);
      return { commandDigest, executable, sha256: core.hash(fs.readFileSync(executable)), inputs: command.inputs.map(source => core.snapshot(root, [source.path]).digest) };
    } catch (error) { return { commandDigest, error: error.code || 'COMMAND_UNAVAILABLE' }; }
  });
  return { contentDigest: current.digest, environmentDigest: core.hash({ runtime: environment().digest, commands }) };
}
function run(session, resolveApproval, checkerAuthority = {}) {
  assertSession(session);
  const plan = selectedPlan(session);
  if (!session.selection) return { status: 'UNVERIFIED', exitCode: 2, state: 'awaiting_selection', executed: 0 };
  if (session.selection.method === 'manual') return { status: 'UNVERIFIED', exitCode: 2, state: 'awaiting_manual', executed: 0, manualChecklist: plan.manual, unselected: plan.unselected };
  assertApproval(session, session.selection, resolveApproval);
  if (!session.bundle.ready) return { status: 'UNVERIFIED', exitCode: 2, state: 'needs_evidence', executed: 0, decisions: session.bundle.decisions };
  if (session.bundle.mode === 'read-only') return { status: 'UNVERIFIED', exitCode: 2, state: 'read_only', executed: 0 };
  const before = currentState(session), results = [];
  for (const check of plan.automatic) {
    if (check.phase !== 'local') {
      results.push({ id: check.id, status: 'UNVERIFIED', level: check.level, issues: ['real pilot execution requires a separately approved host runner'] }); continue;
    }
    const input = { ...core.copy(check.input), taskId: session.bundle.taskId, mode: session.bundle.mode };
    let observed;
    if (check.id === 'i18n.catalog') {
      observed = i18n.check(input, checkerAuthority);
    } else {
      const report = engineering.check(input, checkerAuthority);
      if (report.checks.length !== 1 || report.checks[0].id !== check.id) core.fail('CHECK_SET_CHANGED', 'checker input must execute exactly one planned check');
      observed = report.checks[0];
    }
    const level = observed.level || observed.record?.level;
    if (observed.status === 'PASS' && level !== check.level) observed = { id: check.id, status: 'UNVERIFIED', issues: ['evidence type differs from the independent plan'], level: level || null };
    results.push(observed);
  }
  const after = currentState(session);
  if (core.hash(before) !== core.hash(after)) return { status: 'UNVERIFIED', exitCode: 2, state: 'changed_during_run', executed: results.length, results };
  const result = core.aggregate([...results, ...plan.manual.map(c => ({ id: c.id, status: 'UNVERIFIED', issues: ['awaiting user verification'] }))]);
  const receipt = seal({ schema: 1, version: core.VERSION, taskId: session.bundle.taskId, worktreeId: session.bundle.project.worktreeId, packageDigest: session.bundle.packageDigest, proposalDigest: session.proposal.proposalDigest, selectionDigest: session.selection.selectionDigest,
    runId: crypto.randomUUID(), ...before, createdAt: new Date().toISOString(), ...result, unselected: plan.unselected, verifiedScope: 'selected-local-checks', limits: 'Receipt verifies these provided records and current inputs, not the authenticity of host approvals or real user/production behavior.' }, 'receiptDigest');
  issuedReceipts.add(receipt.receiptDigest);
  if (issuedReceipts.size > 1000) issuedReceipts.delete(issuedReceipts.values().next().value);
  return { ...receipt, executed: results.length };
}
function auditReceipt(session, receipt, resolveApproval, resolveReceipt) {
  try {
    assertSession(session);
    if (!session.selection || session.selection.method === 'manual') return { status: 'UNVERIFIED', exitCode: 2, reason: 'awaiting selection or manual verification' };
    assertApproval(session, session.selection, resolveApproval);
    const { executed, ...sealed } = receipt || {};
    assertSealed(sealed, 'receiptDigest');
    if (!issuedReceipts.has(receipt.receiptDigest)) {
      const trusted = typeof resolveReceipt === 'function' && resolveReceipt(receipt.receiptDigest);
      if (!trusted || core.hash(trusted) !== core.hash(sealed)) core.fail('RECEIPT_ORIGIN_UNKNOWN', 'persisted receipts need the original host record, not a self-declared digest');
    }
    const now = currentState(session);
    if (receipt.taskId !== session.bundle.taskId || receipt.worktreeId !== session.bundle.project.worktreeId || receipt.packageDigest !== session.bundle.packageDigest
        || receipt.proposalDigest !== session.proposal.proposalDigest || receipt.selectionDigest !== session.selection.selectionDigest || receipt.contentDigest !== now.contentDigest || receipt.environmentDigest !== now.environmentDigest) core.fail('STALE_RECEIPT', 'content, environment, policy or selection changed');
    const plan = selectedPlan(session), ids = [...plan.automatic, ...plan.manual].map(c => c.id).sort();
    if (core.hash(ids) !== core.hash(receipt.checks.map(c => c.id).sort()) || new Set(receipt.checks.map(c => c.id)).size !== receipt.checks.length) core.fail('CHECK_SET_CHANGED', 'receipt lost a required check');
    return { ...core.aggregate(receipt.checks), verifiedScope: 'selected-local-checks', limits: receipt.limits };
  } catch (error) { return { status: 'UNVERIFIED', exitCode: 2, code: error.code || 'INVALID_RECEIPT', reason: error.message }; }
}
function hookView(session, receipt, resolveApproval) {
  const result = auditReceipt(session, receipt, resolveApproval);
  return { status: result.status, verified: result.status === 'PASS', message: result.reason || 'Only local receipt freshness was checked; no checks or commands were executed.', blocksHost: false };
}
function save(file, session, expectedDigest = null) {
  assertSession(session);
  if (session.bundle.mode === 'read-only') core.fail('READ_ONLY', 'read-only mode writes no cache or state');
  if (!path.isAbsolute(file) || !fs.existsSync(path.dirname(file)) || fs.lstatSync(path.dirname(file)).isSymbolicLink()) core.fail('STATE_PATH', 'state requires an explicit real directory');
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) core.fail('STATE_PATH', 'state must be a regular file');
  const lock = file + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') core.fail('STATE_BUSY', 'another writer owns the task state'); throw error; }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const previous = fs.existsSync(file) ? core.hash(fs.readFileSync(file)) : null;
    if (previous !== expectedDigest) core.fail('STATE_CHANGED', 'cached state changed since it was read');
    const data = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(data) > core.MAX_BYTES) core.fail('STATE_LIMIT', 'cached state exceeds 2MiB');
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file);
    return { file, digest: core.hash(data) };
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); fs.closeSync(fd); fs.unlinkSync(lock); }
}
function load(file) { const cached = core.readJson(file); assertSession(cached); return core.freeze({ ...cached, state: 'awaiting_selection', selection: null }); }
module.exports = { RANGES, METHODS, prepare, questions, select, selectedPlan, assertSession, environment, currentState, run, auditReceipt, hookView, save, load };
if (require.main === module) core.cli(args => {
  if (args[0] === 'prepare' && args.length === 2) { const input = core.readJson(args[1]); const session = prepare(input.bundle, input.plan); return { session, ...questions(session) }; }
  if (args[0] === 'run' && args.length === 4) {
    const input = core.readJson(args[1]), snapshot = core.readJson(args[2]), approval = core.readJson(args[3]);
    const resolve = sourceRef => approval.grants?.find(g => g.sourceRef === sourceRef);
    return run(select(load(args[1]), snapshot, input.answerMessageId || approval.answerMessageId, resolve), resolve, approval.checkers || {});
  }
  core.fail('USAGE', 'node convention-session.cjs prepare <input.json> | run <session.json> <native-snapshot.json> <host-approval.json>');
});
