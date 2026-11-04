#!/usr/bin/env node
// freshness-check.mjs — 全量事实承载文件时效巡检（1.0.8）
// 演进自 sop-timeliness-check.mjs：范围从 sop/ 扩到全部事实承载 knowledge 文件；
// 要求头部含元数据块（last_verified/verify_cycle/next_verify/primary_source），缺 → missing-meta。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE = path.join(__dirname, '..', 'references', 'knowledge');

// 事实承载文件范围（目录）
const SCAN_DIRS = [
  'compliance-rules.md', 'legal-finance.md', 'tech-specs.md', 'error-reference.md',
  'market-data.md', 'cost-database.md', 'pc-mini-game.md', 'cross-platform.md',
  'glossary.md', 'case-library.md', 'sop', 'compliance',
];

// 易变事实关键词：含这些词的 fact-bearing 文件必须带头部时效元数据块
const VOLATILE = ['包体', '流量主', '软著', '版号', '虚拟支付', '防沉迷', 'UV', 'CPM', 'eCPM',
  '分成', '结算', '实名', '备案', '资质', 'iOS', '内容安全', '极限词', '广告法', '隐私', '数据'];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function hasMetaBlock(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const body = m[1];
  return ['last_verified', 'verify_cycle', 'next_verify'].every((k) => body.includes(k));
}

function main() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const p = path.join(KNOWLEDGE, d);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith('.md')) files.push(p);
  }
  let missing = 0;
  const volatileFiles = files.filter((f) => VOLATILE.some((k) => fs.readFileSync(f, 'utf8').includes(k)));
  for (const f of volatileFiles) {
    const content = fs.readFileSync(f, 'utf8');
    if (!hasMetaBlock(content)) {
      missing++;
      console.log(`[missing-meta] ${path.relative(__dirname, f)}`);
    }
  }
  console.log(`\n巡检 ${files.length} 文件（含易变事实 ${volatileFiles.length} 个须标时效）；missing-meta=${missing}`);
  process.exit(missing > 0 ? 1 : 0);
}

main();
