'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { evaluatePolicy, POLICY_VERSION } = require('./verification-policy.cjs');
const fixture = require('../skills/verify-before-claim/references/adaptive-verification.cases.json');
const input = () => structuredClone(fixture.base);
const contract = id => fixture.cases.find(c => c.id === id);
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('A01 bounded work recommends light; unknown facts recommend standard without hiding options', () => {
  assert.equal(evaluatePolicy(input()).recommendedTier, contract('A01').positive.expectedRecommendation);
  const data = input(); data.facts.risk = 'unknown';
  const plan = evaluatePolicy(data);
  assert.equal(plan.recommendedTier, contract('A01').negative.expectedRecommendation);
  assert.equal(plan.options.length, 4);
  assert.deepEqual(plan.blockers, ['FACTS_UNRESOLVED']);
});
test('A02 sensitive work recommends deep and retains every choice', () => {
  const data = input(); data.facts.sensitive = true;
  const plan = evaluatePolicy(data);
  assert.equal(plan.recommendedTier, contract('A02').positive.expectedRecommendation);
  assert.equal(plan.options.length, contract('A02').positive.expectedOptions);
  assert.equal(plan.options[0].optionId, 'deep');
  assert.deepEqual(new Set(plan.options.map(o => o.optionId)), new Set(['light', 'standard', 'deep', 'manual']));
  for (const id of contract('A02').negative.mustKeep) assert.ok(plan.options.find(o => o.tier === 'light').checkIds.includes(id));
});
for (const action of ['push', 'pull-request', 'deploy', 'publish']) {
  test(action + ' recommends deep without becoming an operation permit', () => {
    const data = input(); data.facts.action = action;
    const plan = evaluatePolicy(data);
    assert.equal(plan.recommendedTier, 'deep');
    assert.equal(plan.authorized, undefined);
    assert.equal(plan.options.length, 4);
  });
}
test('A03 explicit requirements and their dependencies remain in every automatic profile', () => {
  const data = input(); data.userCheckIds.push('review');
  const plan = evaluatePolicy(data);
  for (const option of plan.options.filter(o => o.execution === 'automated')) {
    assert.deepEqual(option.checkIds, [...contract('A03').positive.mustKeep].sort());
  }
  data.userCheckIds.push('not-a-check');
  rejects(() => evaluatePolicy(data), contract('A03').negative.expectedError);
});
test('A04 evidence types remain independent from verification tiers', () => {
  const data = input();
  data.checks[0].evidenceType = 'artifact';
  const plan = evaluatePolicy(data);
  assert.equal(plan.checks.find(c => c.id === 'syntax').evidenceType, 'artifact');
  assert.ok(plan.options.find(o => o.tier === 'light').checkIds.includes('syntax'));
  data.checks[0].evidenceType = 'deep';
  rejects(() => evaluatePolicy(data), 'INVALID_CHECK');
});
test('A05 costs are unknown instead of invented and recommendations are first', () => {
  const data = input(); data.modelSuggestedTier = 'standard';
  const plan = evaluatePolicy(data);
  assert.equal(plan.options[0].tier, 'standard');
  assert.match(plan.options[0].label, /Recommended/);
  for (const option of plan.options) {
    assert.equal(option.estimatedMinutes, contract('A05').negative.expectedMinutes);
    assert.equal(option.estimateSourceRef, null);
  }
  assert.equal(plan.options.at(-1).optionId, 'manual');
});
test('A06 lower profiles disclose omitted optional checks and keep user requirements', () => {
  const data = input(); data.modelSuggestedTier = 'deep';
  const plan = evaluatePolicy(data), light = plan.options.find(o => o.tier === 'light');
  assert.deepEqual(light.checkIds, contract('A06').positive.expectedCheckIds);
  assert.deepEqual(light.omittedComparedToRecommended, ['boundary', 'regression', 'review']);
  assert.deepEqual(light.addedComparedToRecommended, []);
});
test('A07 manual handoff has no automatic checks and retains the pending checklist', () => {
  const manual = evaluatePolicy(input()).options.find(o => o.execution === 'manual');
  assert.equal(manual.checkIds.length, contract('A07').positive.expectedAutomaticChecks);
  assert.equal(manual.tier, null);
  assert.deepEqual(manual.manualCheckIds, ['boundary', 'regression', 'smoke', 'syntax']);
});
test('A13 profiles are monotonic and every dependency is present', () => {
  const plan = evaluatePolicy(input());
  const profiles = ['light', 'standard', 'deep'].map(tier => plan.options.find(o => o.tier === tier).checkIds);
  for (let i = 0; i < profiles.length - 1; i++) for (const id of profiles[i]) assert.ok(profiles[i + 1].includes(id));
  for (const ids of profiles) for (const id of ids) for (const dep of plan.checks.find(c => c.id === id).dependencies) assert.ok(ids.includes(dep));
  const data = input(); data.checks[0].dependencies = ['review'];
  rejects(() => evaluatePolicy(data), contract('A13').negative.expectedError);
});
test('duplicate and dangling check references fail before a partial proposal is returned', () => {
  const duplicate = input(); duplicate.checks.push(structuredClone(duplicate.checks[0]));
  rejects(() => evaluatePolicy(duplicate), 'DUPLICATE_CHECK');
  const dangling = input(); dangling.checks[0].dependencies = ['absent'];
  rejects(() => evaluatePolicy(dangling), 'UNKNOWN_CHECK');
});
test('invalid scope, evidence origin and empty baseline are not silently defaulted', () => {
  const data = input(); data.taskId = '../other';
  rejects(() => evaluatePolicy(data), contract('A21').negative.expectedError);
  const missing = input(); missing.facts.sourceRefs = [];
  rejects(() => evaluatePolicy(missing), 'INVALID_FACTS');
  const empty = input(); empty.baselineCheckIds = [];
  rejects(() => evaluatePolicy(empty), 'INVALID_BASELINE');
});
test('policy identity is stable across object key order and changes with real requirements', () => {
  const data = input(), first = evaluatePolicy(data);
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  assert.equal(evaluatePolicy(reordered).policyDigest, first.policyDigest);
  data.userCheckIds.push('review');
  assert.notEqual(evaluatePolicy(data).policyDigest, first.policyDigest);
  assert.equal(first.policyVersion, POLICY_VERSION);
});
test('CLI only prints a proposal and has no state, shell or configuration side effects', t => {
  const dir = temporary(t), file = path.join(dir, 'request.json'), data = input();
  data.checks[0].commandRef = 'do-not-execute-any-command';
  fs.writeFileSync(file, JSON.stringify(data));
  const before = fs.readdirSync(dir);
  const run = spawnSync(process.execPath, [path.join(__dirname, 'verification-policy.cjs'), file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).options.length, 4);
  assert.deepEqual(fs.readdirSync(dir), before);
  const invalid = spawnSync(process.execPath, [path.join(__dirname, 'verification-policy.cjs'), '--apply'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
});
test('sensitive-recommendation mutation is killed while the original module passes', t => {
  const dir = temporary(t), modulePath = path.join(__dirname, 'verification-policy.cjs');
  const source = fs.readFileSync(modulePath, 'utf8'), anchor = "f.sensitive === true || f.risk === 'high'";
  assert.equal(source.split(anchor).length - 1, 1);
  const mutant = path.join(dir, 'mutant.cjs'), file = path.join(dir, 'request.json');
  fs.writeFileSync(mutant, source.replace(anchor, "false || f.risk === 'high'"));
  const data = input(); data.facts.sensitive = true;
  fs.writeFileSync(file, JSON.stringify(data));
  const probe = "const fs=require('node:fs'); const assert=require('node:assert/strict'); const m=require(process.argv[1]); assert.equal(m.evaluatePolicy(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))).recommendedTier,process.argv[3]);";
  const run = target => spawnSync(process.execPath, ['-e', probe, target, file, contract('A02').positive.expectedRecommendation], { encoding: 'utf8' });
  assert.equal(run(modulePath).status, 0);
  const failed = run(mutant);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /AssertionError/);
});
test('audit regression: irreversible work recommends deep without removing free choice', () => {
  const data = input();
  data.facts.reversible = false;
  const plan = evaluatePolicy(data);
  assert.equal(plan.recommendedTier, 'deep');
  assert.deepEqual(new Set(plan.options.map(o => o.optionId)), new Set(['light', 'standard', 'deep', 'manual']));
  assert.equal(evaluatePolicy(input()).recommendedTier, 'light');
});
