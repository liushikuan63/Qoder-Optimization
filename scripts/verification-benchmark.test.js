'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { summarize, validate } = require('./verification-benchmark.cjs');
const { fingerprint } = require('./verification-policy.cjs');
const fixture = require('../skills/verify-before-claim/references/adaptive-verification.cases.json');
const contract = id => fixture.cases.find(c => c.id === id);

const digest = c => c.repeat(64);
function timed(row) {
  return { ...row, wallClockMs: row.setupMs + row.policyMs + row.agentMs + row.questionMs + row.executeMs + row.humanWaitMs };
}
function run(round, state, caught, base = 100) {
  return timed({
    round, state, termination: 'completed', caughtDefectIds: caught, falsePositiveCount: 0,
    order: round % 2 ? 'AB' : 'BA', resetRef: 'reset/' + round,
    setupMs: 10, policyMs: state === 'candidate' ? 2 : 0, agentMs: base, questionMs: 5, executeMs: base, humanWaitMs: 20, evidenceRef: 'logs/' + state + '-' + round + '.json',
  });
}
function bindRun(task, row) {
  return { ...row, policyVersion: 'adaptive-verification/1', baselineDigest: digest('b'), contentDigest: task.contentDigest,
    environmentKey: task.environmentKey, proposalDigest: task.choice.proposalDigest, choiceDigest: fingerprint(task.choice),
    checkIds: row.state === 'baseline' ? [...task.baselineCheckIds] : [...task.candidateCheckIds],
    evidenceRef: task.id + '/' + row.evidenceRef };
}
function task(id, options = {}) {
  const defects = options.defects || [];
  const item = {
    id, family: options.family ?? (Number(id.replace(/\D/g, '')) || 1),
    split: options.split || 'dev', candidateTier: options.manual ? null : options.tier || 'light',
    risk: options.risk || 'low', hasKnownDefect: options.hasKnownDefect ?? defects.length > 0,
    defectIds: defects, independentTruthRef: 'truth/' + id + '.md',
    baselineCheckIds: ['syntax', 'regression'], candidateCheckIds: options.manual ? [] : ['syntax'],
    mandatoryCheckIds: ['syntax'], userCheckIds: [],
    candidateState: options.manual ? 'manual' : 'candidate',
    contentDigest: digest('c'), environmentKey: 'isolated-test', resetPolicyRef: 'reset-policy',
    choice: { optionId: options.manual ? 'manual' : options.tier || 'light', sourceKind: 'native-answer', sourceRef: 'answers/' + id, proposalDigest: digest('d') },
    evidenceRef: 'records/' + id + '.json', evidenceDigest: digest('a'),
  };
  item.runs = (options.runs || [run(1, 'baseline', options.baseCaught || [], 200), run(2, 'baseline', options.baseCaught || [], 200), run(3, 'baseline', options.baseCaught || [], 200),
    run(1, 'candidate', options.candCaught || [], 50), run(2, 'candidate', options.candCaught || [], 50), run(3, 'candidate', options.candCaught || [], 50)]).map(row => bindRun(item, row));
  return item;
}
function sample() {
  return Array.from({ length: 30 }, (_, i) => {
    const n = i % 10, defective = n < 3 || (n >= 6 && n < 8), id = 'T' + (i + 1);
    return task(id, {
      split: n < 6 ? 'dev' : 'holdout', family: i + 1, tier: ['light', 'standard', 'deep'][Math.floor(i / 10)],
      defects: defective ? ['d' + i] : [],
      baseCaught: defective ? ['d' + i] : [], candCaught: defective ? ['d' + i] : [],
    });
  });
}
function manifest(tasks) {
  return { schema: 1, policyVersion: 'adaptive-verification/1', baselineSourceRef: 'project-ci', baselineDigest: digest('b'), tasks };
}
function many(count, fn) { return Array.from({ length: count }, (_, i) => fn('T' + (i + 1), i)); }
function file(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-benchmark-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'manifest.json');
  fs.writeFileSync(target, JSON.stringify(data));
  return target;
}

test('A17 complete paired measurements produce metrics from supplied simulation records', () => {
  const report = summarize(manifest(sample()), 3);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.metrics.pairedRounds, 90);
  assert.equal(report.metrics.pairedTaskCount, 30);
  assert.ok(report.metrics.medianReduction > 0.2);
  assert.equal(report.metrics.candidateCaught, 15);
  assert.equal(report.metrics.baselineCaught, 15);
  assert.equal(report.metrics.bothMissedDefects, 0);
});
test('B04 development gains cannot hide zero improvement on the light holdout', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier === 'light' && t.split === 'holdout')) {
    item.runs = item.runs.map(row => row.state === 'candidate' ? timed({ ...row, agentMs: 199, executeMs: 199 }) : row);
  }
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /保留集.*p50.*20%/);
  assert.ok(report.metrics.byTier.light.withHumanWait.medianReduction > 0.2);
  assert.equal(report.metrics.byTier.light.bySplit.holdout.withHumanWait.medianReduction, 0);
});
test('B04 slower development baselines cannot hide a holdout tail regression', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier === 'light' && t.split === 'dev')) {
    item.runs = item.runs.map(row => row.state === 'baseline' ? timed({ ...row, executeMs: 2000 }) : row);
  }
  const held = data.tasks.find(t => t.candidateTier === 'light' && t.split === 'holdout');
  held.runs = held.runs.map(row => row.state === 'candidate' ? timed({ ...row, executeMs: 500 }) : row);
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /保留集.*p95/);
  const combined = report.metrics.byTier.light.withHumanWait;
  assert.ok(combined.candidateP95Ms < combined.baselineP95Ms);
  assert.ok(report.metrics.byTier.light.bySplit.holdout.withHumanWait.medianReduction > 0.2);
});
for (const extra of [0, 0.01]) {
  test('B04 holdout twenty-percent boundary with added cost ' + extra, () => {
    const data = manifest(sample());
    for (const item of data.tasks.filter(t => t.candidateTier === 'light' && t.split === 'holdout')) {
      item.runs = item.runs.map(row => row.state === 'candidate' ? timed({ ...row, agentMs: 155.5, executeMs: 155.5 + extra }) : row);
    }
    const report = summarize(data);
    assert.equal(report.verdict, extra === 0 ? 'PASS' : 'FAIL');
    if (extra) assert.match(report.issues.join(' '), /保留集.*p50.*20%/);
  });
}
test('B04 per-tier split metrics retain independent denominators and waiting costs', () => {
  const report = summarize(manifest(sample()));
  assert.equal(report.verdict, 'PASS');
  for (const tier of ['light', 'standard', 'deep']) {
    assert.ok(report.metrics.byTier[tier].bySplit);
    const { dev, holdout } = report.metrics.byTier[tier].bySplit;
    assert.equal(dev.taskCount, 6);
    assert.equal(dev.pairedRounds, 18);
    assert.equal(holdout.taskCount, 4);
    assert.equal(holdout.pairedRounds, 12);
    assert.equal(holdout.withHumanWait.candidateMedianMs, 137);
    assert.equal(holdout.withoutHumanWait.candidateMedianMs, 117);
  }
});
test('A17 empty, skipped or duplicated measurements never become zero-miss or zero-cost', () => {
  assert.equal(summarize(manifest([]), 3).verdict, 'INCOMPLETE');
  const skipped = manifest([task('T1', { runs: [{ ...run(1, 'baseline', []), termination: 'skipped' }] })]);
  assert.equal(summarize(skipped, 3).verdict, 'INCOMPLETE');
  const duplicate = manifest(sample());
  duplicate.tasks[0].runs = duplicate.tasks[0].runs.flatMap(r => r.state === 'candidate' ? [r, { ...r }] : [r]);
  const report = summarize(duplicate, 3);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.match(report.issues.join(' '), /重复轮次/);
});
test('A18 two sets that both miss the same defect cannot pass as success', () => {
  const data = manifest(sample().map(t => ({ ...t, hasKnownDefect: true, defectIds: t.defectIds.length ? t.defectIds : ['normal-' + t.id],
    runs: t.runs.map(r => ({ ...r, caughtDefectIds: [] })) })));
  const report = summarize(data, 3);
  assert.equal(report.metrics.candidateCaught, 0);
  assert.equal(report.metrics.baselineCaught, 0);
  assert.equal(report.metrics.bothMissedDefects, 30);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /都漏检/);
  assert.match(report.warnings.join(' '), /基线自身漏检/);
});
test('A18 candidate missing a defect the baseline caught fails', () => {
  const data = manifest(sample().map(t => ({ ...t, runs: t.runs.map(r => r.state === 'candidate' ? { ...r, caughtDefectIds: [] } : r) })));
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /候选检出低于基线/);
});
test('A18 high-risk known defect missing from candidate blocks admission', () => {
  const data = manifest(sample().map(t => ({ ...t, risk: 'high', runs: t.runs.map(r => r.state === 'candidate' ? { ...r, caughtDefectIds: [] } : r) })));
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.metrics.highRiskMissed, 15);
});
test('A19 the same family cannot span both development and holdout', () => {
  const data = manifest([task('T1', { split: 'dev', family: 7 }), task('T2', { split: 'holdout', family: 7 })]);
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues[0], /LEAKAGE/);
});
test('A19 fewer paired rounds than required is incomplete, not a smaller claim', () => {
  const data = manifest(sample().map(t => ({ ...t, runs: t.runs.filter(r => r.round === 1) })));
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.match(report.issues.join(' '), /少于 3 个配对轮次/);
});
test('A20 manual handoff is excluded from the time ratio and cannot be zero-time evidence', () => {
  const auto = sample();
  const manual = task('M1', { split: 'dev', manual: true, runs: [run(1, 'baseline', [], 200), run(2, 'baseline', [], 200), run(3, 'baseline', [], 200)] });
  const report = summarize(manifest([...auto, manual]), 3);
  assert.equal(report.metrics.manualTasks, 1);
  assert.equal(report.metrics.manualTimeMs, null);
  assert.equal(report.metrics.pairedTaskCount, 30);
  assert.match(report.issues.join(' '), /人工待验任务/);
  assert.equal(report.verdict, contract('A20').negative.expectedVerdict);
  const forged = task('M2', { split: 'dev', manual: true, runs: [run(1, 'baseline', []), run(2, 'baseline', []), run(3, 'baseline', []), run(1, 'candidate', [])] });
  assert.equal(summarize(manifest([forged]), 3).verdict, 'FAIL');
});
test('A20 p95 worse than baseline blocks a median-only improvement', () => {
  const slow = sample().map(t => ({ ...t, runs: t.runs.map(r => r.state === 'candidate' ? timed({ ...r, executeMs: 400 }) : r) }));
  const report = summarize(manifest(slow), 3);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /p95/);
});
test('A17 tampered or missing independent evidence fields are rejected before metrics', () => {
  const data = manifest(sample());
  data.tasks[0].evidenceDigest = 'not-a-digest';
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.metrics, null);
  assert.ok(validate(data).some(i => /指纹/.test(i)));
});
test('A17 missing risk, holdout, normal or defect samples cannot pass', () => {
  const noRisk = manifest(sample()); delete noRisk.tasks[0].risk;
  assert.equal(summarize(noRisk, 3).verdict, 'INCOMPLETE');
  assert.ok(validate(noRisk).some(i => /risk/.test(i)));
  const noHoldout = manifest(sample().map(t => ({ ...t, split: 'dev' })));
  assert.equal(summarize(noHoldout, 3).verdict, 'FAIL');
  assert.match(summarize(noHoldout, 3).issues.join(' '), /保留集/);
  const noNormal = manifest(sample().map(t => ({ ...t, hasKnownDefect: true, defectIds: t.defectIds.length ? t.defectIds : ['n-' + t.id] })));
  assert.equal(summarize(noNormal, 3).verdict, 'FAIL');
  assert.match(summarize(noNormal, 3).issues.join(' '), /正常任务/);
  const noDefect = manifest(sample().map(t => ({ ...t, hasKnownDefect: false, defectIds: [], runs: t.runs.map(r => ({ ...r, caughtDefectIds: [] })) })));
  assert.equal(summarize(noDefect, 3).verdict, 'FAIL');
  assert.match(summarize(noDefect, 3).issues.join(' '), /缺陷任务/);
});
test('A17 out-of-range caught defect IDs are a fault, not extra credit', () => {
  const data = manifest(sample());
  data.tasks[0].runs[0].caughtDefectIds = ['not-in-truth'];
  const report = summarize(data, 3);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /FAULT/);
});
test('A20 one task replayed for many rounds cannot supply thirty independent pairs', () => {
  const data = sample();
  data[0].runs = Array.from({ length: 30 }, (_, i) => [run(i + 1, 'baseline', ['d0'], 200), run(i + 1, 'candidate', ['d0'], 50)]).flat().map(row => bindRun(data[0], row));
  for (let i = 1; i < 30; i++) {
    data[i] = task('M' + i, { split: data[i].split, family: i + 1, manual: true,
      runs: [run(1, 'baseline', [], 200), run(2, 'baseline', [], 200), run(3, 'baseline', [], 200)] });
  }
  const report = summarize(manifest(data), 30);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.metrics.pairedTaskCount, 1);
  assert.match(report.issues.join(' '), /独立配对任务少于30/);
});
test('the evaluator never reads or executes manifest commands', t => {
  const data = manifest(sample());
  data.tasks[0].runs[0].command = 'touch should-not-exist';
  const target = file(t, data), dir = path.dirname(target), sentinel = path.join(dir, 'should-not-exist');
  const executed = spawnSync(process.execPath, [path.join(__dirname, 'verification-benchmark.cjs'), target, '--json'], { encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.ok(!fs.existsSync(sentinel));
  assert.ok(JSON.parse(executed.stdout).metrics);
});
test('CLI distinguishes malformed input from an empty measurement set', t => {
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'verification-benchmark.cjs')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const target = file(t, manifest([]));
  const empty = spawnSync(process.execPath, [path.join(__dirname, 'verification-benchmark.cjs'), target], { encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.equal(JSON.parse(empty.stdout).verdict, contract('A17').negative.expectedVerdict);
});

test('audit regression: the old all-normal holdout fixture cannot meet admission', () => {
  const data = manifest(sample().map((item, i) => {
    const defects = i < 15 ? ['d' + i] : [];
    return { ...item, split: i < 18 ? 'dev' : 'holdout', defectIds: defects, hasKnownDefect: defects.length > 0,
      runs: item.runs.map(row => ({ ...row, caughtDefectIds: defects })) };
  }));
  const report = summarize(data);
  assert.notEqual(report.verdict, 'PASS');
  assert.match(report.issues.join(' '), /保留集|每档|18|12/);
});
test('audit regression: admission counts are checked by tier and split instead of only total size', () => {
  const data = manifest(sample());
  for (const item of data.tasks) {
    item.candidateTier = 'light'; item.choice.optionId = 'light';
    for (const row of item.runs) row.choiceDigest = fingerprint(item.choice);
  }
  const report = summarize(data);
  assert.notEqual(report.verdict, 'PASS');
  assert.match(report.issues.join(' '), /三档|每档|standard|deep/);
});
test('audit regression: repeated families within a split cannot supply independent tasks', () => {
  const data = manifest(sample());
  data.tasks[1].family = data.tasks[0].family;
  const report = summarize(data);
  assert.notEqual(report.verdict, 'PASS');
  assert.equal(report.metrics.independentTaskCount, 29);
});
for (const numbers of [[1, 3, 100], [3]]) {
  test('audit regression: round IDs ' + numbers.join('/') + ' cannot masquerade as three paired rounds', () => {
    const data = manifest(sample());
    data.tasks[0].runs = data.tasks[0].runs.filter(r => numbers.length > 1 || r.round === 3).map(r => ({ ...r, round: numbers.length > 1 ? numbers[r.round - 1] : 3 }));
    const report = summarize(data);
    assert.equal(report.verdict, 'INCOMPLETE');
    assert.equal(report.metrics, null);
  });
}
test('audit regression: extra candidate rounds must be paired before contributing to timing', () => {
  const data = manifest(sample()), item = data.tasks[0];
  item.runs.push(bindRun(item, run(4, 'candidate', item.defectIds, 1)));
  const report = summarize(data);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.metrics, null);
});
for (const field of ['risk', 'candidateTier', 'choice', 'contentDigest', 'environmentKey', 'mandatoryCheckIds', 'resetPolicyRef']) {
  test('audit regression: missing task ' + field + ' cannot become an admission pass', () => {
    const data = manifest(sample()); delete data.tasks[0][field];
    let report;
    assert.doesNotThrow(() => { report = summarize(data); });
    assert.equal(report.verdict, 'INCOMPLETE');
    assert.equal(report.metrics, null);
  });
}
test('audit regression: choice must include a supported real-source reference and match the selected tier', () => {
  for (const change of [c => { delete c.sourceRef; }, c => { c.sourceKind = 'self-approved'; }, c => { c.optionId = 'deep'; }]) {
    const data = manifest(sample()); change(data.tasks[0].choice);
    for (const row of data.tasks[0].runs) row.choiceDigest = fingerprint(data.tasks[0].choice);
    assert.notEqual(summarize(data).verdict, 'PASS');
  }
});
for (const field of ['policyVersion', 'baselineDigest', 'contentDigest', 'environmentKey', 'proposalDigest', 'choiceDigest']) {
  test('audit regression: a cross-version or cross-scope ' + field + ' record cannot join a pair', () => {
    const data = manifest(sample());
    data.tasks[0].runs[3][field] = field.endsWith('Digest') ? digest('f') : 'different-version';
    const report = summarize(data);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(report.metrics, null);
  });
}
test('audit regression: actual check sets cannot omit mandatory checks or smuggle in extra checks', () => {
  const data = manifest(sample());
  data.tasks[0].mandatoryCheckIds.push('regression');
  assert.equal(summarize(data).verdict, 'FAIL');
  const extra = manifest(sample()); extra.tasks[0].runs[3].checkIds.push('unselected');
  assert.equal(summarize(extra).verdict, 'FAIL');
});
test('audit regression: later success cannot conceal an earlier paired defect miss', () => {
  const data = manifest(sample());
  data.tasks[0].runs[3].caughtDefectIds = [];
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.metrics.candidateMissed, 1);
  data.tasks[0].runs[0].caughtDefectIds = [];
  const both = summarize(data);
  assert.equal(both.verdict, 'FAIL');
  assert.equal(both.metrics.bothMissedDefects, 1);
});
test('audit regression: the A18 single-defect case reports both misses explicitly', () => {
  const data = manifest(sample());
  data.tasks[0].runs = data.tasks[0].runs.map(r => ({ ...r, caughtDefectIds: [] }));
  const report = summarize(data);
  assert.equal(report.metrics.candidateMissed, contract('A18').negative.expectedCandidateMisses);
  assert.equal(report.metrics.baselineMissed, contract('A18').negative.expectedBaselineMisses);
  assert.equal(report.verdict, 'FAIL');
});
test('audit regression: a reported false positive on a normal task is not successful detection', () => {
  const data = manifest(sample());
  data.tasks.find(t => !t.hasKnownDefect).runs[3].falsePositiveCount = 1;
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.metrics.candidateFalsePositives, 1);
});
test('audit regression: light improvement below twenty percent fails even when pooled data is fast', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier === 'light')) {
    item.runs = item.runs.map(row => row.state === 'candidate' ? timed({ ...row, executeMs: 300 }) : row);
  }
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /20%/);
});
test('audit regression: light-only tail regression is not hidden by faster other tiers', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier === 'light').slice(0, 2)) {
    item.runs[3] = timed({ ...item.runs[3], executeMs: 1000 });
  }
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.issues.join(' '), /轻量.*p95/);
});
test('audit regression: strengthened non-light coverage need not meet the light speed threshold', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier !== 'light')) {
    item.runs = item.runs.map(row => row.state === 'candidate' ? timed({ ...row, executeMs: 1000 }) : row);
  }
  assert.equal(summarize(data).verdict, 'PASS');
});
test('audit regression: policy overhead and with/without human waiting are independently reported', () => {
  const report = summarize(manifest(sample()));
  assert.equal(report.metrics.candidateMedianMs, 137);
  assert.equal(report.metrics.byTier.light.withHumanWait.baselineMedianMs, 435);
  assert.equal(report.metrics.byTier.light.withoutHumanWait.candidateMedianMs, 117);
  assert.equal(report.metrics.policyP95Ms, 2);
  assert.equal(report.metrics.overhead.candidate.policyMs, 2);
  const slowPolicy = manifest(sample());
  for (const item of slowPolicy.tasks) item.runs = item.runs.map(row => row.state === 'candidate' ? timed({ ...row, policyMs: 101 }) : row);
  assert.equal(summarize(slowPolicy).verdict, 'FAIL');
});
test('audit regression: measured wall-clock, A/B order and reset evidence must be coherent', () => {
  for (const change of [r => { r.wallClockMs = 1; }, r => { r.order = 'unknown'; }, r => { delete r.resetRef; }]) {
    const data = manifest(sample()); change(data.tasks[0].runs[3]);
    assert.notEqual(summarize(data).verdict, 'PASS');
  }
  const repeated = manifest(sample());
  repeated.tasks[0].runs.forEach(r => { r.order = 'AB'; });
  assert.equal(summarize(repeated).verdict, 'INCOMPLETE');
});
test('audit regression: malformed API input is a structured non-pass, not a thrown checker error', () => {
  for (const data of [null, undefined, [], {}, { schema: 1, tasks: null }, manifest([null]), manifest([{ id: 'T1', runs: [null] }])]) {
    let report;
    assert.doesNotThrow(() => { report = summarize(data); });
    assert.notEqual(report.verdict, 'PASS');
    assert.ok([1, 2].includes(report.exitCode));
    assert.doesNotThrow(() => validate(data));
  }
});
test('audit regression: omitted and lowered minimum rounds cannot bypass the three-round contract', () => {
  const data = manifest(sample().map(item => ({ ...item, runs: item.runs.filter(r => r.round === 1) })));
  assert.equal(summarize(data).verdict, 'INCOMPLETE');
  assert.equal(summarize(data, 1).verdict, 'ERROR');
  assert.equal(summarize(data, NaN).verdict, 'ERROR');
});
test('audit regression: CLI rejects unknown, repeated or weakening options', t => {
  const target = file(t, manifest(sample()));
  for (const args of [['--min-rounds', '1'], ['--min-rounds', '3', '--min-rounds', '1'], ['--bogus'], [target]]) {
    const output = spawnSync(process.execPath, [path.join(__dirname, 'verification-benchmark.cjs'), target, ...args], { encoding: 'utf8' });
    assert.equal(output.status, 2);
    assert.equal(JSON.parse(output.stderr).verdict, 'ERROR');
  }
});
function executionOnly(row, executeMs) {
  return timed({ ...row, setupMs: 0, policyMs: 0, agentMs: 0, questionMs: 0, executeMs, humanWaitMs: 0 });
}
test('review regression: one fast task repeated hundreds of times cannot dilute nine slow light tasks', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier === 'light')) {
    const fast = item.id === 'T10', rounds = fast ? 513 : 3;
    item.runs = Array.from({ length: rounds }, (_, i) => ['baseline', 'candidate'].map(state => bindRun(item,
      executionOnly(run(i + 1, state, item.defectIds), state === 'baseline' ? 100 : fast ? 30 : 200)))).flat();
  }
  const report = summarize(data);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.metrics, null);
});
test('review regression: large finite zero-improvement timings cannot overflow the median into a pass', () => {
  const data = manifest(sample());
  for (const item of data.tasks) item.runs = item.runs.map(row => executionOnly(row, 1e308));
  const report = summarize(data);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.metrics.byTier.light.withHumanWait.medianReduction, 0);
  assert.equal(report.metrics.baselineMedianMs, 1e308);
});
test('review regression: non-finite derived metrics are incomplete rather than serializing into apparent success', () => {
  const data = manifest(sample());
  for (const item of data.tasks.filter(t => t.candidateTier !== 'light')) {
    item.runs = item.runs.map(row => executionOnly(row, row.state === 'baseline' ? 1e-308 : 1e308));
  }
  const report = summarize(data);
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.metrics, null);
});
test('review regression: exact twenty percent saving survives floating-point representation but weaker saving fails', () => {
  const data = manifest(sample());
  for (const item of data.tasks) item.runs = item.runs.map(row => executionOnly(row, row.state === 'baseline' ? 1000.1 : 800.08));
  assert.equal(summarize(data).verdict, 'PASS');
  for (const item of data.tasks) item.runs = item.runs.map(row => row.state === 'candidate' ? executionOnly(row, 800.0801) : row);
  assert.equal(summarize(data).verdict, 'FAIL');
});
