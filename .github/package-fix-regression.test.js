'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { BASE_IDS } = require('../scripts/install-package.cjs');
const { isPublicFile } = require('../scripts/pack-share-extras.cjs');

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('share package carries the fixed plan, recall and routing chains', () => {
  assert.match(read('scripts/parallel-plan.cjs'), /PLAN_DOC_REQUIRED/);
  assert.match(read('scripts/parallel-context.cjs'), /DECISION_REQUIRED/);
  assert.match(read('scripts/parallel-context.cjs'), /command === 'recall'/);
  assert.match(read('scripts/capability-advisor.cjs'), /RELEVANT_LOCAL_LIBRARY_SKILL/);
  assert.match(read('skills/skills-router/SKILL.md'), /触发词：技能路由/);
  assert.match(read('skills/rules-conflict-audit/SKILL.md'), /触发词：规则冲突/);
  assert.match(read('skills/parallel-orchestration/SKILL.md'), /--markdown/);
  assert.match(read('skills/parallel-orchestration/SKILL.md'), /parallel-context\.cjs recall/);
});

test('base install ships the plan and recall scripts', () => {
  assert.ok(BASE_IDS.includes('script:parallel-plan.cjs'));
  assert.ok(BASE_IDS.includes('script:parallel-context.cjs'));
  const catalog = JSON.parse(read('catalog.json'));
  for (const id of ['script:parallel-plan.cjs', 'script:parallel-context.cjs']) {
    assert.ok(catalog.entries.some(entry => entry.id === id && entry.status === 'shipped'), id);
  }
});

test('backup process files are never tracked or shipped', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(tracked.filter(file => /\.bak(?:[._-]|\d|$)/i.test(file)), []);
  for (const rel of ['scripts/demo.cjs.bak', 'skills/demo/SKILL.md.bak.20260101', 'README.md.bak_1', 'catalog.json.bak-2', 'notes.bak2']) {
    assert.equal(isPublicFile(rel), false, rel);
  }
});
