#!/usr/bin/env node
// ip-compliance-check.mjs — 未授权 IP/品牌合规检查（1.0.5）
// 扫描 skill 交付物（排除知识/词库定义目录）是否含未授权 IP 线索。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EXCLUDE = ['references/knowledge', 'references/data', 'scripts', 'tests', '.git', 'node_modules', '.workbuddy'];
const HINTS = ['disney', 'pokemon', '宝可梦', '米老鼠', 'hello kitty', '漫威', 'marvel', '王者荣耀', '和平精英', '原神'];
function norm(s) { return s.replace(/\\/g, '/'); }
function walk(dir) { const out=[]; for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name); if(EXCLUDE.some(x=>norm(p).includes(norm(x))))continue; if(e.isDirectory())out.push(...walk(p)); else if(/\.(md|mjs|json)$/.test(e.name))out.push(p);} return out; }

function main() {
  const files = walk(ROOT);
  let hits = 0;
  for (const f of files) {
    const c = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const h of HINTS) if (c.includes(h.toLowerCase())) { hits++; console.log(`[ip] ${path.relative(ROOT, f)} :: "${h}"`); }
  }
  console.log(`\n扫描 ${files.length} 文件；未授权 IP 线索 ${hits}；${hits === 0 ? 'PASS' : 'WARN'}`);
  process.exit(0); // 仅告警
}
main();
