#!/usr/bin/env node
'use strict';
const path = require('path');
const { collectSkills } = require('./build-skills-index.cjs');
const { resolveCatalog, readCatalog, searchEntries, formatEntry, localPresence, needsAsk, compareWithPackage } = require('./pkg-catalog.cjs');

const args = process.argv.slice(2);
const record = args.includes('--record');
const query = args.filter(arg => arg !== '--record').join(' ').trim();
if (!query) {
  console.error('用法: node skill-load.cjs [--record] "<关键词…>"');
  process.exit(2);
}

let entries;
try {
  // 查询现场而非可漂移的生成物；纯检索不修改索引或安装状态。
  entries = collectSkills().map(e => ({ ...e, id: 'skill:' + e.name, category: 'skill' }));
} catch (error) {
  console.error('INDEX_ERROR: ' + error.message);
  process.exit(2);
}
function packageUpdatesFor(hits) {
  const file = resolveCatalog();
  if (!file) return [];
  let entriesInPackage;
  try {
    entriesInPackage = readCatalog(file).entries;
  } catch {
    return [];
  }
  const root = path.dirname(file);
  const updates = [];
  for (const { e } of hits) {
    const entry = entriesInPackage.find(x => x.category === 'skill' && x.name === e.name && x.status === 'shipped');
    if (!entry) continue;
    const cmp = compareWithPackage(entry, root, path.dirname(e.path));
    if (cmp?.differs) updates.push({ e, cmp });
  }
  return updates;
}

const hits = searchEntries(entries, query, 6);
if (hits.length) {
  if (record) {
    // Explicit /skill-load demand signal only; normal programmatic searches
    // stay read-only. Lazy require keeps older clients without the new script
    // working, and native Skill tool invocations still need an explicit log.
    try {
      const { appendUsage, LOG_FILE } = require('./skill-usage.cjs');
      const { clientRoot } = require('./client-root.js');
      appendUsage(path.join(clientRoot(), LOG_FILE), hits[0].e.name, 'skill-load');
    } catch (error) { console.error('USAGE_LOG_WARN: ' + error.message); }
  }
  hits.forEach(({ e, s }, i) => {
    console.log(`${i + 1}. ${e.name}   [${e.tier}]  score=${s}`);
    console.log(`   ${e.path}`);
    console.log(`   ${(e.description || '').slice(0, 110)}`);
  });
  const updates = packageUpdatesFor(hits);
  if (updates.length) {
    console.log(`\n包内更新检查：${updates.length} 个已命中技能与包内内容不同（可更新或本地已改，更新前需三路比对）：`);
    for (const { e, cmp } of updates) console.log(`   - ${e.name}（${cmp.file}）`);
    console.log('NEXT_ACTION: ASK_UPDATE — 必须用 AskUserQuestion 询问是否更新（查看差异 / 保持现状），未获明确选择不得覆盖。');
  }
} else {
  console.log('NO_MATCH');
  const file = resolveCatalog();
  if (file) {
    try {
      const candidates = searchEntries(readCatalog(file).entries, query, 3);
      if (candidates.length) {
        console.log(`分享包候选 ${candidates.length} 条（文件存在不等于已装载；检索不授权安装）：`);
        let ask = 0;
        for (const { e } of candidates) {
          const presence = localPresence(e, path.dirname(file));
          console.log(formatEntry(e, file, presence));
          if (needsAsk(e, presence)) ask++;
        }
        if (ask) console.log(`\nNEXT_ACTION: ASK_INSTALL_OR_UPDATE — ${ask} 条可安装或可更新；必须用 AskUserQuestion 询问用户，未获明确选择不得执行安装或更新。`);
      }
    } catch (error) {
      console.error('CATALOG_UNAVAILABLE: 分享包索引不可用；请核对包位置后重新 register。' + error.message);
    }
  }
  process.exitCode = 3;
}
