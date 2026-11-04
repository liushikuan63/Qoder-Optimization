#!/usr/bin/env node
// verify-specs.mjs — 事实注册表探活 + 时效闸门（1.0.8）
// 演进自 fetch-official-docs.mjs：URL 来源改为读 spec-registry.json，探叶子页而非总览；
// 支持 --platform / --layer 筛选；易变类 stale → exit 1（CI 思维）。不解析 SPA 正文。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(__dirname, '..', 'references', 'data', 'spec-registry.json');

const ALLOWED_HOSTS = [
  'developers.weixin.qq.com', 'developer.open-douyin.com', 'microapp.bytedance.com',
  'partner.open-douyin.com', 'www.nppa.gov.cn', 'www.cac.gov.cn', 'www.samr.gov.cn',
  'mapservice.bnimd.cn', 'q.qq.com', 'open.kuaishou.com', 'opendocs.alipay.com',
  'smartprogram.baidu.com', 'open.taobao.com', 'quickapp.cn',
];

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}

function isAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function linkLiveness(url) {
  if (!url || url === 'pending-verify') return { url, status: 'pending' };
  if (!isAllowed(url)) return { url, status: 'blocked-ssrf' };
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      res.resume();
      resolve({ url, status: res.statusCode < 400 ? 'ok' : `http-${res.statusCode}` });
    });
    req.on('error', (e) => resolve({ url, status: `err-${e.code || 'unknown'}` }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ url, status: 'timeout' }); });
  });
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return 99999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function staleness(spec) {
  if (spec.status === 'unknown') return 'unknown';
  const age = daysSince(spec.lastVerified);
  const cycle = spec.verifyCycleDays || 90;
  if (spec.status === 'verified' && age > cycle) return 'stale';
  return spec.status || 'verified';
}

async function main() {
  const argv = process.argv.slice(2);
  const platArg = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : 'all';
  const layerArg = argv.includes('--layer') ? argv[argv.indexOf('--layer') + 1] : 'all';
  const live = argv.includes('--live');

  const reg = loadRegistry();
  let specs = reg.specs;
  if (platArg !== 'all') specs = specs.filter((s) => s.platform === platArg);
  if (layerArg !== 'all') specs = specs.filter((s) => s.layer === layerArg);

  const report = [];
  let fail = false;
  for (const s of specs) {
    const st = staleness(s);
    if (st === 'unknown') console.log(`  [warn] ${s.id} status=unknown（诚实标注，未核实，不阻断发布；agent 作答须先 WebSearch 重核）`);
    if (st === 'stale' && s.volatility === 'volatile') fail = true;
    let link = 'skip';
    if (live) link = (await linkLiveness(s.sourceUrl)).status;
    report.push({ id: s.id, platform: s.platform, layer: s.layer, status: st, link });
    console.log(`[${s.id}] ${s.platform}/${s.layer} status=${st} link=${link}`);
  }
  console.log(`\n总计 ${report.length} 条；fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
