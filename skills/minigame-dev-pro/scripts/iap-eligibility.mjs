#!/usr/bin/env node
// iap-eligibility.mjs — 资质/变现可达性唯一机器权威（1.0.8）
// 输入主体类型 + 变现模式 + 平台 → 输出必办资质 / 流量主可达性 / 虚拟支付能力。
// 替代"第6引擎 md"，被 compliance-scan / readiness-check 调用（import 或 CLI）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(__dirname, '..', 'references', 'data', 'spec-registry.json');
const PLATFORMS = path.join(__dirname, '..', 'references', 'data', 'platforms.json');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 软著强制矩阵（platform × monetization）：required / self-declaration / pending
const SOFT_COPYRIGHT = {
  wechat: { iaa: 'self-declaration', iap: 'required' },
  douyin: { iaa: 'required', iap: 'required' },
  qq: 'pending', kuaishou: 'pending', alipay: 'pending', baidu: 'pending', taobao: 'pending', qgame: 'pending',
};

// 流量主主体闸门：个人不可
const TRAFFIC_MASTER_BLOCKED_SUBJECT = ['personal'];

export function evaluate({ platform = 'wechat', subject = 'enterprise', monetization = 'iaa' } = {}) {
  const reg = loadJson(REGISTRY);
  const plat = loadJson(PLATFORMS);
  const sc = SOFT_COPYRIGHT[platform];
  let softCopyright = 'pending';
  if (typeof sc === 'object') softCopyright = sc[monetization] || 'pending';
  else if (sc === 'pending') softCopyright = 'pending';

  const trafficMasterBlocked = TRAFFIC_MASTER_BLOCKED_SUBJECT.includes(subject);
  const virtualPayment = platform === 'wechat'
    ? { android: true, ios: false, api: 'wx.requestMidasPayment' }
    : { android: 'pending', ios: 'pending', api: 'pending-verify' };

  return {
    platform,
    subject,
    monetization,
    softCopyright, // required / self-declaration / pending
    versionNumber: monetization === 'iaa' ? 'not-required' : 'required',
    trafficMaster: trafficMasterBlocked ? 'blocked-personal' : 'available',
    virtualPayment,
    note: 'IOS 虚拟支付以官方小游戏文档为准；Tier-2/3 平台值为 pending-verify，须执行期核实。',
  };
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const result = evaluate({
    platform: get('--platform') || 'wechat',
    subject: get('--subject') || 'enterprise',
    monetization: get('--monetization') || 'iaa',
  });
  console.log(JSON.stringify(result, null, 2));
}

// CLI 模式（有参数时运行），被 import 时仅导出 evaluate
if (process.argv.length > 2) main();
