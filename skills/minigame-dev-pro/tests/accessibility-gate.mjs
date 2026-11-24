/**
 * 无障碍合规闸门（自研，1.0.9 新增）
 *
 * 职责：把 references/knowledge/compliance/accessibility.md 的方法论落成可校验闸门。
 *  - 知识接线自检：accessibility.md 存在 + 本脚本语法。
 *  - 项目模式（有 --project）：做两道真实检查——
 *      1) 色觉风险扫描：项目源码/样式中是否以纯红(#FF0000)/纯绿(#00FF00)等作为**唯一**状态区分（色盲风险）。
 *      2) 无障碍清单章节检查：production/accessibility-checklist.md（若存在）是否含 5 类必需章节。
 *  - 规格/证据缺失 → warn（skip），不假 pass；发现风险 → warn（exit 0，标未就绪），绝不标 pass。
 *
 * 设计边界：无障碍是设计层属性，agent 不做渲染判定；本闸门只做静态信号 + 方法论存在性检查，
 *           真机无障碍验证由用户/专业服务完成。0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const ACCESS_DOC = join(SKILL_ROOT, 'references', 'knowledge', 'compliance', 'accessibility.md');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');

const REQUIRED_SECTIONS = ['色觉', '听觉', '运动', '认知', '适老化'];
const COLOR_RISK = [/#ff0000\b/i, /#00ff00\b/i, /rgb\(\s*255\s*,\s*0\s*,\s*0\s*\)/i, /rgb\(\s*0\s*,\s*255\s*,\s*0\s*\)/i];
const SCAN_EXT = ['.css', '.js', '.ts', '.json', '.wxml', '.wxss', '.html'];
const SCAN_CAP = 300;

const HELP = `无障碍合规闸门

用法:
  node tests/accessibility-gate.mjs                          # 自检：无障碍子系统接线
  node tests/accessibility-gate.mjs --project <路径> [--json]

必填（项目模式）:
  --project <path>   小游戏项目目录

可选:
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 规格缺失（skip）/ 仅 warn 级风险
  1  自检损坏（文档缺失或语法错误）`;

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

  const colorHits = scanColorRisk(absProject);
  const checklist = checkChecklist(absProject);

  const failures = [];
  for (const h of colorHits) {
    failures.push({ level: 'warn', category: 'colorblind', detail: `色觉风险：${h.file} 含纯红/纯绿字面（建议补充文字/图标区分）` });
  }
  if (checklist.present && !checklist.complete) {
    failures.push({ level: 'warn', category: 'checklist', detail: `无障碍清单缺章节：${checklist.missing.join('、')}`, missing: checklist.missing });
  }

  // 绝不标 pass：无障碍是设计层属性，agent 不做渲染判定；真机验证由用户/专业服务完成。
  // 本闸门最佳结果只能是 'skip'（静态信号干净但真机验证待补），发现风险则 'warn'。
  const gate = failures.length ? 'warn' : 'skip';

  let note;
  if (failures.length) {
    note = '发现无障碍风险（warn，非阻断）；补齐后重跑。';
  } else if (!checklist.present && colorHits.length === 0) {
    note = '项目无可扫描资源且无无障碍清单；建议参考 accessibility.md 补充 production/accessibility-checklist.md。';
  } else {
    note = '无障碍静态检查通过（清单完整且无色盲字面），但真机无障碍验证由用户/专业服务完成，故不标 pass。';
  }

  outputSuccess({
    mode: 'project',
    gate,
    readyForRelease: false,
    colorblindHits: colorHits.length,
    colorblindSamples: colorHits.slice(0, 10),
    checklist: { present: checklist.present, complete: checklist.complete, missing: checklist.missing },
    failures,
    note,
  }, json);
}

function scanColorRisk(absProject) {
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    if (hits.length >= 50 || scanned >= SCAN_CAP) return;
    let list;
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (scanned >= SCAN_CAP) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '.workbuddy', 'dist', 'build'].includes(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        scanned++;
        const ext = '.' + (e.name.split('.').pop() || '').toLowerCase();
        if (!SCAN_EXT.includes(ext)) continue;
        let txt;
        try { txt = readFileSync(full, 'utf-8'); } catch { continue; }
        if (COLOR_RISK.some((re) => re.test(txt))) {
          hits.push({ file: relative(absProject, full) });
        }
      }
    }
  };
  walk(absProject);
  return hits;
}

function checkChecklist(absProject) {
  const candidates = [
    join(absProject, 'production', 'accessibility-checklist.md'),
    join(absProject, 'accessibility-checklist.md'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const txt = readFileSync(c, 'utf-8');
      const missing = REQUIRED_SECTIONS.filter((s) => !txt.includes(s));
      return { present: true, complete: missing.length === 0, missing };
    }
  }
  return { present: false, complete: false, missing: REQUIRED_SECTIONS };
}

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];
  const docExists = existsSync(ACCESS_DOC);
  checks.push({ name: 'accessibility.md', exists: docExists, syntaxOk: docExists, detail: docExists ? '无障碍方法论文档存在' : '文档缺失' });
  const syntax = runCheck(process.argv[1]);
  checks.push({ name: 'accessibility-gate.mjs 语法', exists: true, syntaxOk: syntax.ok, syntaxErr: syntax.err });
  const docWired = docExists && docReferences();
  const docNote = docWired ? 'SKILL.md 已引用 accessibility.md' : '提示：SKILL.md 未引用 accessibility.md（建议补）';
  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(`无障碍子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文档缺失)')).join('；')}`, { mode: 'self-check', checks, docNote }, json);
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
  try { return readFileSync(SKILL_MD, 'utf-8').includes('accessibility.md'); } catch { return false; }
}

main().catch((e) => {
  outputError(`accessibility-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
