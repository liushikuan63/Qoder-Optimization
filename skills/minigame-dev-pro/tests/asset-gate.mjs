/**
 * 资产规格合规闸门（自研，1.1.0 新增）
 *
 * 职责：把 references/knowledge/art-audio/asset-pipeline.md 的方法论落成可校验闸门。
 *  - 知识接线自检：asset-pipeline.md 存在 + asset-audit.mjs 语法 + SKILL.md 引用。
 *  - 项目模式（有 --project）：复用 scripts/asset-audit.mjs 的 runAssetAudit 做真实校验——
 *      命名/格式/尺寸 warn；未授权 IP 命中（硬违规）fail（exit 1，交人工确权）。
 *  - 资产目录缺失 → skip（不假 pass）；仅 warn 级问题 → warn（exit 0）；有硬违规 → fail（exit 1）。
 *
 * 设计边界：资产生产（生图/生音频）是算力 + 平台工具属性，agent 不在本地跑 ML（与"本地 ComfyUI 生图作废"
 *           纪律一致）；本闸门只验证"资产规格 + 授权声明"是否齐备。0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';
import { runAssetAudit } from '../scripts/asset-audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const ASSET_DOC = join(SKILL_ROOT, 'references', 'knowledge', 'art-audio', 'asset-pipeline.md');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const ASSET_TOOL = join(SKILL_ROOT, 'scripts', 'asset-audit.mjs');

const HELP = `资产规格合规闸门（1.1.0）

用法:
  node tests/asset-gate.mjs                            # 自检：资产子系统接线
  node tests/asset-gate.mjs --project <路径> [--assets <dir>] [--json]

必填（项目模式）:
  --project <path>   小游戏项目目录（自动探测 assets/ 或 res/ 或 src/assets/）

可选:
  --assets <dir>     直接指定资产目录
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 资产目录缺失（skip）/ 仅 warn 级问题
  1  自检损坏（文档缺失或工具语法错误） / 项目模式命中未授权 IP 硬违规`;

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

  const opts = {};
  if (args.assets) opts.assets = args.assets;
  const result = runAssetAudit(absProject, opts);

  if (!result.found) {
    outputSuccess({
      mode: 'project',
      gate: 'skip',
      readyForRelease: false,
      found: false,
      detail: '未探测到资产目录（assets/ 或 res/ 或 src/assets/）；若项目含美术/音频/字体资产请先建立资产目录与 asset-spec.json，本闸门不假 pass。',
      note: '建议参考 asset-pipeline.md 建立资产规格与授权声明工作流。',
    }, json);
    return;
  }

  const violations = result.assets.filter((a) => a.issues.some((i) => i.level === 'violation'));
  const warns = result.assets.filter((a) => a.issues.some((i) => i.level === 'warn'));

  if (violations.length) {
    outputError('资产规格命中硬违规（未授权 IP 线索）', {
      mode: 'project',
      gate: 'fail',
      readyForRelease: false,
      found: true,
      summary: result.summary,
      violations: violations.map((a) => ({ file: a.file, issues: a.issues.filter((i) => i.level === 'violation') })),
      note: '未授权 IP 命中须人工确权授权，禁止未授权商用；确权前不可发布。',
    }, json);
    return;
  }

  // 无硬违规：仅 warn（命名/格式/尺寸/授权声明）或干净（仍不假 pass）。
  const gate = warns.length ? 'warn' : 'skip';
  const failures = warns.flatMap((a) => a.issues.filter((i) => i.level === 'warn').map((i) => ({ level: 'warn', file: a.file, detail: i.detail })));
  const note = warns.length
    ? `审计完成，${warns.length} 个资产有 warn 级问题（命名/格式/尺寸/授权声明），不阻断但建议补齐。`
    : '资产规格合规（静态检查通过，无硬违规），但资产授权确权与真机表现由用户/专业服务完成，故不标 pass。';

  outputSuccess({
    mode: 'project',
    gate,
    readyForRelease: false,
    found: true,
    summary: result.summary,
    warnCount: warns.length,
    failures,
    note,
  }, json);
}

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];
  const docExists = existsSync(ASSET_DOC);
  checks.push({ name: 'asset-pipeline.md', exists: docExists, syntaxOk: docExists, detail: docExists ? '资产方法论文档存在' : '文档缺失' });
  const toolSyntax = runCheck(ASSET_TOOL);
  checks.push({ name: 'asset-audit.mjs 语法', exists: existsSync(ASSET_TOOL), syntaxOk: toolSyntax.ok, syntaxErr: toolSyntax.err });
  const docWired = docExists && docReferences();
  const docNote = docWired ? 'SKILL.md 已引用 asset-pipeline.md' : '提示：SKILL.md 未引用 asset-pipeline.md（建议补）';
  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(`资产子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文档缺失)')).join('；')}`, { mode: 'self-check', checks, docNote }, json);
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
  try { return readFileSync(SKILL_MD, 'utf-8').includes('asset-pipeline.md'); } catch { return false; }
}

main().catch((e) => {
  outputError(`asset-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
