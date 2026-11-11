#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 只认两类「可导航的引用主张」，不认散文里的示例路径：
//   ① markdown 链接目标 [text](path)
//   ② 反引号里以已知仓库/技能目录开头、或以 ../ 开头的路径
// 旧实现只认 references|scripts 前缀，漏掉 resources/、design-md/ 与 ../<兄弟技能>/；
// 但放宽到「任意目录前缀」会把 src/a.js、doctests/x.py 这类文档示例误判为悬空（实测 207 条里大量如此）。
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TICK_RE = /`([^`\n]+)`/g;
const KNOWN_PREFIX = /^(?:\.\.\/)+(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:json|mjs|cjs|md|js|ps1|sh|py|ts|tsx|vue)$/;
const KNOWN_DIR = /^(?:scripts|skills|commands|hooks|references|resources|design-md|fixtures|agents|mcp|\.github)\/[A-Za-z0-9_./-]+\.(?:json|mjs|cjs|md|js|ps1|sh|py)$/;
const FENCE_RE = /```[\s\S]*?```/g;
const MUTED_RE = /<!--[\s\S]*?-->/g;

function stripExamples(text) {
  return String(text).replace(FENCE_RE, '').replace(MUTED_RE, '');
}

function isLocalRef(ref) {
  if (!ref || /^(https?:|mailto:|#|data:)/i.test(ref)) return false;
  if (/^[A-Za-z]:[\\/]/.test(ref)) return false;      // 盘符绝对路径
  if (ref.startsWith('/')) return false;              // 仓库根绝对路径由调用方另行解析
  const clean = ref.split('#')[0];
  if (!clean) return false;
  return KNOWN_DIR.test(clean) || KNOWN_PREFIX.test(clean);
}

function refsIn(text) {
  const found = new Set();
  const clean = stripExamples(text);
  for (const m of clean.matchAll(LINK_RE)) {
    const ref = m[1];
    if (/^(https?:|mailto:|#|data:)/i.test(ref)) continue;
    if (/^[A-Za-z]:[\\/]/.test(ref)) continue;
    const target = ref.split('#')[0];
    if (target && /\.[A-Za-z0-9]+$/.test(target)) found.add(ref);
  }
  for (const m of clean.matchAll(TICK_RE)) {
    if (isLocalRef(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** 技能目录下全部 .md（含 design-md/ 等任意子树），不再只从 SKILL.md 顺着已识别前缀走。 */
function skillMarkdownFiles(root, skill) {
  const base = path.join(root, 'skills', skill);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) out.push(full);
    }
  };
  walk(base, 0);
  return out;
}

function skillNames(root) {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

function loadAllowlist(root) {
  const jsonCandidates = [
    path.join(root, 'scripts', 'skill-reference-data', 'allowlist.json'),
    path.join(root, 'scripts', 'skill-reference-allowlist.json'),
  ];
  const jsonFile = jsonCandidates.find(candidate => fs.existsSync(candidate));
  let data;
  if (jsonFile) data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  else {
    const moduleFile = path.join(root, 'scripts', 'skill-reference-allowlist.cjs');
    if (!fs.existsSync(moduleFile)) return [];
    delete require.cache[require.resolve(moduleFile)];
    data = require(moduleFile);
  }
  if (!data || data.schema !== 1 || !Array.isArray(data.entries)) throw new Error('invalid allowlist schema');
  return data.entries.filter(entry => entry && typeof entry.skill === 'string' && typeof entry.ref === 'string' && typeof entry.reason === 'string' && entry.reason.trim());
}

function resolveCandidate(root, skill, fromFile, ref) {
  // 锚点不是路径的一部分：`./java-jedis.md#1-minimum-supported-versions` 要按 java-jedis.md 解析。
  const target = String(ref).split('#')[0];
  if (!target) return null;
  const skillDir = path.join(root, 'skills', skill);
  const bases = [path.dirname(fromFile), skillDir, root];
  for (const base of bases) {
    const candidate = path.resolve(base, target);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const physical = fs.realpathSync.native(candidate);
    const relative = path.relative(root, physical);
    // A developer's neighboring checkout or link target is not shipped in the
    // ZIP and cannot serve as evidence that this package is self-contained.
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    return physical;
  }
  return null;
}

function scan(root, options = {}) {
  const transitive = options.transitive !== false;
  root = fs.realpathSync.native(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('package root must be a directory');
  const skills = skillNames(root);
  if (!skills.length) throw new Error('package contains no skills to check');
  const allowlist = loadAllowlist(root);
  const allowed = new Set(allowlist.map(entry => entry.skill + '\u0000' + entry.ref));
  const missing = [], seen = new Set();
  let refsScanned = 0, filesScanned = 0;

  const pending = [];
  for (const skill of skills) {
    for (const file of skillMarkdownFiles(root, skill)) pending.push({ skill, file });
  }
  // A visited set terminates cycles without silently truncating deep reference
  // chains. Scope it by skill so each allowlist is applied to its own traversal.
  while (pending.length) {
    const { skill, file } = pending.pop();
    const identity = skill + '\u0000' + fs.realpathSync(file);
    if (seen.has(identity)) continue;
    seen.add(identity);
    filesScanned += 1;
    const text = fs.readFileSync(file, 'utf8');
    for (const ref of refsIn(text)) {
      refsScanned += 1;
      const key = skill + '\u0000' + ref;
      const resolved = resolveCandidate(root, skill, file, ref);
      if (resolved) {
        if (transitive && resolved.endsWith('.md')) pending.push({ skill, file: resolved });
        continue;
      }
      if (!allowed.has(key)) missing.push({ skill, ref, from: path.relative(root, file).replace(/\\/g, '/') });
    }
  }

  missing.sort((a, b) => a.skill.localeCompare(b.skill) || a.ref.localeCompare(b.ref));
  return { schema: 1, root, skills: skills.length, filesScanned, refsScanned, allowlisted: allowlist.length, missing };
}

function main(argv) {
  const known = new Set(['--root', '--check', '--json', '--no-transitive']);
  const seen = new Set();
  let root = path.join(__dirname, '..');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!known.has(arg) || seen.has(arg)) throw new Error('unknown or duplicate option: ' + arg);
    seen.add(arg);
    if (arg === '--root') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--root requires a directory');
      root = path.resolve(argv[++i]);
    }
  }
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  const transitive = !argv.includes('--no-transitive');
  const result = scan(root, { transitive });
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    console.log(`skills=${result.skills} files=${result.filesScanned} refs=${result.refsScanned} allowlisted=${result.allowlisted} missing=${result.missing.length}`);
    for (const item of result.missing) console.log(`${item.skill}: ${item.ref} (from ${item.from})`);
  }
  if (check && result.missing.length) process.exitCode = 2;
}

module.exports = { scan, refsIn, skillNames, loadAllowlist };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error('REFERENCE_INTEGRITY_ERROR: ' + error.message); process.exitCode = 2; }
}
