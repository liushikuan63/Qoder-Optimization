'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'context-governor-hook.cjs');
const TEST_ROOT = process.env.CONTEXT_GOVERNOR_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEST_ROOT, `context-governor-hook-test-${process.pid}-${Date.now()}`);

function makeTranscript(dir, sessionId, ratio) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `transcript-${ratio}.jsonl`);
  const lines = [
    {
      type: 'user',
      uuid: 'h-1',
      sessionId,
      cwd: 'D:/tmp',
      message: { role: 'user', content: 'hook fixture prompt' },
      usage: { input_tokens: 70000, output_tokens: 10, context_usage_ratio: ratio },
      model: 'hook-fixture',
    },
    {
      type: 'assistant',
      uuid: 'h-2',
      sessionId,
      cwd: 'D:/tmp',
      message: { role: 'assistant', content: 'hook fixture answer' },
    },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

function usageLine(sessionId, ratio, inputTokens = 70000, pad = '') {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${sessionId}-${ratio}`,
    sessionId,
    cwd: 'D:/tmp',
    message: { role: 'user', content: 'appended prompt' },
    usage: { input_tokens: inputTokens, output_tokens: 10, context_usage_ratio: ratio },
    model: 'hook-fixture',
    pad,
  });
}

function run(event, dataDir, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CONTEXT_GOVERNOR_DATA: dataDir, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('context-governor hook', async (t) => {
  t.after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  await t.test('PreCompact and PostCompact stay silent and exit 0', () => {
    const dir = path.join(ROOT, 'prepost');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-session', 0.7);
    const pre = run({ hook_event_name: 'PreCompact', session_id: 'hook-session', transcript_path: transcript }, dataDir);
    assert.equal(pre.status, 0);
    assert.equal(pre.stdout.trim(), '');
    const post = run({ hook_event_name: 'PostCompact', session_id: 'hook-session' }, dataDir);
    assert.equal(post.status, 0);
    assert.equal(post.stdout.trim(), '');
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-state', 'hook-session.json'), 'utf8'));
    assert.equal(state.pendingRestore, true);
  });

  await t.test('SessionStart emits a bounded pointer only after PostCompact', () => {
    const dir = path.join(ROOT, 'session-start');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-session', 0.7);
    const post = run({ hook_event_name: 'PostCompact', session_id: 'hook-session', transcript_path: transcript }, dataDir);
    assert.equal(post.status, 0);
    const start = run({ hook_event_name: 'SessionStart', session_id: 'hook-session', transcript_path: transcript }, dataDir);
    assert.equal(start.status, 0);
    const payload = JSON.parse(start.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(payload.hookSpecificOutput.additionalContext.length <= 300);
    assert.ok(payload.hookSpecificOutput.additionalContext.includes('context-governor'));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-state', 'hook-session.json'), 'utf8'));
    assert.equal(state.pendingRestore, false);
    const second = run({ hook_event_name: 'SessionStart', session_id: 'hook-session' }, dataDir);
    assert.equal(second.stdout.trim(), '');
  });

  await t.test('UserPromptSubmit is silent below threshold and injects once at soft ratio', () => {
    const belowDir = path.join(ROOT, 'below');
    const belowData = path.join(belowDir, 'data');
    const belowTranscript = makeTranscript(belowDir, 'hook-below', 0.4);
    const below = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-below',
      transcript_path: belowTranscript,
    }, belowData, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(below.status, 0);
    assert.equal(below.stdout.trim(), '');

    const dir = path.join(ROOT, 'inject');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-session', 0.7);
    const first = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-session',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(first.status, 0);
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(payload.hookSpecificOutput.additionalContext.length <= 400);
    assert.ok(payload.hookSpecificOutput.additionalContext.includes('70%'));
    const second = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-session',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), '');
  });

  await t.test('default mode never injects even at emergency ratio', () => {
    const dir = path.join(ROOT, 'disabled');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-disabled', 0.95);
    const result = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-disabled',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  });

  await t.test('malformed input and help are fail-open', () => {
    const dataDir = path.join(ROOT, 'malformed', 'data');
    const malformed = run('not json', dataDir);
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout.trim(), '');
    const help = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('context-governor-hook'));
  });

  await t.test('incremental scan reads only appended bytes and picks up new usage', () => {
    const dir = path.join(ROOT, 'incremental');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-inc', 0.4);
    const first = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-inc',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(first.status, 0);
    assert.equal(first.stdout.trim(), '');
    const appended = usageLine('hook-inc', 0.7) + '\n';
    fs.appendFileSync(transcript, appended, 'utf8');
    const second = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-inc',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(second.status, 0);
    const payload = JSON.parse(second.stdout);
    assert.ok(payload.hookSpecificOutput.additionalContext.includes('70%'));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-state', 'hook-inc.json'), 'utf8'));
    assert.equal(state.lastScanFull, false);
    assert.equal(state.lastScanBytes, Buffer.byteLength(appended));
  });

  await t.test('partial trailing line is not consumed until newline arrives', () => {
    const dir = path.join(ROOT, 'partial');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-partial', 0.4);
    run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-partial',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    const line = usageLine('hook-partial', 0.7);
    fs.appendFileSync(transcript, line.slice(0, 20), 'utf8');
    const mid = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-partial',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(mid.status, 0);
    assert.equal(mid.stdout.trim(), '');
    fs.appendFileSync(transcript, line.slice(20) + '\n', 'utf8');
    const after = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-partial',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(after.status, 0);
    const payload = JSON.parse(after.stdout);
    assert.ok(payload.hookSpecificOutput.additionalContext.includes('70%'));
  });

  await t.test('truncated transcript triggers full rescan', () => {
    const dir = path.join(ROOT, 'truncated');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-trunc', 0.9);
    const first = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-trunc',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(first.status, 0);
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.additionalContext.includes('90%'));
    const rewritten = usageLine('hook-trunc', 0.4) + '\n';
    fs.writeFileSync(transcript, rewritten, 'utf8');
    const second = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-trunc',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), '');
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-state', 'hook-trunc.json'), 'utf8'));
    assert.equal(state.lastScanFull, true);
    assert.equal(state.snapshotCache.lastUsage.ratio, 0.4);
  });

  await t.test('rewritten transcript with larger size triggers sentinel fallback', () => {
    const dir = path.join(ROOT, 'rewritten');
    const dataDir = path.join(dir, 'data');
    const transcript = makeTranscript(dir, 'hook-rewrite', 0.4);
    run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-rewrite',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    const rewritten = [
      usageLine('hook-rewrite', 0.7, 70000, 'x'.repeat(1024)),
      JSON.stringify({ type: 'assistant', uuid: 'a-1', sessionId: 'hook-rewrite', message: { role: 'assistant', content: 'rewritten' } }),
    ].join('\n') + '\n';
    fs.writeFileSync(transcript, rewritten, 'utf8');
    const second = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-rewrite',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '1' });
    assert.equal(second.status, 0);
    assert.ok(JSON.parse(second.stdout).hookSpecificOutput.additionalContext.includes('70%'));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-state', 'hook-rewrite.json'), 'utf8'));
    assert.equal(state.lastScanFull, true);
  });

  await t.test('config.json inject flag enables injection and env 0 overrides', () => {
    const dir = path.join(ROOT, 'config');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ inject: true }), 'utf8');
    const transcript = makeTranscript(dir, 'hook-config', 0.7);
    const on = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-config',
      transcript_path: transcript,
    }, dataDir, { CONTEXT_GOVERNOR_INJECT: '' });
    assert.equal(on.status, 0);
    assert.ok(JSON.parse(on.stdout).hookSpecificOutput.additionalContext.includes('70%'));

    const offData = path.join(dir, 'data-off');
    fs.mkdirSync(offData, { recursive: true });
    fs.writeFileSync(path.join(offData, 'config.json'), JSON.stringify({ inject: true }), 'utf8');
    const offTranscript = makeTranscript(dir, 'hook-config-off', 0.9);
    const off = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-config-off',
      transcript_path: offTranscript,
    }, offData, { CONTEXT_GOVERNOR_INJECT: '0' });
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), '');
  });
});
