#!/usr/bin/env node
// carrier-preflight 的隔离自测：重名/硬限额必须阻断，唯一名称必须放行，参数错误必须 exit 2。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'carrier-preflight.cjs');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

function setup() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-preflight-'));
  const q = path.join(sb, '.qoder');
  const w = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  w(path.join(q, 'AGENTS.md'), Array.from({ length: 10 }, (_, i) => `- rule ${i}`).join('\n') + '\n');
  w(path.join(q, 'memory', 'MEMORY.md'), Array.from({ length: 5 }, (_, i) => `- [m${i}](memory-${i}.md)`).join('\n') + '\n');
  w(path.join(q, 'memory', 'memory-a.md'), '---\nname: memory-a\ndescription: existing memory\nmetadata:\n  type: reference\n---\n');
  w(path.join(q, 'rules', 'rule-a.md'), '---\ntrigger: model_decision\ndescription: existing rule\n---\n\n- x\n');
  w(path.join(q, 'skills', 'skill-a', 'SKILL.md'), '---\nname: skill-a\ndescription: existing skill\n---\n\n# skill\n');
  w(path.join(q, 'agents', 'agent-a.md'), '---\nname: agent-a\ndescription: existing agent\n---\n\n# agent\n');
  w(path.join(q, 'settings.json'), JSON.stringify({
    mcpServers: { 'mcp-a': { command: 'node', args: ['mcp-a.js'] } },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop-a.js', timeout: 10 }] }] },
  }, null, 2));
  return { sb, q };
}
function run(sb, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: sb, USERPROFILE: sb },
    timeout: 20000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', json };
}
function caseRun(name, setupFn, args, assertFn) {
  const { sb, q } = setup();
  try {
    if (setupFn) setupFn(q);
    const r = run(sb, typeof args === 'function' ? args(q) : args);
    const detail = `exit=${r.code} ${r.json ? r.json.verdict : ''}`;
    check(name, assertFn(r), detail);
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
}
const writeMore = (file, lines) => fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => `- row ${i}`).join('\n') + '\n');

caseRun('唯一技能名 → 放行', null, ['--type', 'skill', '--name', 'brand-new-skill'], (r) => r.code === 0 && r.json && r.json.verdict !== 'BLOCK');
caseRun('同名技能 → 阻断', null, ['--type', 'skill', '--name', 'skill-a'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('同名')));
caseRun('按需库同名技能 → 阻断', (q) => {
  const p = path.join(q, 'skills-library', 'lib-a', 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '---\nname: lib-a\ndescription: library skill\n---\n\n# lib\n');
}, ['--type', 'skill', '--name', 'lib-a'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('skills-library/')));
caseRun('同名技能同时存在两库 → tier 冲突阻断', (q) => {
  for (const d of ['skills', 'skills-library']) {
    const p = path.join(q, d, 'dup-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '---\nname: dup-skill\ndescription: dup\n---\n\n# dup\n');
  }
}, ['--type', 'skill', '--name', 'dup-skill'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('tier 冲突')));
caseRun('同名 MCP → 阻断', null, ['--type', 'mcp', '--name', 'mcp-a'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('同名')));
caseRun('同名 hook 脚本 → 阻断', null, ['--type', 'hook', '--name', 'stop-a'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('同名')));
caseRun('同名 agent → 阻断', null, ['--type', 'agent', '--name', 'agent-a'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('同名')));
caseRun('MEMORY 超 200 行 → 阻断', (q) => writeMore(path.join(q, 'memory', 'MEMORY.md'), 201), ['--type', 'memory', '--name', 'new-memory'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('200')));
caseRun('AGENTS 超 190 行 → 阻断', (q) => writeMore(path.join(q, 'AGENTS.md'), 191), ['--type', 'rule', '--name', 'new-rule'], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('190')));
caseRun('非法类型 → 参数错误', null, ['--type', 'unknown', '--name', 'x'], (r) => r.code === 2);

// --package：入包描述上限改用包侧同一真源并硬拦；不给该参数时行为必须逐字不变。
const REPO = path.join(__dirname, '..');
const desc = (n) => 'x'.repeat(n);
caseRun('入包 短描述 → 放行', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(179), '--package', REPO], (r) => r.code === 0 && r.json && r.json.verdict !== 'BLOCK');
caseRun('入包 恰好 300 → 放行（边界）', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(300), '--package', REPO], (r) => r.code === 0 && r.json && !r.json.blockers.some((x) => x.includes('入包 description')));
caseRun('入包 301 → 硬拦', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(301), '--package', REPO], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('入包 description 301') && x.includes('300')));
caseRun('入包 载体豁免名 400 字符 → 放行', null, ['--type', 'skill', '--name', 'mechanize-rule-into-hook-guard', '--description', desc(400), '--package', REPO], (r) => r.code === 0 && r.json && !r.json.blockers.some((x) => x.includes('入包 description')));
caseRun('入包 载体豁免名超其上限 → 硬拦', null, ['--type', 'skill', '--name', 'mechanize-rule-into-hook-guard', '--description', desc(461), '--package', REPO], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('461') && x.includes('460') && x.includes('载体豁免')));
caseRun('不给 --package 时 301 仍只预警（默认行为不变）', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(301)], (r) => r.code === 0 && r.json && !r.json.blockers.some((x) => x.includes('入包 description')) && r.json.warnings.some((x) => x.includes('300')));
caseRun('入包 但拿不到 description → 判空转阻断', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--package', REPO], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('空转')));
caseRun('--package 指向不存在的路径 → 参数错误', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(10), '--package', path.join(os.tmpdir(), 'phantom-pkg-root-9f3c')], (r) => r.code === 2);
caseRun('--package 缺值 → 参数错误', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--package'], (r) => r.code === 2);
caseRun('--package 相对路径 → 参数错误', null, ['--type', 'skill', '--name', 'pkg-new-skill', '--package', 'relative/pkg'], (r) => r.code === 2);
caseRun('包侧真源读不出 → 阻断而非静默跳过', (q) => {
  const fake = path.join(q, 'fake-pkg', 'scripts');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'share-package-verify.cjs'), "throw new Error('boom-9f3c');\n");
}, (q) => ['--type', 'skill', '--name', 'pkg-new-skill', '--description', desc(10), '--package', path.join(q, 'fake-pkg')], (r) => r.code === 1 && r.json && r.json.blockers.some((x) => x.includes('真源读不出')));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
