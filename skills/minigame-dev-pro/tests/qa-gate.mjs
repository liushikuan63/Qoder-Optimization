/**
 * 小游戏专用 QA 验证闸门（自研，1.0.7 新增）
 *
 * 职责：在"构建 → 出包 → 真机"链路的末端做一道发布闸门：
 *  - 结构合法（game.json + game.js，minigame）
 *  - 包体预算（复用 build.mjs 的 auditBudget，按平台读 platforms.json；超预算=硬失败）
 *  - 运行时可玩性证据完整度（复用 playtest-evidence.mjs 的 classifyCompleteness；缺失=warn，不阻断但标非就绪）
 *
 * 两种模式：
 *  - 无 --project：自检模式——确认 QA 子系统已正确接线（build.mjs / playtest-evidence.mjs
 *    存在、语法通过、关键导出函数可用）。接线损坏则硬失败 exit 1；健康则 exit 0。
 *  - 有 --project：项目闸门——结构/预算违规=硬失败 exit 1；证据不完整=warn（exit 0，
 *    readyForRelease:false，但 gate 绝不标 'pass'，杜绝"假通过"）；全通过=pass exit 0。
 *
 * 设计边界：本闸门只读（不组装包、不写证据），全部基于 build.mjs / playtest-evidence.mjs
 * 的纯函数，零重复逻辑。0 外部依赖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { detectProject } from '../scripts/lib/project-detector.mjs';
import { auditBudget, loadPlatforms } from '../scripts/build.mjs';
import { collectEvidence, classifyCompleteness } from '../scripts/playtest-evidence.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from '../scripts/lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const BUILD_SCRIPT = join(SKILL_ROOT, 'scripts', 'build.mjs');
const EVIDENCE_SCRIPT = join(SKILL_ROOT, 'scripts', 'playtest-evidence.mjs');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const SUPPORTED_PLATFORMS = ['wechat', 'douyin'];

const HELP = `小游戏 QA 验证闸门

用法:
  node tests/qa-gate.mjs                       # 自检：QA 子系统接线是否健康
  node tests/qa-gate.mjs --project <路径> --platform <wechat|douyin> [--json]

必填（项目模式）:
  --project <path>   小游戏项目目录
  --platform <name>  目标平台 wechat | douyin

可选:
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  自检健康 / 项目闸门 pass / 仅 warn 级（证据不完整，非阻断）
  1  自检损坏 / 结构非法 / 包体超预算（硬失败）`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;

  if (!args.project) {
    await selfCheck(json);
    return;
  }

  const projectPath = args.project;
  const platform = args.platform;
  if (!platform) {
    outputError('项目模式缺少 --platform（wechat|douyin）', { hint: 'node tests/qa-gate.mjs --project <路径> --platform wechat' }, json);
  }
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    outputError(`当前仅支持 wechat/douyin 闸门；平台 "${platform}" 预算未核实。`, {}, json);
  }
  const absProject = resolve(projectPath);
  if (!existsSync(absProject)) {
    outputError(`项目路径不存在: ${absProject}`, {}, json);
  }

  const failures = [];

  // 1) 结构
  const detection = detectProject(absProject);
  if (!detection.valid || detection.type !== 'minigame') {
    failures.push({
      level: 'error',
      category: 'structure',
      detail: detection.errors.length ? detection.errors.join('；') : `类型=${detection.type}（需 minigame）`,
    });
  }

  // 2) 包体预算（仅当结构合法时才有意义；结构非法时跳过以免噪声）
  let budgetReport = null;
  if (detection.valid && detection.type === 'minigame') {
    const platforms = loadPlatforms();
    const pmeta = platforms[platform];
    if (!pmeta || !pmeta.packageLimitMB || typeof pmeta.packageLimitMB !== 'object') {
      failures.push({ level: 'error', category: 'budget', detail: `平台 "${platform}" 包体预算未核实（platforms.json pending-verify）` });
    } else {
      budgetReport = auditBudget(absProject, detection, pmeta.packageLimitMB, platform);
      if (budgetReport.status !== 'ok') {
        failures.push({ level: 'error', category: 'budget', detail: budgetReport.summary });
      }
    }
  }

  // 3) 运行时可玩性证据
  const evidence = collectEvidence(absProject);
  const cls = classifyCompleteness(evidence);
  if (cls.completeness !== 'complete') {
    failures.push({
      level: 'warn',
      category: 'evidence',
      detail: `运行时证据不完整（${cls.completeness}），缺失：${cls.missing.join('、')}`,
      missing: cls.missing,
    });
  }

  const hasHard = failures.some((f) => f.level === 'error');
  const gate = hasHard ? 'fail' : (failures.length ? 'warn' : 'pass');
  const readyForRelease = gate === 'pass';

  if (gate === 'pass') {
    outputSuccess({
      mode: 'project',
      platform,
      gate: 'pass',
      readyForRelease: true,
      structure: { valid: true, type: detection.type, engine: detection.info.engine },
      budget: budgetReport ? { status: budgetReport.status, mainMB: budgetReport.mainMB, totalMB: budgetReport.totalMB } : null,
      evidence: { completeness: cls.completeness, presentCount: cls.presentCount },
      failures: [],
    }, json);
  } else {
    // 硬失败 exit 1；仅 warn 级（证据不完整）exit 0，但绝不标 pass
    const exitCode = hasHard ? 1 : 0;
    if (exitCode === 1) {
      outputError(
        `QA 闸门未通过（${gate}）：${failures.map((f) => `[${f.level}] ${f.category}: ${f.detail}`).join('；')}`,
        { mode: 'project', platform, gate, readyForRelease, failures },
        json,
      );
    }
    // warn 级：以成功退出码返回结构化结果（gate=warn，非 pass）
    outputSuccess({
      mode: 'project',
      platform,
      gate: 'warn',
      readyForRelease: false,
      structure: { valid: detection.valid, type: detection.type, engine: detection.info.engine },
      budget: budgetReport ? { status: budgetReport.status, mainMB: budgetReport.mainMB, totalMB: budgetReport.totalMB } : null,
      evidence: { completeness: cls.completeness, presentCount: cls.presentCount },
      failures,
    }, json);
  }
}

// ---- 自检模式 ----

async function selfCheck(json) {
  const checks = [];

  // 1) 脚本存在
  checks.push(fileCheck('build.mjs', BUILD_SCRIPT));
  checks.push(fileCheck('playtest-evidence.mjs', EVIDENCE_SCRIPT));

  // 2) 语法检查（node --check）
  for (const c of checks.filter((x) => x.exists)) {
    const r = runCheck(c.path);
    c.syntaxOk = r.ok;
    c.syntaxErr = r.err;
  }

  // 3) 关键导出函数可用（动态 import，验证接线）
  const exportCheck = await verifyExports();
  checks.push({
    name: 'exports',
    exists: true,
    syntaxOk: exportCheck.ok,
    syntaxErr: exportCheck.err,
    detail: exportCheck.detail,
  });

  // 4) SKILL.md 接线（非阻断，仅提示）
  const docWired = [BUILD_SCRIPT, EVIDENCE_SCRIPT].every((p) => docReferences(p));
  const docNote = docWired ? 'SKILL.md 已引用两个脚本' : '提示：SKILL.md 未同时引用 build.mjs / playtest-evidence.mjs（建议补）';

  const broken = checks.filter((c) => !c.exists || !c.syntaxOk);
  if (broken.length) {
    outputError(
      `QA 子系统自检未通过：${broken.map((c) => c.name + (c.exists ? `(语法错误: ${c.syntaxErr})` : '(文件缺失)')).join('；')}`,
      { mode: 'self-check', checks, docNote },
      json,
    );
  }

  outputSuccess({
    mode: 'self-check',
    healthy: true,
    checks: checks.map((c) => ({ name: c.name, exists: c.exists, syntaxOk: c.syntaxOk, detail: c.detail })),
    docNote,
  }, json);
}

function fileCheck(name, path) {
  return { name, path, exists: existsSync(path) };
}

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
    const b = await import(pathToFileURL(BUILD_SCRIPT).href);
    const e = await import(pathToFileURL(EVIDENCE_SCRIPT).href);
    const need = [
      typeof b.auditBudget === 'function',
      typeof b.loadPlatforms === 'function',
      typeof e.collectEvidence === 'function',
      typeof e.classifyCompleteness === 'function',
    ];
    const ok = need.every(Boolean);
    return { ok, err: ok ? null : '缺少关键导出函数', detail: ok ? 'auditBudget/loadPlatforms/collectEvidence/classifyCompleteness 均可用' : '导出缺失' };
  } catch (err) {
    return { ok: false, err: (err && err.message ? err.message : String(err)).slice(0, 300), detail: '动态 import 失败' };
  }
}

function docReferences(scriptPath) {
  if (!existsSync(SKILL_MD)) return false;
  try {
    const txt = readFileSync(SKILL_MD, 'utf-8');
    const base = scriptPath.split(/[\\/]/).pop();
    return txt.includes(base);
  } catch { return false; }
}

main().catch((e) => {
  outputError(`qa-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
});
