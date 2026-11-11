'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const c = require('../scripts/continuity.cjs');
const script = path.join(__dirname, '..', 'scripts', 'continuity.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-continuity-prune-'));
process.env.CONTINUITY_PRUNE_TMP = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

function pruneConfig(store, value = {}) {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'prune.json'), JSON.stringify({
    schema: 1, enabled: true, retentionDays: 90, orphanGraceDays: 7,
    quarantineRoot: path.join(path.dirname(store), 'quarantine'), ...value,
  }));
}

function session(store, base, id, task, options = {}) {
  const auto = options.auto !== false;
  const cwd = path.join(base, 'ws-' + id.slice(0, 6));
  fs.mkdirSync(cwd, { recursive: true });
  const transcript = path.join(base, id + '.jsonl');
  fs.writeFileSync(transcript, '');
  const o = { store, cwd, session: id, task, transcript };
  c.enable(o);
  if (auto) {
    const file = path.join(c.location(o).dir, 'scope.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), auto: true }));
  }
  fs.appendFileSync(transcript, JSON.stringify({
    type: 'user', humanInput: true, sessionId: id, cwd, uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: options.text || ('证据 ' + task) }] },
  }) + '\n');
  c.capture(o);
  if (options.days) ageSession(o, options.days);
  return o;
}

function ageSession(o, days) {
  const dir = c.location(o).dir;
  const at = new Date(Date.now() - days * 86400000);
  const scopeFile = path.join(dir, 'scope.json');
  const scope = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  fs.writeFileSync(scopeFile, JSON.stringify({ ...scope, createdAt: at.toISOString() }));
  fs.writeFileSync(path.join(dir, 'last-UserPromptSubmit.json'), JSON.stringify({ schema: 1, event: 'UserPromptSubmit', at: at.toISOString(), session: o.session }));
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (/^(scope\.json|continuity\.sqlite(?:-wal|-shm)?)$/.test(name)) fs.utimesSync(file, at, at);
  }
}

function hashOf(o) { return c.location(o).dir.split(path.sep).at(-1); }

function snapshot(dir) {
  const out = [];
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else out.push([path.relative(dir, file), stat.size, stat.mtimeMs]);
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

test('prune 默认只干跑，apply 才把超期自动档移入隔离区且近期档不受影响', () => {
  const base = path.join(root, 'prune-core-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const old = session(store, base, 'aaaaaaaa-1111-4111-8111-111111111111', 'OLD-TASK', { days: 40 });
  session(store, base, 'bbbbbbbb-2222-4222-8222-222222222222', 'NEW-TASK', { days: 1 });
  const before = snapshot(store);
  const dry = c.prune({ store });
  assert.equal(dry.status, 'DRY_RUN');
  assert.deepEqual(dry.candidates.map(item => item.sessionHash), [hashOf(old)]);
  assert.match(dry.candidates[0].reasons.join(','), /expired/);
  assert.equal(snapshot(store), before);
  assert.equal(fs.existsSync(path.join(store, 'prune.lock')), false);
  const applied = c.prune({ store, apply: true });
  assert.equal(applied.status, 'PRUNED');
  assert.equal(applied.deleted.length, 1);
  assert.equal(applied.errors.length, 0);
  assert.equal(fs.existsSync(c.location(old).dir), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(applied.quarantineBatch, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].sessionHash, hashOf(old));
  for (const file of manifest.sessions[0].files) {
    if (!file.sha256) continue;
    const moved = fs.readFileSync(path.join(applied.quarantineBatch, manifest.sessions[0].cwdHash, manifest.sessions[0].sessionHash, file.path));
    assert.equal(crypto.createHash('sha256').update(moved).digest('hex'), file.sha256);
  }
});

test('手工任务档案默认不被自动清理，显式 includeManual 才纳入', () => {
  const base = path.join(root, 'prune-manual-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const manual = session(store, base, 'cccccccc-3333-4333-8333-333333333333', 'REAL-EVIDENCE', { auto: false, days: 60 });
  const auto = session(store, base, 'dddddddd-4444-4444-8444-444444444444', 'AUTO-TASK', { days: 60 });
  const dry = c.prune({ store });
  assert.deepEqual(dry.candidates.map(item => item.sessionHash), [hashOf(auto)]);
  const forced = c.prune({ store, includeManual: true });
  assert.deepEqual(new Set(forced.candidates.map(item => item.sessionHash)), new Set([hashOf(manual), hashOf(auto)]));
  assert.ok(fs.existsSync(c.location(manual).dir));
});

test('来源 transcript 消失的孤儿档按宽限期清理，宽限内不动', () => {
  const base = path.join(root, 'prune-orphan-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const orphan = session(store, base, 'eeeeeeee-5555-4555-8555-555555555555', 'DELETED-SESSION', { days: 10 });
  const recent = session(store, base, 'ffffffff-6666-4666-8666-666666666666', 'RECENT-ORPHAN', { days: 1 });
  fs.unlinkSync(orphan.transcript);
  fs.unlinkSync(recent.transcript);
  const dry = c.prune({ store });
  assert.deepEqual(dry.candidates.map(item => item.sessionHash), [hashOf(orphan)]);
  assert.match(dry.candidates[0].reasons.join(','), /orphan/);
  assert.ok(fs.existsSync(c.location(recent).dir));
});

test('新鲜 capture.lock 阻止清理，陈旧锁不阻止', () => {
  const base = path.join(root, 'prune-lock-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const locked = session(store, base, '11111111-7777-4777-8777-777777777777', 'LOCKED', { days: 60 });
  const lock = path.join(c.location(locked).dir, 'capture.lock');
  fs.writeFileSync(lock, '');
  assert.equal(c.prune({ store }).candidates.length, 0);
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(lock, old, old);
  assert.deepEqual(c.prune({ store }).candidates.map(item => item.sessionHash), [hashOf(locked)]);
});

test('空档与零字节坏库按宽限期清掉，无法读取的非空库受保护', () => {
  const base = path.join(root, 'prune-empty-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const empty = { store, cwd: path.join(base, 'ws-empty'), session: '22222222-8888-4888-8888-888888888888', task: 'EMPTY' };
  fs.mkdirSync(empty.cwd, { recursive: true });
  c.enable(empty);
  const emptyScope = path.join(c.location(empty).dir, 'scope.json');
  fs.writeFileSync(emptyScope, JSON.stringify({ ...JSON.parse(fs.readFileSync(emptyScope, 'utf8')), auto: true }));
  ageSession(empty, 10);
  const broken = session(store, base, '33333333-9999-4999-8999-999999999999', 'BROKEN', { days: 10 });
  const corrupt = session(store, base, '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'CORRUPT', { days: 10 });
  const at = new Date(Date.now() - 10 * 86400000);
  for (const o of [broken, corrupt]) {
    const file = path.join(c.location(o).dir, 'continuity.sqlite');
    fs.writeFileSync(file, o === broken ? '' : 'not-a-sqlite-database');
    fs.utimesSync(file, at, at);
  }
  const dry = c.prune({ store });
  const hashes = dry.candidates.map(item => item.sessionHash);
  assert.ok(hashes.includes(hashOf(empty)));
  assert.ok(hashes.includes(hashOf(broken)));
  assert.equal(hashes.includes(hashOf(corrupt)), false);
});

test('hook 在 SessionStart 自动清理并每日节流，配置关闭时完全不执行', () => {
  const base = path.join(root, 'prune-hook-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const old = session(store, base, '55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'OLD-HOOK', { days: 60 });
  const live = session(store, base, '66666666-cccc-4ccc-8ccc-cccccccccccc', 'LIVE', { days: 0 });
  c.hook({ cwd: live.cwd, session_id: live.session, transcript_path: live.transcript, hook_event_name: 'SessionStart', source: 'startup' }, { store });
  assert.equal(fs.existsSync(c.location(old).dir), false);
  assert.ok(fs.existsSync(path.join(store, 'prune-state.json')));
  const next = session(store, base, '77777777-dddd-4ddd-8ddd-dddddddddddd', 'SECOND-OLD', { days: 60 });
  c.hook({ cwd: live.cwd, session_id: live.session, transcript_path: live.transcript, hook_event_name: 'SessionStart', source: 'startup' }, { store });
  assert.ok(fs.existsSync(c.location(next).dir), '24h 内不重复清理');
  const stateFile = path.join(store, 'prune-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), lastRunAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }));
  c.hook({ cwd: live.cwd, session_id: live.session, transcript_path: live.transcript, hook_event_name: 'SessionStart', source: 'startup' }, { store });
  assert.equal(fs.existsSync(c.location(next).dir), false);
  pruneConfig(store, { enabled: false, retentionDays: 30 });
  const off = session(store, base, '88888888-eeee-4eee-8eee-eeeeeeeeeeee', 'DISABLED-OLD', { days: 60 });
  c.hook({ cwd: live.cwd, session_id: live.session, transcript_path: live.transcript, hook_event_name: 'SessionStart', source: 'startup' }, { store });
  assert.ok(fs.existsSync(c.location(off).dir));
});

test('当前会话永远排除在清理之外', () => {
  const base = path.join(root, 'prune-current-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const current = session(store, base, '99999999-ffff-4fff-8fff-ffffffffffff', 'CURRENT', { days: 90 });
  const other = session(store, base, 'aaaaaaab-1111-4111-8111-aaaaaaaaaaaa', 'OTHER', { days: 90 });
  c.hook({ cwd: current.cwd, session_id: current.session, transcript_path: current.transcript, hook_event_name: 'SessionStart', source: 'resume' }, { store });
  assert.ok(fs.existsSync(c.location(current).dir));
  assert.equal(fs.existsSync(c.location(other).dir), false);
});

test('隔离区最多保留配置批次，非本工具目录不动', () => {
  const base = path.join(root, 'prune-quarantine-' + (++seq));
  const store = path.join(base, 'store');
  const rootDir = path.join(base, 'quarantine');
  pruneConfig(store, { quarantineRoot: rootDir, maxQuarantineBatches: 3, quarantineDays: 7 });
  fs.mkdirSync(rootDir, { recursive: true });
  for (const stamp of ['20260101T000000Z-aaaa', '20260102T000000Z-bbbb', '20260103T000000Z-cccc', '20260104T000000Z-dddd']) {
    fs.mkdirSync(path.join(rootDir, stamp), { recursive: true });
    fs.writeFileSync(path.join(rootDir, stamp, 'manifest.json'), JSON.stringify({ schema: 1, tool: 'continuity-prune' }));
  }
  fs.mkdirSync(path.join(rootDir, 'unrelated'), { recursive: true });
  const result = c.prune({ store, apply: true });
  assert.deepEqual(result.quarantineCleanup, ['20260101T000000Z-aaaa']);
  assert.ok(fs.existsSync(path.join(rootDir, '20260102T000000Z-bbbb')));
  assert.ok(fs.existsSync(path.join(rootDir, '20260104T000000Z-dddd')));
  assert.ok(fs.existsSync(path.join(rootDir, 'unrelated')));
});

test('容量上限触发最旧自动档 LRU 清理，手工档仍保留', () => {
  const base = path.join(root, 'prune-quota-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 365, maxStoreBytes: 1 });
  const older = session(store, base, 'bbbbbbbc-2222-4222-8222-bbbbbbbbbbbb', 'OLDER', { days: 20 });
  session(store, base, 'cccccccd-3333-4333-8333-cccccccccccc', 'NEWER', { days: 2 });
  session(store, base, 'ddddddee-4444-4444-8444-dddddddddddd', 'MANUAL', { auto: false, days: 300 });
  const dry = c.prune({ store });
  assert.equal(dry.candidates[0].sessionHash, hashOf(older));
  assert.match(dry.candidates[0].reasons.join(','), /quota/);
  assert.equal(dry.candidates.some(item => item.manual), false);
});

test('prune 命令行 apply 返回 0，非法保留期返回 3 且不改档案', () => {
  const base = path.join(root, 'prune-cli-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const old = session(store, base, 'eeeeeeff-5555-4555-8555-eeeeeeeeeeee', 'CLI-OLD', { days: 60 });
  const env = { ...process.env, CONTINUITY_PRUNE_TMP: root };
  const invalid = spawnSync(process.execPath, [script, 'prune', '--store', store, '--retention-days', 'abc'], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(invalid.status, 3);
  assert.equal(JSON.parse(invalid.stdout).status, 'INVALID_CONFIG');
  assert.ok(fs.existsSync(c.location(old).dir));
  const applied = spawnSync(process.execPath, [script, 'prune', '--store', store, '--apply'], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(applied.status, 0);
  assert.equal(JSON.parse(applied.stdout).status, 'PRUNED');
  assert.equal(fs.existsSync(c.location(old).dir), false);
});
