#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { test } = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const q = path.join(home, '.qoder');
  const pkg = path.join(root, 'package');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const skill = (tier, name, description) => {
    const file = path.join(q, tier === 'core' ? 'skills' : 'skills-library', name, 'SKILL.md');
    write(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);
    return file;
  };
  const catalog = (entries) => write(path.join(pkg, 'catalog.json'), JSON.stringify({ schema: 1, entries }));
  const register = (file = path.join(pkg, 'catalog.json')) => write(path.join(q, 'share-package.json'), JSON.stringify({ catalog: file }));
  const index = (entries = []) => write(path.join(q, 'skills-index.json'), JSON.stringify({ count: entries.length, entries }));
  fs.mkdirSync(q, { recursive: true });
  const run = (name, args = []) => spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    encoding: 'utf8', timeout: 15000, cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, QODER_SHARE_CATALOG: '' },
  });
  return { q, pkg, write, skill, catalog, register, index, run };
}
const bundledScript = { id: 'script:demo.cjs', name: 'demo.cjs', category: 'script', status: 'shipped', description: '专用报表', source: 'scripts/demo.cjs', install: { mode: 'copy-file' } };

function tree(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tree(p) : [[p, fs.readFileSync(p).toString('hex')]];
  });
}

test('未建立索引也可只读检索真实技能，不自动写索引', t => {
  const f = fixture(t);
  const file = f.skill('library', 'demo-skill', '导出报表');
  const before = tree(f.q);
  const r = f.run('skill-load.cjs', ['报表']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(file.split(path.sep).join('/')));
  assert.deepEqual(tree(f.q), before);
});

test('索引中旧路径不能被当成仍安装', t => {
  const f = fixture(t);
  f.index([{ name: 'deleted-skill', tier: 'library', description: '旧报表', path: path.join(f.q, 'gone', 'SKILL.md') }]);
  const r = f.run('skill-load.cjs', ['旧报表']);
  assert.equal(r.status, 3);
  assert.ok(!r.stdout.includes('1. deleted-skill'));
});

test('索引已存在时仍能找到新增技能', t => {
  const f = fixture(t); f.index();
  f.skill('core', 'new-skill', '全新领域');
  const r = f.run('skill-load.cjs', ['全新领域']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /new-skill.*\[core\]/);
});

test('正文描述改动立即反映在检索中', t => {
  const f = fixture(t);
  f.skill('library', 'demo-skill', '旧报表');
  assert.equal(f.run('build-skills-index.cjs').status, 0);
  f.skill('library', 'demo-skill', '新领域');
  assert.equal(f.run('skill-load.cjs', ['新领域']).status, 0);
  assert.equal(f.run('skill-load.cjs', ['旧报表']).status, 3);
});

test('多关键词必须全部匹配，局部命中不隐藏包候选', t => {
  const f = fixture(t);
  f.skill('core', 'report', '报表');
  f.catalog([{ ...bundledScript, description: '报表 专用' }]); f.register();
  const r = f.run('skill-load.cjs', ['报表 专用']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /script:demo.cjs/);
  assert.ok(!r.stdout.includes('1. report'));
});

test('无匹配保留 NO_MATCH 和退出码3', t => {
  const f = fixture(t); f.index();
  const r = f.run('skill-load.cjs', ['zzz-no-such']);
  assert.equal(r.status, 3); assert.match(r.stdout, /NO_MATCH/);
});

test('已存在的脚本不再提示加装', t => {
  const f = fixture(t); f.index(); f.catalog([bundledScript]); f.register();
  f.write(path.join(f.q, 'scripts', 'demo.cjs'), 'local version');
  const r = f.run('skill-load.cjs', ['专用报表']);
  assert.equal(r.status, 3); assert.match(r.stdout, /本地文件已存在/);
  assert.ok(!r.stdout.includes('install script:demo.cjs'));
  assert.ok(!r.stdout.includes('尚未安装'));
});

test('本地命中但包内内容不同时输出更新信号', t => {
  const f = fixture(t); f.index();
  f.skill('library', 'demo-skill', '报表导出');
  f.write(path.join(f.pkg, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 报表导出\n---\n\n包内新版\n');
  f.catalog([{ id: 'skill:demo-skill', category: 'skill', name: 'demo-skill', status: 'shipped', description: '报表导出', source: 'skills/demo-skill', install: { tier: 'library' } }]);
  f.register();
  const r = f.run('skill-load.cjs', ['报表导出']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /包内更新检查/);
  assert.match(r.stdout, /NEXT_ACTION: ASK_UPDATE/);
});

test('本地命中且包内一致时不提示更新', t => {
  const f = fixture(t); f.index();
  const local = f.skill('library', 'demo-skill', '报表导出');
  f.write(path.join(f.pkg, 'skills', 'demo-skill', 'SKILL.md'), fs.readFileSync(local, 'utf8'));
  f.catalog([{ id: 'skill:demo-skill', category: 'skill', name: 'demo-skill', status: 'shipped', description: '报表导出', source: 'skills/demo-skill', install: { tier: 'library' } }]);
  f.register();
  const r = f.run('skill-load.cjs', ['报表导出']);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('NEXT_ACTION'));
});

test('包候选内容不同时输出更新询问信号', t => {
  const f = fixture(t); f.index();
  f.write(path.join(f.pkg, 'scripts', 'demo.cjs'), 'package version');
  f.catalog([{ ...bundledScript, description: '专用报表 工具' }]); f.register();
  f.write(path.join(f.q, 'scripts', 'demo.cjs'), 'local changed');
  const r = f.run('skill-load.cjs', ['专用报表 工具']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /内容与包内不同/);
  assert.match(r.stdout, /NEXT_ACTION: ASK_INSTALL_OR_UPDATE/);
});

test('包候选内容一致时静默，不提示安装或更新', t => {
  const f = fixture(t); f.index();
  f.write(path.join(f.pkg, 'scripts', 'demo.cjs'), 'same version');
  f.catalog([{ ...bundledScript, description: '专用报表 工具' }]); f.register();
  f.write(path.join(f.q, 'scripts', 'demo.cjs'), 'same version');
  const r = f.run('skill-load.cjs', ['专用报表 工具']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /与包内一致/);
  assert.ok(!r.stdout.includes('NEXT_ACTION'));
});

test('未安装候选只建议预演，不自动 apply', t => {
  const f = fixture(t); f.index(); f.catalog([bundledScript]); f.register();
  const before = tree(f.q);
  const r = f.run('skill-load.cjs', ['专用报表']);
  assert.equal(r.status, 3); assert.match(r.stdout, /本地未发现/);
  assert.match(r.stdout, /install/); assert.ok(!r.stdout.includes('--apply'));
  assert.deepEqual(tree(f.q), before);
});

test('插件和 MCP 的可用状态保持未核验，不冒充未安装', t => {
  const f = fixture(t); f.index();
  f.catalog([{ id: 'plugin:demo', name: 'demo', category: 'plugin', status: 'recommended', description: '插件能力', install: { mode: 'external', command: '使用官方管理入口' } }]); f.register();
  const r = f.run('skill-load.cjs', ['插件能力']);
  assert.equal(r.status, 3); assert.match(r.stdout, /未核验/);
  assert.ok(!r.stdout.includes('尚未安装'));
});

test('包指针失效明确报缺口，不静默当无候选', t => {
  const f = fixture(t); f.index(); f.register(path.join(f.pkg, 'missing.json'));
  const r = f.run('skill-load.cjs', ['zzz-no-such']);
  assert.equal(r.status, 3); assert.match(r.stderr, /CATALOG_UNAVAILABLE/);
});

test('包索引损坏明确报告且不写配置', t => {
  const f = fixture(t); f.index(); f.write(path.join(f.pkg, 'catalog.json'), '{'); f.register();
  const before = tree(f.q);
  const r = f.run('skill-load.cjs', ['zzz-no-such']);
  assert.equal(r.status, 3); assert.match(r.stderr, /CATALOG_UNAVAILABLE/);
  assert.deepEqual(tree(f.q), before);
});

test('包内搜索与 fallback 使用相同的多词规则', t => {
  const f = fixture(t); f.index(); f.catalog([bundledScript]); f.register();
  assert.equal(f.run('pkg-catalog.cjs', ['search', '报表 zzz']).status, 3);
  const r = f.run('skill-load.cjs', ['报表 zzz']);
  assert.equal(r.status, 3); assert.ok(!r.stdout.includes('script:demo.cjs'));
});

test('中文触发词整词命中优先返回对应技能', t => {
  const f = fixture(t);
  f.skill('core', 'skills-router', '任务能力路由入口。触发词：技能路由、skill-load');
  f.skill('library', 'rules-conflict-audit', '规则体系冲突审计。触发词：规则冲突、规则审计');
  const routed = f.run('skill-load.cjs', ['技能路由']);
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout.split('\n')[0], /skills-router/);
  const rules = f.run('skill-load.cjs', ['规则冲突']);
  assert.equal(rules.status, 0, rules.stderr);
  assert.match(rules.stdout.split('\n')[0], /rules-conflict-audit/);
});

test('两层同名不静默选一个，保留原索引', t => {
  const f = fixture(t); f.index(); f.skill('core', 'duplicate', '共同功能'); f.skill('library', 'duplicate', '共同功能');
  const before = fs.readFileSync(path.join(f.q, 'skills-index.json'), 'utf8');
  const r = f.run('build-skills-index.cjs');
  assert.equal(r.status, 2); assert.match(r.stderr, /重复/);
  assert.equal(fs.readFileSync(path.join(f.q, 'skills-index.json'), 'utf8'), before);
  assert.equal(f.run('skill-load.cjs', ['共同功能']).status, 2);
});

test('显式重建仍生成完整可读索引', t => {
  const f = fixture(t); f.skill('core', 'one', '常驻'); f.skill('library', 'two', '按需');
  const r = f.run('build-skills-index.cjs'); assert.equal(r.status, 0, r.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(f.q, 'skills-index.json'), 'utf8'));
  assert.equal(idx.count, 2); assert.equal(idx.entries.length, 2);
  assert.deepEqual(idx.entries.map(e => e.tier).sort(), ['core', 'library']);
});
