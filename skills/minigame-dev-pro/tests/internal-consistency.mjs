#!/usr/bin/env node
// internal-consistency.mjs — 内部矛盾/冗余/冲突拦截（1.0.5）
// 扫描 references 是否残留历史矛盾标记（软著必须/建议并存、流量主个人可、iOS已开放、小程序API误用等）。
// 出现任一即 fail，确保 skill 内部零冲突、零冗余、零 BUG。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FORBIDDEN = [
  '软著是瓶颈',
  '个人/企业均可开通流量主',
  'iOS 虚拟支付已开放',
  '走苹果 IAP',
  'wx.requestMidasPaymentGameItem',
  'wx.requestVirtualPayment',
  'wx.checkIsSupportMidasPayment',
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // references/data 是注册表/词库数据，非知识正文，其中的纠错说明性提及不视为矛盾
      if (path.relative(ROOT, p) === path.join('references', 'data')) continue;
      out.push(...walk(p));
    } else if (/\.(md|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  const files = walk(path.join(ROOT, 'references'));
  let conflicts = 0;
  for (const f of files) {
    const c = fs.readFileSync(f, 'utf8');
    for (const m of FORBIDDEN) if (c.includes(m)) { conflicts++; console.log(`[conflict] ${path.relative(ROOT, f)} :: "${m}"`); }
  }
  console.log(`\n内部矛盾标记=${conflicts}；${conflicts === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(conflicts === 0 ? 0 : 1);
}
main();
