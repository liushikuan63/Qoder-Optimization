#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { isPublicFile, metadataFor } = require('../scripts/pack-share-extras.cjs');

function walk(root, rel = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (!rel && ['.git', '.github'].includes(entry.name)) continue;
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('symbolic link: ' + next);
    if (entry.isDirectory()) files.push(...walk(root, next));
    else files.push(next);
  }
  return files.sort();
}

function checkRelease(root, tag, selectedFiles) {
  const problems = [];
  const fail = message => problems.push(message);
  const version = String(tag || '').replace(/^v/, '');
  const read = file => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); }
    catch { fail('missing or unreadable: ' + file); return ''; }
  };
  const json = file => {
    try { return JSON.parse(read(file)); }
    catch { fail('invalid JSON: ' + file); return {}; }
  };
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('invalid or missing version argument');
  const lines = read('VERSION').trim().split(/\r?\n/);
  if (lines[0] !== 'v' + version) fail('VERSION first line does not match tag');
  if (lines.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(lines[1] || '')) fail('VERSION must contain a version and a date on separate lines');
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', 'INDEX.md', 'README-安装说明.md', 'Qoder-AI编码通用规则.md', 'Qoder-个人规则生成提示词.md', 'SKILLS-清单.md']) {
    if (!fs.existsSync(path.join(root, file))) fail('missing: ' + file);
  }
  const catalog = json('catalog.json');
  const manifest = json('skills-manifest.json');
  if (catalog.package?.version !== version) fail('catalog.package.version does not match tag');
  if (manifest.version !== version) fail('manifest.version does not match tag');
  if (catalog.package?.name !== 'Qoder-Optimization' || manifest.package_name !== 'Qoder-Optimization') fail('package name must be Qoder-Optimization');
  if (![1, 'qoder-share-catalog/1'].includes(catalog.schema)) fail('unknown catalog schema');
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  if (!entries.length) fail('catalog entries are empty or missing');
  if (new Set(entries.map(e => e.id)).size !== entries.length) fail('duplicate catalog IDs');
  let files = [];
  try { files = selectedFiles || walk(root); }
  catch (error) { fail(error.message); }
  if (!files.length) fail('no release files');
  for (const file of files) {
    if (!isPublicFile(file)) fail('unexpected release file: ' + file);
    try {
      const st = fs.lstatSync(path.join(root, file));
      if (!st.isFile() || st.isSymbolicLink()) fail('not a regular file: ' + file);
      else if (!st.size) fail('empty file: ' + file);
    } catch { fail('missing release file: ' + file); }
  }
  try {
    const expected = metadataFor(root);
    for (const category of Object.keys(expected.catalog.counts)) {
      if (catalog.counts?.[category] !== expected.catalog.counts[category]) fail('catalog count drift: ' + category);
    }
    if (JSON.stringify(catalog.entries) !== JSON.stringify(expected.catalog.entries)) fail('catalog entries, descriptions or install/source paths drift from package files');
    if (JSON.stringify(manifest.skills) !== JSON.stringify(expected.manifest.skills)) fail('manifest skill names, tiers or file counts drift');
    if (read('INDEX.md') !== expected.files['INDEX.md']) fail('INDEX.md version or counts drift');
    for (const file of ['README.md', 'README-安装说明.md', 'SKILLS-清单.md', 'Qoder-AI编码通用规则.md', 'Qoder-个人规则生成提示词.md']) {
      if (read(file).replace(/\r\n/g, '\n') !== expected.files[file]) fail('generated documentation drift: ' + file);
    }
    try {
      const { normalizeGzipHeader } = require('../scripts/archive-entries.cjs');
      if (!normalizeGzipHeader(fs.readFileSync(path.join(root, 'qoder-memory-export-generic.tar.gz'))).equals(expected.files['qoder-memory-export-generic.tar.gz'])) fail('memory archive tools drift from public source');
    } catch (error) { fail('memory archive is unreadable: ' + error.message); }
  } catch (error) { fail('package metadata cannot be regenerated: ' + error.message); }
  const readme = read('README.md');
  if (!readme.includes('version-' + version + '-')) fail('README version badge drift');
  if (readme.split(/\r?\n/).filter(line => line.startsWith(`| ${version} | ${lines[1]} |`)).length !== 2) fail('README must have matching English and Chinese version rows');
  const asset = `/releases/download/v${version}/Qoder-Optimization-${version}.zip`;
  if (readme.split(asset).length - 1 !== 2) fail('README current download links drift');
  for (const [label, count] of [
    ['Skills', catalog.counts?.skill], ['技能', catalog.counts?.skill],
    ['Scripts', catalog.counts?.script], ['脚本', catalog.counts?.script],
    ['Commands', catalog.counts?.command], ['命令', catalog.counts?.command],
    ['Sub-agents', catalog.counts?.agent], ['子智能体', catalog.counts?.agent],
    ['Catalog entries', entries.length], ['目录条目', entries.length],
  ]) if (!readme.includes(`| ${label} | ${count} |`)) fail('README count drift: ' + label);
  const skillEntries = entries.filter(entry => entry.category === 'skill');
  const coreEntries = skillEntries.filter(entry => entry.tier === 'core');
  const coreChars = coreEntries.reduce((sum, entry) => sum + String(entry.description || '').length, 0);
  const totalChars = skillEntries.reduce((sum, entry) => sum + String(entry.description || '').length, 0);
  const format = value => value.toLocaleString('en-US');
  if (!readme.includes(`${coreEntries.length} core skill descriptions total ${format(coreChars)} characters`) ||
      !readme.includes(`${coreEntries.length} 个常驻技能的描述共 ${format(coreChars)} 字符`) ||
      !readme.includes(`all ${skillEntries.length} skill descriptions total ${format(totalChars)} characters`) ||
      !readme.includes(`${skillEntries.length} 个技能的描述共 ${format(totalChars)} 字符`)) fail('README tier statistics drift');
  const skillList = read('SKILLS-清单.md');
  for (const entry of skillEntries) if (!skillList.includes('- `' + entry.name + '`（' + (entry.tier === 'core' ? '常驻' : '按需') + '）')) fail('skill-list tier drift: ' + entry.name);
  const offline = files.filter(file => file.startsWith('mcp/offline/'));
  if (offline.length && !files.includes('mcp/offline/LICENSE-cua-driver.txt')) fail('missing offline third-party license');
  return { problems, files, version };
}

module.exports = { checkRelease, walk };
if (require.main === module) {
  const result = checkRelease(process.cwd(), process.argv[2]);
  for (const problem of result.problems) console.error('FAIL ' + problem);
  console.log(`checked ${result.files.length} files`);
  console.log(result.problems.length ? `VERDICT: FAIL (${result.problems.length} problems)` : 'VERDICT: CLEAN');
  process.exitCode = result.problems.length ? 1 : 0;
}
