'use strict';
// 变异验证（T-04 / T-05 / T-06）：把三处修复分别摘掉做成 mutant，同一夹具在 mutant 上
// 必须**判红**，否则 continuity-prune.test.js 里那几条就是恒绿的假判据。
// 形式沿用 scripts/auth-lock-merge-mutation.test.js；mutant 写在隔离临时目录，不落仓库。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = path.join(__dirname, '..', 'scripts', 'continuity.cjs');
const src = fs.readFileSync(SOURCE, 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-continuity-mutation-'));
process.env.CONTINUITY_PRUNE_TMP = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

function replaceOnce(text, needle, replacement) {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error('MUTATION_TARGET_MISSING: ' + needle.slice(0, 60));
  if (text.indexOf(needle, first + 1) >= 0) throw new Error('MUTATION_TARGET_AMBIGUOUS: ' + needle.slice(0, 60));
  return text.slice(0, first) + replacement + text.slice(first + needle.length);
}

function cutBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle, start + 1);
  if (start < 0 || end < 0) throw new Error('MUTATION_RANGE_MISSING: ' + startNeedle.slice(0, 60));
  return text.slice(0, start) + text.slice(end);
}

// M4：摘掉跨设备复制后的逐文件字节核对
const m4 = cutBetween(src, '    // 跨设备复制后必须逐文件核字节', '    fs.rmSync(src, { recursive: true, force: false });');
// M5：缓存键、缓存条目、活动判定三处一起退回不看 sidecar
const m5 = (() => {
  let out = replaceOnce(src,
    '    if (cached && cached.dbMtime === dbMtime && cached.dbSize === dbSize && cached.legacyMtime === legacyMtime\n'
    + '      && cached.walMtime === walMtime && cached.walSize === walSize\n'
    + '      && cached.shmMtime === shmMtime && cached.shmSize === shmSize) {',
    '    if (cached && cached.dbMtime === dbMtime && cached.dbSize === dbSize && cached.legacyMtime === legacyMtime) {');
  out = replaceOnce(out, '        dbMtime, dbSize, legacyMtime, walMtime, walSize, shmMtime, shmSize,\n', '        dbMtime, dbSize, legacyMtime,\n');
  out = cutBetween(out, '  // WAL 未 checkpoint 时主库 mtime 不变', '  const legacy = path.join(dir, \'records\');');
  return out;
})();
// M6：摘掉 quota 的年龄下限
const m6 = replaceOnce(src,
  '    const evictable = sessions.filter(item => !item.manual && item.reasons.length === 0\n'
  + '      && (item.lastActivity ? (now - item.lastActivity) / 86400000 : Infinity) > policy.orphanGraceDays)\n'
  + '      .sort((a, b) => a.lastActivity - b.lastActivity);',
  '    const evictable = sessions.filter(item => !item.manual && item.reasons.length === 0).sort((a, b) => a.lastActivity - b.lastActivity);');

for (const [name, text, absent] of [
  ['M4', m4, 'COPY_VERIFY_FAILED'],
  ['M5', m5, 'cached.walMtime'],
  ['M5', m5, 'legacyMtime, walMtime'],
  ['M5', m5, '// WAL 未 checkpoint 时主库 mtime 不变'],
  ['M6', m6, 'orphanGraceDays)\n      .sort'],
]) {
  if (text === src) throw new Error('MUTATION_NOOP: ' + name);
  if (text.includes(absent)) throw new Error('MUTATION_RESIDUE: ' + name + ' 仍含 ' + absent);
}

let loadSeq = 0;
function load(text) {
  const file = path.join(root, 'continuity-mutant-' + (++loadSeq) + '.cjs');
  fs.writeFileSync(file, text);
  return require(file);
}
const real = require(SOURCE);
const mutant = { M4: load(m4), M5: load(m5), M6: load(m6) };

const DDL = 'CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT, text TEXT, source TEXT, task TEXT, session TEXT, cwd TEXT, captured_at TEXT, integrity TEXT)';
const DAY = 86400000;

function backdate(file, days) {
  const at = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, at, at);
}

function fixture(label, config) {
  const base = fs.mkdtempSync(path.join(root, label + '-'));
  const store = path.join(base, 'store');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'prune.json'), JSON.stringify({
    schema: 1, enabled: true, retentionDays: 90, orphanGraceDays: 7,
    quarantineRoot: path.join(base, 'quarantine'), ...config,
  }));
  return { base, store };
}

function rawSession(store, cwdHash, sessHash, ageDays, scope = {}) {
  const dir = path.join(store, cwdHash, sessHash);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'continuity.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(DDL);
  db.close();
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify({
    schema: 1, auto: true, enabled: true, createdAt: at, task: 'MUTATION', session: sessHash, cwd: 'D:/fixture', ...scope,
  }));
  backdate(dbFile, ageDays);
  backdate(path.join(dir, 'scope.json'), ageDays);
  return { dir, dbFile };
}

function insert(db, id, sourceFile) {
  db.prepare('INSERT INTO records (id,kind,text,source,task,session,cwd,captured_at,integrity) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'user-request', 'MUTATION-EVIDENCE', JSON.stringify({ file: sourceFile }), 'MUTATION', 'sess', 'D:/fixture', new Date().toISOString(), 'ok');
}

function withCrossDevice(dir, fault, run) {
  const realRename = fs.renameSync;
  const realCp = fs.cpSync;
  const isTarget = value => path.resolve(String(value)) === path.resolve(dir);
  fs.renameSync = function (src) {
    if (isTarget(src)) { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
    return realRename.apply(fs, arguments);
  };
  fs.cpSync = function (src, dest) {
    const result = realCp.apply(fs, arguments);
    if (isTarget(src) && fault) fault(dest);
    return result;
  };
  try { return run(); }
  finally { fs.renameSync = realRename; fs.cpSync = realCp; }
}

// 判据①：截断复制后源必须保留、错误码必须是 COPY_VERIFY_FAILED、批次不得记 complete
function copyGuardHolds(mod, label) {
  const { base, store } = fixture(label, { retentionDays: 30 });
  const { dir } = rawSession(store, 'cwdCopy', 'sessCopy', 60);
  const payload = path.join(dir, 'payload.bin');
  fs.writeFileSync(payload, Buffer.alloc(4096, 7));
  const applied = withCrossDevice(dir, dest => fs.writeFileSync(path.join(dest, 'payload.bin'), Buffer.alloc(4095, 7)),
    () => mod.prune({ store, apply: true }));
  if (!applied.quarantineBatch) return false;
  const manifest = JSON.parse(fs.readFileSync(path.join(applied.quarantineBatch, 'manifest.json'), 'utf8'));
  return applied.errors.length === 1 && applied.errors[0].code === 'COPY_VERIFY_FAILED'
    && applied.deleted.length === 0 && fs.existsSync(dir) && fs.statSync(payload).size === 4096
    && manifest.status === 'incomplete';
}

// 判据②：主库指纹未变、仅 -wal 增长时，过期缓存不得把有记录的会话判成 empty
function walCacheHolds(mod, label) {
  const { base, store } = fixture(label, { retentionDays: 90, orphanGraceDays: 7 });
  const { dir, dbFile } = rawSession(store, 'cwdWal', 'sessWal', 30);
  const transcript = path.join(base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const policy = mod.prunePolicy(store);
  const first = mod.planPrune(store, policy);
  if (first.inspected !== 1) return false;
  fs.writeFileSync(path.join(store, 'prune-cache.json'), JSON.stringify(first.cache));
  const before = fs.statSync(dbFile);
  const wal = new DatabaseSync(dbFile);
  try {
    wal.exec('PRAGMA wal_autocheckpoint = 0');
    insert(wal, 'wal-1', transcript);
    if (!fs.existsSync(dbFile + '-wal') || fs.statSync(dbFile + '-wal').size === 0) return false;
    const during = fs.statSync(dbFile);
    if (during.mtimeMs !== before.mtimeMs || during.size !== before.size) return false;
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) backdate(dbFile + suffix, 30);
    const second = mod.planPrune(store, policy);
    const item = second.sessions.find(entry => entry.sessionHash === 'sessWal');
    return second.inspected === 1 && item.records === 1 && !item.reasons.includes('empty');
  } finally { wal.close(); }
}

// 判据③：-wal 刚写过就是活跃会话，即使 records 仍为 0 也不得按陈旧空档清理
function walActivityHolds(mod, label) {
  const { store } = fixture(label, { retentionDays: 30, orphanGraceDays: 7 });
  const { dbFile } = rawSession(store, 'cwdAct', 'sessAct', 60);
  const wal = new DatabaseSync(dbFile);
  try {
    wal.exec('PRAGMA wal_autocheckpoint = 0');
    wal.exec('CREATE TABLE IF NOT EXISTS scratch (x TEXT)');
    wal.prepare('INSERT INTO scratch (x) VALUES (?)').run('fresh-write');
    if (!fs.existsSync(dbFile + '-wal') || fs.statSync(dbFile + '-wal').size === 0) return false;
    return mod.planPrune(store, mod.prunePolicy(store)).candidates.length === 0;
  } finally { wal.close(); }
}

// 判据④：超配额时年轻自动会话不得被 quota 命中
function quotaFloorHolds(mod, label) {
  const { store } = fixture(label, { retentionDays: 365, orphanGraceDays: 7, maxStoreBytes: 1 });
  rawSession(store, 'cwdYoung', 'sessYoung', 1);
  const plan = mod.planPrune(store, mod.prunePolicy(store));
  return plan.totalBytes > 1 && plan.candidates.length === 0;
}

// 对照：老会话仍须被 quota 命中（修复不得削弱功能），真实与变异都应成立
function quotaStillEvictsOld(mod, label) {
  const { base, store } = fixture(label, { retentionDays: 365, orphanGraceDays: 7, maxStoreBytes: 1 });
  const { dbFile } = rawSession(store, 'cwdOld', 'sessOld', 30);
  const transcript = path.join(base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const db = new DatabaseSync(dbFile);
  insert(db, 'old-1', transcript);
  db.close();
  backdate(dbFile, 30);
  const plan = mod.planPrune(store, mod.prunePolicy(store));
  return plan.candidates.length === 1 && plan.candidates[0].reasons.includes('quota');
}

// 对照：正常跨设备复制仍须成功（修复不得把正常路径也拦掉），真实与变异都应成立
function copyStillWorks(mod, label) {
  const { store } = fixture(label, { retentionDays: 30 });
  const { dir } = rawSession(store, 'cwdOk', 'sessOk', 60);
  fs.writeFileSync(path.join(dir, 'payload.bin'), Buffer.alloc(4096, 7));
  const applied = withCrossDevice(dir, null, () => mod.prune({ store, apply: true }));
  if (!applied.quarantineBatch) return false;
  const manifest = JSON.parse(fs.readFileSync(path.join(applied.quarantineBatch, 'manifest.json'), 'utf8'));
  return applied.errors.length === 0 && applied.deleted.length === 1 && !fs.existsSync(dir)
    && manifest.status === 'complete' && manifest.sessions[0].mode === 'copy';
}

const cases = [
  ['T-04 截断复制保留源', 'M4', copyGuardHolds, true],
  ['T-05 WAL 增长使命中缓存失效', 'M5', walCacheHolds, true],
  ['T-05 WAL 新鲜即活跃', 'M5', walActivityHolds, true],
  ['T-06 quota 年龄下限', 'M6', quotaFloorHolds, true],
];

for (const [label, key, run, expected] of cases) {
  test('变异验证 ' + label, () => {
    assert.equal(run(real, 'real-' + key), expected, '真实实现必须满足判据');
    assert.equal(run(mutant[key], 'mut-' + key), !expected, '摘掉修复后同一夹具必须判红，否则判据恒绿');
  });
}

for (const [label, run] of [['正常跨设备复制仍成功', copyStillWorks], ['老会话仍被 quota 命中', quotaStillEvictsOld]]) {
  test('非削弱对照 ' + label, () => {
    for (const key of ['M4', 'M5', 'M6']) {
      assert.equal(run(real, 'real-' + key), true, '真实实现：' + label);
      assert.equal(run(mutant[key], 'mut-' + key), true, '变异实现：' + label);
    }
  });
}

test('变异确实改到了目标代码', () => {
  assert.equal(m4.includes('COPY_VERIFY_FAILED'), false);
  assert.equal(m5.includes('cached.walMtime'), false);
  assert.equal(m5.includes('legacyMtime, walMtime'), false);
  assert.equal(m5.includes('// WAL 未 checkpoint 时主库 mtime 不变'), false);
  assert.equal(m6.includes('> policy.orphanGraceDays)\n      .sort'), false);
  assert.ok(m4.length < src.length && m5.length < src.length && m6.length < src.length);
});