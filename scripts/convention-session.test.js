'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./convention-core.cjs');
const session = require('./convention-session.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.cjs'), "'use strict';\nmodule.exports = 1;\n");
  fs.writeFileSync(path.join(root, 'rules.json'), '{"modules":"commonjs"}');
  const source = { path: 'rules.json', sha256: core.hash(fs.readFileSync(path.join(root, 'rules.json'))) };
  const rule = { id: 'cjs', dimension: 'coding-style', key: 'modules', value: 'commonjs', scope: '.', kind: 'policy', overridable: false, checkIds: ['style.syntax'], source };
  const request = { schema: 1, projectRoot: root, taskId: 't', sessionId: 's', mode: 'write', files: ['a.cjs'], applicability: Object.fromEntries(core.DIMENSIONS.map(d => [d, { applies: d === 'coding-style', reason: 'scoped task', source }])), rules: [rule] };
  const untrusted = core.resolve(request);
  const authority = { taskId: 't', sessionId: 's', worktreeId: untrusted.project.worktreeId, scopeDigest: untrusted.scopeDigest, sources: [{ ...source, ruleDigests: [core.hash(rule)] }] };
  const bundle = core.resolve(request, authority);
  const plan = { requestMessageId: 'request', checks: [{ id: 'style.syntax', phase: 'local', level: 'static', expectationRef: 'policy:commonjs', input: { schema: 1, projectRoot: root, files: ['a.cjs'], style: { modules: 'commonjs', quotes: 'single' } } }] };
  const prepared = session.prepare(bundle, plan);
  function choose(range = 'local', method = 'automated', target = prepared) {
    const qs = session.questions(target).questions;
    const output = 'Your questions have been answered: ' + qs.map((q, i) => JSON.stringify(q.question) + '=' + JSON.stringify(i === 0 ? session.RANGES[range] : session.METHODS[method])).join(', ') + '. You can now continue with these answers in mind.';
    const snapshot = { kind: 'qoder.chatSession.read', sessionId: 's', messages: [{ id: 'request', role: 'user', status: 'completed', text: 'implement' }, { id: 'answer', role: 'assistant', status: 'completed', tools: [{ name: 'AskUserQuestion', status: 'completed', output }] }] };
    const sourceRef = 'answer/' + core.hash(output);
    const grant = { sourceRef, proposalDigest: target.proposal.proposalDigest, packageDigest: target.bundle.packageDigest, range, method, taskId: 't', worktreeId: target.bundle.project.worktreeId };
    const resolve = ref => ref === sourceRef ? grant : null;
    return { snapshot, resolve, grant, selected: session.select(target, snapshot, 'answer', resolve) };
  }
  return { root, bundle, request, plan, prepared, choose };
}
test('range choices and manual verification are independent native questions', t => {
  const f = fixture(t), q = session.questions(f.prepared);
  assert.equal(q.questions.length, 2); assert.equal(q.questions[0].options.length, 4);
  assert.equal(q.questions[1].options.length, 3); assert.ok(q.questions[1].options.some(o => o.label === '交由用户验证'));
});
test('no answer or cancellation starts nothing', t => {
  const f = fixture(t); assert.equal(session.run(f.prepared).executed, 0);
  const answer = f.choose(); answer.snapshot.messages[1].tools[0].output = 'The user did not answer the questions.';
  const cancelled = session.select(f.prepared, answer.snapshot, 'answer');
  assert.equal(cancelled.selection, null); assert.equal(session.run(cancelled).status, 'UNVERIFIED');
});
test('manual mode does not call a checker, source reader or approval resolver', t => {
  const f = fixture(t), selected = f.choose('local', 'manual').selected;
  fs.unlinkSync(path.join(f.root, 'a.cjs'));
  const r = session.run(selected, () => { throw new Error('must not be called'); });
  assert.equal(r.executed, 0); assert.equal(r.state, 'awaiting_manual'); assert.equal(r.manualChecklist.length, 1);
});
test('staged selection never implicitly authorizes a later phase', t => {
  const f = fixture(t);
  f.plan.checks.push({ id: 'architecture.review', phase: 'project', level: 'review', expectationRef: 'architecture', input: { schema: 1, projectRoot: f.root, files: ['a.cjs'], reviews: [{ id: 'architecture.review' }] } });
  const prepared = session.prepare(f.bundle, f.plan);
  const selected = f.choose('staged', 'automated', prepared).selected;
  assert.equal(session.selectedPlan(selected).automatic.length, 1);
  assert.deepEqual(session.selectedPlan(selected).unselected, ['architecture.review']);
});
test('split mode retains manual pilot obligations instead of assuming success', t => {
  const f = fixture(t);
  f.plan.checks.push({ id: 'architecture.review', phase: 'isolated', level: 'review', expectationRef: 'architecture', input: { schema: 1, projectRoot: f.root, files: ['a.cjs'], reviews: [{ id: 'architecture.review' }] } });
  const prepared = session.prepare(f.bundle, f.plan), choice = f.choose('isolated', 'split', prepared);
  const r = session.run(choice.selected, choice.resolve);
  assert.equal(r.executed, 1); assert.equal(r.status, 'UNVERIFIED'); assert.equal(r.checks.length, 2);
});
test('cross-session, cross-proposal and later user messages invalidate selection', t => {
  const f = fixture(t), c = f.choose();
  const wrong = core.copy(c.snapshot); wrong.sessionId = 'other';
  assert.throws(() => session.select(f.prepared, wrong, 'answer', c.resolve), { code: 'SCOPE_MISMATCH' });
  assert.throws(() => session.select(session.prepare(f.bundle, f.plan), c.snapshot, 'answer', c.resolve), { code: 'STALE_SELECTION' });
  c.snapshot.messages.push({ id: 'later', role: 'user', status: 'completed', text: 'cancel' });
  assert.throws(() => session.select(f.prepared, c.snapshot, 'answer', c.resolve), { code: 'STALE_SELECTION' });
});
test('the latest question must be the selected completed question', t => {
  const f = fixture(t), c = f.choose();
  c.snapshot.messages.push({ id: 'later', role: 'assistant', status: 'completed', tools: [{ name: 'AskUserQuestion', status: 'completed', output: 'The user did not answer the questions.' }] });
  assert.throws(() => session.select(f.prepared, c.snapshot, 'answer', c.resolve), { code: 'ANSWER_UNTRUSTED' });
});
test('completed native answers in streaming assistant messages are accepted', t => {
  const f = fixture(t), c = f.choose(); c.snapshot.messages[1].status = 'streaming';
  assert.equal(session.select(f.prepared, c.snapshot, 'answer', c.resolve).state, 'selected');
  c.snapshot.messages[1].tools[0].status = 'running';
  assert.throws(() => session.select(f.prepared, c.snapshot, 'answer', c.resolve), { code: 'ANSWER_UNTRUSTED' });
});
test('scope choice is not a substitute for host operation approval', t => {
  const f = fixture(t), c = f.choose();
  assert.throws(() => session.select(f.prepared, c.snapshot, 'answer', () => null), { code: 'APPROVAL_MISSING' });
  assert.throws(() => session.run(c.selected, () => ({ ...c.grant, range: 'project' })), { code: 'APPROVAL_MISSING' });
});
test('extra commands and omitted required checks are rejected before running', t => {
  const f = fixture(t);
  assert.throws(() => session.prepare(f.bundle, { ...f.plan, checks: [] }), { code: 'REQUIRED_CHECK_MISSING' });
  f.plan.checks[0].input.commands = [{ id: 'tools.identity' }];
  assert.throws(() => session.prepare(f.bundle, f.plan), { code: 'CHECK_SET_CHANGED' });
});
test('checker settings cannot contradict resolved policy or omit covered files', t => {
  const f = fixture(t); f.plan.checks[0].input.style.modules = 'esm';
  assert.throws(() => session.prepare(f.bundle, f.plan), { code: 'EXPECTATION_MISMATCH' });
  f.plan.checks[0].input.style.modules = 'commonjs'; f.plan.checks[0].input.files = [];
  assert.throws(() => session.prepare(f.bundle, f.plan), { code: 'SCOPE_MISMATCH' });
});
test('actual local checks produce a current, scoped receipt', t => {
  const f = fixture(t), c = f.choose();
  const receipt = session.run(c.selected, c.resolve);
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.executed, 1);
  assert.equal(session.auditReceipt(c.selected, receipt, c.resolve).status, 'PASS');
  assert.equal(session.hookView(c.selected, receipt, c.resolve).blocksHost, false);
});
test('failed syntax is a failed receipt, not a thrown-away check', t => {
  const f = fixture(t), c = f.choose(); fs.writeFileSync(path.join(f.root, 'a.cjs'), 'invalid { syntax');
  const receipt = session.run(c.selected, c.resolve); assert.equal(receipt.status, 'FAIL');
  assert.equal(session.auditReceipt(c.selected, receipt, c.resolve).status, 'FAIL');
});
test('content, policy and environment changes invalidate previous receipts', t => {
  const f = fixture(t), c = f.choose(), receipt = session.run(c.selected, c.resolve);
  const oldPath = process.env.PATH;
  try { process.env.PATH = (oldPath || '') + path.delimiter + 'changed-profile'; assert.equal(session.auditReceipt(c.selected, receipt, c.resolve).status, 'UNVERIFIED'); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
  fs.writeFileSync(path.join(f.root, 'a.cjs'), 'module.exports = 2;'); assert.equal(session.auditReceipt(c.selected, receipt, c.resolve).status, 'UNVERIFIED');
});
function commandFixture(t, copiedExecutable = false) {
  const f = fixture(t);
  const script = path.join(f.root, 'checker.cjs'), data = path.join(f.root, 'checker-data.json');
  fs.writeFileSync(script, "const fs = require('node:fs'); fs.appendFileSync('invocations', 'run\\n'); console.log(JSON.parse(fs.readFileSync('checker-data.json', 'utf8')).valid ? 'CHECK_OK' : 'CHECK_BAD');");
  fs.writeFileSync(data, '{"valid":true}');
  const executable = copiedExecutable ? path.join(f.root, path.basename(process.execPath)) : process.execPath;
  if (copiedExecutable) fs.copyFileSync(process.execPath, executable);
  const command = { id: 'tools.identity', executable, sha256: core.hash(fs.readFileSync(executable)), args: ['checker.cjs'],
    inputs: ['checker.cjs', 'checker-data.json'].map(name => ({ path: name, sha256: core.hash(fs.readFileSync(path.join(f.root, name))) })),
    expect: { exitCode: 0, stdoutIncludes: ['CHECK_OK'] } };
  f.plan.checks.push({ id: command.id, phase: 'local', level: 'runtime', expectationRef: 'checker:valid-data', input: { schema: 1, projectRoot: f.root, files: ['a.cjs'], commands: [command] } });
  const choice = f.choose('local', 'automated', session.prepare(f.bundle, f.plan));
  const authority = { taskId: 't', worktreeId: f.bundle.project.worktreeId, commandDigests: [core.hash(command)] };
  return { ...f, ...choice, authority, command, script, data, executable };
}
for (const change of ['script', 'data', 'deleted-data', 'executable', 'bom-script', 'bom-data']) {
  test('B03 changing command ' + change + ' invalidates its receipt without rerunning it', t => {
    const f = commandFixture(t, change === 'executable');
    assert.ok(!f.bundle.files.some(file => file.path === 'checker.cjs' || file.path === 'checker-data.json'));
    const receipt = session.run(f.selected, f.resolve, f.authority);
    assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.checks.find(c => c.id === 'tools.identity').record.stdout.trim(), 'CHECK_OK');
    assert.equal(session.auditReceipt(f.selected, receipt, f.resolve).status, 'PASS');
    if (change === 'script') fs.appendFileSync(f.script, '\nprocess.exitCode = 1;');
    if (change === 'data') fs.writeFileSync(f.data, '{"valid":false}');
    if (change === 'deleted-data') fs.unlinkSync(f.data);
    if (change === 'executable') fs.appendFileSync(f.executable, 'changed');
    if (change.startsWith('bom-')) {
      const file = change === 'bom-script' ? f.script : f.data;
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(file)]));
      if (change === 'bom-data') assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), SyntaxError);
    }
    const audited = session.auditReceipt(f.selected, receipt, f.resolve);
    assert.equal(audited.status, 'UNVERIFIED');
    assert.equal(audited.code, 'STALE_RECEIPT');
    assert.equal(session.hookView(f.selected, receipt, f.resolve).verified, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'invocations'), 'utf8'), 'run\n');
  });
}
test('B03 unchanged command inputs stay current while unapproved commands do not execute', t => {
  const f = commandFixture(t);
  const denied = session.run(f.selected, f.resolve);
  assert.equal(denied.status, 'UNVERIFIED');
  assert.equal(fs.existsSync(path.join(f.root, 'invocations')), false);
  const receipt = session.run(f.selected, f.resolve, f.authority);
  assert.equal(receipt.status, 'PASS');
  fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'outside declared inputs');
  assert.equal(session.auditReceipt(f.selected, receipt, f.resolve).status, 'PASS');
  assert.equal(fs.readFileSync(path.join(f.root, 'invocations'), 'utf8'), 'run\n');
});
test('new source files invalidate i18n receipts instead of escaping the fixed file list', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, 'src/page.html'), '<button data-i18n="save">Save</button>');
  fs.writeFileSync(path.join(f.root, 'en.json'), '{"save":"Save"}');
  f.request.files.push('src/page.html', 'en.json');
  f.request.applicability['coding-style'].files = ['a.cjs'];
  f.request.applicability.i18n = { ...f.request.applicability.i18n, applies: true, files: ['src/page.html'] };
  f.request.rules.push({ ...f.request.rules[0], id: 'locale', dimension: 'i18n', key: 'requiredLocales', value: ['en'], scope: 'src', checkIds: ['i18n.catalog'] });
  const pending = core.resolve(f.request);
  const authority = { taskId: 't', sessionId: 's', worktreeId: pending.project.worktreeId, scopeDigest: pending.scopeDigest, sources: [{ ...f.request.rules[0].source, ruleDigests: f.request.rules.map(core.hash) }] };
  const bundle = core.resolve(f.request, authority);
  f.plan.checks.push({ id: 'i18n.catalog', phase: 'local', level: 'static', expectationRef: 'required-locale', input: { schema: 1, projectRoot: f.root, sourceRoots: ['src'], catalog: { requiredLocales: ['en'], defaultLocale: 'en', defaultNamespace: 'translation', namespaces: { translation: { en: 'en.json' } } } } });
  const prepared = session.prepare(bundle, f.plan), c = f.choose('local', 'automated', prepared);
  const receipt = session.run(c.selected, c.resolve); assert.equal(receipt.status, 'PASS');
  fs.writeFileSync(path.join(f.root, 'src/new.html'), '<h1>New unverified text</h1>');
  assert.equal(session.auditReceipt(c.selected, receipt, c.resolve).status, 'UNVERIFIED');
  assert.equal(session.hookView(c.selected, receipt, c.resolve).verified, false);
});
test('i18n plans cannot omit a convention-bound source file', t => {
  const f = fixture(t);
  for (const dir of ['src', 'legacy']) fs.mkdirSync(path.join(f.root, dir));
  fs.writeFileSync(path.join(f.root, 'src/page.html'), '<button data-i18n="save">Save</button>');
  fs.writeFileSync(path.join(f.root, 'legacy/page.html'), '<button data-i18n="missing">Untranslated</button>');
  fs.writeFileSync(path.join(f.root, 'en.json'), '{"save":"Save"}');
  f.request.files.push('src/page.html', 'legacy/page.html', 'en.json');
  f.request.applicability['coding-style'].files = ['a.cjs'];
  f.request.applicability.i18n = { ...f.request.applicability.i18n, applies: true, files: ['src/page.html', 'legacy/page.html'] };
  f.request.rules.push({ ...f.request.rules[0], id: 'locale', dimension: 'i18n', key: 'requiredLocales', value: ['en'], scope: '.', checkIds: ['i18n.catalog'] });
  const pending = core.resolve(f.request);
  const authority = { taskId: 't', sessionId: 's', worktreeId: pending.project.worktreeId, scopeDigest: pending.scopeDigest, sources: [{ ...f.request.rules[0].source, ruleDigests: f.request.rules.map(core.hash) }] };
  const bundle = core.resolve(f.request, authority);
  const check = { id: 'i18n.catalog', phase: 'local', level: 'static', expectationRef: 'required-locale', input: { schema: 1, projectRoot: f.root, sourceRoots: ['src'], catalog: { requiredLocales: ['en'], defaultLocale: 'en', defaultNamespace: 'translation', namespaces: { translation: { en: 'en.json' } } } } };
  f.plan.checks.push(check);
  assert.throws(() => session.prepare(bundle, f.plan), { code: 'SCOPE_MISMATCH' });
  check.input.sourceRoots.push('legacy');
  const prepared = session.prepare(bundle, f.plan), choice = f.choose('local', 'automated', prepared);
  const receipt = session.run(choice.selected, choice.resolve);
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.checks.find(c => c.id === 'i18n.catalog').status, 'FAIL');
});
test('rehashed fabricated receipts cannot create a PASS', t => {
  const f = fixture(t), c = f.choose(); const receipt = core.copy(session.run(c.selected, c.resolve));
  const { receiptDigest, executed, ...body } = receipt; body.runId = 'fabricated';
  const forged = { ...body, receiptDigest: core.hash(body), executed };
  assert.equal(session.auditReceipt(c.selected, forged, c.resolve).code, 'RECEIPT_ORIGIN_UNKNOWN');
});
test('evidence level and plan mutation are checked', t => {
  const f = fixture(t); f.plan.checks[0].level = 'runtime';
  const prepared = session.prepare(f.bundle, f.plan), c = f.choose('local', 'automated', prepared);
  assert.equal(session.run(c.selected, c.resolve).status, 'UNVERIFIED');
  const changed = core.copy(c.selected); changed.proposal.checks[0].level = 'static';
  assert.throws(() => session.run(changed, c.resolve), { code: 'STATE_CHANGED' });
});
test('persistent state cannot overwrite another writer or retain cached permission', t => {
  const f = fixture(t), c = f.choose(), file = path.join(f.root, 'session.json');
  const saved = session.save(file, c.selected);
  assert.throws(() => session.save(file, c.selected), { code: 'STATE_CHANGED' });
  assert.equal(session.load(file).selection, null); assert.equal(session.run(session.load(file)).executed, 0);
  assert.equal(session.save(file, c.selected, saved.digest).digest, saved.digest);
  fs.writeFileSync(file + '.lock', 'another');
  assert.throws(() => session.save(file, c.selected, saved.digest), { code: 'STATE_BUSY' });
});
