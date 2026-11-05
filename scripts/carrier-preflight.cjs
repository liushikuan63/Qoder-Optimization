#!/usr/bin/env node
// 新增规则/技能/MCP/记忆/hook/agent 前的只读预检：同类、冲突、限额、截断风险。
// 用法：node carrier-preflight.cjs --type <skill|rule|memory|mcp|hook|agent> --name <名称> [--description <描述>] [--path <计划文件>] [--json]
// 退出码：0 = 无阻断（可能含 REVIEW 提醒）；1 = 存在重名/硬限额阻断；2 = 参数错误。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };
const boundClient = arg('client-root');
if (argv.includes('--client-root') && (!boundClient || !path.isAbsolute(boundClient) || argv.filter(item => item === '--client-root').length !== 1)) { console.error('--client-root 需要唯一绝对路径'); process.exit(2); }
const ROOT = boundClient || require('./client-root.js').clientRoot(HOME);
const TYPE = arg('type');
const NAME = arg('name');
const DESC = arg('description');
const PLAN_PATH = arg('path');
const JSON_OUT = argv.includes('--json');
const TYPES = ['skill', 'rule', 'memory', 'mcp', 'hook', 'agent'];
if (!TYPES.includes(TYPE) || !NAME) {
  console.error('用法: node carrier-preflight.cjs --type <skill|rule|memory|mcp|hook|agent> --name <名称> [--description <描述>] [--path <计划文件>] [--json]');
  process.exit(2);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(read(p)); } catch { return {}; } };
const lineCount = (t) => { if (!t) return 0; const lines = t.split(/\r?\n/); return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length; };
const norm = (s) => String(s || '').toLowerCase().replace(/\.(md|js|cjs|mjs|json)$/, '');
const tokens = (s) => {
  const out = new Set();
  for (const x of String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) if (x.length >= 3) out.add(x);
  return [...out];
};
const frontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const o = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return o;
};

const candidates = [];
const add = (kind, name, desc, file, extra = {}) => candidates.push({ kind, name: String(name || ''), desc: String(desc || ''), file, ...extra });

const ruleDir = path.join(ROOT, 'rules');
for (const f of (() => { try { return fs.readdirSync(ruleDir); } catch { return []; } })()) {
  if (!f.endsWith('.md')) continue;
  const text = read(path.join(ruleDir, f));
  const fm = frontmatter(text);
  add('rule', fm.name || f.replace(/\.md$/, ''), fm.description || '', 'rules/' + f);
}
const skillEntries = require('./build-skills-index.cjs').collectSkills(ROOT, { quarantineAmbiguous: true });
for (const entry of skillEntries) {
  const text = require('./capability-roots.cjs').readFileWithin(ROOT, entry.path).toString('utf8');
  add('skill', entry.name, entry.description, path.relative(ROOT, entry.path).split(path.sep).join('/'), { bodyLines: lineCount(text), tier: entry.tier });
}
for (const diagnostic of skillEntries.diagnostics || []) for (const tier of [{ dir: 'skills', label: 'core' }, { dir: 'skills-library', label: 'library' }]) add('skill', diagnostic.name, '同名来源待核对，未读取正文', tier.dir + '/' + diagnostic.name + '/SKILL.md', { tier: tier.label });
const memoryDir = path.join(ROOT, 'memory');
const memoryFiles = (() => { try { return fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { return []; } })();
for (const f of memoryFiles) {
  const text = read(path.join(memoryDir, f));
  const fm = frontmatter(text);
  add('memory', fm.name || f.replace(/\.md$/, ''), fm.description || '', 'memory/' + f);
}
const settings = readJson(path.join(ROOT, 'settings.json'));
const mcpKeys = Object.keys(settings.mcpServers || {});
for (const k of mcpKeys) add('mcp', k, '已配置；不展开私有连接参数', 'settings.json#mcpServers.' + k);
let maxHookPerEvent = 0;
for (const [event, groups] of Object.entries(settings.hooks || {})) {
  const list = Array.isArray(groups) ? groups : [];
  maxHookPerEvent = Math.max(maxHookPerEvent, list.length);
  for (const group of list) for (const hook of (group && group.hooks) || []) {
    const command = String(hook.command || '');
    const token = command.split(/\s+/).find((x) => /\.(js|cjs|mjs)$/i.test(x)) || '';
    add('hook', path.basename(token).replace(/\.(js|cjs|mjs)$/i, '') || event, '已配置；不展开私有命令参数', 'settings.json#hooks.' + event);
  }
}
const agentDir = path.join(ROOT, 'agents');
for (const f of (() => { try { return fs.readdirSync(agentDir).filter((x) => x.endsWith('.md')); } catch { return []; } })()) {
  const text = read(path.join(agentDir, f));
  const fm = frontmatter(text);
  add('agent', fm.name || f.replace(/\.md$/, ''), fm.description || '', 'agents/' + f);
}

const nameKey = norm(NAME);
const myTokens = tokens(NAME);
const scored = candidates.map((c) => {
  const ct = new Set(tokens(c.name + ' ' + c.desc));
  const shared = myTokens.filter((t) => ct.has(t));
  let score = shared.length / Math.max(1, Math.min(myTokens.length, ct.size));
  if (norm(c.name).includes(nameKey) || nameKey.includes(norm(c.name))) score = Math.max(score, 0.9);
  return { ...c, score: Number(score.toFixed(2)), shared };
}).filter((c) => c.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 8);

const blockers = [];
const warnings = [];
const same = candidates.filter((c) => c.kind === TYPE && norm(c.name) === nameKey);
if (same.length) blockers.push(`同名 ${TYPE} 已存在：${same.map((c) => c.file).join(', ')}`);
if (same.length > 1 && same.some((c) => c.tier === 'core') && same.some((c) => c.tier === 'library')) {
  blockers.push('同一技能同时存在于常驻与按需库（tier 冲突）：确认哪份为真源，另一份移除，再重建索引');
}
const cross = candidates.filter((c) => c.kind !== TYPE && norm(c.name) === nameKey);
if (cross.length) warnings.push(`跨载体同名：${cross.map((c) => c.kind + ':' + c.file).join(', ')}`);
if (PLAN_PATH && fs.existsSync(PLAN_PATH)) warnings.push(`目标路径已存在（按修改流程处理，不重复索取同范围授权）：${PLAN_PATH}`);

const agentsText = read(path.join(ROOT, 'AGENTS.md'));
const agentsLines = lineCount(agentsText);
const memText = read(path.join(memoryDir, 'MEMORY.md'));
const memLines = lineCount(memText);
const settingsBytes = Buffer.byteLength(read(path.join(ROOT, 'settings.json')));
const skillCore = candidates.filter((c) => c.kind === 'skill' && c.tier === 'core').length;
const skillLibrary = candidates.filter((c) => c.kind === 'skill' && c.tier === 'library').length;
const counts = { rule: candidates.filter((c) => c.kind === 'rule').length, skill: skillCore + skillLibrary, skillCore, skillLibrary, memory: memoryFiles.length, mcp: mcpKeys.length, hook: maxHookPerEvent, agent: candidates.filter((c) => c.kind === 'agent').length };
// 技能上限只约束常驻注入面；按需库不占每轮上下文，只受总量提醒
const caps = { rule: [24, 30], skill: [40, 60], memory: [260, 320], mcp: [8, 12], hook: [6, 10], agent: [6, 10] };
const planIsLibrary = /skills[-_/\\]library/i.test(PLAN_PATH);
const projected = { ...counts, [TYPE]: (counts[TYPE] || 0) + 1 };
if (TYPE === 'skill') projected.skill = counts.skill + 1;
const cap = caps[TYPE];
const gateCount = TYPE === 'skill' ? skillCore + (planIsLibrary ? 0 : 1) : projected[TYPE];
if (gateCount > cap[1]) blockers.push(`${TYPE} 数量 ${gateCount} 超过硬上限 ${cap[1]}`);
else if (gateCount > cap[0]) warnings.push(`${TYPE} 数量 ${gateCount} 超过软上限 ${cap[0]}，确认是否可合并`);

if (TYPE === 'rule') {
  if (agentsLines + 1 > 190) blockers.push(`加入后 AGENTS 约 ${agentsLines + 1} 行，超过硬线 190`);
  else if (agentsLines + 1 > 160) warnings.push(`加入后 AGENTS 约 ${agentsLines + 1} 行，超过预警线 160`);
}
if (TYPE === 'memory' && memLines + 1 > 200) blockers.push(`加入后 MEMORY.md 约 ${memLines + 1} 行，超过 200 行上限`);
let proposedDesc = DESC;
if (!proposedDesc && PLAN_PATH && fs.existsSync(PLAN_PATH)) proposedDesc = frontmatter(read(PLAN_PATH)).description || '';
if (TYPE === 'skill' && proposedDesc) {
  if (proposedDesc.length > 1024) blockers.push(`技能 description ${proposedDesc.length} 字符，超过 frontmatter 上限 1024`);
  else if (proposedDesc.length > 300) warnings.push(`技能 description ${proposedDesc.length} 字符，超过 CN 可见预警线 300（每轮注入成本）`);
}
if (TYPE === 'skill' && PLAN_PATH && fs.existsSync(PLAN_PATH)) {
  const bodyLines = lineCount(read(PLAN_PATH));
  if (bodyLines > 500) warnings.push(`SKILL.md ${bodyLines} 行，超过建议上限 500`);
}
if (settingsBytes > 1024 * 1024) blockers.push(`settings.json ${Math.round(settingsBytes / 1024)}KB，超过 1MB`);
else if (settingsBytes > 256 * 1024) warnings.push(`settings.json ${Math.round(settingsBytes / 1024)}KB，超过 256KB 预警线`);

const conflictLines = [];
for (const [label, text] of [['AGENTS.md', agentsText], ...(() => { try { return fs.readdirSync(ruleDir).filter((f) => f.endsWith('.md')).map((f) => ['rules/' + f, read(path.join(ruleDir, f))]); } catch { return []; } })()]) {
  for (const line of text.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (lower.includes(nameKey) || (myTokens.length >= 2 && myTokens.filter((t) => lower.includes(t)).length >= 2)) {
      conflictLines.push({ file: label, line: line.trim().slice(0, 180) });
      if (conflictLines.length >= 8) break;
    }
  }
  if (conflictLines.length >= 8) break;
}

const verdict = blockers.length ? 'BLOCK' : warnings.length ? 'REVIEW' : 'PASS';
const report = {
  type: TYPE, name: NAME, verdict,
  similar: scored,
  blockers, warnings,
  conflictCandidates: conflictLines,
  counts, limits: { agentsLines, agentsWarn: 160, agentsHard: 190, memLines, memHard: 200, settingsBytes, caps: { [TYPE]: cap } },
  confirmationRequired: true,
};
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`载体预检：type=${TYPE} name=${NAME}`);
  console.log(`[结论] ${verdict}${blockers.length ? '（存在阻断项）' : warnings.length ? '（需人工复核）' : ''}`);
  if (scored.length) {
    console.log('[同类候选]');
    for (const c of scored) console.log(`  - ${c.kind}:${c.name} (${c.file}) 相似度=${c.score}${c.shared.length ? ' 共享词=' + c.shared.join(',') : ''}`);
  } else console.log('[同类候选] 无');
  if (conflictLines.length) {
    console.log('[需人工复核的现有表述]');
    for (const c of conflictLines) console.log(`  - ${c.file}: ${c.line}`);
  }
  if (blockers.length) { console.log('[阻断]'); for (const b of blockers) console.log('  - ' + b); }
  if (warnings.length) { console.log('[提醒]'); for (const w of warnings) console.log('  - ' + w); }
  console.log(`[限额] AGENTS ${agentsLines} 行（预警 160 / 硬线 190）；MEMORY.md ${memLines} 行（上限 200）；settings.json ${Math.round(settingsBytes / 1024)}KB`);
  console.log(`[数量] 规则=${counts.rule} 技能=${counts.skill}（常驻 ${skillCore} / 按需 ${skillLibrary}） 记忆=${counts.memory} MCP=${counts.mcp} hooks单事件峰值=${counts.hook} agents=${counts.agent}`);
  if (TYPE === 'skill') {
    console.log(`[分层] 本次拟入${planIsLibrary ? '按需库' : '常驻'}；常驻预算 ${gateCount}/${cap[0]} 软 · ${cap[1]} 硬。判定：元/跨域高频或被 AGENTS·rules·commands 硬引用 → skills/；单领域低频/项目专用 → skills-library/；拿不准默认进库。落盘后跑 build-skills-index.cjs。`);
  } else {
    console.log(`[限额] 本次类型 ${TYPE} 拟增至 ${projected[TYPE]}（软/硬 ${cap[0]}/${cap[1]}）`);
  }
  console.log('[要求] 创建前把本报告 + 拟放位置 / 影响面 / 回滚 / 验证方案交用户确认；未确认不写入。');
}
process.exit(blockers.length ? 1 : 0);
