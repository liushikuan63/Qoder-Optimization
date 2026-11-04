'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const { planCapabilities } = require('../scripts/capability-advisor.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = path.join(dir, 'client'), pkg = path.join(dir, 'package');
  const entry = {
    id: 'skill:parallel-orchestration',
    name: 'parallel-orchestration',
    category: 'skill',
    status: 'shipped',
    tier: 'library',
    source: 'skills/parallel-orchestration',
    description: 'parallel orchestration',
    install: { mode: 'copy-skill', tier: 'library' },
    dependencies: [],
  };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(path.join(pkg, entry.source, 'SKILL.md'), '# parallel-orchestration\n');
  write(path.join(client, entry.source, 'SKILL.md'), '# parallel-orchestration\n');
  write(path.join(pkg, 'catalog.json'), JSON.stringify({ schema: 1, entries: [entry] }));
  return { dir, client, catalogFile: path.join(pkg, 'catalog.json') };
}

function action(f, prompt) {
  const result = planCapabilities({ catalogFile: f.catalogFile, clientRoot: f.client, phase: 'task', prompt });
  return result.items.find(item => item.id === 'skill:parallel-orchestration');
}

test('multi-module and explicit collaboration wording auto-triggers parallel orchestration', t => {
  const f = fixture(t);
  for (const prompt of [
    '同时处理前后端两个模块',
    '把任务分工给几个子代理',
    '多个模块一起做',
    '这是多模块任务，先判断能否并行',
  ]) {
    const item = action(f, prompt);
    assert.equal(item?.action, 'AUTO_USE', prompt);
    assert.equal(item.reason, 'AUTO_TRIGGERED_INSTALLED_CAPABILITY');
  }
});

test('discussion and unrelated splits do not over-trigger parallel orchestration', t => {
  const f = fixture(t);
  for (const prompt of ['解释一下并行是什么意思', '拆分字符串函数并补测试']) {
    assert.notEqual(action(f, prompt)?.action, 'AUTO_USE', prompt);
  }
});

test('parallel orchestration ships on-demand but remains auto-triggerable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'skills-manifest.json'), 'utf8'));
  const entry = manifest.skills.find(item => item.name === 'parallel-orchestration');
  assert.equal(entry?.tier, 'library');
});
