/**
 * 本地轻量 CI 等价物（自研，1.1.0 新增）
 *
 * 职责：对标头部 CI Pipeline 思想，但**只做本地脚本、不建 GitHub Actions 服务器**。
 *       在提交/构建前跑一遍：① 全量 .mjs 语法检查；② 运行确定性质量闸门（不含需联网的 link-audit）。
 *       任一失败即 exit 1，作为本地 pre-commit / 构建校验等价物。
 *
 * 边界（human-in-the-loop）：
 *  - 只跑确定性、可离线执行的检查；link-audit（官方链接探活）需联网，交 CI 服务器或人工，本地不阻断。
 *  - 不替代平台官方面审/构建；真正的 Cocos/微信构建与运行依赖用户本地已装编辑器/CLI（缺失则降级提示）。
 *
 * 0 外部依赖。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';
const HELP = `本地轻量 CI 等价物（${VERSION}）

用法:
  node scripts/ci-local.mjs [--project <路径>] [--json]

可选:
  --project <path>   若提供，额外对项目跑项目级闸门（balance-gate/accessibility-gate/i18n-gate/asset-gate/release-gate）
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  全部确定性检查通过
  1  任一检查失败`;

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 确定性闸门（不含 link-audit，因其需联网）
const DETERMINISTIC_GATES = [
  'consistency-check', 'internal-consistency', 'freshness-gate', 'sensitive-word-gate',
  'ad-law-gate', 'ip-compliance-check', 'map-territory-check', 'scaffold-smoke',
  'qa-gate', 'balance-gate', 'accessibility-gate', 'i18n-gate', 'asset-gate', 'release-gate',
];

function syntaxCheckAll() {
  const dirs = [join(SKILL_ROOT, 'scripts'), join(SKILL_ROOT, 'tests')];
  const bad = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.mjs')) continue;
      try { execFileSync(process.execPath, ['--check', join(d, f)], { stdio: 'pipe' }); }
      catch (e) { bad.push(`${f}: ${(e.stderr || e.stdout || '').toString().split('\n')[0]}`); }
    }
  }
  return bad;
}

function runGate(name, projectArg) {
  const argv = [join(SKILL_ROOT, 'tests', `${name}.mjs`)];
  if (projectArg) argv.push('--project', projectArg);
  try {
    execFileSync(process.execPath, argv, { stdio: 'pipe' });
    return { name, ok: true };
  } catch {
    return { name, ok: false };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  const projectArg = args.project ? resolve(args.project) : null;
  if (projectArg && !existsSync(projectArg)) outputError(`--project 路径不存在: ${projectArg}`, {}, json);

  const syntaxBad = syntaxCheckAll();
  const gateResults = DETERMINISTIC_GATES.map((g) => runGate(g, projectArg));
  const failedGates = gateResults.filter((g) => !g.ok).map((g) => g.name);

  const allOk = syntaxBad.length === 0 && failedGates.length === 0;
  if (!allOk) {
    outputError('本地 CI 校验未通过', {
      syntaxErrors: syntaxBad,
      failedGates,
      hint: '修复后重跑；link-audit 需联网不在此本地校验范围。',
    }, json);
  }
  outputSuccess({
    tool: 'ci-local',
    version: VERSION,
    syntax: { checked: syntaxBad.length === 0, errors: syntaxBad },
    gates: { total: gateResults.length, passed: gateResults.length - failedGates.length, failed: failedGates },
    projectMode: !!projectArg,
    note: '本地确定性检查全部通过；link-audit（联网）与平台官方面审/构建不在此范围。',
  }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => outputError(`ci-local.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false));
}
