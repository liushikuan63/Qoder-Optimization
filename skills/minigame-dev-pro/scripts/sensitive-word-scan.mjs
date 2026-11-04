#!/usr/bin/env node
// sensitive-word-scan.mjs — 内容安全敏感词扫描（L3，1.0.8）
// 扫描目标路径文本文件，命中 sensitive-words.json 分类词即报告。默认排除 skill 自身知识/词库目录（其仅以"禁止项"定义类别）。
// 用法：node sensitive-word-scan.mjs --path <dir> [--exclude "a,b"] [--strict]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDBANK = path.join(__dirname, '..', 'references', 'data', 'sensitive-words.json');

function loadBank() {
  const b = JSON.parse(fs.readFileSync(WORDBANK, 'utf8'));
  const words = [];
  for (const cat of Object.keys(b.categories)) for (const w of b.categories[cat]) words.push(w);
  return words;
}

function norm(s) { return s.replace(/\\/g, '/'); }
function walk(dir, excludes) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (excludes.some((x) => norm(p).includes(norm(x)))) continue;
    if (e.isDirectory()) out.push(...walk(p, excludes));
    else if (/\.(md|mjs|json|txt|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 教学/禁止语境标记：合规知识文件须以"禁止项"命名类别，含这些标记的行不视为敏感词命中
const NEG = ['禁止', '不得', '不可', '严禁', '避免', '注意', '风险', '合规', '规范', '红线',
  '须', '必须', '要求', '建议', '请勿', '勿', '不含', '不含有', '禁止包含', '避免包含',
  'warning', 'Warning', '不得出现', '不得包含'];

function main() {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const target = get('--path') || process.cwd();
  const excludes = (get('--exclude') || 'references/knowledge,references/data,.git,node_modules,.workbuddy').split(',').filter(Boolean);
  const strict = argv.includes('--strict');

  const words = loadBank();
  const files = walk(target, excludes);
  let hits = 0;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (const w of words) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(w) && !NEG.some((m) => lines[i].includes(m))) {
          hits++;
          console.log(`[sensitive] ${path.relative(process.cwd(), f)}:${i + 1} :: 命中 "${w}"`);
        }
      }
    }
  }
  console.log(`\n扫描 ${files.length} 文件；命中 ${hits}`);
  if (strict && hits > 0) process.exit(1);
  process.exit(0);
}

main();
