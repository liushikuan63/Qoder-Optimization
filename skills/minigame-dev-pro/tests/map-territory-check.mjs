#!/usr/bin/env node
// map-territory-check.mjs — 地图领土合规检查（1.0.5）
// 扫描 skill 交付物中的图片素材，若含地图类图片须含台湾/南海九段线标注说明；无图片则 PASS。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function main() {
  const imgs = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(png|jpg|jpeg|webp|svg)$/i.test(e.name)) imgs.push(p); } }
  walk(ROOT);
  if (imgs.length === 0) { console.log('未含图片素材；map-territory-check=PASS'); process.exit(0); }
  // skill 不应打包任何地图图片；若出现须人工核对领土标注
  console.log(`发现 ${imgs.length} 个图片，须人工确认均含台湾/南海九段线：${imgs.join(', ')}`);
  process.exit(1);
}
main();
