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
  const goal = {
    id: 'skill:goal-driven-execution',
    name: 'goal-driven-execution',
    category: 'skill',
    status: 'shipped',
    tier: 'core',
    source: 'skills/goal-driven-execution',
    description: 'goal driven execution',
    install: { mode: 'copy-skill', tier: 'core' },
    dependencies: [],
  };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  for (const item of [entry, goal]) {
    write(path.join(pkg, item.source, 'SKILL.md'), '# ' + item.name + '\n');
    write(path.join(client, item.source, 'SKILL.md'), '# ' + item.name + '\n');
  }
  write(path.join(pkg, 'catalog.json'), JSON.stringify({ schema: 1, entries: [entry, goal] }));
  return { dir, client, catalogFile: path.join(pkg, 'catalog.json') };
}

function find(f, id, prompt) {
  const result = planCapabilities({ catalogFile: f.catalogFile, clientRoot: f.client, phase: 'task', prompt });
  return result.items.find(item => item.id === id);
}

function action(f, prompt) {
  return find(f, 'skill:parallel-orchestration', prompt);
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

test('project-wide review wording auto-triggers parallel orchestration', t => {
  const f = fixture(t);
  for (const prompt of [
    '审查项目，列缺陷项修复方案，形成vibecoding文档',
    '审查项目，列缺陷项修复方案，完整版/lite git/lite svn版本分别形成vibecoding文档',
    '全项目审查并出报告',
    '分析介绍一下本项目，并告诉我是否有可完善优化的地方',
  ]) {
    const item = action(f, prompt);
    assert.equal(item?.action, 'AUTO_USE', prompt);
    assert.equal(item.reason, 'AUTO_TRIGGERED_INSTALLED_CAPABILITY');
  }
});

test('narrow review and discussion do not over-trigger parallel orchestration', t => {
  const f = fixture(t);
  for (const prompt of ['解释一下并行是什么意思', '拆分字符串函数并补测试', '审查这个按钮文案', '审查方案并给建议', '分析这个函数的报错']) {
    assert.notEqual(action(f, prompt)?.action, 'AUTO_USE', prompt);
  }
});

test('long-task wording routes goal-driven-execution to confirmation', t => {
  const f = fixture(t);
  for (const prompt of ['这是个长任务，帮我持续推进', '多步骤任务，先给完成判据']) {
    const item = find(f, 'skill:goal-driven-execution', prompt);
    assert.equal(item?.action, 'ASK_USE', prompt);
  }
});

test('parallel orchestration ships on-demand but remains auto-triggerable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'skills-manifest.json'), 'utf8'));
  const entry = manifest.skills.find(item => item.name === 'parallel-orchestration');
  assert.equal(entry?.tier, 'library');
});
