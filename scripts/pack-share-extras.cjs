#!/usr/bin/env node
/**
 * 分享包组装器（重建版，替代丢失的 pack-share-extras.js）。
 * 用法：node pack-share-extras.cjs <输出包目录> [--name Qoder-Optimization] [--version 0.0.1] [--apply]
 * 做四件事：① 按白名单从本机真源复制；② 逐文件应用 SANITIZE（占位替换，本机原值不动）；
 * ③ 剪掉输出目录里不在白名单的文件（防"白名单缩了旧文件还留在包里"）；④ 生成 VERSION /
 * skills-manifest.json / catalog.json / INDEX.md。敏感词与结构校验交给
 * share-secret-scan.cjs 与 share-package-verify.cjs，本脚本不自检通过。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir().replace(/\\/g, '/');
const SRC = {
  scripts: HOME + '/.qoder/scripts',
  skillsCore: HOME + '/.qoder/skills',
  skillsLib: HOME + '/.qoder/skills-library',
  commands: HOME + '/.qoder/commands',
  agents: HOME + '/.qoder/agents',
  rules: HOME + '/.qoder/rules',
  agentsMd: HOME + '/.qoder/AGENTS.md',
};
const SKIP_NAME = /(\.bak|\.log|~$|\.tmp$|^backups$|node_modules|^\.export-|\.DS_Store|Thumbs\.db)/;
// 明确不外发的脚本（日志/词表/含本机私有形态的助手）
const SCRIPT_DENY = new Set(['.export-secrets', '.export-bizterms', 'hooks-crash.log', 'rules-reminder.log',
  'export-memory.sh', 'import-memory.sh']);
// 明确不外发的技能（含真实凭据/AppID 且无法机械脱敏、或强绑定内网系统）
const SKILL_DENY = new Set([
  'polarmem0-memory',        // 强绑定另一台机器的本地服务
  'uni-app-wechat-cicd',     // 含本机专有小程序标识
  'clarify-ambiguous-request' // 已由 commands/clarify.md + rules/long-task.md 的 A/B/C 判档完整承接，双轨会冲突
]);
// 逐文件脱敏：本机保留原值，包内换成占位
const SANITIZE = {
  'skills/wechat-miniprogram-dev/references/config.md': [[/\bwx[0-9a-f]{16}\b/g, 'wx1234567890abcdef']],
};
const NO_SHIP_SELF_BUILT = new Set(['local-api-contracts', 'local-browser-e2e', 'local-db-migrations',
  'local-frontend-a11y', 'local-performance-evidence', 'local-rust-engineering', 'local-spring-mybatis']);

const out = process.argv[2];
const APPLY = process.argv.includes('--apply');
const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
if (!out) { console.error('用法：pack-share-extras.cjs <输出包目录> [--name 名称] [--version x.y.z] [--apply]'); process.exit(2); }
const md5 = b => require('crypto').createHash('md5').update(b).digest('hex');
function copyFile(src, dst, relKey) {
  let data = fs.readFileSync(src);
  const rules = SANITIZE[relKey];
  if (rules) {
    let t = data.toString('utf8');
    for (const [re, rep] of rules) t = t.replace(re, rep);
    data = Buffer.from(t, 'utf8');
  }
  if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, data); }
  return data;
}
function walkFiles(root, rel = '', acc = []) {
  const p = path.join(root, rel);
  let names;
  try { names = fs.readdirSync(p); } catch (e) { log.push(`  [跳过不可读目录] ${rel || path.basename(root)} (${e.code})`); return acc; }
  for (const name of names) {
    if (SKIP_NAME.test(name)) continue;
    const r = rel ? rel + '/' + name : name;
    const q = path.join(root, r);
    let lst;
    try { lst = fs.lstatSync(q); } catch { continue; }
    if (lst.isSymbolicLink()) { log.push(`  [跳过链接，不跟] ${r}`); continue; }
    if (lst.isDirectory()) walkFiles(q, r, acc);
    else if (lst.isFile()) acc.push(r);
  }
  return acc;
}
const log = [];
let n = 0;
// 1) scripts
const scripts = fs.readdirSync(SRC.scripts).filter(f => fs.statSync(path.join(SRC.scripts, f)).isFile() && !SKIP_NAME.test(f) && !SCRIPT_DENY.has(f));
for (const f of scripts) { copyFile(path.join(SRC.scripts, f), path.join(out, 'scripts', f), 'scripts/' + f); n++; }
log.push(`scripts: ${scripts.length} 个（拒发 ${SCRIPT_DENY.size} 类）`);
// 2) skills（常驻 + 按需库，去重，本机独有也进）
const skillDirs = new Map();
for (const root of [SRC.skillsCore, SRC.skillsLib]) {
  if (!fs.existsSync(root)) continue;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (SKIP_NAME.test(d) || !fs.statSync(p).isDirectory()) continue;
    if (!fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    if (!skillDirs.has(d)) skillDirs.set(d, p);
  }
}
const shippedSkills = [];
for (const [name, dir] of [...skillDirs.entries()].sort()) {
  if (SKILL_DENY.has(name)) { log.push(`  [拒发] ${name}`); continue; }
  for (const rel of walkFiles(dir)) {
    copyFile(path.join(dir, rel), path.join(out, 'skills', name, rel), `skills/${name}/${rel}`);
    n++;
  }
  shippedSkills.push({ name, tier: path.dirname(dir).endsWith('skills') ? 'core' : 'library', files: walkFiles(dir).length });
}
log.push(`skills: ${shippedSkills.length} 个技能，常驻 ${shippedSkills.filter(s => s.tier === 'core').length} / 按需 ${shippedSkills.filter(s => s.tier === 'library').length}`);
// 3) commands / agents
for (const kind of ['commands', 'agents']) {
  const files = fs.readdirSync(SRC[kind]).filter(f => !SKIP_NAME.test(f) && fs.statSync(path.join(SRC[kind], f)).isFile());
  for (const f of files) { copyFile(path.join(SRC[kind], f), path.join(out, kind, f), `${kind}/${f}`); n++; }
  log.push(`${kind}: ${files.length}`);
}
// 4) 剪除：输出目录里不在本次名单的文件
const keep = new Set();
for (const s of shippedSkills) keep.add('skills/' + s.name);
if (APPLY) {
  for (const kind of ['scripts', 'commands', 'agents']) {
    const d = path.join(out, kind);
    if (!fs.existsSync(d)) continue;
    const want = new Set(fs.readdirSync(SRC[kind]).filter(f => !SKIP_NAME.test(f) && !SCRIPT_DENY.has(f)));
    for (const f of fs.readdirSync(d)) if (!want.has(f)) { fs.rmSync(path.join(d, f), { recursive: true, force: true }); log.push(`  [剪除] ${kind}/${f}`); }
  }
  const sd = path.join(out, 'skills');
  if (fs.existsSync(sd)) {
    const want = new Set(shippedSkills.map(s => s.name));
    for (const f of fs.readdirSync(sd)) if (!want.has(f)) { fs.rmSync(path.join(sd, f), { recursive: true, force: true }); log.push(`  [剪除] skills/${f}`); }
  }
}
// 5) 产物：VERSION / skills-manifest.json / catalog.json / INDEX.md
const agentsVer = fs.existsSync(SRC.agentsMd) ? (fs.readFileSync(SRC.agentsMd, 'utf8').match(/版本：([0-9.]+)/) || [, '0.0.0'])[1] : '0.0.0';
const ver = argValue('--version', agentsVer);
const packageName = argValue('--name', path.basename(out));
const descOf = name => {
  const dir = skillDirs.get(name);
  if (!dir) return '';
  const m = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^description: (.*)$/m);
  return m ? m[1].trim() : '';
};
const entries = [];
for (const s of shippedSkills) {
  const selfBuilt = !NO_SHIP_SELF_BUILT.has(s.name);
  entries.push({ id: 'skill:' + s.name, category: 'skill', name: s.name, status: 'shipped',
    tier: s.tier, description: (NO_SHIP_SELF_BUILT.has(s.name) || /^local-/.test(s.name)) ? '' : descOf(s.name).slice(0, 300),
    install: `cp -r skills/${s.name} ~/.qoder/${s.tier === 'core' ? 'skills' : 'skills-library'}/`, source: selfBuilt ? 'self-built' : 'self-built' });
}
for (const f of scripts) entries.push({ id: 'script:' + f, category: 'script', name: f, status: 'shipped', install: `cp scripts/${f} ~/.qoder/scripts/`, source: 'self-built' });
for (const kind of ['commands', 'agents']) {
  for (const f of fs.readdirSync(SRC[kind]).filter(x => !SKIP_NAME.test(x))) {
    entries.push({ id: kind.slice(0, -1) + ':' + path.basename(f, '.md'), category: kind.slice(0, -1), name: path.basename(f, '.md'), status: 'shipped',
      install: `cp ${kind}/${f} ~/.qoder/${kind}/`, source: 'self-built' });
  }
}
const counts = {};
for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
const catalog = { schema: 1, package: { name: packageName, version: ver }, generated: new Date().toISOString().slice(0, 19) + 'Z',
  usage: 'node ~/.qoder/scripts/pkg-catalog.cjs register <包目录> → search "<关键词>" → install <id> [--apply]', counts, entries };
const manifest = { package_name: packageName, version: ver, generated: catalog.generated, skills: shippedSkills.map(s => ({ name: s.name, tier: s.tier, files: s.files })) };
const indexMd = [`# ${packageName} - ${ver}`, '', '## 分享包索引（按需加装）', '', `共 ${entries.length} 条：` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' / '),
  '', '- 状态：`shipped` 随包可直接装；`external` 只给官方安装方式；`template` 给合并说明。',
  '- 机器可读版：`catalog.json`。', '', '```bash', 'node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>',
  'node ~/.qoder/scripts/pkg-catalog.cjs search "<关键词>"', 'node ~/.qoder/scripts/pkg-catalog.cjs install <id> --apply', '```', ''].join('\n');
if (APPLY) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'VERSION'), 'v' + ver + '\n' + new Date().toISOString().slice(0, 10) + '\n');
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 1));
  fs.writeFileSync(path.join(out, 'skills-manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(out, 'INDEX.md'), indexMd);
}
console.log(`目标 v${ver} → ${out}`);
console.log(log.join('\n'));
console.log(`复制 ${n} 个文件；catalog 条目 ${entries.length}`);
console.log(APPLY ? 'APPLIED' : 'DRY-RUN（未写盘）');
