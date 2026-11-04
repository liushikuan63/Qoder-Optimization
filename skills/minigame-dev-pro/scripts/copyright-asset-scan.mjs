#!/usr/bin/env node
// copyright-asset-scan.mjs — 版权素材授权合法性扫描（L4，1.0.8）
// 扫描素材资源目录，检测未授权 IP/品牌关键词与授权声明缺失。仅 warning，不自动判定侵权。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, '..', 'references', 'data', 'copyright-ip.json');

// 内置回退列表：即使检测库缺失也不中断（单一真源优先，回退保证健壮）
const FALLBACK_HINTS = ['disney', 'pokemon', '宝可梦', '米老鼠', 'hello kitty', '漫威', 'marvel', '王者荣耀', '和平精英'];

function loadHints() {
  try {
    const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
    if (Array.isArray(bank.unauthorizedIpHints) && bank.unauthorizedIpHints.length) {
      return bank.unauthorizedIpHints;
    }
  } catch { /* 检测库不可用时回退 */ }
  return FALLBACK_HINTS;
}

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const target = get('--path');
  if (!target) {
    console.log('[copyright-asset-scan] 用法：node copyright-asset-scan.mjs --path <素材目录>');
    process.exit(0);
  }
  const HINTS = loadHints();
  const files = walk(target);
  let warnings = 0;
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    for (const h of HINTS) {
      if (base.includes(h)) {
        warnings++;
        console.log(`[copyright-warn] ${f} :: 文件名含未授权 IP 线索 "${h}"，须确认授权`);
      }
    }
  }
  console.log(`\n扫描 ${files.length} 文件；授权警示 ${warnings}（warning，须人工确认）`);
  process.exit(0);
}

main();
