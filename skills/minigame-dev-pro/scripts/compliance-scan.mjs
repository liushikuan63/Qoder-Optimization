#!/usr/bin/env node
/**
 * compliance-scan.mjs 合规红线扫描（质量自检工具）
 * 用法：
 *   node compliance-scan.mjs --project <项目路径> [--json]
 *
 * 能力：
 *  - 扫描代码检查 10 条 P0合规红线
 *  - 检测违规分享奖励、未授权IP、随机抽取未公示概率、虚拟货币回流兑换等
 *  - 输出违规项和警告项 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');

const HELP = `合规红线扫描（7条代码层红线+3条安全规则，支持过滤）

用法:
  node compliance-scan.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --json              以 JSON 格式输出
  --filter <过滤条件> 过滤输出结果（可多次指定，OR 关系）
  --help              显示帮助

过滤条件语法（key:value）
  severity:block      只看阻断性违规（必须修复才能过审）  severity:warn       只看警告项（建议修复）
  severity:pass       只看通过项  category:share      违规分享奖励类（RULE-008）
  category:ip         IP/品牌类（RULE-011）
  category:gacha      随机抽取概率类（RULE-009）
  category:currency   虚拟货币类（RULE-010）
  category:ad         广告类（RULE-012）
  category:minor      未成年人保护类（RULE-005）
  category:content    敏感内容类（RULE-013）
  category:ad-law     广告法禁用词类（SCAN-01）
  category:payment    支付类（SCAN-02）
  category:privacy    隐私数据类（SCAN-03）
  rule:RULE-008       只看指定规则（如 RULE-008/RULE-011/SCAN-01 等）

示例:
  node compliance-scan.mjs --project ./my-game --filter severity:block --json
  node compliance-scan.mjs --project ./my-game --filter "category:privacy,category:minor"

检查红线（编号与 references/knowledge/compliance-rules.md 对齐）
  RULE-008 违规分享奖励（分享奖励逻辑）          [category: share]
  RULE-011 未授权IP/品牌关键词               [category: ip]
  RULE-009 随机抽取未公示概率               [category: gacha]
  RULE-010 虚拟货币回流兑换                   [category: currency]
  RULE-012 广告频次超标                       [category: ad]
  RULE-005 未成年人保护缺失                   [category: minor]
  RULE-013 内容安全（UGC 未接入官方审核接口）   [category: content]
  SCAN-01  广告法禁止的绝对化用语                 [category: ad-law]
  SCAN-02  第三方支付（未走微信支付）        [category: payment]
  SCAN-03  用户数据明文存储                   [category: privacy]
`;

// 规则分类映射（用于过滤器）
// 编号体系与 references/knowledge/compliance-rules.md 对齐
//   RULE-XXX = compliance-rules.md 定义的 14 条红线中可由代码扫描检测的条目
//   SCAN-XX  = 代码扫描专属规则（compliance-rules.md 未单列，但属法律/平台风险）
const RULE_CATEGORY = {
  'RULE-008': 'share',
  'RULE-011': 'ip',
  'RULE-009': 'gacha',
  'RULE-010': 'currency',
  'RULE-012': 'ad',
  'RULE-005': 'minor',
  'RULE-013': 'content',
  'SCAN-01': 'ad-law',
  'SCAN-02': 'payment',
  'SCAN-03': 'privacy',
};

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node compliance-scan.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  // 收集所有JS 文件内容
  const jsFiles = collectJsFiles(projectPath);
  const allCode = jsFiles.map((f) => f.content).join('\n');

  const violations = [];
  const warnings = [];

  // RULE-008 违规分享奖励
  checkInduceShare(jsFiles, violations, warnings);
  // RULE-011 未授权IP
  checkUnauthorizedIP(allCode, jsFiles, violations, warnings);
  // RULE-009 随机抽取概率
  checkGachaProbability(allCode, jsFiles, violations, warnings);
  // RULE-010 虚拟货币回流兑换
  checkCurrencyExchange(jsFiles, violations, warnings);
  // RULE-012 广告频次
  checkAdFrequency(allCode, jsFiles, violations, warnings);
  // RULE-005 未成年人保护
  checkMinorProtection(allCode, jsFiles, violations, warnings);
  // RULE-013 敏感内容
  checkSensitiveContent(allCode, jsFiles, violations, warnings);
  // SCAN-01 广告法禁用词
  checkAdLawWords(allCode, jsFiles, violations, warnings);
  // SCAN-02 第三方支付
  checkThirdPartyPayment(allCode, jsFiles, violations, warnings);
  // SCAN-03 用户数据明文
  checkPlainStorage(jsFiles, violations, warnings);

  // 给每条结果打一category 标签（供过滤器使用）
  for (const v of violations) v.category = RULE_CATEGORY[v.rule] || 'other';
  for (const w of warnings) w.category = RULE_CATEGORY[w.rule] || 'other';

  // 解析过滤器（支持单值或多值）
  const filters = parseFilters(args.filter);

  // 校验 filter key 是否合法，不合法的直接中断并提示
  const VALID_FILTER_KEYS = ['severity', 'category', 'rule'];
  const invalidFilters = filters.filter((f) => !VALID_FILTER_KEYS.includes(f.key));
  if (invalidFilters.length > 0) {
    outputError(
      `无效的过滤器 key: ${invalidFilters.map((f) => f.key).join(', ')}`,
      { hint: `合法 key: ${VALID_FILTER_KEYS.join(', ')}（如 severity:block / category:privacy / rule:RULE-008）` },
      args.json,
    );
  }

  let filteredViolations = violations;
  let filteredWarnings = warnings;
  let filterApplied = false;

  if (filters.length > 0) {
    filterApplied = true;
    filteredViolations = violations.filter((v) => matchFilters(v, filters));
    filteredWarnings = warnings.filter((w) => matchFilters(w, filters));
  }

  const status = violations.length === 0 ? 'pass' : 'fail';

  outputSuccess({
    action: 'compliance_scan',
    project: projectPath,
    status,
    totalChecks: 10,
    filterApplied,
    filters: filters.length > 0 ? filters : null,
    violationCount: filteredViolations.length,
    warningCount: filteredWarnings.length,
    totalViolationCount: violations.length,
    totalWarningCount: warnings.length,
    violations: filteredViolations,
    warnings: filteredWarnings,
    scannedFiles: jsFiles.length,
    recommendation: violations.length === 0
      ? (warnings.length === 0 ? '合规检查通过' : `${warnings.length} 个警告项建议修复`)
      : `${violations.length} 个违规项必须修复`,
  }, args.json);
}

/**
 * 解析 --filter 参数为过滤器数组
 * 支持：单值字符串、多值数组、逗号分隔
 * @param {string|string[]|boolean} raw
 * @returns {Array<{key: string, value: string}>}
 */
function parseFilters(raw) {
  if (!raw || raw === true) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const filters = [];
  for (const item of list) {
    // 支持逗号分隔
    for (const part of String(item).split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim().toLowerCase();
      const value = trimmed.slice(colon + 1).trim().toLowerCase();
      if (key && value) filters.push({ key, value });
    }
  }
  return filters;
}

/**
 * 判断一条违规警告是否匹配任一过滤器（OR 关系）
 * @param {object} item {rule, severity, category}
 * @param {Array} filters
 * @returns {boolean}
 */
function matchFilters(item, filters) {
  for (const f of filters) {
    if (f.key === 'severity') {
      // item.severity 可能为 'block'/'warn'，warnings 里的 pass 项 severity 字段无，用 status 判断
      let sev = item.severity;
      if (!sev && item.status === 'pass') sev = 'pass';
      if (sev === f.value) return true;
    } else if (f.key === 'category') {
      if (item.category === f.value) return true;
    } else if (f.key === 'rule') {
      if (item.rule && item.rule.toLowerCase() === f.value) return true;
    }
  }
  return filters.length === 0;
}

function collectJsFiles(projectPath) {
  const results = [];
  const excludeDirs = ['node_modules', '.git', 'miniprogram_npm', 'typings', 'build', 'dist', '.bak'];
  function walk(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        if (excludeDirs.includes(entry)) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (['.js', '.mjs', '.ts'].includes(extname(entry).toLowerCase())) {
          try {
            const content = readFileSync(full, 'utf-8');
            // 剥离注释和字符串字面量，降低误报率
            const cleanContent = stripCommentsAndStrings(content);
            results.push({ path: full, content: cleanContent, rawContent: content });
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }
  walk(projectPath);
  return results;
}

function findInFiles(jsFiles, pattern) {
  const hits = [];
  for (const f of jsFiles) {
    const matches = [...f.content.matchAll(pattern)];
    if (matches.length > 0) {
      hits.push({ file: f.path, count: matches.length, snippet: matches[0][0] });
    }
  }
  return hits;
}

function checkInduceShare(jsFiles, violations, warnings) {
  // 检测词表：仅用于扫描【待审项目代码】中的分享奖励逻辑，用于风险提示，不代表本包自身内容
  const patterns = [
    /share.*?(reward|奖励|获得|赠送|金币|钻石)/gi,
    /转发.*?(得|送|奖励|金币|钻石)/g,
    /分享.*?(得|送)/g,
  ];
  let hits = [];
  for (const p of patterns) hits = hits.concat(findInFiles(jsFiles, p));
  if (hits.length > 0) {
    violations.push({
      rule: 'RULE-008',
      name: '违规分享奖励',
      severity: 'block',
      description: '检测到分享奖励逻辑，可能属于违规分享奖励机制',
      files: hits.slice(0, 5),
      fix: '删除分享即奖励的逻辑，分享应为用户自愿行为，不能与游戏内奖励挂钩',
    });
  } else {
    warnings.push({ rule: 'RULE-008', name: '违规分享奖励', status: 'pass', note: '未检测到违规分享奖励逻辑' });
  }
}

function checkUnauthorizedIP(code, jsFiles, violations, warnings) {
  // 检测词表：仅用于扫描【待审项目代码】中是否引用未授权品牌/IP，用于风险提示，不代表本包自身内容
  const ipKeywords = ['迪士尼', '漫威', '皮卡丘', '宝可梦', 'pokemon', 'mario', '马里奥', '索尼', '海贼王', '火影', '鸣人', '路飞', '原神', '王者荣耀', '和平精英'];
  const found = ipKeywords.filter((k) => code.toLowerCase().includes(k.toLowerCase()));
  if (found.length > 0) {
    violations.push({
      rule: 'RULE-011',
      name: '未授权IP/品牌',
      severity: 'block',
      description: `检测到可能未授权的IP 关键词 ${found.join(', ')}`,
      fix: '确认已获得相关IP授权，否则删除所有相关内容',
    });
  } else {
    warnings.push({ rule: 'RULE-011', name: '未授权IP/品牌', status: 'pass', note: '未检测到已知IP 关键词' });
  }
}

function checkGachaProbability(code, jsFiles, violations, warnings) {
  const gachaPatterns = [/随机抽取|随机获得|概率抽取|gacha|lottery|drop.?rate/i];
  const hasGacha = gachaPatterns.some((p) => p.test(code));
  const hasProbability = /概率|probability|概率公示|drop.?rate/i.test(code);
  if (hasGacha && !hasProbability) {
    violations.push({
      rule: 'RULE-009',
      name: '随机抽取未公示概率',
      severity: 'block',
      description: '检测到随机抽取机制，但未发现概率公示',
      fix: '在游戏内显著位置公示各物品抽取概率',
    });
  } else {
    warnings.push({ rule: 'RULE-009', name: '随机抽取概率', status: 'pass', note: hasGacha ? '已检测到概率公示' : '未检测到随机抽取机制' });
  }
}

function checkCurrencyExchange(jsFiles, violations, warnings) {
  // 检测词表：仅用于扫描【待审项目代码】中的虚拟货币反向兑换逻辑，用于风险提示，不代表本包自身内容
  const patterns = [
    /虚拟货币.*?(兑换|提现|转出).*(?:人民币|元|￥|rmb)/gi,
    /金币.*?提现/gi,
    /钻石.*?(兑换|金币)/gi,
  ];
  let hits = [];
  for (const p of patterns) hits = hits.concat(findInFiles(jsFiles, p));
  if (hits.length > 0) {
    violations.push({
      rule: 'RULE-010',
      name: '虚拟货币反向兑换',
      severity: 'block',
      description: '检测到虚拟货币兑换人民币的逻辑',
      files: hits.slice(0, 3),
      fix: '虚拟货币不可反向兑换人民币，删除相关逻辑',
    });
  } else {
    warnings.push({ rule: 'RULE-010', name: '虚拟货币反向兑换', status: 'pass', note: '未检测到反向兑换逻辑' });
  }
}

function checkAdFrequency(code, jsFiles, violations, warnings) {
  // 检测插屏广告及其频次控制
  const hasInterstitial = /createInterstitialAd/i.test(code);
  // 频次控制特征：时间戳差值比较 / 冷却变量 / setTimeout 节流
  // 不再用宽泛的 interval|frequency 关键词（正常代码出现 interval 就假 pass）
  const hasTimeControl = /Date\.now\(\)\s*-\s*\w*(?:[Aa]d|show|interstitial|插屏)\w*/.test(code)
    || /last(?:Ad|Show|Interstitial)[Tt]ime|adCooldown|adInterval|nextAdTime|lastInterstit/i.test(code)
    || /setTimeout\([^,]*,\s*\d{4,}\)/.test(code);
  if (hasInterstitial && !hasTimeControl) {
    warnings.push({
      rule: 'RULE-012',
      name: '广告频次',
      severity: 'warn',
      description: '检测到插屏广告但未发现明确的时间间隔控制逻辑（Date.now 差值冷却变量/setTimeout节流）',
      fix: '插屏广告应控制展示间隔≥60秒，单次会话≤5次。建议用 lastAdTime 时间戳差值控制',
    });
  } else if (hasInterstitial && hasTimeControl) {
    warnings.push({ rule: 'RULE-012', name: '广告频次', status: 'pass', note: '已检测到时间间隔控制特征' });
  } else {
    warnings.push({ rule: 'RULE-012', name: '广告频次', status: 'pass', note: '未检测到插屏广告' });
  }
}

function checkMinorProtection(code, jsFiles, violations, warnings) {
  const hasAntiAddiction = /checkIsUserAdvisedToRest|防沉迷|antiAddiction|未成年|minor/i.test(code);
  if (!hasAntiAddiction) {
    violations.push({
      rule: 'RULE-005',
      name: '未成年人保护缺失',
      severity: 'block',
      description: '未检测到防沉迷系统接入',
      fix: '接入 wx.checkIsUserAdvisedToRest 和实名认证系统',
    });
  } else {
    warnings.push({ rule: 'RULE-005', name: '未成年人保护', status: 'pass', note: '已检测到防沉迷接入' });
  }
}

function checkSensitiveContent(code, jsFiles, violations, warnings) {
  // 内容安全检测原则：不依赖本地关键词黑名单（词表无法覆盖平台全部标准、且误报率高），
  // 而是检查"有 UGC/用户输入功能的游戏是否接入微信官方内容安全接口"。
  // 微信内容安全接口为服务端接口：security.msgSecCheck（文本）、security.imgSecCheck（图片）；
  // 小游戏另有"游戏内容安全"服务端接口（gamesecurity.mediaCheck 等）；客户端小程序端为 wx.checkText / wx.checkImage。
  const hasUgc = /security\.msgSecCheck|security\.imgSecCheck|gamesecurity\.|wx\.checkText|wx\.checkImage/.test(code);
  const hasUserInput = /wx\.(createInput|createTextArea)|<input|<textarea|onKeyboardInput|onInput|onMessage/.test(code);
  if (!hasUgc && hasUserInput) {
    violations.push({
      rule: 'RULE-013',
      name: '内容安全',
      severity: 'block',
      description: '检测到用户输入/UGC功能，但未接入微信官方内容安全接口（security.msgSecCheck / security.imgSecCheck，小游戏可用 gamesecurity.* 游戏内容安全）',
      fix: '在服务端/云函数接入 security.msgSecCheck 文本检测、security.imgSecCheck 图片检测（小游戏可选用 gamesecurity.mediaCheck），审核通过后再展示用户内容',
    });
  } else if (hasUgc) {
    warnings.push({ rule: 'RULE-013', name: '内容安全', status: 'pass', note: '已接入微信官方内容安全接口' });
  } else {
    warnings.push({ rule: 'RULE-013', name: '内容安全', status: 'pass', note: '未检测到用户输入/UGC功能，不涉及用户内容审核' });
  }
}

function checkAdLawWords(code, jsFiles, violations, warnings) {
  // 检测词表：仅用于扫描【待审项目代码】中的广告法绝对化用语，用于风险提示，不代表本包自身内容。
  // 词库单一真源：references/data/ad-law-words.json（absoluteTerms + falsePromotion），避免与 tests/ad-law-gate.mjs 漂移。
  let forbidden = ['国家级', '最高级', '第一', '最佳', '顶级', '极品', '万能', '神奇'];
  try {
    const lib = JSON.parse(readFileSync(join(SKILL_ROOT, 'references', 'data', 'ad-law-words.json'), 'utf-8'));
    const list = [...(lib.absoluteTerms || []), ...(lib.falsePromotion || [])].map((s) => s.trim()).filter(Boolean);
    if (list.length) forbidden = list;
  } catch (_) { /* 词库缺失时回退内置最小集 */ }
  const found = forbidden.filter((w) => code.includes(w));
  if (found.length > 0) {
    warnings.push({
      rule: 'SCAN-01',
      name: '广告法禁用词',
      severity: 'warn',
      description: `检测到广告法禁用词: ${found.join(', ')}`,
      fix: '替换为合规表述',
    });
  } else {
    warnings.push({ rule: 'SCAN-01', name: '广告法禁用词', status: 'pass', note: '未检测到禁用词' });
  }
}

function checkThirdPartyPayment(code, jsFiles, violations, warnings) {
  // 明确的第三方支付关键词（不含 wechatpay/wxpay，那本是微信支付）
  const thirdPartyPatterns = [
    /alipay|支付宝/i,
    /paypal/i,
    /stripe/i,
    /tenpay(?!.*wx)/i, // 财付通但排除微信通道
    /unionpay|银联/i,
    /apple[\s_]?pay/i,
  ];
  const hasThirdParty = thirdPartyPatterns.some((p) => p.test(code));
  const hasWxPay = /requestPayment|wx\.requestPayment|wx\.pay/i.test(code);
  if (hasThirdParty && !hasWxPay) {
    violations.push({
      rule: 'SCAN-02',
      name: '第三方支付未走微信支付',
      severity: 'block',
      description: '检测到第三方支付接口，未使用微信支付',
      fix: '虚拟支付必须使用 wx.requestPayment，不能接入第三方支付',
    });
  } else {
    warnings.push({ rule: 'SCAN-02', name: '第三方支付', status: 'pass', note: '支付方式合规' });
  }
}

function checkPlainStorage(jsFiles, violations, warnings) {
  const plainStoragePatterns = /setStorageSync.*?(?:openid|idcard|id_card|phone|mobile|passwd|password|token|account|uid)/gi;
  const hits = findInFiles(jsFiles, plainStoragePatterns);
  if (hits.length > 0) {
    warnings.push({
      rule: 'SCAN-03',
      name: '用户数据明文存储',
      severity: 'warn',
      description: '检测到敏感数据明文存储',
      files: hits.slice(0, 3),
      fix: '敏感数据应加密存储或仅存服务端',
    });
  } else {
    warnings.push({ rule: 'SCAN-03', name: '用户数据明文存储', status: 'pass', note: '未检测到明文存储敏感数据' });
  }
}

/**
 * 剥离 JS/TS 代码中的注释和字符串字面量，降低合规扫描的误报率（注释里的分享得金币不应触发违规）
 * 策略：用占位符替换字符串和注释，保留代码结构
 */
function stripCommentsAndStrings(code) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  let lastSignificant = ''; // 上一个非空白字符（用于区分正则与除法）
  // 正则字面量上下文：这些字符关键词之后出现的 / 视为正则开头
  const regexContextChars = new Set(['=', '(', '[', ',', '!', '&', '|', ':', ';', '{', '}', '+', '-', '*', '%', '<', '>', '?']);
  const regexContextKw = ['return', 'typeof', 'instanceof', 'in', 'of', 'await', 'yield', 'case'];

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    // 行注释
    if (!inString && !inBlockComment && !inRegex && ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        result += '\n';
      }
      i++;
      continue;
    }

    // 块注释
    if (!inString && !inLineComment && !inRegex && ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') result += '\n';
      i++;
      continue;
    }

    // 正则字面量（区分除法：仅在正则上下文出现时才视为正则）
    if (!inString && !inLineComment && !inBlockComment && ch === '/' && isRegexContext(lastSignificant, result)) {
      inRegex = true;
      result += '__REGEX__';
      i++;
      continue;
    }
    if (inRegex) {
      if (ch === '\\') {
        i += 2; // 跳过转义
        continue;
      }
      if (ch === '/') {
        inRegex = false;
        lastSignificant = '/';
        i++;
        // 跳过正则标志（g/i/m/s/u/y）
        while (i < code.length && /[gimsuy]/.test(code[i])) i++;
        continue;
      }
      if (ch === '\n') {
        // 正则不应跨行，视为异常终止
        inRegex = false;
        result += '\n';
      }
      i++;
      continue;
    }

    // 字符串
    if (!inString && !inBlockComment && !inRegex && (ch === '"' || ch === "'" || ch === '`')) {
      inString = true;
      stringChar = ch;
      result += '__STR__';
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2; // 跳过转义字符
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    result += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  return result;

  /**
   * 判断 / 是正则开头还是除法
   * @param {string} last 上一个非空白字符
   * @param {string} res 当前 result（用于检测关键词结构）
   */
  function isRegexContext(last, res) {
    if (!last) return true; // 文件开头
    if (regexContextChars.has(last)) return true;
    for (const kw of regexContextKw) {
      if (res.endsWith(kw)) return true;
    }
    return false;
  }
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));


