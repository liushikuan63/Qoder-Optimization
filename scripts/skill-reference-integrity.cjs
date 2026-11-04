#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REF_RE = /(?:\.\.\/)*(?:references|scripts)\/[A-Za-z0-9._\/-]+\.(?:json|mjs|cjs|md|js|ps1|sh|py)(?![A-Za-z0-9])/g;
const FENCE_RE = /```[\s\S]*?```/g;
const MUTED_RE = /<!--[\s\S]*?-->/g;

function stripExamples(text) {
  return String(text).replace(FENCE_RE, '').replace(MUTED_RE, '');
}

function refsIn(text) {
  const found = new Set();
  for (const match of stripExamples(text).matchAll(REF_RE)) found.add(match[0]);
  return [...found];
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
  const skillDir = path.join(root, 'skills', skill);
  const bases = [path.dirname(fromFile), skillDir, root];
  for (const base of bases) {
    const candidate = path.resolve(base, ref);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function scan(root, options = {}) {
  const transitive = options.transitive !== false;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const allowlist = loadAllowlist(root);
  const allowed = new Set(allowlist.map(entry => entry.skill + '\u0000' + entry.ref));
  const missing = [], seen = new Set();
  let refsScanned = 0, filesScanned = 0;

  function visit(skill, file, depth) {
    if (seen.has(file) || depth > maxDepth) return;
    seen.add(file);
    filesScanned += 1;
    const text = fs.readFileSync(file, 'utf8');
    for (const ref of refsIn(text)) {
      refsScanned += 1;
      const key = skill + '\u0000' + ref;
      const resolved = resolveCandidate(root, skill, file, ref);
      if (resolved) {
        if (transitive && resolved.endsWith('.md')) visit(skill, resolved, depth + 1);
        continue;
      }
      if (!allowed.has(key)) missing.push({ skill, ref, from: path.relative(root, file).replace(/\\/g, '/') });
    }
  }

  for (const skill of skillNames(root)) visit(skill, path.join(root, 'skills', skill, 'SKILL.md'), 0);
  missing.sort((a, b) => a.skill.localeCompare(b.skill) || a.ref.localeCompare(b.ref));
  return { schema: 1, root, skills: skillNames(root).length, filesScanned, refsScanned, allowlisted: allowlist.length, missing };
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.join(__dirname, '..'));
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
