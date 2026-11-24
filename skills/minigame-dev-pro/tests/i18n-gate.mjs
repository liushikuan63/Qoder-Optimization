/**
 * 出海本地化闸门（自研，1.1.0 新增）
 *
 * 职责：把 references/knowledge/operations/localization.md 的方法论落成可校验闸门。
 *  - 知识接线自检：localization.md 存在 + localize-check.mjs 语法 + SKILL.md 引用。
 *  - 项目模式（有 --project）：复用 scripts/localize-check.mjs 的 runLocalize 做真实校验——
 *      缺键 / 空值 / 疑似未翻译（值与默认语言相同）/ 跨语言敏感词预检命中。
 *  - 规格/资源缺失 → skip（不假 pass）；发现缺口/命中 → warn（exit 0，标未就绪），绝不标 pass。
 *
 * 设计边界：翻译是人文/专业服务属性，agent 不翻译、不生成文案。本闸门只做静态完整性信号，
 *           真机/母语审校由用户/专业服务完成。0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';
import { runLocalize } from '../scripts/localize-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const LOC_DOC = join(SKILL_ROOT, 'references', 'knowledge', 'operations', 'localization.md');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const LOC_TOOL = join(SKILL_ROOT, 'scripts', 'localize-check.mjs');

const HELP = `出海本地化闸门（1.1.0）

用法:
  node tests/i18n-gate.mjs                            # 自检：本地化子系统接线
  node tests/i18n-gate.mjs --project <路径> [--json]

必填（项目模式）:
  --project <path>   小游戏项目目录（自动探测 locales/ 或 i18n/ 下的 <lang>.json）

可选:
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 规格缺失（skip）/ 仅 warn 级缺口
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

  const opts = { defaultLocale: args.defaultLocale || 'zh' };
  if (args.locales) opts.locales = String(args.locales).split(',').map((s) => s.trim()).filter(Boolean);
  const result = runLocalize(absProject, opts);

  if (!result.found) {
    outputSuccess({
      mode: 'project',
      gate: 'skip',
      readyForRelease: false,
      found: false,
      detail: '未探测到 locale 目录（locales/ 或 i18n/ 下无 <lang>.json）；若项目需出海请先建立 i18n 资源，本闸门不假 pass。',
      note: '建议参考 localization.md 建立 i18n 资源与本地化流程。',
    }, json);
    return;
  }

  const failures = [];
  for (const m of result.missing) failures.push({ level: 'warn', category: 'missing', detail: `缺键：${m.locale} → ${m.key}` });
  for (const e of result.empty) failures.push({ level: 'warn', category: 'empty', detail: `空值：${e.locale} → ${e.key}` });
  for (const u of result.untranslated) failures.push({ level: 'warn', category: 'untranslated', detail: `疑似未翻译（与默认语言同值）：${u.locale} → ${u.key}` });
  for (const h of result.sensitiveHits) failures.push({ level: 'warn', category: 'sensitive', detail: `跨语言敏感词预检命中：${h.locale} → ${h.key} 含「${h.word}」（须人工复核，不直接判定违规）` });

  // 绝不标 pass：翻译是人文/专业服务属性，agent 不做翻译；真机/母语审校由用户/专业服务完成。
  const gate = failures.length ? 'warn' : 'skip';

  let note;
  if (failures.length) note = `发现 ${failures.length} 处本地化缺口/命中（warn，非阻断）；补齐后重跑。`;
  else note = '本地化资源完整（静态检查通过），但真机/母语审校由用户/专业服务完成，故不标 pass。';

  outputSuccess({
    mode: 'project',
    gate,
    readyForRelease: false,
    found: true,
    defaultLocale: result.defaultLocale,
    locales: result.locales,
    summary: result.summary,
    failures,
    note,
  }, json);
}

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];
  const docExists = existsSync(LOC_DOC);
  checks.push({ name: 'localization.md', exists: docExists, syntaxOk: docExists, detail: docExists ? '本地化方法论文档存在' : '文档缺失' });
  const toolSyntax = runCheck(LOC_TOOL);
  checks.push({ name: 'localize-check.mjs 语法', exists: existsSync(LOC_TOOL), syntaxOk: toolSyntax.ok, syntaxErr: toolSyntax.err });
  const docWired = docExists && docReferences();
  const docNote = docWired ? 'SKILL.md 已引用 localization.md' : '提示：SKILL.md 未引用 localization.md（建议补）';
  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(`本地化子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文档缺失)')).join('；')}`, { mode: 'self-check', checks, docNote }, json);
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
  try { return readFileSync(SKILL_MD, 'utf-8').includes('localization.md'); } catch { return false; }
}

main().catch((e) => {
  outputError(`i18n-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
