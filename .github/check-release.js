#!/usr/bin/env node
'use strict';
// Release gate: fails when tag, VERSION, catalog and on-disk assets disagree.
// Usage: node .github/check-release.js <version-or-tag>
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const tag = (process.argv[2] || '').trim().replace(/^v/, '');
const problems = [];
const ok = (m) => console.log(`ok   ${m}`);
const fail = (m) => { problems.push(m); console.log(`FAIL ${m}`); };

if (!tag) fail('missing version argument (usage: node .github/check-release.js <version>)');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1) VERSION must equal the tag (file format: version on the first line, build date after)
const ver = read('VERSION').split(/\r?\n/)[0].trim().replace(/^v/, '');
if (tag && ver !== tag) fail(`VERSION(${ver}) != tag(${tag})`);
else if (tag) ok(`VERSION matches tag: ${ver}`);

// 2) required top-level files
for (const f of ['README.md', 'LICENSE', 'catalog.json', 'skills-manifest.json', 'README-安装说明.md']) {
  fs.existsSync(path.join(root, f)) ? ok(`present ${f}`) : fail(`missing ${f}`);
}

// 3) catalog counts must equal both the entry list and the files on disk
const cat = JSON.parse(read('catalog.json'));
const entries = cat.entries || [];
const counts = cat.counts || {};
const byCat = {};
for (const e of entries) byCat[e.category] = (byCat[e.category] || 0) + 1;
const dirs = { skill: 'skills', script: 'scripts', command: 'commands', agent: 'agents' };

for (const [kind, dir] of Object.entries(dirs)) {
  const declared = counts[kind];
  const listed = byCat[kind] || 0;
  if (declared !== listed) fail(`catalog.counts.${kind}=${declared} disagrees with ${listed} entries`);
  if (!fs.existsSync(path.join(root, dir))) { fail(`missing directory ${dir}`); continue; }
  const actual = kind === 'skill'
    ? fs.readdirSync(path.join(root, dir)).filter((d) => fs.existsSync(path.join(root, dir, d, 'SKILL.md'))).length
    : fs.readdirSync(path.join(root, dir)).filter((f) => fs.statSync(path.join(root, dir, f)).isFile()).length;
  if (declared !== actual) fail(`${dir}/ has ${actual} items, catalog declares ${declared}`);
  else ok(`${dir}/ ${actual} items match catalog`);
}

// 4) every shipped entry must resolve to a file
const missing = [];
for (const e of entries) {
  if (e.status !== 'shipped') continue;
  let rel = null;
  if (e.category === 'skill') rel = path.join('skills', e.name, 'SKILL.md');
  else if (e.category === 'script') rel = path.join('scripts', e.name);
  else if (e.category === 'command') rel = path.join('commands', `${e.name}.md`);
  else if (e.category === 'agent') rel = path.join('agents', `${e.name}.md`);
  if (rel && !fs.existsSync(path.join(root, rel))) missing.push(rel);
}
if (missing.length) fail(`${missing.length} shipped entries have no file, e.g. ${missing.slice(0, 3).join(', ')}`);
else ok('all shipped entries resolve to files');

// 5) hygiene: no backups, no empty files, no local-only artifacts
const walk = (dir, acc = []) => {
  for (const name of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['.git', '.github', 'node_modules'].includes(name.name)) continue;
    const rel = path.join(dir, name.name);
    if (name.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
};
const files = walk('.');
const junk = files.filter((f) => /\.bak|Thumbs\.db|desktop\.ini|\.DS_Store|\.env$|\.pem$|\.key$/.test(f));
if (junk.length) fail(`unexpected files: ${junk.slice(0, 5).join(', ')}`);
else ok('no backup / secret-like files');
const empty = files.filter((f) => fs.statSync(path.join(root, f)).size === 0 && !path.basename(f).startsWith('.'));
if (empty.length) fail(`empty files: ${empty.slice(0, 5).join(', ')}`);
else ok('no empty files');

// 6) summary
console.log(`\nchecked ${files.length} files`);
if (problems.length) {
  console.log(`VERDICT: FAIL (${problems.length} problems)`);
  process.exit(1);
}
console.log('VERDICT: CLEAN');
