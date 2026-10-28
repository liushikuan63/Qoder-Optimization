#!/usr/bin/env node
// pkg-catalog 的隔离自测：检索命中/未命中、dry-run 不写盘、apply 才安装、覆盖保护、外部条目只给命令、越界 id 拒绝。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'pkg-catalog.cjs');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

function setup() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-catalog-'));
  const home = path.join(sb, 'home');
  const pkg = path.join(sb, 'pkg');
  fs.mkdirSync(path.join(home, '.qoder'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示用技能：导出报表\n---\n\n# demo\n');
  const catalog = {
    schema: 1,
    entries: [
      { id: 'skill:demo-skill', category: 'skill', name: 'demo-skill', status: 'shipped', tier: 'library', description: '演示用技能：导出报表', source: 'skills/demo-skill', install: { tier: 'library' } },
      { id: 'plugin:demo-plugin', category: 'plugin', name: 'demo-plugin', status: 'external', description: '演示：前端设计审查', install: { mode: 'external', command: 'Qoder 扩展市场搜索「demo-plugin」安装' } },
      { id: 'mcp:demo-mcp', category: 'mcp', name: 'demo-mcp', status: 'template', description: '演示 MCP 模板', install: { mode: 'merge', note: '合并进 settings.json 的 mcpServers' } },
    ],
  };
  const catalogPath = path.join(pkg, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  return { sb, home, pkg, catalogPath };
}
function run(ctx, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--catalog', ctx.catalogPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home },
    timeout: 20000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function caseRun(name, args, assertFn) {
  const ctx = setup();
  try {
    const r = run(ctx, args);
    check(name, assertFn(r, ctx), `exit=${r.code}`);
  } finally {
    fs.rmSync(ctx.sb, { recursive: true, force: true });
  }
}
const target = (ctx) => path.join(ctx.home, '.qoder', 'skills-library', 'demo-skill', 'SKILL.md');

caseRun('中文关键词检索命中', ['search', '报表'], (r) => r.code === 0 && r.out.includes('skill:demo-skill'));
caseRun('按类别中文名检索', ['search', '插件'], (r) => r.code === 0 && r.out.includes('plugin:demo-plugin'));
caseRun('检索未命中 → exit 3', ['search', 'zzz-no-such'], (r) => r.code === 3 && r.out.includes('NO_MATCH'));
caseRun('多词查询要求全部命中', ['search', '报表 zzz'], (r) => r.code === 3 && r.out.includes('NO_MATCH'));
caseRun('默认 dry-run 不写盘', ['install', 'skill:demo-skill'], (r, c) => r.code === 0 && !fs.existsSync(target(c)) && r.out.includes('预演'));
caseRun('--apply 安装到按需库', ['install', 'skill:demo-skill', '--apply'], (r, c) => r.code === 0 && fs.existsSync(target(c)));
caseRun('--tier core 安装到常驻目录', ['install', 'skill:demo-skill', '--apply', '--tier', 'core'], (r, c) => r.code === 0 && fs.existsSync(path.join(c.home, '.qoder', 'skills', 'demo-skill', 'SKILL.md')));
caseRun('先装再装 → exit 1', ['install', 'skill:demo-skill', '--apply'], (r, c) => {
  const second = run(c, ['install', 'skill:demo-skill', '--apply']);
  return r.code === 0 && second.code === 1 && second.out.includes('已存在');
});
caseRun('--force 覆盖已存在', ['install', 'skill:demo-skill', '--apply'], (r, c) => {
  fs.writeFileSync(target(c), 'local content');
  const forced = run(c, ['install', 'skill:demo-skill', '--apply', '--force']);
  return r.code === 0 && forced.code === 0 && fs.readFileSync(target(c), 'utf8') ===
    fs.readFileSync(path.join(c.pkg, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
});
caseRun('已安装技能检索不再建议重复加装', ['install', 'skill:demo-skill', '--apply'], (r, c) => {
  const search = run(c, ['search', '报表']);
  return r.code === 0 && search.code === 0 && search.out.includes('本地文件已存在') && !search.out.includes('安装预演');
});
caseRun('外部插件只给命令不写盘', ['install', 'plugin:demo-plugin', '--apply'], (r, c) => r.code === 0 && r.out.includes('扩展市场') && !fs.existsSync(path.join(c.home, '.qoder', 'skills-library', 'demo-plugin')));
caseRun('MCP 模板只给合并说明', ['install', 'mcp:demo-mcp'], (r) => r.code === 0 && r.out.includes('mcpServers'));
caseRun('未知条目 → exit 2', ['show', 'no-such'], (r) => r.code === 2);
caseRun('越界 id 被拒', ['install', 'skill:../../evil', '--apply'], (r) => r.code === 2);
caseRun('list 按类别过滤', ['list', '--category', 'skill'], (r) => r.code === 0 && r.out.includes('skill:demo-skill') && !r.out.includes('plugin:demo-plugin'));

function caseSchema(name, schema, wantExit) {
  const ctx = setup();
  try {
    const cat = JSON.parse(fs.readFileSync(ctx.catalogPath, 'utf8'));
    cat.schema = schema;
    fs.writeFileSync(ctx.catalogPath, JSON.stringify(cat, null, 2));
    const r = run(ctx, ['list']);
    check(name, r.code === wantExit, `exit=${r.code}`);
  } finally {
    fs.rmSync(ctx.sb, { recursive: true, force: true });
  }
}
caseSchema('已发布包的字符串 schema 可读', 'qoder-share-catalog/1', 0);
caseSchema('未知 schema 判失败', 'qoder-share-catalog/99', 2);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
