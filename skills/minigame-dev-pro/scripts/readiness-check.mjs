#!/usr/bin/env node
/**
 * readiness-check.mjs 上架就绪度自检（质量自检工具）
 * 用法：
 *   node readiness-check.mjs --project <项目路径> [--json]
 *
 * 能力：
 *  - 对照14项上架就绪度清单逐项检查
 *  - 检测配置文件完整性、包体大小、隐私指引、防沉迷等
 *  - 输出结构化报告，标注阻断项和警告项
 *  - 给出预估审核通过率
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { detectProject } from './lib/project-detector.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `上架就绪度自检（14项）

用法:
  node readiness-check.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --json              以 JSON 格式输出
  --help              显示帮助

检查项（14项）:
  1. 游戏可玩性（检查 game.js 入口）
  2. 首次体验（检查 Loading 配置）
  3. 隐私合规（检测隐私指引配置）
  4. 内容合规（检测 UGC 内容安全接口）
  5. 类目匹配（检查 project.config.json 类目）
  6. 包体大小（主包 ≤4MB）
  7. 性能达标（检测性能相关配置）
  8. 适配测试（检查 deviceOrientation 配置）
  9. 广告配置（检测广告位合理性）
  10. 分享功能（检测分享配置）
  11. 用户协议（检测协议文件）
  12. 软著/资质（检测资质文件）
  13. 自审报告（检测自审报告文件）
  14. 账号状态（检查 AppID 配置）`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node readiness-check.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const project = detectProject(projectPath);
  const checks = runAllChecks(projectPath, project);

  const passed = checks.filter((c) => c.status === 'pass').length;
  const blocked = checks.filter((c) => c.status === 'block');
  const warnings = checks.filter((c) => c.status === 'warn');

  // 预估通过率
  let passRate;
  if (passed === 14) passRate = '85-95%';
  else if (passed >= 12) passRate = '60-75%';
  else passRate = '<50%';

  let recommendation;
  if (passed === 14) recommendation = '可以提交审核';
  else if (blocked.length === 0) recommendation = '修复警告项后提交';
  else recommendation = `需修复 ${blocked.length} 个阻断项后才能提交`;

  outputSuccess({
    action: 'readiness_check',
    project: projectPath,
    projectName: project.projectName,
    appId: project.appId,
    totalChecks: 14,
    passed,
    blockedCount: blocked.length,
    warningCount: warnings.length,
    estimatedPassRate: passRate,
    recommendation,
    checks,
    blockedItems: blocked.map((c) => ({ id: c.id, name: c.name, issue: c.issue, fix: c.fix })),
    warningItems: warnings.map((c) => ({ id: c.id, name: c.name, issue: c.issue, fix: c.fix })),
  }, args.json);
}

function runAllChecks(projectPath, project) {
  return [
    check1Playable(projectPath, project),
    check2FirstExperience(projectPath, project),
    check3Privacy(projectPath, project),
    check4Content(projectPath, project),
    check5Category(projectPath, project),
    check6PackageSize(projectPath, project),
    check7Performance(projectPath, project),
    check8Adaptation(projectPath, project),
    check9Ads(projectPath, project),
    check10Share(projectPath, project),
    check11UserAgreement(projectPath, project),
    check12Copyright(projectPath, project),
    check13SelfReview(projectPath, project),
    check14Account(projectPath, project),
  ];
}

function makeResult(id, name, status, issue, fix) {
  return { id, name, status, issue: issue || null, fix: fix || null };
}

function check1Playable(projectPath, project) {
  if (project.info.hasGameJs) return makeResult('C01', '游戏可玩性', 'pass');
  return makeResult('C01', '游戏可玩性', 'block', '缺少 game.js 入口文件', '创建 game.js 作为游戏入口');
}

function check2FirstExperience(projectPath, project) {
  // 检测是否有 Loading 相关配置或代码
  const gameJson = safeReadJson(join(projectPath, 'game.json'));
  const hasLoading = existsSync(join(projectPath, 'loading.js'))
    || existsSync(join(projectPath, 'js', 'loading.js'))
    || (gameJson && gameJson.networkTimeout);
  if (hasLoading) return makeResult('C02', '首次体验', 'pass');
  return makeResult('C02', '首次体验', 'warn', '未检测到 Loading 页配置', '建议添加 Loading 页，确保 3 秒内可交互');
}

function check3Privacy(projectPath, project) {
  // 深化检查：不只查文件存在，还查配置内容
  const gameJson = safeReadJson(join(projectPath, 'game.json'));
  const privacyJson = safeReadJson(join(projectPath, 'privacy.json'));

  // 检查game.json 是否启用隐私检查
  const privacyEnabled = gameJson && (
    gameJson.__usePrivacyCheck__ === true
    || gameJson.__usePrivacyCheck__ === 1
  );

  // 检查privacy.json 是否有必要的权限声明
  let privacyComplete = false;
  if (privacyJson) {
    // 隐私政策至少要有 permission_desc 或PrivacyContractName
    privacyComplete = !!(privacyJson.permission_desc || privacyJson.PrivacyContractName || privacyJson.privacy_contract_name);
  }

  if (privacyEnabled && privacyComplete) return makeResult('C03', '隐私合规', 'pass');
  if (privacyEnabled && !privacyComplete) {
    return makeResult('C03', '隐私合规', 'warn', '已启用隐私检查但 privacy.json 内容不完整', '在privacy.json 中添加permission_desc 字段描述各权限用途');
  }
  if (!privacyEnabled && existsSync(join(projectPath, 'privacy.json'))) {
    return makeResult('C03', '隐私合规', 'warn', '有 privacy.json 但未在 game.json 启用 __usePrivacyCheck__', '在game.json 中添加"__usePrivacyCheck__": true');
  }
  return makeResult('C03', '隐私合规', 'block', '未检测到隐私保护指引配置', '1. 在game.json 中添加"__usePrivacyCheck__": true\n2. 创建 privacy.json 并声明权限用途');
}

function check4Content(projectPath, project) {
  // 内容安全检测原则：不依赖本地关键词黑名单（词表无法覆盖平台全部标准、且误报率高），
  // 而是检查"有 UGC/用户输入功能的游戏是否接入微信官方内容安全接口"。
  // 微信内容安全接口为服务端接口：security.msgSecCheck（文本）、security.imgSecCheck（图片）；
  // 小游戏另有"游戏内容安全"服务端接口（gamesecurity.mediaCheck 等）；客户端小程序端为 wx.checkText / wx.checkImage。
  const excludeDirs = ['node_modules', '.git', 'miniprogram_npm', 'typings', '.bak'];
  let hasUgc = false;
  let hasUserInput = false;
  let hasSecCheckApi = false;
  const reSecCheck = /security\.msgSecCheck|security\.imgSecCheck|gamesecurity\.|wx\.checkText|wx\.checkImage/;
  const reUserInput = /wx\.(createInput|createTextArea)|<input|<textarea|onKeyboardInput|onInput|onMessage/;
  function walk(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        if (excludeDirs.includes(entry)) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (['.js', '.mjs', '.ts', '.json'].includes(extname(entry).toLowerCase())) {
          try {
            const content = readFileSync(full, 'utf-8');
            if (reSecCheck.test(content)) hasSecCheckApi = true;
            if (reUserInput.test(content)) hasUserInput = true;
            if (hasUserInput) hasUgc = true;
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }
  walk(projectPath);
  if (hasUgc && !hasSecCheckApi) {
    return makeResult('C04', '内容合规', 'block', '检测到用户输入/UGC功能，但未接入微信官方内容安全接口（security.msgSecCheck / security.imgSecCheck）', '在服务端/云函数接入 security.msgSecCheck 文本检测、security.imgSecCheck 图片检测（小游戏可选用 gamesecurity.mediaCheck），审核通过后再展示用户内容');
  }
  return makeResult('C04', '内容合规', 'pass');
}

function check5Category(projectPath, project) {
  // 深化检查：不只查AppID，还查类目配置
  const cfg = safeReadJson(join(projectPath, 'project.config.json'));
  if (!cfg) return makeResult('C05', '类目匹配', 'warn', '缺少 project.config.json', '创建 project.config.json');
  const appId = cfg.appid || cfg.appId;
  if (!appId || appId === 'touristappid') return makeResult('C05', '类目匹配', 'block', '未配置有效AppID', '在project.config.json 中配置正确AppID');
  // 检查是否有类目配置
  const hasCategory = cfg.category || cfg.miniProgramCategory;
  if (hasCategory) return makeResult('C05', '类目匹配', 'pass');
  return makeResult('C05', '类目匹配', 'warn', '有 AppID 但未配置类目', '在微信公众平台确认游戏类目与实际玩法匹配');
}

function check6PackageSize(projectPath, project) {
  const sizeMB = project.info.mainPackageSizeMB;
  if (sizeMB <= 4) return makeResult('C06', '包体大小', 'pass', null, null);
  return makeResult('C06', '包体大小', 'block', `主包 ${sizeMB}MB 超过 4MB 限制`, '使用 package-analyzer.mjs 分析并优化，资源 CDN 化或移入分包');
}

function check7Performance(projectPath, project) {
  // 性能达标检查：检测是否有性能相关配置/代码（不等于真性能达标，只是配置就绪）
  const gameJson = safeReadJson(join(projectPath, 'game.json'));
  const checks = [];
  if (gameJson && gameJson.networkTimeout) checks.push('networkTimeout');
  if (gameJson && gameJson.workers) checks.push('workers');
  // 检测是否有性能优化代码（对象池/资源释放）
  if (safeGrep(join(projectPath, 'game.js'), ['Pool', 'release', 'destroy', 'gc'])) checks.push('resource-mgmt');
  if (checks.length >= 2) return makeResult('C07', '性能达标', 'pass', null, `检测到: ${checks.join(', ')}`);
  if (checks.length === 1) return makeResult('C07', '性能达标', 'warn', `性能配置不全（仅 ${checks[0]}）`, '配置 networkTimeout + 资源释放逻辑，建议用 perf-profiler.mjs 实测');
  return makeResult('C07', '性能达标', 'warn', '未检测到性能相关配置', '在game.json 中配置 networkTimeout，接入资源释放逻辑，用 perf-profiler.mjs 实测');
}

function check8Adaptation(projectPath, project) {
  if (project.info.deviceOrientation) return makeResult('C08', '适配测试', 'pass');
  return makeResult('C08', '适配测试', 'warn', '未检测到屏幕方向配置', '在game.json 中配置 deviceOrientation');
}

function check9Ads(projectPath, project) {
  // 检测广告SDK 接入
  const adFiles = ['game.js'];
  let hasAds = false;
  for (const f of adFiles) {
    if (safeGrep(join(projectPath, f), ['createRewardedVideoAd', 'createInterstitialAd', 'createBannerAd'])) {
      hasAds = true;
      break;
    }
  }
  if (hasAds) return makeResult('C09', '广告配置', 'pass');
  return makeResult('C09', '广告配置', 'warn', '未检测到广告 SDK 接入', '如需广告变现，接入 wx.createRewardedVideoAd');
}

function check10Share(projectPath, project) {
  if (safeGrep(join(projectPath, 'game.js'), ['onShareAppMessage', 'shareAppMessage'])) {
    return makeResult('C10', '分享功能', 'pass');
  }
  return makeResult('C10', '分享功能', 'warn', '未检测到分享功能', '接入 wx.onShareAppMessage 实现分享');
}

function check11UserAgreement(projectPath, project) {
  const has = existsSync(join(projectPath, 'user-agreement.txt'))
    || existsSync(join(projectPath, 'agreement.html'))
    || existsSync(join(projectPath, 'docs', 'user-agreement.md'));
  if (has) return makeResult('C11', '用户协议', 'pass');
  return makeResult('C11', '用户协议', 'warn', '未检测到用户协议文件', '创建用户协议文档并确保可访问');
}

function check12Copyright(projectPath, project) {
  const has = existsSync(join(projectPath, '软著'))
    || existsSync(join(projectPath, 'docs', 'software-copyright'))
    || existsSync(join(projectPath, 'copyright.txt'));
  if (has) return makeResult('C12', '软著/资质', 'pass');
  // 软著要求因「平台 × 变现模式」而异：微信 IAA 可走《著作权自我声明》非必填；IAP / 抖音必填。
  // 用 --monetization iaa|iap --platform wechat|douyin 可精确判定；未指定时给矩阵提示，不做一刀切结论。
  const a = parseArgs();
  const monet = (a.monetization || '').toLowerCase();
  const plat = (a.platform || '').toLowerCase();
  let hint = '软著要求因平台与变现模式而异：微信纯广告(IAA)可走《著作权自我声明》非必填；含内购(IAP)/抖音必填。详见 compliance-rules.md RULE-002';
  if (monet === 'iap' || plat === 'douyin') hint = '该项目需软著：尽早提交软著申请（周期30-60 天，名称须与游戏名一致）';
  else if (monet === 'iaa' && plat === 'wechat') hint = '微信纯广告(IAA)软著非必填，可走《著作权自我声明》；如需品牌/含英文名称等情形仍可能需软著';
  return makeResult('C12', '软著/资质', 'warn', '未检测到软著材料', hint);
}

function check13SelfReview(projectPath, project) {
  const has = existsSync(join(projectPath, '自审报告.txt'))
    || existsSync(join(projectPath, 'docs', 'self-review.md'))
    || existsSync(join(projectPath, 'self-review-report.md'));
  if (has) return makeResult('C13', '自审报告', 'pass');
  return makeResult('C13', '自审报告', 'warn', '未检测到自审报告', '按模板填写自审自查报告');
}

function check14Account(projectPath, project) {
  if (project.appId && project.appId !== 'touristappid' && project.appId.length > 10) {
    return makeResult('C14', '账号状态', 'pass');
  }
  return makeResult('C14', '账号状态', 'block', '未配置有效AppID 或使用游客模式', '在project.config.json 中配置正确AppID');
}

// ---- 辅助函数 ----

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function safeGrep(filePath, keywords) {
  try {
    if (!existsSync(filePath)) return false;
    const content = readFileSync(filePath, 'utf-8');
    return keywords.some((k) => content.includes(k));
  } catch (_) {
    return false;
  }
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

