#!/usr/bin/env node
// ad-law-gate.mjs — 广告法极限词闸门（1.0.5）
// 扫描 skill 交付物（排除知识/词库定义目录）是否含广告法绝对化用语。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BANK = path.join(ROOT, 'references', 'data', 'ad-law-words.json');
const EXCLUDE = ['references/knowledge', 'references/data', 'scripts', '.git', 'node_modules', '.workbuddy'];

const bank = JSON.parse(fs.readFileSync(BANK, 'utf8'));
const terms = [...bank.absoluteTerms, ...bank.falsePromotion].map((t) => t.trim()).filter(Boolean);
// 教学/禁止语境标记：合规知识须以"禁止项"命名类别，含这些标记的行不视为极限词命中
const NEG = ['禁止', '不得', '不可', '严禁', '避免', '注意', '风险', '合规', '规范', '红线',
  '须', '必须', '要求', '建议', '请勿', '勿', '极限词', '广告法', 'warning', 'Warning', '不得出现', '不得包含'];

function norm(s) { return s.replace(/\\/g, '/'); }
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (EXCLUDE.some((x) => norm(p).includes(norm(x)))) continue;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(md|mjs|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  const files = walk(ROOT);
  let hits = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (const t of terms) {
      if (!t) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(t) && !NEG.some((m) => lines[i].includes(m))) {
          hits++;
          console.log(`[ad-law] ${path.relative(ROOT, f)}:${i + 1} :: "${t}"`);
        }
      }
    }
  }
  console.log(`\n扫描 ${files.length} 文件；极限词命中 ${hits}；${hits === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(hits === 0 ? 0 : 1);
}
main();
