/**
 * 数值平衡阈值闸门（自研，1.0.9 新增）
 *
 * 职责：把 balance-check.mjs 的蒙特卡洛报告与**用户定义的平衡规格阈值**比对，
 *       判定数值是否通过闸门。复用 balance-check.mjs 的 runBalance（零重复逻辑）。
 *
 * 两种模式：
 *  - 无 --project：自检模式——验证 balance-check.mjs 存在、语法、runBalance 导出可用。
 *  - 有 --project：项目闸门——读取 <project>/production/balance-spec.json（或 <project>/balance-spec.json）。
 *      · 规格缺失 → gate:'skip'（warn，提示先跑 balance-check 生成规格），不假 pass。
 *      · 规格存在 → 跑模拟 + 阈值比对；越阈值 = 硬失败 exit 1；全通过 = pass exit 0。
 *
 * 阈值 schema（balance-spec.json）：
 *  {"model":"drop","input":{...},"thresholds":{"maxRateDeviation":0.05}}
 *  {"model":"economy","input":{...},"thresholds":{"maxAbsSlope":0.05,"requireStable":false}}
 *  {"model":"difficulty","input":{...},"thresholds":{"maxSpikeDrop":0.15}}
 *
 * 设计边界：本闸门只读规格 + 调用模拟，不写数值；绝不假 pass（规格缺/越阈均不标 pass）。
 * 0 外部依赖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { runBalance } from '../scripts/balance-check.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const BALANCE_SCRIPT = join(SKILL_ROOT, 'scripts', 'balance-check.mjs');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');

const HELP = `数值平衡阈值闸门

用法:
  node tests/balance-gate.mjs                              # 自检：平衡子系统接线是否健康
  node tests/balance-gate.mjs --project <路径> [--json] [--seed 12345]

必填（项目模式）:
  --project <path>   小游戏项目目录（内含 production/balance-spec.json 或 balance-spec.json）

可选:
  --seed <N>         随机种子（须与规格生成时一致以复现），默认 12345
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 规格缺失（skip，warn）/ 阈值全通过（pass）
  1  自检损坏 / 数值越阈值（硬失败）`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  const seed = args.seed !== undefined ? Number(args.seed) : 12345;

  if (!args.project) {
    await selfCheck(json);
    return;
  }

  const absProject = resolve(args.project);
  if (!existsSync(absProject)) {
    outputError(`项目路径不存在: ${absProject}`, {}, json);
  }

  const spec = findSpec(absProject);
  if (!spec) {
    outputSuccess({
      mode: 'project',
      gate: 'skip',
      passed: false,
      readyForRelease: false,
      detail: '未配置数值平衡规格（balance-spec.json）；建议先跑 balance-check.mjs 生成规格与阈值后再门控。',
      hint: 'node scripts/balance-check.mjs --model drop --in ./balance-input.json --json',
    }, json);
    return;
  }

  const model = spec.model;
  if (!['drop', 'economy', 'difficulty'].includes(model)) {
    outputError(`balance-spec.json model 非法: "${model}"（仅 drop/economy/difficulty）`, { specPath: spec.path }, json);
  }

  let report;
  try {
    report = runBalance({ model, input: spec.input, iter: spec.iter || 10000, seed });
  } catch (e) {
    outputError(`运行平衡模拟失败: ${e && e.message ? e.message : e}`, { specPath: spec.path }, json);
  }

  const violations = compareThresholds(report, spec.thresholds || {});
  if (violations.length) {
    outputError(
      `数值平衡闸门未通过（${violations.length} 项越阈）：${violations.join('；')}`,
      { mode: 'project', gate: 'fail', model, specPath: spec.path, violations },
      json,
    );
  }

  outputSuccess({
    mode: 'project',
    gate: 'pass',
    model,
    specPath: spec.path,
    summary: report.recommendation || '数值在阈值内',
    report,
  }, json);
}

function findSpec(absProject) {
  const candidates = [
    join(absProject, 'production', 'balance-spec.json'),
    join(absProject, 'balance-spec.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const txt = readFileSync(c, 'utf-8');
        const parsed = JSON.parse(txt);
        if (!parsed.model || !parsed.input) return null;
        return { path: c, ...parsed };
      } catch { return null; }
    }
  }
  return null;
}

function compareThresholds(report, thresholds) {
  const v = [];
  if (report.model === 'drop') {
    const maxDev = typeof thresholds.maxRateDeviation === 'number' ? thresholds.maxRateDeviation : 0.05;
    for (const it of report.items) {
      const dev = Math.abs(it.observed - it.expected);
      if (dev > maxDev) v.push(`item=${it.id} 掉落率偏差 ${round4(dev)} > 阈值 ${maxDev}（观测 ${it.observed} / 期望 ${it.expected}）`);
    }
  } else if (report.model === 'economy') {
    const maxSlope = typeof thresholds.maxAbsSlope === 'number' ? thresholds.maxAbsSlope : 0.05;
    const rel = report.start !== 0 ? Math.abs(report.slopePerTick) / Math.abs(report.start) : 0;
    if (rel > maxSlope) v.push(`每 tick 净变化斜率 ${round4(report.slopePerTick)}（相对 ${round4(rel)}）> 阈值 ${maxSlope}`);
    if (thresholds.requireStable && report.classification !== 'stable') v.push(`经济判定=${report.classification}（requireStable=true 要求 stable）`);
  } else if (report.model === 'difficulty') {
    const maxDrop = typeof thresholds.maxSpikeDrop === 'number' ? thresholds.maxSpikeDrop : 0.15;
    if (report.spikeDrop > maxDrop) v.push(`难度断崖在第 ${report.spikeLevel} 关，单关流失 ${round4(report.spikeDrop)} > 阈值 ${maxDrop}`);
  }
  return v;
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];
  checks.push(fileCheck('balance-check.mjs', BALANCE_SCRIPT));
  for (const c of checks.filter((x) => x.exists)) {
    const r = runCheck(c.path);
    c.syntaxOk = r.ok;
    c.syntaxErr = r.err;
  }
  const exportCheck = await verifyExports();
  checks.push({ name: 'exports', exists: true, syntaxOk: exportCheck.ok, syntaxErr: exportCheck.err, detail: exportCheck.detail });
  const docWired = docReferences(BALANCE_SCRIPT);
  const docNote = docWired ? 'SKILL.md 已引用 balance-check.mjs' : '提示：SKILL.md 未引用 balance-check.mjs（建议补）';
  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(`平衡子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文件缺失)')).join('；')}`, { mode: 'self-check', checks, docNote }, json);
  }
  outputSuccess({ mode: 'self-check', healthy: true, checks: checks.map((c) => ({ name: c.name, exists: c.exists, syntaxOk: c.syntaxOk, detail: c.detail })), docNote }, json);
}

function fileCheck(name, path) { return { name, path, exists: existsSync(path) }; }

function runCheck(path) {
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    return { ok: true, err: null };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.stdout || e.message || '').toString().slice(0, 300) };
  }
}

async function verifyExports() {
  try {
    const b = await import(pathToFileURL(BALANCE_SCRIPT).href);
    const ok = typeof b.runBalance === 'function';
    return { ok, err: ok ? null : '缺少 runBalance 导出', detail: ok ? 'runBalance 可用（复用模拟逻辑，零重复）' : '导出缺失' };
  } catch (err) {
    return { ok: false, err: (err && err.message ? err.message : String(err)).slice(0, 300), detail: '动态 import 失败' };
  }
}

function docReferences(scriptPath) {
  if (!existsSync(SKILL_MD)) return false;
  try {
    const txt = readFileSync(SKILL_MD, 'utf-8');
    return txt.includes(scriptPath.split(/[\\/]/).pop());
  } catch { return false; }
}

main().catch((e) => {
  outputError(`balance-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
