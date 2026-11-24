#!/usr/bin/env node
// sensitive-word-gate.mjs — 敏感词闸门（1.0.5）
// 扫描 skill 自身交付物（排除知识/词库定义目录）是否含 L3 分类敏感词。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'sensitive-word-scan.mjs'),
    '--path', ROOT,
    '--exclude', 'references/knowledge,references/data,scripts,.git,node_modules,.workbuddy',
    '--strict',
  ], { stdio: 'inherit', cwd: ROOT });
  console.log('\nsensitive-word-gate=PASS');
  process.exit(0);
} catch {
  console.log('\nsensitive-word-gate=FAIL');
  process.exit(1);
}
