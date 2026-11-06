'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const gov = require('./context-governor.cjs');

const TEST_ROOT = process.env.CONTEXT_GOVERNOR_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEST_ROOT, `context-governor-test-${process.pid}-${Date.now()}`);
let caseNo = 0;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function neutralText(index) {
  const body = 'The quick brown fox jumps over the lazy dog. ';
  return (`Neutral fixture text for token budget coverage, section ${index}. ` + body.repeat(80)).slice(0, 3200);
}

function makeCase() {
  caseNo += 1;
  const dir = path.join(ROOT, `case-${caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const sessionId = 'fixture-session';
  const cwd = 'D:/project/Qoder-Optimization';
  const lines = [];
  const push = (obj) => lines.push(JSON.stringify(obj));
  push({
    type: 'system',
    uuid: 'sys-1',
    sessionId,
    cwd,
    message: { role: 'system', content: 'System fixture prompt only.' },
  });
  push({
    type: 'user',
    uuid: 'u-first',
    sessionId,
    cwd,
    message: { role: 'user', content: 'First fixture request.' },
    usage: { input_tokens: 48309, cache_read_input_tokens: 48000, output_tokens: 100, context_usage_ratio: 0.1207725 },
    model: 'fixture-model',
  });
  for (let i = 2; i <= 24; i += 1) {
    if (i === 10) {
      push({
        type: 'assistant',
        uuid: 'f-10',
        sessionId,
        cwd,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'fixture.txt' } },
            { type: 'text', text: neutralText(10) },
          ],
        },
      });
      continue;
    }
    if (i === 11) {
      push({
        type: 'user',
        uuid: 'f-11',
        sessionId,
        cwd,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: neutralText(11) }],
        },
      });
      continue;
    }
    if (i === 21) {
      push({
        type: 'user',
        uuid: 'u-pin',
        sessionId,
        cwd,
        message: { role: 'user', content: 'Authorized scope marker: keep this.' },
      });
      continue;
    }
    push({
      type: i % 2 === 0 ? 'assistant' : 'user',
      uuid: `f-${i}`,
      sessionId,
      cwd,
      message: { role: i % 2 === 0 ? 'assistant' : 'user', content: neutralText(i) },
    });
  }
  push({
    type: 'user',
    uuid: 'u-recent-1',
    sessionId,
    cwd,
    message: { role: 'user', content: 'Recent message one.' },
  });
  push({
    type: 'assistant',
    uuid: 'u-recent-2',
    sessionId,
    cwd,
    message: { role: 'assistant', content: 'Recent message two.' },
  });
  push({
    type: 'user',
    uuid: 'u-recent-3',
    sessionId,
    cwd,
    message: { role: 'user', content: 'Recent message three.' },
  });
  push({
    type: 'assistant',
    uuid: 'u-final',
    sessionId,
    cwd,
    message: { role: 'assistant', content: 'Final answer.' },
    usage: {
      input_tokens: 59909,
      cache_read_input_tokens: 59700,
      cache_creation_input_tokens: 0,
      output_tokens: 6886,
      context_usage_ratio: 0.1497725,
    },
    model: 'fixture-model',
    compactMetadata: { preTokens: 362058, postTokens: 4645 },
  });
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');
  const parsed = gov.readTranscript(transcriptPath);
  return { dir, transcriptPath, parsed, dataDir: path.join(dir, 'data') };
}

function rangeHashFor(c, startUuid, endUuid) {
  const start = c.parsed.lines.find((line) => line.uuid === startUuid);
  const end = c.parsed.lines.find((line) => line.uuid === endUuid);
  assert.ok(start && end, 'range uuids must exist');
  const buf = c.parsed.lines.slice(start.index, end.index + 1)
    .map((line) => line.raw)
    .reduce((acc, raw) => Buffer.concat([acc, raw, Buffer.from('\n')]), Buffer.alloc(0))
    .subarray(0, -1);
  return { start, end, rangeHash: sha256(buf) };
}

function makeSummary(c, startUuid, endUuid, overrides = {}) {
  const range = rangeHashFor(c, startUuid, endUuid);
  const base = {
    schema: 1,
    sessionId: c.parsed.sessionId,
    taskId: 'fixture-task',
    goal: 'fixture goal for context governor',
    scope: { mode: 'test', authorityRef: 'current-request-id' },
    state: { done: [], inProgress: ['fixture'], notStarted: [] },
    decisions: [],
    constraints: [{
      claimId: 'C1',
      text: 'Keep fixture constraints',
      source: 'user',
      ref: 'current-request-id',
      asOf: '2026-11-06',
      status: 'current',
    }],
    evidence: [{
      claimId: 'E1',
      claim: 'fixture evidence',
      ref: startUuid,
      asOf: '2026-11-06',
      status: 'current',
    }],
    open: [],
    next: [{ action: 'run fixture test', acceptance: 'exit 0' }],
    verbatim: ['fixture'],
    dropped: [],
    handles: ['fixture-handle'],
    sourceRange: {
      startUuid,
      endUuid,
      startOffset: range.start.start,
      endOffset: range.end.end,
      rangeHash: range.rangeHash,
    },
    purpose: { executor: 'logical', reason: 'fixture', expectedDelta: 0, horizonTurns: null },
    tokenEstimate: 0,
  };
  return { ...base, ...overrides };
}

function writeJson(c, name, value) {
  const file = path.join(c.dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

test('context-governor core', async (t) => {
  t.after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  await t.test('report separates measured input, inferred window and postTokens', () => {
    const c = makeCase();
    const result = gov.cmdReport({ transcript: c.transcriptPath, dataDir: c.dataDir, json: true });
    assert.equal(result.code, 0);
    assert.equal(result.report.P, 59909);
    assert.equal(result.report.window.tokens, 400000);
    assert.equal(result.report.window.source, 'inferred');
    assert.equal(result.report.B, 48309);
    assert.equal(result.report.compact.postTokens, 4645);
    assert.equal(result.report.cost.prices, 'UNKNOWN_COST');
    assert.equal(result.report.expectedDelta, 0);
    assert.equal(result.report.netProjected, null);
    assert.equal(result.report.breakevenTurns, null);
    assert.equal(result.report.usage.inputTokens, 59909);
    assert.ok(result.report.candidates.some((candidate) => candidate.eligible));
    assert.ok(result.report.C >= result.report.threshold);
    assert.ok(result.report.C <= result.report.P);
    assert.ok(result.report.flags.includes('candidate_estimate_within_input') || result.report.flags.includes('candidate_estimate_capped_to_measured_input'));
    assert.ok(result.report.flags.includes('physical_savings_not_observed'));
    assert.equal(fs.readdirSync(path.join(c.dataDir, 'reports')).length, 1);
  });

  await t.test('snapshot protects recent and system ranges and hashes candidates', () => {
    const c = makeCase();
    const result = gov.cmdSnapshot({ transcript: c.transcriptPath, json: true });
    assert.equal(result.code, 0);
    assert.equal(result.snapshot.P, 59909);
    assert.ok(result.snapshot.protected.reasons['u-recent-3']);
    assert.ok(result.snapshot.protected.reasons['sys-1']);
    assert.equal(result.snapshot.protected.reasons['f-2'], undefined);
    const candidate = result.snapshot.candidates.find((item) => item.startUuid === 'u-first' && item.endUuid === 'f-15');
    assert.ok(candidate, JSON.stringify(result.snapshot.candidates));
    assert.equal(candidate.rangeHash.length, 64);
    assert.ok(candidate.tokens > 8000);
    assert.equal(candidate.eligible, true);
  });

  await t.test('fold --dry-run validates without writing a ledger', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary-dry.json', makeSummary(c, 'f-2', 'f-15'));
    const result = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      dryRun: true,
      json: true,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.receipt.dryRun, true);
    assert.equal(result.receipt.phase, 'logical_committed');
    assert.equal(result.receipt.physicalSavings, 0);
    assert.equal(fs.existsSync(path.join(c.dataDir, 'ledgers', 'fixture-session.db')), false);
  });

  await t.test('fold commits logical receipt, search and show recover exact range', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary.json', makeSummary(c, 'f-2', 'f-15'));
    const result = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.receipt.phase, 'logical_committed');
    assert.equal(result.receipt.physicalSavings, 0);
    assert.equal(result.receipt.breakevenTurns, null);
    assert.equal(result.receipt.segmentIds.length, 1);

    const search = gov.cmdSearch({
      query: 'fixture goal',
      session: 'fixture-session',
      dataDir: c.dataDir,
      limit: 3,
      json: true,
    });
    assert.equal(search.code, 0);
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].phase, 'logical_committed');
    assert.equal(search.results[0].physicalSavings, 0);
    assert.equal(search.results[0].sourceHash.length, 64);

    const showFold = gov.cmdShow({
      id: result.receipt.id,
      session: 'fixture-session',
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(showFold.code, 0);
    assert.equal(showFold.result.phase, 'logical_committed');
    assert.equal(showFold.result.summary.goal, 'fixture goal for context governor');

    const showRange = gov.cmdShow({
      range: result.receipt.segmentIds[0],
      session: 'fixture-session',
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(showRange.code, 0);
    assert.ok(showRange.result.text.includes('Neutral fixture text'));
    assert.equal(showRange.result.rangeHash.length, 64);
    assert.equal(showRange.result.excerptHash.length, 64);
    assert.notEqual(showRange.result.nextCursor, null);

    const showFull = gov.cmdShow({
      range: result.receipt.segmentIds[0],
      session: 'fixture-session',
      dataDir: c.dataDir,
      full: true,
      ackCost: true,
      json: true,
    });
    assert.equal(showFull.code, 0);
    assert.ok(showFull.result.text.length > showRange.result.text.length);
    assert.equal(showFull.result.nextCursor, null);

    const verify = gov.cmdVerify({ session: 'fixture-session', dataDir: c.dataDir, json: true });
    assert.equal(verify.code, 0);
    assert.equal(verify.folds, 1);
    assert.equal(verify.segments, 1);
  });

  await t.test('fold rejects protected recent range', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary-protected.json', makeSummary(c, 'u-recent-3', 'u-recent-3'));
    const result = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(result.code, 1);
    assert.ok(result.errors.join(' ').includes('protected range'));
  });

  await t.test('fold rejects low value unless force carries a reason', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary-small.json', makeSummary(c, 'f-2', 'f-2'));
    const rejected = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(rejected.code, 2);
    assert.ok(rejected.errors.join(' ').includes('candidate value too low'));

    const forced = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      force: true,
      reason: 'fixture force reason',
      json: true,
    });
    assert.equal(forced.code, 0);
    assert.equal(forced.receipt.physicalSavings, 0);
  });

  await t.test('fold rejects secrets, missing evidence and orphan tool halves', () => {
    const c = makeCase();
    const secretSummary = makeSummary(c, 'f-2', 'f-15', { goal: 'fixture goal ' + 'sk-' + 'a'.repeat(24) });
    const secretPath = writeJson(c, 'summary-secret.json', secretSummary);
    const secret = gov.cmdFold({
      summary: secretPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(secret.code, 1);
    assert.ok(secret.errors.join(' ').includes('secret'));

    const noEvidence = makeSummary(c, 'f-2', 'f-15', { evidence: [] });
    const noEvidencePath = writeJson(c, 'summary-no-evidence.json', noEvidence);
    const missing = gov.cmdFold({
      summary: noEvidencePath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(missing.code, 1);
    assert.ok(missing.errors.join(' ').includes('evidence'));

    const orphan = makeSummary(c, 'f-10', 'f-10');
    const orphanPath = writeJson(c, 'summary-orphan.json', orphan);
    const orphanResult = gov.cmdFold({
      summary: orphanPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(orphanResult.code, 1);
    assert.ok(orphanResult.errors.join(' ').includes('orphan tool pairs'));
  });

  await t.test('pin protects the referenced message in report', () => {
    const c = makeCase();
    const pin = gov.cmdPin({
      session: 'fixture-session',
      text: 'Authorized scope marker',
      source: 'user-approval-fixture',
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(pin.code, 0);
    const report = gov.cmdReport({ transcript: c.transcriptPath, dataDir: c.dataDir, json: true });
    assert.equal(report.code, 0);
    assert.equal(report.report.protected.reasons['u-pin'], 'pin');
  });

  await t.test('handoff keeps key items and degrades source bodies to handles', () => {
    const c = makeCase();
    const input = {
      taskId: 'task-handoff',
      cwd: 'D:/project/Qoder-Optimization',
      ownerSession: 'fixture-session',
      currentRequest: 'Implement the fixture handoff',
      approvalScope: 'document-only fixture scope',
      state: { done: ['fixture'], inProgress: ['handoff'], notStarted: [] },
      constraints: [{ text: 'Keep key constraints', source: 'user' }],
      decisions: [{ text: 'Use handles', reason: 'size', ref: 'fixture-handle' }],
      open: ['none'],
      sources: [{ handle: 'fixture-handle', text: 'fixture source body' }],
      next: [{ action: 'verify handoff', acceptance: 'key items present' }],
    };
    const inputPath = writeJson(c, 'handoff-valid.json', input);
    const outPath = path.join(c.dir, 'handoff-valid.md');
    const result = gov.cmdHandoff({
      task: input.taskId,
      input: inputPath,
      out: outPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(result.code, 0);
    assert.equal(result.handoff.createdSession, false);
    assert.ok(result.handoff.estimatedTokens <= 4096);
    const text = fs.readFileSync(outPath, 'utf8');
    assert.ok(text.includes('## 当前请求'));
    assert.ok(text.includes('## 批准范围'));
    assert.ok(text.includes('## 关键约束'));
    assert.ok(text.includes('## 下一步及验收'));
    assert.ok(text.includes('fixture source body'));

    const manySources = Array.from({ length: 40 }, (_, index) => ({
      handle: `fixture-source-${index}`,
      text: 'x'.repeat(5000),
    }));
    const bigInput = { ...input, sources: manySources };
    const bigPath = writeJson(c, 'handoff-big.json', bigInput);
    const bigOut = path.join(c.dir, 'handoff-big.md');
    const big = gov.cmdHandoff({
      task: bigInput.taskId,
      input: bigPath,
      out: bigOut,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(big.code, 0);
    assert.ok(big.handoff.estimatedTokens <= 4096);
    const bigText = fs.readFileSync(bigOut, 'utf8');
    assert.ok(bigText.includes('[body omitted'));
    assert.ok(bigText.includes('fixture-source-0'));
    assert.ok(bigText.includes('## 关键约束'));

    const missing = { ...input, constraints: [] };
    const missingPath = writeJson(c, 'handoff-missing.json', missing);
    const rejected = gov.cmdHandoff({
      task: input.taskId,
      input: missingPath,
      out: path.join(c.dir, 'handoff-missing.md'),
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(rejected.code, 2);
  });

  await t.test('handoff verifies real ledger handles when the owner session exists', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary-handoff-source.json', makeSummary(c, 'f-2', 'f-15'));
    const folded = gov.cmdFold({ summary: summaryPath, transcript: c.transcriptPath, dataDir: c.dataDir, json: true });
    assert.equal(folded.code, 0, JSON.stringify(folded));
    const shown = gov.cmdShow({
      id: folded.receipt.id,
      session: 'fixture-session',
      dataDir: c.dataDir,
      json: true,
    });
    const segmentId = folded.receipt.segmentIds[0];
    const input = {
      taskId: 'task-handle',
      cwd: 'D:/project/Qoder-Optimization',
      ownerSession: 'fixture-session',
      currentRequest: 'Use the folded source',
      approvalScope: 'fixture scope',
      state: { done: [], inProgress: ['verify handle'], notStarted: [] },
      constraints: [{ text: 'Keep fixture constraints', source: 'user' }],
      decisions: [],
      open: [],
      sources: [{ handle: segmentId, text: 'fixture folded body', sourceHash: shown.result.sourceRange.rangeHash }],
      next: [{ action: 'verify handle', acceptance: 'exit 0' }],
    };
    const inputPath = writeJson(c, 'handoff-handle.json', input);
    const ok = gov.cmdHandoff({
      task: input.taskId,
      input: inputPath,
      out: path.join(c.dir, 'handoff-handle.md'),
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(ok.code, 0, JSON.stringify(ok));

    const bad = { ...input, sources: [{ handle: 'seg-deadbeefdeadbeef', text: 'missing' }] };
    const badPath = writeJson(c, 'handoff-bad-handle.json', bad);
    const rejected = gov.cmdHandoff({
      task: bad.taskId,
      input: badPath,
      out: path.join(c.dir, 'handoff-bad-handle.md'),
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(rejected.code, 2);
    assert.ok(rejected.error.includes('not found'));
  });

  await t.test('report aggregates explicit participants without dedupe inflation', () => {
    const c = makeCase();
    const secondPath = path.join(c.dir, 'second.jsonl');
    fs.writeFileSync(secondPath, JSON.stringify({
      type: 'user',
      uuid: 's-1',
      sessionId: 'fixture-session-2',
      cwd: 'D:/project/Qoder-Optimization',
      message: { role: 'user', content: 'Second session.' },
      usage: { input_tokens: 1000, output_tokens: 10, context_usage_ratio: 0.5 },
      model: 'fixture-model',
    }) + '\n', 'utf8');
    const manifestPath = writeJson(c, 'participants.json', [c.transcriptPath, secondPath, secondPath]);
    const result = gov.cmdReport({
      transcript: c.transcriptPath,
      participants: manifestPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(result.code, 0);
    assert.equal(result.report.participants.length, 2);
    assert.equal(result.report.participantsTotal.P, 60909);
    assert.equal(result.report.participantsTotal.outputTokens, 6896);
  });

  await t.test('edge fixture, CRLF, empty and oversized sources stay bounded', () => {
    const fixture = path.join(__dirname, 'fixtures', 'context-governor', 'edge-cases.jsonl');
    const parsed = gov.readTranscript(fixture);
    assert.equal(parsed.sessionId, 'edge-session');
    assert.equal(parsed.usages.length, 1);
    assert.equal(parsed.usages[0].inputTokens, 1200);
    assert.ok(parsed.lines.some((line) => line.messageText.includes('授权')));
    assert.ok(gov.estimateTokens('中文上下文') >= 4);

    const crlf = path.join(ROOT, 'crlf.jsonl');
    const first = JSON.stringify({
      type: 'user',
      uuid: 'crlf-1',
      sessionId: 'crlf-session',
      cwd: 'D:/tmp',
      message: { role: 'user', content: '中文行一' },
      usage: { input_tokens: 1000, context_usage_ratio: 0.5 },
      model: 'edge-model',
    });
    const second = JSON.stringify({
      type: 'assistant',
      uuid: 'crlf-2',
      sessionId: 'crlf-session',
      cwd: 'D:/tmp',
      message: { role: 'assistant', content: '中文行二' },
    });
    fs.writeFileSync(crlf, first + '\r\n' + second + '\r\n', 'utf8');
    const crlfParsed = gov.readTranscript(crlf);
    assert.equal(crlfParsed.lines.length, 2);
    assert.equal(crlfParsed.lines[1].text.includes('\r'), false);

    const empty = path.join(ROOT, 'empty.jsonl');
    fs.writeFileSync(empty, '', 'utf8');
    const emptyReport = gov.cmdReport({ transcript: empty, dataDir: path.join(ROOT, 'empty-data'), json: true });
    assert.equal(emptyReport.code, 2);

    const huge = path.join(ROOT, 'huge.jsonl');
    fs.writeFileSync(huge, JSON.stringify({
      type: 'user',
      uuid: 'huge-1',
      sessionId: 'huge-session',
      cwd: 'D:/tmp',
      message: { role: 'user', content: 'x'.repeat(200000) },
      usage: { input_tokens: 50000, context_usage_ratio: 0.25 },
      model: 'edge-model',
    }) + '\n', 'utf8');
    const hugeSnapshot = gov.cmdSnapshot({ transcript: huge, json: true });
    assert.equal(hugeSnapshot.code, 0);
    assert.equal(hugeSnapshot.snapshot.messages, 1);
    assert.ok(hugeSnapshot.snapshot.lines[0].tokens > 1000);
  });

  await t.test('CLI entry point is runnable and emits JSON', () => {
    const c = makeCase();
    const cli = path.join(__dirname, 'context-governor.cjs');
    const result = spawnSync(process.execPath, [cli, 'report', '--transcript', c.transcriptPath, '--data-dir', c.dataDir, '--json'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.report.P, 59909);
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('context-governor'));
  });

  await t.test('load manifest reuses resident sources and records only on request', () => {
    const c = makeCase();
    const input = {
      taskId: 'task-load',
      activeACs: ['AC-02'],
      sources: [
        { id: 'spec-4.2', path: 'docs/proactive-context-compaction/spec.md', sourceHash: 'aaa', resident: true, coveredRange: '§4.2', acs: ['AC-02'], asOf: '2026-11-06' },
        { id: 'tasks-T-02', path: 'docs/proactive-context-compaction/tasks.md', sourceHash: 'bbb', resident: false, coveredRange: 'T-02', acs: ['AC-02'] },
        { id: 'memory-index', path: 'MEMORY.md', sourceHash: 'ccc', resident: false, coveredRange: 'index', acs: ['AC-16'] },
        { id: 'no-hash', path: 'README.md', resident: false, coveredRange: 'readme', acs: ['AC-02'] },
        { id: 'pointer-only', path: 'docs/proactive-context-compaction/README.md', sourceHash: 'ddd', pointerOnly: true, coveredRange: 'evidence', acs: ['AC-02'] },
      ],
    };
    const inputPath = writeJson(c, 'load-manifest.json', input);
    const result = gov.cmdLoadManifest({ input: inputPath, dataDir: c.dataDir, json: true });
    assert.equal(result.code, 0);
    const byId = Object.fromEntries(result.manifest.decisions.map((item) => [item.sourceId, item]));
    assert.equal(byId['spec-4.2'].decision, 'reuse');
    assert.equal(byId['tasks-T-02'].decision, 'read');
    assert.equal(byId['memory-index'].decision, 'omit');
    assert.equal(byId['no-hash'].decision, 'pointer');
    assert.equal(byId['pointer-only'].decision, 'pointer');
    assert.equal(result.manifest.counts.reuse, 1);
    assert.equal(fs.existsSync(path.join(c.dataDir, 'load-manifests')), false);

    const recorded = gov.cmdLoadManifest({ input: inputPath, dataDir: c.dataDir, record: true, json: true });
    assert.equal(recorded.code, 0);
    assert.ok(recorded.manifest.recorded);
    assert.equal(fs.readdirSync(path.join(c.dataDir, 'load-manifests')).length, 1);
  });

  await t.test('prune apply refuses broad deletion without explicit ids', () => {
    const c = makeCase();
    const result = gov.cmdPrune({ dataDir: c.dataDir, apply: true, json: true });
    assert.equal(result.code, 1);
    assert.ok(result.error.includes('--ids'));
  });

  await t.test('verify and show detect middle tampering after fold', () => {
    const c = makeCase();
    const summaryPath = writeJson(c, 'summary-tamper.json', makeSummary(c, 'f-2', 'f-15'));
    const folded = gov.cmdFold({
      summary: summaryPath,
      transcript: c.transcriptPath,
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(folded.code, 0, JSON.stringify(folded));
    const buf = fs.readFileSync(c.transcriptPath);
    const start = c.parsed.lines.find((line) => line.uuid === 'f-2').start;
    const offset = start + 40;
    buf[offset] = buf[offset] ^ 0xff;
    fs.writeFileSync(c.transcriptPath, buf);
    const verify = gov.cmdVerify({ session: 'fixture-session', dataDir: c.dataDir, json: true });
    assert.equal(verify.code, 4);
    assert.ok(verify.errors.some((item) => item.error === 'rangeHash mismatch'));
    const show = gov.cmdShow({
      range: folded.receipt.segmentIds[0],
      session: 'fixture-session',
      dataDir: c.dataDir,
      json: true,
    });
    assert.equal(show.code, 4);
    assert.equal(show.status, 'STALE');
  });
});
