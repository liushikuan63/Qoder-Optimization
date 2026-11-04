/**
 * QA 测试计划 / 回归套件骨架生成器（自研，1.0.9 新增）
 *
 * 职责：基于项目画像（复用 project-detector 推断引擎；读 project-state 取平台/变现）
 *       生成结构化测试计划 tests/qa-plan.md（功能 / 性能 / 兼容 / 合规 / 回归 五类），
 *       供人工或 CI 消费。生成的**是骨架**，具体用例由用户填充（human-in-the-loop）。
 *
 * 输入：
 *  - --project <path>  推荐：自动推断引擎/平台/变现以裁剪条目
 *  - --genre <name>   轻量：仅品类模板
 *  - --out <dir>      输出目录，默认 <project>/tests 或当前目录
 * 无 --project/--genre：生成通用模板。
 *
 * 设计边界：纯文件生成，0 CLI 依赖，CLI 缺失不阻断；产出明确标注"骨架/待填充"，
 *           不伪称已覆盖全部用例（与 QA Lead 测试计划方法论对齐，见 references/knowledge/...）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectProject } from './lib/project-detector.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';

const HELP = `QA 测试计划生成器（${VERSION}）

用法:
  node scripts/qa-plan.mjs --project <路径> [--out <dir>] [--json]
  node scripts/qa-plan.mjs --genre <品类> [--out <dir>] [--json]
  node scripts/qa-plan.mjs [--out <dir>] [--json]          # 通用模板

可选:
  --project <path>  小游戏项目目录（推断引擎/平台/变现以裁剪条目）
  --genre <name>    游戏品类（轻量模板）
  --out <dir>       输出目录，默认 <project>/tests 或 cwd
  --json            输出 JSON
  --help            显示本帮助

退出码:
  0  计划已生成
  1  参数冲突 / 项目路径不存在`;

const PLATFORM_COMPLIANCE = {
  wechat: ['实名注册 + 防沉迷时长/充值限额（8 岁以下禁付）', '内容安全服务端接口（gamesecurity.*）', 'iOS 虚拟支付仅 Android 支持，禁止套用小程序 API', '流量主主体闸门（个人不可开通）'],
  douyin: ['抖音开发者平台资质与类目', '内容合规与未成年人保护', '支付按平台规则（IOS/Android 分流）'],
};

function readProjectState(absProject) {
  const p = join(absProject, '.workbuddy', 'minigame-dev', 'project-state.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function buildPlan(ctx) {
  const { engine, platforms, monetization, genre } = ctx;
  const engLine = engine ? `引擎：${engine}` : '引擎：未推断（请在编辑器中确认）';
  const platLine = platforms && platforms.length ? `目标平台：${platforms.join('/')}` : '目标平台：未声明（建议先明确平台以裁剪合规项）';
  const monLine = monetization ? `变现模式：${monetization}` : '变现模式：未声明';
  const genreLine = genre ? `品类：${genre}` : '品类：未声明';

  const lines = [];
  lines.push(`# QA 测试计划（骨架）`);
  lines.push('');
  lines.push(`> 本文件由 qa-plan.mjs 生成，为**测试计划骨架**，具体用例由人工/CI 填充。`);
  lines.push(`> agent 不伪称已覆盖全部用例；标注 ✅ 已覆盖 / ❌ 待补 / ⚠️ 跳过（附原因）。`);
  lines.push('');
  lines.push(`## 项目画像`);
  lines.push('');
  lines.push(`- ${engLine}`);
  lines.push(`- ${platLine}`);
  lines.push(`- ${monLine}`);
  lines.push(`- ${genreLine}`);
  lines.push('');

  // 功能测试
  lines.push(`## 1. 功能测试（Functional）`);
  lines.push('');
  lines.push(`- [ ] 核心循环可玩（进入→操作→反馈→目标达成）`);
  lines.push(`- [ ] 关卡/模式解锁逻辑正确`);
  lines.push(`- [ ] 货币/道具产出与消耗符合 economy-balance.md 设计`);
  lines.push(`- [ ] 存档/读档（本地 + 云）一致性`);
  lines.push(`- [ ] 支付链路（${monetization && monetization.includes('iap') ? '含内购' : '无内购'}）`);
  lines.push('');

  // 性能测试
  lines.push(`## 2. 性能测试（Performance）`);
  lines.push('');
  lines.push(`- [ ] 启动时间 < 3s（冷启）`);
  lines.push(`- [ ] 稳态 FPS ≥ 50（中端机）`);
  lines.push(`- [ ] 内存峰值 < 256MB（对标 perf-profiler.mjs）`);
  lines.push(`- [ ] 包体预算（主包/总包）符合 platforms.json（见 qa-gate 预算硬失败项）`);
  lines.push('');

  // 兼容性测试
  lines.push(`## 3. 兼容性测试（Compatibility）`);
  lines.push('');
  lines.push(`- [ ] iOS / Android 主流机型（屏幕适配 + 输入）`);
  lines.push(`- [ ] 不同系统版本 JS 引擎差异`);
  lines.push(`- [ ] 横/竖屏与刘海/安全区`);
  lines.push(`- [ ] 弱网/断网降级（${engine ? engine + ' 引擎网络层' : '网络层'}）`);
  lines.push('');

  // 合规测试（按平台裁剪）
  lines.push(`## 4. 合规测试（Compliance，按平台裁剪）`);
  lines.push('');
  const platKeys = platforms && platforms.length ? platforms : ['wechat'];
  const seen = new Set();
  for (const pk of platKeys) {
    const items = PLATFORM_COMPLIANCE[pk];
    if (!items) continue;
    for (const it of items) {
      const key = pk + '|' + it;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- [ ] 【${pk}】${it}`);
    }
  }
  lines.push(`- [ ] 内容安全（无违规词 / 无未授权 IP，见 sensitive-word-gate / ip-compliance-check）`);
  lines.push(`- [ ] 地图领土合规（含台湾、南海九段线，见 map-territory-check）`);
  lines.push(`- [ ] 隐私政策与数据收集告知（见 analytics-ops.md 隐私优先埋点）`);
  lines.push('');

  // 回归测试
  lines.push(`## 5. 回归测试（Regression）`);
  lines.push('');
  lines.push(`- [ ] 数值平衡回归（balance-spec.json 阈值，见 balance-gate.mjs）`);
  lines.push(`- [ ] 历史缺陷修复验证（引用 feedback-log / bug 清单）`);
  lines.push(`- [ ] 版本升级兼容（旧存档/旧配置迁移）`);
  lines.push('');

  lines.push(`## 6. 无障碍 checklist 引用（Accessibility）`);
  lines.push('');
  lines.push(`- [ ] 色觉：不以纯红/纯绿作为唯一状态区分（见 accessibility.md）`);
  lines.push(`- [ ] 听觉：关键反馈有视觉替代`);
  lines.push(`- [ ] 运动：不可依赖精确快速操作`);
  lines.push(`- [ ] 认知：文案简洁、指引明确`);
  lines.push(`- [ ] 适老化：字体/对比度达标`);
  lines.push('');
  lines.push(`---`);
  lines.push(`生成工具：qa-plan.mjs v${VERSION} ｜ 引擎推断：${engine || 'n/a'} ｜ 平台：${platforms && platforms.length ? platforms.join('/') : 'n/a'}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;

  let engine = null;
  let platforms = [];
  let monetization = '';
  let genre = args.genre || null;
  let outDir;

  if (args.project) {
    const absProject = resolve(args.project);
    if (!existsSync(absProject)) outputError(`项目路径不存在: ${absProject}`, {}, json);
    const detection = detectProject(absProject);
    engine = detection.valid ? detection.info.engine : null;
    const state = readProjectState(absProject);
    platforms = (state && Array.isArray(state.platforms)) ? state.platforms : [];
    monetization = (state && state.monetization) || (detection.info && detection.info.monetization) || '';
    outDir = args.out ? resolve(args.out) : join(absProject, 'tests');
  } else if (args.out) {
    outDir = resolve(args.out);
  } else {
    outDir = process.cwd();
  }

  const ctx = { engine, platforms, monetization, genre };
  const plan = buildPlan(ctx);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'qa-plan.md');
  writeFileSync(outPath, plan, 'utf-8');

  const sectionCount = (plan.match(/^## /gm) || []).length;
  const itemCount = (plan.match(/- \[ \]/g) || []).length;
  outputSuccess({
    tool: 'qa-plan',
    version: VERSION,
    engine,
    platforms,
    monetization,
    outPath,
    sections: sectionCount,
    items: itemCount,
    note: '骨架已生成，具体用例需人工/CI 填充；agent 不伪称已覆盖全部用例',
  }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    outputError(`qa-plan.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
  });
}
