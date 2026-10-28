'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('child_process');
const script = process.env.SUGGESTIONS_SCRIPT || path.resolve(__dirname, '../skills/skill-authoring-closure/scripts/mark-suggestions-evolved.cjs');

function fixture(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestion-test-'));
  const file = path.join(root, 'main.sqlite');
  const backups = path.join(root, 'backups');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE skill_evolution_suggestions (id TEXT PRIMARY KEY, skill_name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER, updated_at INTEGER, reason TEXT, summary TEXT, evolution_session_id TEXT UNIQUE, evolution_turn_id TEXT)');
  const insert = db.prepare('INSERT INTO skill_evolution_suggestions VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)');
  for (const [id, name, status] of [['p1', 'demo', 'pending'], ['p2', 'demo', 'pending'], ['active', 'demo', 'evolving'], ['done', 'demo', 'evolved']]) insert.run(id, name, status, 'original reason', 'original summary ' + id, 'original-session-' + id, 'original-turn-' + id);
  const snapshot = () => db.prepare('SELECT * FROM skill_evolution_suggestions ORDER BY id').all();
  const before = snapshot();
  const run = args => {
    const env = { ...process.env, HOME: root, USERPROFILE: root, TMP: root, TEMP: root, TMPDIR: root };
    delete env.QODER_HOME;
    return spawnSync(process.execPath, [script, '--db', file, '--backup-dir', backups, '--reason', 'reviewed and merged', ...args], { env, encoding: 'utf8', timeout: 15000 });
  };
  try { body({ root, file, backups, db, snapshot, before, run }); }
  finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('preview does not change rows or create backups', () => fixture(f => {
  const result = f.run(['--ids', 'p1']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.snapshot(), f.before);
  assert.equal(fs.existsSync(f.backups), false);
}));

test('exact IDs update only selected pending rows and retain a complete logical backup', () => fixture(f => {
  const result = f.run(['--ids', 'p1', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  const after = f.snapshot();
  assert.deepEqual(after.filter(r => r.id !== 'p1'), f.before.filter(r => r.id !== 'p1'));
  const changed = after.find(r => r.id === 'p1');
  assert.equal(changed.status, 'evolved');
  assert.equal(changed.reason, 'reviewed and merged');
  for (const key of ['summary', 'created_at', 'evolution_session_id', 'evolution_turn_id']) assert.equal(changed[key], f.before.find(r => r.id === 'p1')[key]);
  const backupFiles = fs.readdirSync(f.backups);
  assert.equal(backupFiles.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(f.backups, backupFiles[0])));
  assert.deepEqual(backup.rows.map(r => ({ ...r })), f.before.filter(r => r.id === 'p1').map(r => ({ ...r })));
}));

test('partially missing IDs refuse all writes', () => fixture(f => {
  assert.equal(f.run(['--ids', 'p1,missing', '--apply']).status, 3);
  assert.deepEqual(f.snapshot(), f.before);
  assert.equal(fs.existsSync(f.backups), false);
}));

test('explicit partial mode only updates the matched IDs', () => fixture(f => {
  assert.equal(f.run(['--ids', 'p1,missing', '--allow-partial', '--apply']).status, 0);
  assert.equal(f.snapshot().find(r => r.id === 'p1').status, 'evolved');
  assert.deepEqual(f.snapshot().filter(r => r.id !== 'p1'), f.before.filter(r => r.id !== 'p1'));
}));

test('evolving rows are never treated as pending', () => fixture(f => {
  assert.equal(f.run(['--ids', 'active', '--apply']).status, 3);
  assert.deepEqual(f.snapshot(), f.before);
}));

test('same-name rows count only this batch, not already evolved rows', () => fixture(f => {
  const result = f.run(['--names', 'demo', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已标记 evolved = 2/);
  assert.deepEqual(f.snapshot().filter(r => ['active', 'done'].includes(r.id)), f.before.filter(r => ['active', 'done'].includes(r.id)));
}));

test('backup failure is a controlled error and rolls back before any state change', () => fixture(f => {
  fs.writeFileSync(f.backups, 'not a directory');
  const result = f.run(['--ids', 'p1', '--apply']);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /已回滚/);
  assert.deepEqual(f.snapshot(), f.before);
}));

test('a later SQL failure rolls back earlier updates in the batch', () => fixture(f => {
  f.db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON skill_evolution_suggestions WHEN OLD.id = 'p2' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
  assert.equal(f.run(['--ids', 'p1,p2', '--apply']).status, 4);
  assert.deepEqual(f.snapshot(), f.before);
}));

test('verification happens before COMMIT and rolls back unexpected extra updates', () => fixture(f => {
  f.db.exec("CREATE TRIGGER extra_update AFTER UPDATE ON skill_evolution_suggestions WHEN OLD.id = 'p1' BEGIN UPDATE skill_evolution_suggestions SET status = 'evolved' WHERE id = 'p2'; END");
  assert.equal(f.run(['--ids', 'p1', '--apply']).status, 4);
  assert.deepEqual(f.snapshot(), f.before);
}));

test('missing database and missing selectors are rejected', () => fixture(f => {
  assert.equal(f.run([]).status, 2);
  const result = spawnSync(process.execPath, [script, '--db', path.join(f.root, 'absent.sqlite'), '--ids', 'p1'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'absent.sqlite')), false);
}));
