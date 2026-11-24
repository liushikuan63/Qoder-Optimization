/**
 * 发行复盘清单闸门（自研，1.1.0 新增）
 *
 * 职责：把 references/knowledge/operations/release-ops.md 的方法论落成可校验闸门。
 *  - 知识接线自检：release-ops.md 存在 + release-gate.mjs 语法 + SKILL.md 引用。
 *  - 项目模式（有 --project）：复用 scripts/release-gate.mjs 的 runReleaseGate 做真实校验——
 *      生产/release-checklist.md 是否含 上线前 / 热更 / 复盘 / 合规沟通 四节。
 *  - 清单缺失 → skip；清单存在但缺章节 → warn；完整 → skip（绝不标 pass，官方审核不在 agent 范围）。
 *
 * 设计边界：复盘内容由人工/运营填写；本闸门只校验清单章节完整性，代表流程闭环就绪，
 *           不标"已通过官方审核"。0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';
import { runReleaseGate } from '../scripts/release-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const RELEASE_DOC = join(SKILL_ROOT, 'references', 'knowledge', 'operations', 'release-ops.md');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const RELEASE_TOOL = join(SKILL_ROOT, 'scripts', 'release-gate.mjs');

const HELP = `发行复盘清单闸门（1.1.0）

用法:
  node tests/release-gate.mjs                          # 自检：发行复盘子系统接线
  node tests/release-gate.mjs --project <路径> [--json]

必填（项目模式）:
  --project <path>   小游戏项目目录（默认探测 production/release-checklist.md 或 release-checklist.md）

可选:
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 清单缺失（skip）/ 完整或缺章节（skip/warn）
  1  自检损坏（文档缺失或工具语法错误）`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;

  if (!args.project) {
    await selfCheck(json);
    return;
  }

  const absProject = resolve(args.project);
  if (!existsSync(absProject)) outputError(`项目路径不存在: ${absProject}`, {}, json);

  const result = runReleaseGate(absProject, { checklist: args.checklist });

  if (!result.found) {
    outputSuccess({
      mode: 'project',
      gate: 'skip',
      readyForRelease: false,
      found: false,
      missing: result.missing,
      detail: '未找到发行复盘清单（production/release-checklist.md）；建议参考 release-ops.md 建立四节清单，本闸门不假 pass。',
      note: '建议参考 release-ops.md 建立上线前/热更/复盘/合规沟通四节清单。',
    }, json);
    return;
  }

  const gate = result.complete ? 'skip' : 'warn';
  const note = result.complete
    ? '发行复盘清单完整（上线前/热更/复盘/合规沟通）；清单齐备仅代表流程闭环就绪，不标"已通过官方审核"。'
    : `清单存在但缺章节：${result.missing.join('、')}；补齐后重跑。`;

  outputSuccess({
    mode: 'project',
    gate,
    readyForRelease: false,
    found: true,
    present: true,
    complete: result.complete,
    missing: result.missing,
    note,
  }, json);
}

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];
  const docExists = existsSync(RELEASE_DOC);
  checks.push({ name: 'release-ops.md', exists: docExists, syntaxOk: docExists, detail: docExists ? '发行运营方法论文档存在' : '文档缺失' });
  const toolSyntax = runCheck(RELEASE_TOOL);
  checks.push({ name: 'release-gate.mjs 语法', exists: existsSync(RELEASE_TOOL), syntaxOk: toolSyntax.ok, syntaxErr: toolSyntax.err });
  const docWired = docExists && docReferences();
  const docNote = docWired ? 'SKILL.md 已引用 release-ops.md' : '提示：SKILL.md 未引用 release-ops.md（建议补）';
  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(`发行复盘子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文档缺失)')).join('；')}`, { mode: 'self-check', checks, docNote }, json);
  }
  outputSuccess({ mode: 'self-check', healthy: true, checks: checks.map((c) => ({ name: c.name, exists: c.exists, syntaxOk: c.syntaxOk, detail: c.detail })), docNote }, json);
}

function runCheck(path) {
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    return { ok: true, err: null };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.stdout || e.message || '').toString().slice(0, 300) };
  }
}

function docReferences() {
  if (!existsSync(SKILL_MD)) return false;
  try { return readFileSync(SKILL_MD, 'utf-8').includes('release-ops.md'); } catch { return false; }
}

main().catch((e) => {
  outputError(`release-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
