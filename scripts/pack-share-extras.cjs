#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { dependenciesFor } = require('./package-dependencies.cjs');
const { archiveEntries, encodeTar } = require('./archive-entries.cjs');
const { gzipSync } = require('zlib');

function memoryArchiveFor(root) {
  const name = 'qoder-memory-export-generic.tar.gz';
  const entries = new Map(archiveEntries(name, fs.readFileSync(path.join(root, name))).map(e => [e.name, e.data]));
  entries.set('scripts/import-memory.sh', Buffer.from('#!/bin/bash\nset -euo pipefail\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nexec node "$SCRIPT_DIR/import-memory.cjs" "$@"\n'));
  for (const file of ['import-memory.cjs', 'archive-entries.cjs', 'client-root.js']) entries.set('scripts/' + file, fs.readFileSync(path.join(root, 'scripts', file)));
  return gzipSync(encodeTar([...entries].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, data]) => ({ name, data }))), { level: 9 });
}

const PUBLIC_PATHS = [
  '.gitattributes', '.gitignore', 'VERSION', 'README.md', 'LICENSE', 'CHANGELOG.md',
  'INDEX.md', 'README-安装说明.md', 'Qoder-AI编码通用规则.md', 'Qoder-个人规则生成提示词.md',
  'SKILLS-清单.md', 'catalog.json', 'skills-manifest.json', 'qoder-memory-export-generic.tar.gz',
  'skills', 'scripts', 'commands', 'agents', 'hooks', 'mcp', 'plugins',
];
const PRIVATE_FILE = /(^|\/)(?:\.git|\.github|node_modules|logs?|backups|credentials(?:\.[^/]*)?|settings\.json|share-package\.json|\.env(?:\.[^/]*)?|\.qoder-work-queue\.md|\.export-[^/]*|Thumbs\.db|desktop\.ini|\.DS_Store)(?:\/|$)|\.bak(?:[._-]|$)|(?:~|\.tmp|\.swp|\.orig|\.log|\.pem|\.key)$/i;

function isPublicFile(rel) {
  return typeof rel === 'string' && !/[\\:\x00-\x1f]/.test(rel) &&
    !rel.split('/').some(p => !p || p === '.' || p === '..') &&
    PUBLIC_PATHS.includes(rel.split('/')[0]) && !PRIVATE_FILE.test(rel);
}

function filesUnder(root, rel) {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const next = rel + '/' + name;
    if (PRIVATE_FILE.test(next)) continue;
    const st = fs.lstatSync(path.join(root, next));
    if (st.isSymbolicLink()) throw new Error('不读取符号链接：' + next);
    if (st.isDirectory()) result.push(...filesUnder(root, next));
    else if (st.isFile()) result.push(next);
  }
  return result;
}

function descriptionOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const raw = (text.match(/^description:[ \t]*(.+)$/m) || [])[1];
  if (!raw) throw new Error('缺少单行 description：' + path.basename(path.dirname(file)));
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function metadataFor(root, options = {}) {
  const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const previous = readJson('catalog.json');
  const previousManifest = readJson('skills-manifest.json');
  if (![1, 'qoder-share-catalog/1'].includes(previous.schema) || !Array.isArray(previous.entries)) {
    throw new Error('catalog schema 或 entries 无效');
  }
  const versionLines = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim().split(/\r?\n/);
  const originalVersion = versionLines[0].replace(/^v/, '');
  const version = String(options.version || originalVersion).replace(/^v/, '');
  const date = options.date || (version === originalVersion ? versionLines[1] : new Date().toISOString().slice(0, 10));
  const name = options.name || previous.package?.name || previousManifest.package_name;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本必须为 x.y.z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('VERSION 第二行需要有效日期');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) throw new Error('包名不能为空或包含空格');
  const oldEntries = new Map(previous.entries.map(e => [e.id, e]));
  const oldSkills = new Map((previousManifest.skills || []).map(s => [s.name, s]));
  const skills = [];
  const entries = [];
  for (const skill of fs.readdirSync(path.join(root, 'skills')).sort()) {
    const dir = path.join(root, 'skills', skill);
    if (PRIVATE_FILE.test('skills/' + skill)) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('技能不能是符号链接：' + skill);
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('技能缺少 SKILL.md：' + skill);
    const old = oldEntries.get('skill:' + skill) || {};
    const tier = oldSkills.get(skill)?.tier || old.tier || 'library';
    if (!['core', 'library'].includes(tier)) throw new Error('技能层级无效：' + skill);
    skills.push({ ...oldSkills.get(skill), name: skill, tier, files: filesUnder(root, 'skills/' + skill).length });
    entries.push({ ...old, id: 'skill:' + skill, category: 'skill', name: skill, status: 'shipped', tier,
      description: descriptionOf(path.join(dir, 'SKILL.md')), source: 'skills/' + skill, install: { mode: 'copy-skill', tier } });
  }
  for (const [category, dir] of Object.entries({ script: 'scripts', command: 'commands', agent: 'agents' })) {
    for (const file of filesUnder(root, dir)) {
      if (path.posix.dirname(file) !== dir) throw new Error('目录条目只支持直接文件：' + file);
      if (category !== 'script' && !file.endsWith('.md')) throw new Error('命令和 agent 必须为 Markdown：' + file);
      const name = category === 'script' ? path.posix.basename(file) : path.posix.basename(file, '.md');
      const id = category + ':' + name;
      entries.push({ ...oldEntries.get(id), id, category, name, status: 'shipped', source: file, install: { mode: 'copy-file' } });
    }
  }
  for (const entry of entries) entry.dependencies = dependenciesFor(root, entry);
  const ids = new Set(entries.map(e => e.id));
  for (const entry of entries) for (const id of entry.dependencies) if (!ids.has(id)) throw new Error('缺少依赖条目：' + id);
  for (const entry of previous.entries) {
    if (entry.status !== 'shipped' && !ids.has(entry.id)) {
      entries.push(entry);
      ids.add(entry.id);
    }
  }
  const counts = entries.reduce((result, entry) => { result[entry.category] = (result[entry.category] || 0) + 1; return result; }, {});
  for (const category of ['skill', 'script', 'command', 'agent']) counts[category] ||= 0;
  const catalog = { ...previous, schema: 1, package: { name, version }, generated: date, counts, entries };
  const manifest = { ...previousManifest, package_name: name, version, generated: date, skills };
  const index = [
    `# ${name} - ${version}`, '', '## 分享包索引（按需加装）', '',
    `共 ${entries.length} 条：` + Object.entries(counts).map(([kind, count]) => `${kind}=${count}`).join(' / '), '',
    '- 状态：`shipped` 随包可直接装；`external` 只给官方安装方式；`template` 给合并说明。',
    '- 机器可读版：`catalog.json`。文件存在不代表已安装或已装载。', '',
    '```bash', 'node scripts/pkg-catalog.cjs register <分享包目录>',
    'node scripts/pkg-catalog.cjs search "<关键词>"',
    'node scripts/pkg-catalog.cjs install <id>',
    'node scripts/pkg-catalog.cjs install <id> --apply', '```', '',
  ].join('\n');
  const core = entries.filter(e => e.category === 'skill' && e.tier === 'core');
  const skillEntries = entries.filter(e => e.category === 'skill');
  const coreChars = core.reduce((n, e) => n + e.description.length, 0);
  const totalChars = skillEntries.reduce((n, e) => n + e.description.length, 0);
  const percentage = (coreChars * 100 / totalChars).toFixed(1);
  const fmt = n => n.toLocaleString('en-US');
  const readDoc = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  let readme = readDoc('README.md').replace(/version-\d+\.\d+\.\d+-/g, 'version-' + version + '-');
  for (const [label, count] of Object.entries({ Skills: counts.skill, 技能: counts.skill, Scripts: counts.script, 脚本: counts.script, Commands: counts.command, 命令: counts.command, 'Sub-agents': counts.agent, 子智能体: counts.agent, 'Catalog entries': entries.length, 目录条目: entries.length })) {
    readme = readme.replace(new RegExp('(\\| ' + label + ' \\| )\\d+( \\|)', 'g'), (_, before, after) => before + count + after);
  }
  readme = readme.replace(/\d+ core skill descriptions total [\d,]+ characters/g, `${core.length} core skill descriptions total ${fmt(coreChars)} characters`)
    .replace(/all \d+ skill descriptions total [\d,]+ characters/g, `all ${skills.length} skill descriptions total ${fmt(totalChars)} characters`)
    .replace(/\d+ 个常驻技能的描述共 [\d,]+ 字符/g, `${core.length} 个常驻技能的描述共 ${fmt(coreChars)} 字符`)
    .replace(/\d+ 个技能的描述共 [\d,]+ 字符/g, `${skills.length} 个技能的描述共 ${fmt(totalChars)} 字符`)
    .replace(/\d+\.\d+%/g, percentage + '%')
    .replace(/catalog generated on \d{4}-\d{2}-\d{2}/g, 'catalog generated on ' + date)
    .replace(/截至 \d{4}-\d{2}-\d{2} 生成的目录/g, '截至 ' + date + ' 生成的目录');
  if (version !== originalVersion) {
    let row = 0;
    readme = readme.split('\n').flatMap(line => {
      if (!line.startsWith('| ' + originalVersion + ' |')) return [line];
      const summary = row++ === 0 ? 'Integrity fixes; optional offline bundle' : '完整性修复；离线附件按需下载';
      const url = 'https://github.com/liushikuan63/Qoder-Optimization/releases/';
      return [`| ${version} | ${date} | ${summary} | [zip](${url}download/v${version}/${name}-${version}.zip) · [notes](${url}tag/v${version}) |`, line];
    }).join('\n');
  }
  const offlineUrl = 'https://github.com/liushikuan63/Qoder-Optimization/releases/download/v' + version + '/' + name + '-' + version + '-offline.zip';
  readme = readme.replace(/\n<!-- offline-bundle:start -->[\s\S]*?<!-- offline-bundle:end -->\n?/g, '').trimEnd() + '\n\n<!-- offline-bundle:start -->\n### Optional offline bundle / 可选离线附件\n\nThe core ZIP excludes MCP offline binaries. Download the [offline bundle](' + offlineUrl + ') only when needed; verify its separate .sha256 and extract both ZIPs into the same directory. Links become available when that version is published.\n\n核心包不含 MCP 离线二进制；需要时单独下载离线附件，核对各自的 .sha256 后解压到同一目录。无需离线组件时只取核心包；链接仅在对应版本发布后可用。\n<!-- offline-bundle:end -->\n';
  let install = readDoc('README-安装说明.md').replace(/^# Qoder-Optimization[^\n]*/, '# Qoder-Optimization-' + version + ' 安装说明');
  install = install.replace(/^包内实物：.*$/m, `包内实物：${skills.length} 个技能（${core.length} 常驻 + ${skills.length - core.length} 按需）；常驻描述 ${coreChars} 字符，全部技能描述 ${totalChars} 字符，占比 ${percentage}%。按 catalog 计算，不是接收者的已安装数量。`);
  const oldList = readDoc('SKILLS-清单.md');
  const exclusion = oldList.indexOf('## 明确不随包');
  const skillList = [`# ${name} - ${version} 技能清单`, '', `共 ${skills.length} 个源码随包技能：常驻 ${core.length} / 按需 ${skills.length - core.length}。机器可读版见 skills-manifest.json 与 catalog.json。`, '', '默认按需选择安装；层级与依赖以 catalog 为准。', '', '## 源码随包', '', ...skillEntries.map(e => '- `' + e.name + '`（' + (e.tier === 'core' ? '常驻' : '按需') + '）—— ' + e.description), '', exclusion >= 0 ? oldList.slice(exclusion).trimEnd() : '', ''].join('\n');
  return { catalog, manifest, files: {
    VERSION: `v${version}\n${date}\n`,
    'README.md': readme,
    'README-安装说明.md': install,
    'SKILLS-清单.md': skillList,
    'Qoder-AI编码通用规则.md': readDoc('Qoder-AI编码通用规则.md').replace(/^# Qoder-Optimization[^\n]*/, '# Qoder-Optimization - ' + version).replace(/^> 版本：.*$/m, '> 版本：' + version + '；制作日期：' + date + '。版本、计数与目录由公开包元数据同步；是否已发布以对应 Release 为准。').replace(/^> 制作端家用机实际装.*$/m, '> 包内技能 ' + skills.length + ' 个（' + core.length + ' 常驻 + ' + (skills.length - core.length) + ' 按需），不等于接收者已安装数量。'),
    'Qoder-个人规则生成提示词.md': readDoc('Qoder-个人规则生成提示词.md').replace(/配套包：Qoder-Optimization-\d+\.\d+\.\d+（\d{4}-\d{2}-\d{2}）/, '配套包：Qoder-Optimization-' + version + '（' + date + '）'),
    'catalog.json': JSON.stringify(catalog, null, 1) + '\n',
    'skills-manifest.json': JSON.stringify(manifest, null, 1) + '\n',
    'INDEX.md': index,
    'qoder-memory-export-generic.tar.gz': memoryArchiveFor(root),
  } };
}

function main(argv) {
  const args = [...argv];
  const rootArg = args.shift();
  if (!rootArg || rootArg.startsWith('--')) throw new Error('用法：pack-share-extras.cjs <公开仓库或包目录> [--version x.y.z] [--date YYYY-MM-DD] [--apply|--check]');
  const options = {};
  let apply = false;
  let check = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--apply') apply = true;
    else if (arg === '--check') check = true;
    else if (['--version', '--date', '--name'].includes(arg) && args[0] && !args[0].startsWith('--')) options[arg.slice(2)] = args.shift();
    else throw new Error('未知或缺值参数：' + arg);
  }
  if (apply && check) throw new Error('--apply 与 --check 不能混用');
  const root = path.resolve(rootArg);
  const generated = metadataFor(root, options);
  const changed = Object.entries(generated.files).filter(([file, text]) => !fs.existsSync(path.join(root, file)) || !fs.readFileSync(path.join(root, file)).equals(Buffer.from(text)));
  console.log(`公开目录：${root}；不读取 HOME，不复制或删除本机载体`);
  for (const [file] of changed) console.log(`${apply ? 'WRITE' : 'DIFF'} ${file}`);
  if (apply) for (const [file, text] of changed) fs.writeFileSync(path.join(root, file), text);
  console.log(`${apply ? 'APPLIED' : check ? 'CHECK' : 'DRY-RUN'} entries=${generated.catalog.entries.length} changed=${changed.length}`);
  return check && changed.length ? 1 : 0;
}

module.exports = { PUBLIC_PATHS, PRIVATE_FILE, isPublicFile, filesUnder, descriptionOf, metadataFor };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('PACKAGE_ERROR: ' + error.message); process.exitCode = 2; }
}
