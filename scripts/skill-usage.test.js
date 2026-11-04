#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { test } = require('node:test');

const source = path.resolve(__dirname);
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-usage-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const client = path.join(base, '.qoder');
  const put = (rel, text) => {
    const file = path.join(client, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const skill = (tier, name) => put(`${tier === 'core' ? 'skills' : 'skills-library'}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name} fixture\n---\n`);
  const router = skill('core', 'skills-router');
  const extra = skill('core', 'parallel-orchestration');
  const library = skill('library', 'office-docs');
  put('skills-resident.json', JSON.stringify({ schema: 1, skills: ['parallel-orchestration', 'skills-router'] }));
  put('skills-index.json', JSON.stringify({
    count: 3,
    entries: [
      { name: 'skills-router', tier: 'core', path: router },
      { name: 'parallel-orchestration', tier: 'core', path: extra },
      { name: 'office-docs', tier: 'library', path: library },
    ],
  }));
  const env = { ...process.env, HOME: base, USERPROFILE: base, QODER_HOME: client, TEMP: base, TMP: base, TMPDIR: base };
  const run = (script, args) => spawnSync(process.execPath, [path.join(source, script), ...args, '--client-root', client], { env, encoding: 'utf8', timeout: 20000 });
  const runRaw = (script, args) => spawnSync(process.execPath, [path.join(source, script), ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { base, client, run, runRaw, put };
}

const NOW = '2026-11-04T00:00:00.000Z';
const old = days => new Date(Date.parse(NOW) - days * 86400000).toISOString();

test('standalone help succeeds without requiring a command or writing client state', t => {
  const f = fixture(t);
  const result = f.runRaw('skill-usage.cjs', ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /log\|report\|suggest\|prune/);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-usage.jsonl')), false);
  const unknown = f.runRaw('skill-usage.cjs', ['--help', '--unknown']);
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /未知参数/);
});

test('log, dedupe, report and suggest promote after repeated use', t => {
  const f = fixture(t);
  for (const day of [1, 2, 3]) {
    const r = f.run('skill-usage.cjs', ['log', 'office-docs', '--source', 'use', '--now', old(day)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOGGED/);
  }
  const duplicate = f.run('skill-usage.cjs', ['log', 'office-docs', '--source', 'use', '--now', old(1)]);
  assert.match(duplicate.stdout, /SKIP/);
  const report = f.run('skill-usage.cjs', ['report', '--json', '--now', NOW]);
  assert.equal(report.status, 0, report.stderr);
  const data = JSON.parse(report.stdout);
  const row = data.skills.find(item => item.skill === 'office-docs');
  assert.equal(row.d30, 3);
  assert.equal(row.total, 3);
  const suggest = f.run('skill-usage.cjs', ['suggest', '--json', '--now', NOW]);
  assert.equal(suggest.status, 0, suggest.stderr);
  const result = JSON.parse(suggest.stdout);
  assert.deepEqual(result.suggestions.filter(item => item.action !== 'demote').map(item => [item.skill, item.from, item.to]), [['office-docs', 'library', 'core']]);
});

test('two uses are not enough to suggest promotion', t => {
  const f = fixture(t);
  for (const day of [1, 2]) f.run('skill-usage.cjs', ['log', 'office-docs', '--now', old(day)]);
  const suggest = f.run('skill-usage.cjs', ['suggest', '--json', '--now', NOW]);
  assert.equal(JSON.parse(suggest.stdout).suggestions.length, 0);
});

test('idle user-promoted core skills are demoted, package CORE defaults are not', t => {
  const f = fixture(t);
  f.run('skill-usage.cjs', ['log', 'parallel-orchestration', '--now', old(120)]);
  f.run('skill-usage.cjs', ['log', 'skills-router', '--now', old(120)]);
  const suggest = f.run('skill-usage.cjs', ['suggest', '--json', '--now', NOW]);
  const demote = JSON.parse(suggest.stdout).suggestions.filter(item => item.from === 'core');
  assert.deepEqual(demote.map(item => item.skill), ['parallel-orchestration']);
});

test('malformed usage lines are ignored and never invent suggestions', t => {
  const f = fixture(t);
  const file = path.join(f.client, 'skills-usage.jsonl');
  fs.writeFileSync(file, 'not-json\n{"ts":"bad","skill":"office-docs","source":"use"}\n');
  const report = f.run('skill-usage.cjs', ['report', '--json', '--now', NOW]);
  const data = JSON.parse(report.stdout);
  assert.equal(data.invalid, 2);
  assert.equal(data.skills.length, 0);
  assert.match(f.run('skill-usage.cjs', ['suggest', '--now', NOW]).stdout, /NO_SUGGESTIONS/);
});

test('skill-load records only with --record', t => {
  const f = fixture(t);
  const normal = f.runRaw('skill-load.cjs', ['office']);
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-usage.jsonl')), false);
  const recorded = f.runRaw('skill-load.cjs', ['--record', 'office']);
  assert.equal(recorded.status, 0, recorded.stderr);
  const lines = fs.readFileSync(path.join(f.client, 'skills-usage.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).skill, 'office-docs');
  assert.equal(JSON.parse(lines[0]).source, 'skill-load');
});

test('suggest fails on an invalid resident list instead of silently disabling demotion', t => {
  const f = fixture(t);
  f.put('skills-resident.json', '{"schema":1,"skills":["../outside"]}');
  const result = f.run('skill-usage.cjs', ['suggest', '--now', NOW]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /skills-resident\.json 格式无效/);
});

test('prune previews and removes only expired entries', t => {
  const f = fixture(t);
  f.run('skill-usage.cjs', ['log', 'office-docs', '--now', old(500)]);
  f.run('skill-usage.cjs', ['log', 'office-docs', '--now', old(10)]);
  const preview = f.run('skill-usage.cjs', ['prune', '--days', '365', '--now', NOW]);
  assert.match(preview.stdout, /DRY-RUN prune=1 keep=1/);
  const applied = f.run('skill-usage.cjs', ['prune', '--days', '365', '--apply', '--now', NOW]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /PRUNED removed=1 keep=1/);
  const report = JSON.parse(f.run('skill-usage.cjs', ['report', '--json', '--now', NOW]).stdout);
  assert.equal(report.skills[0].total, 1);
});

test('tier suggestions follow live installed paths after a move despite a stale index', t => {
  const f = fixture(t);
  const library = path.join(f.client, 'skills-library/office-docs');
  const resident = path.join(f.client, 'skills/office-docs');
  fs.renameSync(library, resident);
  // A stale index path still exists when the old tier was replaced by another
  // ordinary file; the live skill entry remains the authoritative location.
  fs.mkdirSync(library); fs.writeFileSync(path.join(library, 'README.md'), 'moved');
  const stale = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-index.json'), 'utf8'));
  stale.entries.find(entry => entry.name === 'office-docs').path = path.join(library, 'README.md');
  f.put('skills-index.json', JSON.stringify(stale));
  for (const day of [1, 2, 3]) f.run('skill-usage.cjs', ['log', 'office-docs', '--now', old(day)]);
  const result = f.run('skill-usage.cjs', ['suggest', '--json', '--now', NOW]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).suggestions.some(entry => entry.skill === 'office-docs'), false);
  const report = JSON.parse(f.run('skill-usage.cjs', ['report', '--json', '--now', NOW]).stdout);
  assert.equal(report.skills.find(entry => entry.skill === 'office-docs').tier, 'core');
});

test('tier suggestions do not resolve a skill installed in both tiers', t => {
  const f = fixture(t);
  f.put('skills/office-docs/SKILL.md', '# ambiguous copy');
  for (const day of [1, 2, 3]) f.run('skill-usage.cjs', ['log', 'office-docs', '--now', old(day)]);
  const result = f.run('skill-usage.cjs', ['suggest', '--json', '--now', NOW]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).suggestions.some(entry => entry.skill === 'office-docs'), false);
});
