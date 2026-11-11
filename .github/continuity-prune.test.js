'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
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

function legacyRecord(o, days) {
  const dir = c.location(o).dir;
  const scopeFile = path.join(dir, 'scope.json');
  const scope = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  const at = new Date(Date.now() - days * 86400000).toISOString();
  fs.writeFileSync(scopeFile, JSON.stringify({ ...scope, auto: true, createdAt: at }));
  const transcript = path.join(o.cwd, o.session + '.jsonl');
  fs.writeFileSync(transcript, '');
  const body = { schema: 1, task: o.task, session: o.session, cwd: scope.cwd, kind: 'user-request', text: 'LEGACY-EVIDENCE', source: { file: transcript, byteOffset: 0, byteLength: 0, sha256: crypto.createHash('sha256').update('').digest('hex') } };
  const id = crypto.createHash('sha256').update(JSON.stringify({ ...body, origin: body.source })).digest('hex');
  const record = { id, capturedAt: at, integrity: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body };
  const records = path.join(dir, 'records');
  fs.mkdirSync(records, { recursive: true });
  const file = path.join(records, id + '.json');
  fs.writeFileSync(file, JSON.stringify(record));
  const old = new Date(Date.now() - days * 86400000);
  for (const item of [scopeFile, file]) fs.utimesSync(item, old, old);
  return file;
}

test('旧 JSON 档案不被误判为空档，0 字节库加 legacy 记录也受保护', () => {
  const base = path.join(root, 'prune-legacy-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const legacy = { store, cwd: path.join(base, 'ws-legacy'), session: '11111111-aaaa-4aaa-8aaa-111111111111', task: 'LEGACY-TASK' };
  fs.mkdirSync(legacy.cwd, { recursive: true });
  c.enable(legacy);
  legacyRecord(legacy, 20);
  assert.equal(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(legacy)), false);
  const db = path.join(c.location(legacy).dir, 'continuity.sqlite');
  fs.writeFileSync(db, '');
  const old = new Date(Date.now() - 20 * 86400000);
  fs.utimesSync(db, old, old);
  assert.equal(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(legacy)), false);
});

test('prune 排除指定当前会话，手工 apply 不会删它', () => {
  const base = path.join(root, 'prune-exclude-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const current = session(store, base, '22222222-bbbb-4bbb-8bbb-222222222222', 'CURRENT', { days: 60 });
  const other = session(store, base, '33333333-cccc-4ccc-8ccc-333333333333', 'OTHER', { days: 60 });
  const applied = c.prune({ store, apply: true, cwd: current.cwd, session: current.session });
  assert.equal(applied.deleted.length, 1);
  assert.ok(fs.existsSync(c.location(current).dir));
  assert.equal(fs.existsSync(c.location(other).dir), false);
  assert.equal(c.prune({ store, cwd: current.cwd }).status, 'INVALID_ARGUMENT');
});

test('transcript 移到已知根目录时不判孤儿', () => {
  const base = path.join(root, 'prune-alt-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const o = session(store, base, '44444444-dddd-4ddd-8ddd-444444444444', 'MOVED', { days: 10 });
  fs.unlinkSync(o.transcript);
  const alt = path.join(base, 'qoder-cn', 'projects', 'project-x', o.session + '.jsonl');
  fs.mkdirSync(path.dirname(alt), { recursive: true });
  fs.writeFileSync(alt, '');
  assert.equal(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(o)), false);
});

test('未完成隔离批次可通过 recover 移回，list 能列出批次', () => {
  const base = path.join(root, 'prune-recover-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const old = session(store, base, '55555555-eeee-4eee-8eee-555555555555', 'RECOVER', { days: 60 });
  const applied = c.prune({ store, apply: true });
  assert.equal(applied.deleted.length, 1);
  const manifestFile = path.join(applied.quarantineBatch, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.status = 'inprogress';
  for (const item of manifest.sessions) delete item.restoredAt;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal(c.listQuarantine(store).batches.length, 1);
  const recovered = c.recoverQuarantine(store);
  assert.equal(recovered.status, 'RECOVERED');
  assert.equal(recovered.restored.length, 1);
  assert.ok(fs.existsSync(c.location(old).dir));
});

test('scope.json 的 mtime 不会给旧会话续命', () => {
  const base = path.join(root, 'prune-activity-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const o = session(store, base, '66666666-ffff-4fff-8fff-666666666666', 'OLD', { days: 60 });
  const now = new Date();
  fs.utimesSync(path.join(c.location(o).dir, 'scope.json'), now, now);
  assert.ok(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(o)));
});

test('apply 写审计与检查缓存，dry-run 零写入', () => {
  const base = path.join(root, 'prune-audit-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  session(store, base, '77777777-aaaa-4aaa-8aaa-777777777777', 'AUDIT', { days: 60 });
  const before = snapshot(store);
  c.prune({ store });
  assert.equal(snapshot(store), before);
  assert.equal(fs.existsSync(path.join(store, 'prune-audit.jsonl')), false);
  c.prune({ store, apply: true });
  assert.ok(fs.existsSync(path.join(store, 'prune-audit.jsonl')));
  assert.ok(fs.existsSync(path.join(store, 'prune-cache.json')));
});

// ---- T-04：跨设备隔离先核字节再删源 ----
// EXDEV 无法在单盘夹具里自然触发，只能注入；注入点严格限定为本会话目录，
// 免得把 atomic() 的 renameSync 也改成跨设备，污染 manifest 写入路径。
function withCrossDevice(dir, fault, run) {
  const realRename = fs.renameSync;
  const realCp = fs.cpSync;
  const hits = { exdev: 0, fault: 0 };
  const isTarget = value => path.resolve(String(value)) === path.resolve(dir);
  fs.renameSync = function (src) {
    if (isTarget(src)) {
      hits.exdev++;
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    }
    return realRename.apply(fs, arguments);
  };
  fs.cpSync = function (src, dest) {
    const result = realCp.apply(fs, arguments);
    if (isTarget(src) && fault) { fault(dest); hits.fault++; }
    return result;
  };
  try { return { value: run(), hits }; }
  finally { fs.renameSync = realRename; fs.cpSync = realCp; }
}

function payloadSession(store, base, id, task, days) {
  const o = session(store, base, id, task, { days });
  const dir = c.location(o).dir;
  const payload = path.join(dir, 'payload.bin');
  fs.writeFileSync(payload, Buffer.alloc(4096, 7));
  return { o, dir, payload };
}

function readManifest(applied) {
  return JSON.parse(fs.readFileSync(path.join(applied.quarantineBatch, 'manifest.json'), 'utf8'));
}

for (const [label, fault] of [
  ['截断 1 字节', dest => fs.writeFileSync(path.join(dest, 'payload.bin'), Buffer.alloc(4095, 7))],
  ['大小相同但内容不同', dest => fs.writeFileSync(path.join(dest, 'payload.bin'), Buffer.alloc(4096, 9))],
]) {
  test('T-04 跨设备复制' + label + '时保留源、不记 complete', () => {
    const base = path.join(root, 'prune-copy-bad-' + (++seq));
    const store = path.join(base, 'store');
    pruneConfig(store, { retentionDays: 30 });
    const { dir, payload } = payloadSession(store, base, 'a1b2c3d4-1111-4111-8111-111111111111', 'COPY-BAD', 60);
    const { value: applied, hits } = withCrossDevice(dir, fault, () => c.prune({ store, apply: true }));
    assert.equal(hits.exdev, 1, '必须真的走到 EXDEV 分支');
    assert.equal(hits.fault, 1, '必须真的注入了坏副本');
    assert.equal(applied.errors.length, 1);
    assert.equal(applied.errors[0].code, 'COPY_VERIFY_FAILED');
    assert.equal(applied.deleted.length, 0);
    assert.ok(fs.existsSync(dir), '核验失败时源目录必须保留');
    assert.equal(fs.statSync(payload).size, 4096);
    assert.equal(fs.readFileSync(payload).equals(Buffer.alloc(4096, 7)), true);
    const manifest = readManifest(applied);
    assert.equal(manifest.status, 'incomplete');
    assert.notEqual(manifest.status, 'complete');
  });
}

test('T-04 正常跨设备复制逐文件核字节通过后删源并记 mode:copy', () => {
  const base = path.join(root, 'prune-copy-ok-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const { dir } = payloadSession(store, base, 'a1b2c3d4-2222-4222-8222-222222222222', 'COPY-OK', 60);
  const { value: applied, hits } = withCrossDevice(dir, null, () => c.prune({ store, apply: true }));
  assert.equal(hits.exdev, 1);
  assert.equal(hits.fault, 0);
  assert.equal(applied.errors.length, 0);
  assert.equal(applied.deleted.length, 1);
  assert.equal(fs.existsSync(dir), false);
  const manifest = readManifest(applied);
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.sessions[0].mode, 'copy');
  const movedRoot = path.join(applied.quarantineBatch, manifest.sessions[0].cwdHash, manifest.sessions[0].sessionHash);
  for (const file of manifest.sessions[0].files) {
    const moved = fs.readFileSync(path.join(movedRoot, file.path));
    assert.equal(moved.length, file.size);
    if (file.sha256) assert.equal(crypto.createHash('sha256').update(moved).digest('hex'), file.sha256);
  }
});

test('T-04 同设备仍走 rename 快路径，行为与改动前一致', () => {
  const base = path.join(root, 'prune-rename-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30 });
  const { dir } = payloadSession(store, base, 'a1b2c3d4-3333-4333-8333-333333333333', 'RENAME', 60);
  const applied = c.prune({ store, apply: true });
  assert.equal(applied.errors.length, 0);
  assert.equal(fs.existsSync(dir), false);
  const manifest = readManifest(applied);
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.sessions[0].mode, 'rename');
});

// ---- T-05：缓存键与活动判定纳入 WAL sidecar ----
function emptyAgedSession(store, base, id, task, days) {
  const cwd = path.join(base, 'ws-' + id.slice(0, 6));
  fs.mkdirSync(cwd, { recursive: true });
  const transcript = path.join(base, id + '.jsonl');
  fs.writeFileSync(transcript, '');
  const o = { store, cwd, session: id, task, transcript };
  c.enable(o);
  const dir = c.location(o).dir;
  const scopeFile = path.join(dir, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(scopeFile, 'utf8')), auto: true }));
  c.capture(o);
  ageSession(o, days);
  return { o, dir, transcript };
}

function backdate(file, days) {
  const at = new Date(Date.now() - days * 86400000);
  fs.utimesSync(file, at, at);
}

function reasonsOf(plan, sessionHash) {
  const item = plan.sessions.find(entry => entry.sessionHash === sessionHash);
  return item ? item.reasons : null;
}

test('T-05 主库 mtime/size 不变、仅 -wal 增长时不得判 empty', () => {
  const base = path.join(root, 'prune-wal-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const { o, dir, transcript } = emptyAgedSession(store, base, 'b1b2c3d4-1111-4111-8111-111111111111', 'WAL-ONLY', 30);
  const dbFile = path.join(dir, 'continuity.sqlite');
  const first = c.planPrune(store, c.prunePolicy(store));
  assert.equal(first.inspected, 1);
  assert.deepEqual(reasonsOf(first, hashOf(o)), ['empty']);
  fs.writeFileSync(path.join(store, 'prune-cache.json'), JSON.stringify(first.cache));

  const before = fs.statSync(dbFile);
  const wal = new DatabaseSync(dbFile);
  let second;
  try {
    wal.exec('PRAGMA wal_autocheckpoint = 0');
    wal.prepare('INSERT INTO records (id,kind,text,source,task,session,cwd,captured_at,integrity) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('wal-row-1', 'user-request', 'WAL-EVIDENCE', JSON.stringify({ file: transcript }), 'WAL-ONLY', o.session, o.cwd, new Date().toISOString(), 'ok');
    const walFile = dbFile + '-wal';
    assert.ok(fs.existsSync(walFile) && fs.statSync(walFile).size > 0, '夹具必须真的把记录留在 -wal 里');
    // 负对照必须在连接仍打开时取：close 会 checkpoint 并改主库 mtime，把归因混进活动闸门
    const during = fs.statSync(dbFile);
    assert.equal(during.mtimeMs, before.mtimeMs, '主库 mtime 必须未变');
    assert.equal(during.size, before.size, '主库 size 必须未变');
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) backdate(dbFile + suffix, 30);
    second = c.planPrune(store, c.prunePolicy(store));
  } finally { wal.close(); }
  assert.equal(second.inspected, 1, 'sidecar 指纹变了必须重新检查，不得命中过期缓存');
  const item = second.sessions.find(entry => entry.sessionHash === hashOf(o));
  assert.equal(item.records, 1);
  assert.deepEqual(item.reasons, []);
});

test('T-05 旧格式缓存条目缺 sidecar 字段必须失效并重查', () => {
  const base = path.join(root, 'prune-wal-legacy-cache-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const o = session(store, base, 'b1b2c3d4-2222-4222-8222-222222222222', 'OLD-CACHE', { days: 30 });
  const policy = c.prunePolicy(store);
  const first = c.planPrune(store, policy);
  assert.equal(first.inspected, 1);
  const stale = JSON.parse(JSON.stringify(first.cache));
  for (const entry of Object.values(stale.entries)) {
    for (const field of ['walMtime', 'walSize', 'shmMtime', 'shmSize']) delete entry[field];
  }
  fs.writeFileSync(path.join(store, 'prune-cache.json'), JSON.stringify(stale));
  const second = c.planPrune(store, policy);
  assert.equal(second.inspected, 1, '缺 sidecar 字段的旧条目不得当作命中');
  assert.equal(second.sessions.find(entry => entry.sessionHash === hashOf(o)).records, first.sessions[0].records);
});

test('T-05 无 sidecar 时缓存命中路径与改动前一致', () => {
  const base = path.join(root, 'prune-wal-hit-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 90, orphanGraceDays: 7 });
  const o = session(store, base, 'b1b2c3d4-3333-4333-8333-333333333333', 'CACHE-HIT', { days: 30 });
  const dbFile = path.join(c.location(o).dir, 'continuity.sqlite');
  assert.equal(fs.existsSync(dbFile + '-wal'), false);
  assert.equal(fs.existsSync(dbFile + '-shm'), false);
  const policy = c.prunePolicy(store);
  const first = c.planPrune(store, policy);
  assert.equal(first.inspected, 1);
  fs.writeFileSync(path.join(store, 'prune-cache.json'), JSON.stringify(first.cache));
  const second = c.planPrune(store, policy);
  assert.equal(second.inspected, 0);
  assert.deepEqual(reasonsOf(second, hashOf(o)), reasonsOf(first, hashOf(o)));
  assert.equal(second.sessions[0].records, first.sessions[0].records);
});

test('T-05 活动判定看 sidecar：仅 -wal 新鲜时不再显得陈旧', () => {
  const base = path.join(root, 'prune-wal-activity-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 30, orphanGraceDays: 7 });
  const { o, dir } = emptyAgedSession(store, base, 'b1b2c3d4-4444-4444-8444-444444444444', 'WAL-ACTIVE', 60);
  const dbFile = path.join(dir, 'continuity.sqlite');
  assert.ok(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(o)), '对照组：陈旧空档应被清理');
  const wal = new DatabaseSync(dbFile);
  try {
    wal.exec('PRAGMA wal_autocheckpoint = 0');
    wal.prepare('INSERT INTO records (id,kind,text,source,task,session,cwd,captured_at,integrity) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('wal-row-2', 'user-request', 'FRESH-WAL', JSON.stringify({ file: path.join(base, 'missing.jsonl') }), 'WAL-ACTIVE', o.session, o.cwd, new Date().toISOString(), 'ok');
    assert.ok(fs.statSync(dbFile + '-wal').size > 0);
    assert.equal(c.prune({ store }).candidates.some(item => item.sessionHash === hashOf(o)), false, '-wal 刚写过就是活跃会话');
  } finally { wal.close(); }
});

// ---- T-06：quota 驱逐补年龄下限 ----
test('T-06 超配额时年轻自动会话不得被 quota 命中', () => {
  const base = path.join(root, 'prune-quota-young-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 365, orphanGraceDays: 7, maxStoreBytes: 1 });
  session(store, base, 'c1b2c3d4-1111-4111-8111-111111111111', 'YOUNG', { days: 1 });
  const dry = c.prune({ store });
  assert.ok(dry.totalBytes > 1, '夹具必须真的超配额');
  assert.deepEqual(dry.candidates, []);
});

test('T-06 超配额时超过宽限期的老会话仍被 quota 命中', () => {
  const base = path.join(root, 'prune-quota-old-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 365, orphanGraceDays: 7, maxStoreBytes: 1 });
  const old = session(store, base, 'c1b2c3d4-2222-4222-8222-222222222222', 'OLD', { days: 30 });
  const dry = c.prune({ store });
  assert.equal(dry.candidates.length, 1);
  assert.equal(dry.candidates[0].sessionHash, hashOf(old));
  assert.match(dry.candidates[0].reasons.join(','), /quota/);
});

test('T-06 超配额下 manual / current-session / capture-lock 命中数均为 0', () => {
  const base = path.join(root, 'prune-quota-protected-' + (++seq));
  const store = path.join(base, 'store');
  pruneConfig(store, { retentionDays: 365, orphanGraceDays: 7, maxStoreBytes: 1 });
  session(store, base, 'c1b2c3d4-3333-4333-8333-333333333333', 'MANUAL', { auto: false, days: 30 });
  const locked = session(store, base, 'c1b2c3d4-4444-4444-8444-444444444444', 'LOCKED', { days: 30 });
  fs.writeFileSync(path.join(c.location(locked).dir, 'capture.lock'), '');
  const current = session(store, base, 'c1b2c3d4-5555-4555-8555-555555555555', 'CURRENT', { days: 30 });
  const dry = c.prune({ store, cwd: current.cwd, session: current.session });
  assert.ok(dry.totalBytes > 1);
  assert.deepEqual(dry.candidates, []);
  const plan = c.planPrune(store, c.prunePolicy(store), { excludeDir: c.location(current).dir });
  assert.equal(plan.sessions.filter(item => item.reasons.includes('quota')).length, 0);
  assert.equal(plan.sessions.length, 3);
});
