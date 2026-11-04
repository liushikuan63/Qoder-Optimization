/**
 * 数值平衡量化工具（自研，1.0.9 新增）
 *
 * 职责：用蒙特卡洛模拟对小游戏数值做**可量化验证**，输出分布 / EV / 百分位 / 趋势，
 *       供用户决策；**不自动改数值**（方法论工具，与 economy-balance.md 联动）。
 *
 * 三种模型（--model）：
 *  - drop       掉落表模拟：加权掉落率（观测 vs 期望）、95% 置信区间、EV。
 *  - economy    经济系统模拟：货币 source/sink 建模，通胀 / 紧缩 / 稳定判定 + sink 覆盖率。
 *  - difficulty 难度曲线模拟：玩家爬塔留存 / 流失，定位难度陡坡（最大流失关卡）。
 *
 * 设计边界（严格，禁止表面功能 / 弄虚作假）：
 *  - P0 输入契约（计划附录②）：必须提供 --in <file.json> 或 --data '<json>'；schema 按模型校验。
 *    无合法输入即 outputError 退出（exit 1），**绝不静默跑空、绝不伪造报告**。
 *  - --model 必填且 ∈ {drop,economy,difficulty}；--iter 默认 10000，须为正整数。
 *  - 种子 PRNG（mulberry32）保证可复现：同一输入 + 同种子 → 同结果（便于回归比对）。
 *  - 0 外部依赖：仅 node 内置模块；导出 simulate* / runBalance 供 balance-gate.mjs 复用，零重复逻辑。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';
const DEFAULT_SEED = 12345;
const SUPPORTED_MODELS = ['drop', 'economy', 'difficulty'];

const HELP = `小游戏数值平衡量化工具（${VERSION}）

用法:
  node scripts/balance-check.mjs --model <drop|economy|difficulty> --in <file.json> [--iter 10000] [--seed 12345] [--json]
  node scripts/balance-check.mjs --model <drop|economy|difficulty> --data '<json>' [--iter 10000] [--json]

必填:
  --model <name>   模拟模型：drop（掉落表）/ economy（经济系统）/ difficulty（难度曲线）
  --in <file>      输入 JSON 文件路径（schema 见下）；或 --data 内联 JSON

可选:
  --iter <N>       蒙特卡洛迭代次数（drop=抽取次数 / economy=模拟 tick 数 / difficulty=模拟玩家数），默认 10000
  --seed <N>       随机种子（可复现），默认 ${DEFAULT_SEED}
  --json           输出 JSON
  --help           显示本帮助

输入 schema（每种模型）:
  drop:    {"items":[{"id":"A","weight":10,"value"?:5}, ...]}            // weight 须 >0
  economy: {"start":1000,"sources":[{"name":"通关","perTick":120,"vol"?:5}],"sinks":[{"name":"抽卡","perTick":110,"vol"?:5}]}
  difficulty: {"curve":[{"level":1,"clearProb":0.85}, ...]}              // clearProb ∈ (0,1]

退出码:
  0  模拟完成并产出报告
  1  参数缺失 / 模型不支持 / 输入 schema 非法 / 文件不存在（绝不静默跑空）`;

// ---- 可复现 PRNG ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 标准正态（Box-Muller），使用给定 rng
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- 输入契约校验 ----

function loadInput(args, json) {
  let raw = null;
  let src = null;
  if (args.in) {
    const p = resolve(args.in);
    if (!existsSync(p)) outputError(`输入文件不存在: ${p}`, {}, json);
    try {
      raw = readFileSync(p, 'utf-8');
      src = p;
    } catch (e) {
      outputError(`读取输入文件失败: ${e && e.message ? e.message : e}`, {}, json);
    }
  } else if (args.data) {
    raw = String(args.data);
    src = 'inline';
  } else {
    outputError('缺少输入数据：必须提供 --in <file.json> 或 --data \'<json>\'（P0 输入契约，不静默跑空）', { hint: 'node scripts/balance-check.mjs --model drop --in ./balance-input.json' }, json);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    outputError(`输入 JSON 解析失败: ${e && e.message ? e.message : e}`, { source: src }, json);
  }
  return { parsed, src };
}

function validateDrop(input, json) {
  if (!input || typeof input !== 'object') return '输入根必须是对象';
  if (!Array.isArray(input.items) || input.items.length === 0) return 'drop 模型需要非空 items 数组';
  let total = 0;
  for (const it of input.items) {
    if (!it || typeof it.id !== 'string' || it.id.length === 0) return 'items[].id 必须是非空字符串';
    if (typeof it.weight !== 'number' || !isFinite(it.weight) || it.weight <= 0) return `items[].weight 必须是 >0 的有限数（id=${it.id}）`;
    if (it.value !== undefined && (typeof it.value !== 'number' || !isFinite(it.value))) return `items[].value 必须是有限数（id=${it.id}）`;
    total += it.weight;
  }
  if (!isFinite(total) || total <= 0) return 'items 权重之和必须为 >0 的有限数';
  return null;
}

function validateEconomy(input, json) {
  if (!input || typeof input !== 'object') return '输入根必须是对象';
  if (typeof input.start !== 'number' || !isFinite(input.start)) return 'economy 模型需要数值 start（初始余额）';
  if (!Array.isArray(input.sources)) return 'economy 模型需要 sources 数组';
  if (!Array.isArray(input.sinks)) return 'economy 模型需要 sinks 数组';
  for (const arr of [input.sources, input.sinks]) {
    for (const s of arr) {
      if (!s || typeof s.name !== 'string' || s.name.length === 0) return 'sources/sinks[].name 必须是非空字符串';
      if (typeof s.perTick !== 'number' || !isFinite(s.perTick)) return `sources/sinks[].perTick 必须是有限数（name=${s.name}）`;
      if (s.vol !== undefined && (typeof s.vol !== 'number' || !isFinite(s.vol) || s.vol < 0)) return `sources/sinks[].vol 必须 ≥0（name=${s.name}）`;
    }
  }
  return null;
}

function validateDifficulty(input, json) {
  if (!input || typeof input !== 'object') return '输入根必须是对象';
  if (!Array.isArray(input.curve) || input.curve.length === 0) return 'difficulty 模型需要非空 curve 数组';
  for (const lv of input.curve) {
    if (typeof lv.level !== 'number' || !isFinite(lv.level)) return 'curve[].level 必须是数值';
    if (typeof lv.clearProb !== 'number' || !isFinite(lv.clearProb) || lv.clearProb <= 0 || lv.clearProb >= 1) return `curve[].clearProb 必须 ∈ (0,1)（level=${lv.level}）`;
  }
  return null;
}

// ---- 模拟器（导出，供 balance-gate 复用） ----

export function simulateDrop(input, iter, rng) {
  const total = input.items.reduce((s, it) => s + it.weight, 0);
  const cum = [];
  let acc = 0;
  for (const it of input.items) {
    acc += it.weight / total;
    cum.push(acc);
  }
  const counts = new Array(input.items.length).fill(0);
  for (let i = 0; i < iter; i++) {
    const r = rng();
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r <= cum[mid]) hi = mid;
      else lo = mid + 1;
    }
    counts[lo]++;
  }
  const z = 1.96;
  const perItem = input.items.map((it, idx) => {
    const observed = counts[idx] / iter;
    const expected = it.weight / total;
    const se = Math.sqrt((expected * (1 - expected)) / iter);
    const ciLow = Math.max(0, observed - z * se);
    const ciHigh = Math.min(1, observed + z * se);
    const ev = it.value !== undefined ? observed * it.value : null;
    return {
      id: it.id,
      expected: round4(expected),
      observed: round4(observed),
      ci95: [round4(ciLow), round4(ciHigh)],
      within95: ciLow <= expected && expected <= ciHigh,
      ev: ev === null ? null : round4(ev),
    };
  });
  return { model: 'drop', pulls: iter, totalWeight: round4(total), items: perItem };
}

export function simulateEconomy(input, iter, rng) {
  const srcRate = input.sources.reduce((s, x) => s + x.perTick, 0);
  const sinkRate = input.sinks.reduce((s, x) => s + x.perTick, 0);
  const srcVol = Math.sqrt(input.sources.reduce((s, x) => s + (x.vol || 0) ** 2, 0));
  const sinkVol = Math.sqrt(input.sinks.reduce((s, x) => s + (x.vol || 0) ** 2, 0));
  const balances = new Array(iter + 1);
  balances[0] = input.start;
  let min = input.start;
  let max = input.start;
  for (let t = 1; t <= iter; t++) {
    const inflow = srcRate + (srcVol > 0 ? gaussian(rng) * srcVol : 0);
    const outflow = sinkRate + (sinkVol > 0 ? gaussian(rng) * sinkVol : 0);
    let b = balances[t - 1] + inflow - outflow;
    if (b < 0) b = 0; // 货币不为负
    balances[t] = b;
    if (b < min) min = b;
    if (b > max) max = b;
  }
  const final = balances[iter];
  const slope = iter > 0 ? (final - input.start) / iter : 0; // 每 tick 净变化（回归斜率近似）
  const sinkCoverage = srcRate > 0 ? round4(sinkRate / srcRate) : (sinkRate > 0 ? Infinity : 1);
  let classification;
  if (sinkCoverage < 0.999) classification = 'inflation'; // 流出 < 流入，货币膨胀
  else if (sinkCoverage > 1.001) classification = 'deflation'; // 流出 > 流入，货币紧缩
  else classification = 'stable';
  return {
    model: 'economy',
    ticks: iter,
    start: input.start,
    finalBalance: round2(final),
    minBalance: round2(min),
    maxBalance: round2(max),
    netPerTick: round4(srcRate - sinkRate),
    slopePerTick: round4(slope),
    sinkCoverage: sinkCoverage === Infinity ? 'inf' : sinkCoverage,
    classification,
    recommendation: classification === 'inflation'
      ? '货币膨胀：提升 sink（消耗）速率或降低 source，使 sinkCoverage 趋近 1'
      : classification === 'deflation'
        ? '货币紧缩：提升 source（产出）速率或降低 sink，使 sinkCoverage 趋近 1'
        : '货币供需平衡，维持当前 source/sink 比例',
  };
}

export function simulateDifficulty(input, iter, rng) {
  const curve = input.curve;
  const entered = new Array(curve.length);
  entered[0] = iter; // 所有玩家从第 1 关进入
  const perLevel = [];
  let spikeLevel = null;
  let spikeDrop = 0; // 单关流失占比最大值
  for (let i = 0; i < curve.length; i++) {
    const cum = entered[i] / iter; // 到达本关的玩家占比
    let cleared = 0;
    for (let k = 0; k < entered[i]; k++) {
      if (rng() <= curve[i].clearProb) cleared++;
    }
    const dropFrac = (entered[i] - cleared) / iter; // 在本关流失的玩家占比
    perLevel.push({
      level: curve[i].level,
      clearProb: round4(curve[i].clearProb),
      cumRetention: round4(cum),
      cumDrop: round4(dropFrac),
    });
    if (dropFrac > spikeDrop) {
      spikeDrop = dropFrac;
      spikeLevel = curve[i].level;
    }
    if (i + 1 < curve.length) entered[i + 1] = cleared;
  }
  const flag = spikeDrop > 0.15;
  return {
    model: 'difficulty',
    players: iter,
    perLevel,
    spikeLevel,
    spikeDrop: round4(spikeDrop),
    flag,
    recommendation: flag
      ? `第 ${spikeLevel} 关留存断崖（单关流失 ${round4(spikeDrop * 100)}%），建议下调该关 clearProb 或前置引导`
      : '难度曲线平滑，无显著断崖',
  };
}

export function runBalance({ model, input, iter = 10000, seed = DEFAULT_SEED }) {
  const rng = mulberry32(seed);
  if (model === 'drop') return simulateDrop(input, iter, rng);
  if (model === 'economy') return simulateEconomy(input, iter, rng);
  if (model === 'difficulty') return simulateDifficulty(input, iter, rng);
  throw new Error(`不支持的模型: ${model}`);
}

function round4(n) { return Math.round(n * 10000) / 10000; }
function round2(n) { return Math.round(n * 100) / 100; }

// ---- 主流程 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  const model = args.model;
  const iter = args.iter !== undefined ? Number(args.iter) : 10000;
  const seed = args.seed !== undefined ? Number(args.seed) : DEFAULT_SEED;

  if (!model) {
    outputError('缺少必填参数 --model（drop|economy|difficulty）', { hint: 'node scripts/balance-check.mjs --model drop --in ./input.json' }, json);
  }
  if (!SUPPORTED_MODELS.includes(model)) {
    outputError(`不支持的模型 "${model}"（仅 ${SUPPORTED_MODELS.join('/')}）`, {}, json);
  }
  if (!Number.isInteger(iter) || iter <= 0) {
    outputError(`--iter 必须是正整数（收到 ${args.iter}）`, {}, json);
  }
  if (!Number.isFinite(seed)) {
    outputError(`--seed 必须是有限数（收到 ${args.seed}）`, {}, json);
  }

  const { parsed } = loadInput(args, json);

  const validators = { drop: validateDrop, economy: validateEconomy, difficulty: validateDifficulty };
  const err = validators[model](parsed, json);
  if (err) {
    outputError(`输入 schema 校验失败（${model}）：${err}`, { model, schemaHint: HELP.split('输入 schema')[1] ? HELP.split('输入 schema')[1].split('\n\n')[0].trim() : undefined }, json);
  }

  const report = runBalance({ model, input: parsed, iter, seed });
  outputSuccess({ tool: 'balance-check', version: VERSION, model, iter, seed, report }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    outputError(`balance-check.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
  });
}
