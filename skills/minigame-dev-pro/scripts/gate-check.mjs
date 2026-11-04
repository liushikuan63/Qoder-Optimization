/**
 * 门控泳道编排器（自研，1.0.8 新增）
 *
 * 职责：把"结构检测 → 包体预算 → QA 闸门 → 原型/切片门控"编排为一道发布门控，
 *       产出 production/gate-report.md 与 production/launch-checklist.md（上线人工清单）。
 *
 * 设计边界（严格，禁止弄虚作假 / 表面功能）：
 *  - 规模路由门控：--scale light（单 gate）/ full（双 gate）/ auto（默认，按风险路由）。
 *    小游戏体量少，不照搬 3A 双 gate；auto 仅在 monetization 含 iap 或 多平台时升 full（见 gate-pipeline.md §二）。
 *  - 复用纯函数，零重复：detectProject（project-detector）、auditBudget/loadPlatforms（build.mjs）、
 *    collectEvidence/classifyCompleteness（playtest-evidence.mjs）。本脚本只做"编排 + 路由 + 报告产出"。
 *  - 不假 pass：结构非法 / 超预算 = 硬失败 exit 1；证据不全 / 原型或切片文档缺失 = warn（exit 0，
 *    readyForRelease:false，gate 绝不标 pass）。
 *  - 真实写报告：每次都落盘 gate-report.md（含逐层状态与 human-in-the-loop 边界引用），不静默。
 *  - 0 外部依赖：仅 node 内置模块。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectProject } from './lib/project-detector.mjs';
import { auditBudget, loadPlatforms } from './build.mjs';
import { collectEvidence, classifyCompleteness } from './playtest-evidence.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPPORTED_PLATFORMS = ['wechat', 'douyin'];

const HELP = `小游戏门控泳道编排器

用法:
  node scripts/gate-check.mjs --project <项目路径> --platform <wechat|douyin> [选项]

必填:
  --project <path>   小游戏项目目录
  --platform <name>  目标平台 wechat | douyin

可选:
  --scale <light|full|auto>   门控规模，默认 auto（按风险路由：含 IAP / 多平台 → full，否则 light）
  --out <dir>                 报告输出目录，默认 <项目>/production
  --json                      输出 JSON 结构化结果
  --help                      显示本帮助

退出码:
  0  门控 pass / 仅 warn 级（证据或设计文档不全，非阻断）
  1  结构非法 / 包体超预算（硬失败）`;

// ---- 路由判定 ----

function readProjectState(absProject) {
  const p = join(absProject, '.workbuddy', 'minigame-dev', 'project-state.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function resolveScale(scaleArg, absProject, detection) {
  if (scaleArg === 'light' || scaleArg === 'full') return scaleArg;
  // auto：仅在能确认高风险信号时升 full，否则保守 light（不假装做过 full gate）
  const state = readProjectState(absProject);
  const monet = (state && state.monetization) || (detection.info && detection.info.monetization) || '';
  const plats = (state && Array.isArray(state.platforms)) ? state.platforms : [];
  if (String(monet).includes('iap') || plats.length >= 2) return 'full';
  return 'light';
}

// ---- 设计层文档校验（full gate 才需要） ----

function docHasSections(path, sections) {
  if (!existsSync(path)) return { found: false, missing: sections };
  const txt = readFileSync(path, 'utf-8');
  const missing = sections.filter((s) => !new RegExp(s).test(txt));
  return { found: missing.length === 0, missing };
}

function checkPrototype(absProject) {
  const candidates = [
    join(absProject, 'production', 'prototype.md'),
    join(absProject, 'docs', 'prototype.md'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const r = docHasSections(c, ['核心循环', 'PIVOT', 'KILL']);
      return { path: c, ...r };
    }
  }
  return { path: null, found: false, missing: ['核心循环', 'PIVOT 条件', 'KILL 条件'] };
}

function checkSlice(absProject) {
  const candidates = [
    join(absProject, 'production', 'slice-checklist.md'),
    join(absProject, 'docs', 'slice-checklist.md'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const r = docHasSections(c, ['核心循环', '关键系统', '合规']);
      return { path: c, ...r };
    }
  }
  return { path: null, found: false, missing: ['核心循环可玩切片', '关键系统清单', '合规复核项'] };
}

// ---- 报告产出 ----

const LAUNCH_TEMPLATE = `# 上线人工清单（模板）

> 本文件由 gate-check.mjs 生成，列出**需用户手动完成**的上线步骤。agent 不断言"已上架"。
> 每项标注：✅ 完成 / ❌ 未完成 / ⚠️ 跳过（附原因）。

## 真机预览
- [ ] 微信开发者工具 / 抖音开发者工具 打开项目，点"预览"扫码到真机
- [ ] 真机无白屏 / 崩溃 / 明显卡顿

## 上传
- [ ] 通过 CLI 或开发者工具"上传"代码包（包体在平台限额内）
- [ ] 填写版本号与版本描述

## 提审 / 资质
- [ ] 类目与资质齐全（软著 / 版号按平台与变现模式矩阵）
- [ ] 个人主体确认不具备的资质（如流量主 / 企业支付）已规避

## 合规复核
- [ ] 实名注册 + 防沉迷时长/充值限额（8 岁以下禁付）
- [ ] 内容安全（无违规词 / 无未授权 IP / 地图合规）
- [ ] 支付合规（iOS 虚拟支付仅 Android；内购按平台规则）

## 灰度 / 全量
- [ ] 先灰度小流量，观察留存 / 崩溃率，再全量
`;

function buildReport(ctx) {
  const rows = [];
  rows.push(`| 层 | 结果 | 说明 |`);
  rows.push(`|----|------|------|`);
  rows.push(`| 结构 structure | ${ctx.structure.ok ? 'ok' : 'FAIL'} | ${ctx.structure.detail || (ctx.detection.valid ? 'minigame / ' + ctx.detection.info.engine : ctx.structure.detail)} |`);
  rows.push(`| 包体预算 budget | ${ctx.budget.ok ? 'ok' : 'FAIL'} | 主包 ${ctx.budget.mainMB}MB / 总包 ${ctx.budget.totalMB}MB / 上限见 platforms.json |`);
  rows.push(`| 运行时证据 evidence | ${ctx.evidence.completeness} | present=${ctx.evidence.presentCount}/4 ${ctx.evidence.missing.length ? '缺失:' + ctx.evidence.missing.join('/') : ''} |`);
  if (ctx.scale === 'full') {
    rows.push(`| 玩法原型 concept-prototype | ${ctx.prototype.found ? 'ok' : 'WARN'} | ${ctx.prototype.found ? ctx.prototype.path : '缺 prototype.md（含 核心循环/PIVOT/KILL）'}`);
    rows.push(`| 垂直切片 vertical-slice | ${ctx.slice.found ? 'ok' : 'WARN'} | ${ctx.slice.found ? ctx.slice.path : '缺 slice-checklist.md（含 核心循环/关键系统/合规）'}`);
  }
  const table = rows.join('\n');

  return `# 门控报告 gate-report（${ctx.scale}）

- 项目：${ctx.project}
- 平台：${ctx.platform}
- 门控规模 scale：${ctx.scale}
- 闸门结果 gate：**${ctx.gate}**
- 可上架 readyForRelease：${ctx.readyForRelease}

## 逐层状态

${table}

## 结论与下一步

${ctx.summary}

## 职责边界（human-in-the-loop，详见 references/knowledge/gate-pipeline.md §五）

- 结构 / 预算 / 证据聚合 / 门控编排：agent 自动
- 游戏逻辑 / 美术 / 真机预览 / 上传 / 提审：用户手动
- 引擎 CLI 缺失：build 降级为 built:false + 安装提示，不假成功
- agent 不断言"已上架 / 已通过真机验证"
`;
}

// ---- 主流程 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);

  const json = !!args.json;
  const projectPath = args.project;
  const platform = args.platform;
  const scaleArg = args.scale || 'auto';
  const outDir = args.out ? resolve(args.out) : null;

  if (!projectPath) {
    outputError('缺少必填参数 --project <项目路径>', { hint: 'node scripts/gate-check.mjs --project <路径> --platform wechat' }, json);
  }
  if (!platform) {
    outputError('项目模式缺少 --platform（wechat|douyin）', { hint: 'node scripts/gate-check.mjs --project <路径> --platform wechat' }, json);
  }
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    outputError(`当前仅支持 wechat/douyin 门控；平台 "${platform}" 预算未核实。`, {}, json);
  }
  const absProject = resolve(projectPath);
  if (!existsSync(absProject)) {
    outputError(`项目路径不存在: ${absProject}`, {}, json);
  }

  // 1) 结构
  const detection = detectProject(absProject);
  const structureOk = detection.valid && detection.type === 'minigame';

  // 2) 包体预算
  let budgetReport = null;
  let budgetOk = false;
  if (structureOk) {
    const platforms = loadPlatforms();
    const pmeta = platforms[platform];
    if (!pmeta || !pmeta.packageLimitMB || typeof pmeta.packageLimitMB !== 'object') {
      budgetOk = false;
    } else {
      budgetReport = auditBudget(absProject, detection, pmeta.packageLimitMB, platform);
      budgetOk = budgetReport.status === 'ok';
    }
  }

  // 3) 证据
  const evidence = collectEvidence(absProject);
  const cls = classifyCompleteness(evidence);

  // 4) 路由
  const scale = resolveScale(scaleArg, absProject, detection);

  // 5) full 额外层
  const prototype = scale === 'full' ? checkPrototype(absProject) : { required: false, found: true, missing: [] };
  const slice = scale === 'full' ? checkSlice(absProject) : { required: false, found: true, missing: [] };

  // 6) 组装 failures
  const failures = [];
  if (!structureOk) {
    failures.push({ level: 'error', category: 'structure', detail: detection.errors.length ? detection.errors.join('；') : `类型=${detection.type}（需 minigame）` });
  }
  if (structureOk && !budgetOk) {
    failures.push({ level: 'error', category: 'budget', detail: budgetReport ? budgetReport.summary : `平台 "${platform}" 包体预算未核实（pending-verify）` });
  }
  if (cls.completeness !== 'complete') {
    failures.push({ level: 'warn', category: 'evidence', detail: `运行时证据不完整（${cls.completeness}），缺失：${cls.missing.join('、')}`, missing: cls.missing });
  }
  if (scale === 'full' && !prototype.found) {
    failures.push({ level: 'warn', category: 'concept-prototype', detail: `缺玩法原型文档（需含 核心循环/PIVOT/KILL），缺失：${prototype.missing.join('、')}`, missing: prototype.missing });
  }
  if (scale === 'full' && !slice.found) {
    failures.push({ level: 'warn', category: 'vertical-slice', detail: `缺垂直切片清单（需含 核心循环/关键系统/合规），缺失：${slice.missing.join('、')}`, missing: slice.missing });
  }

  const hasHard = failures.some((f) => f.level === 'error');
  const gate = hasHard ? 'fail' : (failures.length ? 'warn' : 'pass');
  const readyForRelease = gate === 'pass';

  const ctx = {
    project: absProject,
    platform,
    scale,
    gate,
    readyForRelease,
    detection,
    structure: { ok: structureOk, detail: hasHard && failures.find((f) => f.category === 'structure') ? failures.find((f) => f.category === 'structure').detail : '' },
    budget: { ok: budgetOk, mainMB: budgetReport ? budgetReport.mainMB : null, totalMB: budgetReport ? budgetReport.totalMB : null },
    evidence: { completeness: cls.completeness, presentCount: cls.presentCount, missing: cls.missing },
    prototype,
    slice,
    summary: gate === 'pass'
      ? '全部门控层通过，可进入上线人工清单（真机预览/上传/提审由用户手动完成）。'
      : gate === 'fail'
        ? '存在硬失败（结构非法 / 包体超预算），须修复后重跑，不可上架。'
        : '存在 warn 级缺口（证据或设计文档不全）。gate 未标 pass；补齐后可重跑至 pass。',
  };

  // 7) 写报告（每次都写，先于退出判定）
  const reportDir = outDir || join(absProject, 'production');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'gate-report.md');
  const launchPath = join(reportDir, 'launch-checklist.md');
  writeFileSync(reportPath, buildReport(ctx), 'utf-8');
  if (!existsSync(launchPath)) writeFileSync(launchPath, LAUNCH_TEMPLATE, 'utf-8');

  const result = {
    mode: 'gate-check',
    platform,
    scale,
    gate,
    readyForRelease,
    structure: { valid: structureOk, type: detection.type, engine: detection.info.engine },
    budget: budgetReport ? { status: budgetReport.status, mainMB: budgetReport.mainMB, totalMB: budgetReport.totalMB } : null,
    evidence: { completeness: cls.completeness, presentCount: cls.presentCount },
    scaleLayers: scale === 'full' ? { conceptPrototype: prototype.found, verticalSlice: slice.found } : null,
    reportPath,
    launchChecklistPath: launchPath,
    failures,
  };

  if (hasHard) {
    outputError(`门控硬失败（${failures.map((f) => f.category).join('/')}）；报告已写入 ${reportPath}`, result, json);
  }
  outputSuccess(result, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    outputError(`gate-check.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
  });
}
