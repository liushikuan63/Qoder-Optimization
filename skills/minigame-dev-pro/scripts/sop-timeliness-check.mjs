#!/usr/bin/env node
/**
 * sop-timeliness-check.mjs SOP 时效巡检（质量自检工具）
 * 用法：
 *   node sop-timeliness-check.mjs [--json] [--sop <文件名] [--threshold <天数>] [--dir <SOP目录>]
 *
 * 能力：
 *  - 扫描 references/knowledge/sop/*.md 全部 SOP 的时效元数据
 *  - 按下次核实日期判定状态：ok / due-soon / overdue / missing-meta / malformed-date
 *  - 输出巡检报告，退出码反映是否存在需处理项 *
 * 退出码：
 *  - 0：全部 SOP 均 ok 或 due-soon（健康）
 *  - 1：存在 overdue / missing-meta / malformed-date（需处理）
 *
 * 设计原则：
 *  - 无副作用：只读 SOP 文件，不修改任何内容
 *  - 严格：缺元数据/日期格式非法一律视为 P0 缺陷
 *  - 可组合：JSON 输出供 CI / knowledge-filter 调用
 *
 * 详见 references/engine/evolution-protocol.md 第十节 "SOP时效巡检机制"
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');
const SOP_DIR = join(SKILL_ROOT, 'references', 'knowledge', 'sop');

const HELP = `SOP 时效巡检（扫描8 份操作手册的核实周期）
用法:
  node sop-timeliness-check.mjs [选项]

选项:
  --json              以 JSON 格式输出
  --sop <文件名>      只检指定 SOP（如 icp-filing-sop.md）
  --threshold <天数>  due-soon 预警阈值，默认 14 天
  --dir <SOP目录>     指定 SOP 目录（默认 references/knowledge/sop，用于测试自定义）
  --help              显示帮助

状态说明
  ok              未到期（距下次核实> 阈值天数）
  due-soon        即将到期（距下次核实 ≤阈值天数，且未过期）
  overdue         已过期（今天 > 下次核实日期）→ 需立即核实
  missing-meta    缺少任一元数据行（最后更新最后核实核实周期/下次核实）→ P0 缺陷
  malformed-date  日期格式非法或不是有效日期→ P0 缺陷

退出码:
  0  全部 ok / due-soon
  1  存在 overdue / missing-meta / malformed-date

示例:
  node sop-timeliness-check.mjs --json
  node sop-timeliness-check.mjs --sop icp-filing-sop.md
`;

// 元数据行的正则（支持全角/半角冒号容错）
const RE_LAST_UPDATE = /^>\s*最后更新[:：]\s*(.+?)\s*$/;
const RE_LAST_VERIFY = /^>\s*最后核实[:：]\s*(.+?)\s*$/;
const RE_CYCLE = /^>\s*核实周期[:：]\s*(.+?)\s*$/;
const RE_NEXT_VERIFY = /^>\s*下次核实[:：]\s*(.+?)\s*$/;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DUE_SOON_DEFAULT = 14; // 天

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const json = !!args.json;
  const threshold = parseThreshold(args.threshold, json);
  const sopFilter = args.sop ? String(args.sop) : null;
  const dir = args.dir ? String(args.dir) : SOP_DIR;

  if (!existsSync(dir)) {
    outputError(`SOP 目录不存在: ${dir}`, { hint: '请确认 skill 安装完整，references/knowledge/sop/ 应含 8 份 SOP（或用 --dir 指定）' }, json);
  }

  // 收集 SOP 文件
  let files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  if (sopFilter) {
    // 兼容带/不带 .md 后缀的 --sop 参数（如 icp-filing-sop 或 icp-filing-sop.md）
    files = files.filter((f) => f === sopFilter || f === sopFilter.replace(/\.md$/, '') + '.md');
    if (files.length === 0) {
      outputError(`未找到 SOP: ${sopFilter}`, { hint: '可用 SOP 见 references/knowledge/sop/ 目录' }, json);
    }
  }

  const today = todayDate();
  const items = files.map((f) => inspectSop(join(dir, f), f, today, threshold));

  // 汇总状态分布
  const dist = { ok: 0, 'due-soon': 0, overdue: 0, 'missing-meta': 0, 'malformed-date': 0 };
  for (const it of items) dist[it.status] = (dist[it.status] || 0) + 1;

  // 健康度评分：起始 10，每一 overdue 扣 2，任一 missing-meta/malformed-date 直接 0
  let health = 10;
  if (dist['missing-meta'] > 0 || dist['malformed-date'] > 0) {
    health = 0;
  } else {
    health = Math.max(0, 10 - dist.overdue * 2);
  }

  // 待处理项（overdue / missing-meta / malformed-date）
  const actionRequired = items.filter((it) =>
    it.status === 'overdue' || it.status === 'missing-meta' || it.status === 'malformed-date'
  );

  const hasIssues = actionRequired.length > 0;
  const status = hasIssues ? 'action-required' : 'healthy';

  const report = {
    ok: !hasIssues,
    action: 'sop_timeliness_check',
    scanDate: today.iso,
    thresholdDays: threshold,
    totalSops: items.length,
    statusDistribution: dist,
    healthScore: health,
    status,
    items,
    actionRequired: actionRequired.map((it) => ({
      file: it.file,
      status: it.status,
      reason: it.reason || null,
      nextVerify: it.nextVerify ? it.nextVerify.iso : null,
      daysOverdue: it.daysOverdue,
    })),
    recommendation: hasIssues
      ? `${actionRequired.length} 个 SOP 需处理（overdue/缺元数据/日期非法），详见 actionRequired`
      : `全部 ${items.length} 个 SOP 时效正常`,
  };

  // 输出（自定义输出，控制退出码：有需处理项则 exit 1）
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printReport(report);
  }
  process.exit(hasIssues ? 1 : 0);
}

/**
 * 巡检单个 SOP 文件
 */
function inspectSop(filePath, fileName, today, threshold) {
  const item = {
    file: fileName,
    lastUpdate: null,
    lastVerify: null,
    cycle: null,
    nextVerify: null,
    status: null,
    daysRemaining: null,
    daysOverdue: null,
    reason: null,
  };

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    item.status = 'missing-meta';
    item.reason = `读取失败: ${e.message}`;
    return item;
  }

  // 只解析头部元数据（前 20 行足够）
  const headLines = content.split('\n').slice(0, 20);

  let lastUpdateRaw = null;
  let lastVerifyRaw = null;
  let cycleRaw = null;
  let nextVerifyRaw = null;

  for (const line of headLines) {
    if (!lastUpdateRaw) {
      const m = line.match(RE_LAST_UPDATE);
      if (m) lastUpdateRaw = m[1];
    }
    if (!lastVerifyRaw) {
      const m = line.match(RE_LAST_VERIFY);
      if (m) lastVerifyRaw = m[1];
    }
    if (!cycleRaw) {
      const m = line.match(RE_CYCLE);
      if (m) cycleRaw = m[1];
    }
    if (!nextVerifyRaw) {
      const m = line.match(RE_NEXT_VERIFY);
      if (m) nextVerifyRaw = m[1];
    }
  }

  item.cycle = cycleRaw;

  // 缺元数据检查
  const missing = [];
  if (!lastUpdateRaw) missing.push('最后更新');
  if (!lastVerifyRaw) missing.push('最后核实');
  if (!cycleRaw) missing.push('核实周期');
  if (!nextVerifyRaw) missing.push('下次核实');
  if (missing.length > 0) {
    item.status = 'missing-meta';
    item.reason = `缺少元数据 ${missing.join('、')}（SOP 头部必须含最后更新、最后核实、核实周期、下次核实 4 行）`;
    return item;
  }

  // 解析日期（剥离可能的 ✓ 等标记）
  const luDate = parseDate(stripMarkers(lastUpdateRaw));
  const lvDate = parseDate(stripMarkers(lastVerifyRaw));
  const nvDate = parseDate(stripMarkers(nextVerifyRaw));

  item.lastUpdate = luDate ? { iso: luDate.iso } : { raw: lastUpdateRaw };
  item.lastVerify = lvDate ? { iso: lvDate.iso } : { raw: lastVerifyRaw };
  item.nextVerify = nvDate ? { iso: nvDate.iso } : { raw: nextVerifyRaw };

  // 日期格式合法性
  if (!luDate || !lvDate || !nvDate) {
    const bad = [];
    if (!luDate) bad.push(`最后更新="${lastUpdateRaw}"`);
    if (!lvDate) bad.push(`最后核实="${lastVerifyRaw}"`);
    if (!nvDate) bad.push(`下次核实="${nextVerifyRaw}"`);
    item.status = 'malformed-date';
    item.reason = `日期格式非法（应为 YYYY-MM-DD）：${bad.join('、')}`;
    return item;
  }

  // 逻辑校验：下次核实应大致等于最后核实+核实周期（仅警告，不阻断）
  // 这里只做状态判定，不强校验周期一致性（避免误报）
  // 状态判定（基于 下次核实）
  const diffMs = nvDate.time - today.time;
  const dayMs = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.ceil(diffMs / dayMs);
  item.daysRemaining = daysRemaining;

  if (daysRemaining < 0) {
    item.status = 'overdue';
    item.daysOverdue = -daysRemaining;
    item.reason = `已过期${-daysRemaining} 天（下次核实: ${nvDate.iso}），需立即核实`;
  } else if (daysRemaining <= threshold) {
    item.status = 'due-soon';
    item.reason = `即将到期，剩余${daysRemaining} 天（下次核实: ${nvDate.iso}）`;
  } else {
    item.status = 'ok';
    item.reason = `剩余 ${daysRemaining} 天（下次核实: ${nvDate.iso}）`;
  }

  return item;
}

/**
 * 剥离日期字符串中的标记符号（如✓、括号说明）
 * 取第一个 YYYY-MM-DD 模式
 */
function stripMarkers(raw) {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : raw.trim();
}

/**
 * 解析日期字符串，返回 { iso, time } 或 null（非法）
 */
function parseDate(str) {
  const m = str.match(RE_DATE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 构造 Date（UTC 中午，避免时区越界）
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  // 校验真实日期（防止 2026-02-30 这类）
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return { iso: `${m[1]}-${m[2]}-${m[3]}`, time: dt.getTime() };
}

/**
 * 返回今天的日期对象（UTC 中午，与 parseDate 对齐，避免时区导致的状态抖动）
 */
function todayDate() {
  const now = new Date();
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return { iso: `${y}-${mo}-${d}`, time: dt.getTime() };
}

/**
 * 解析 --threshold 参数
 */
function parseThreshold(raw, json) {
  if (!raw || raw === true) return DUE_SOON_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    outputError(`无效的 --threshold 值: ${raw}`, { hint: '应为非负整数，默认 14' }, json);
  }
  return n;
}

/**
 * 文本模式报告输出
 */
function printReport(r) {
  const W = process.stdout;
  W.write(`\n=== SOP 时效巡检报告 ===\n`);
  W.write(`巡检日期: ${r.scanDate}\n`);
  W.write(`预警阈值 ${r.thresholdDays} 天\n`);
  W.write(`巡检数量: ${r.totalSops}\n`);
  W.write(`健康度   ${r.healthScore}/10\n`);
  W.write(`整体状态 ${r.status === 'healthy' ? '✓ 健康' : '✗ 需处理'}\n\n`);

  W.write(`状态分布 ok=${r.statusDistribution.ok}  due-soon=${r.statusDistribution['due-soon']}  overdue=${r.statusDistribution.overdue}  missing-meta=${r.statusDistribution['missing-meta']}  malformed-date=${r.statusDistribution['malformed-date']}\n\n`);

  W.write(`明细:\n`);
  W.write(`${'SOP'.padEnd(34)}  ${'最后更新'.padEnd(12)}  ${'最后核实'.padEnd(12)}  ${'下次核实'.padEnd(12)}  ${'状态'.padEnd(15)}  剩余/过期\n`);
  W.write(`${'-'.repeat(120)}\n`);
  for (const it of r.items) {
    const lu = it.lastUpdate ? (it.lastUpdate.iso || it.lastUpdate.raw || '-') : '-';
    const lv = it.lastVerify ? (it.lastVerify.iso || it.lastVerify.raw || '-') : '-';
    const nv = it.nextVerify ? (it.nextVerify.iso || it.nextVerify.raw || '-') : '-';
    const dayInfo = it.status === 'overdue'
      ? `过期 ${it.daysOverdue}天`
      : it.daysRemaining !== null
        ? `剩余 ${it.daysRemaining}天`
        : '-';
    const statusLabel = statusIcon(it.status) + it.status;
    W.write(`${it.file.padEnd(34)}  ${lu.padEnd(12)}  ${lv.padEnd(12)}  ${nv.padEnd(12)}  ${statusLabel.padEnd(15)}  ${dayInfo}\n`);
  }

  if (r.actionRequired.length > 0) {
    W.write(`\n待处理项 (${r.actionRequired.length}):\n`);
    for (const a of r.actionRequired) {
      W.write(`  [${a.status}] ${a.file}\n`);
      if (a.reason) W.write(`      → ${a.reason}\n`);
    }
    W.write(`\n建议: ${r.recommendation}\n`);
  } else {
    W.write(`\n✓ 全部 SOP 时效正常，无需处理。\n`);
  }
}

function statusIcon(s) {
  switch (s) {
    case 'ok': return '✓ ';
    case 'due-soon': return '⚠ ';
    case 'overdue': return '✗ ';
    case 'missing-meta': return '✗ ';
    case 'malformed-date': return '✗ ';
    default: return '  ';
  }
}

main().catch((e) => {
  process.stderr.write(`未捕获异常 ${e.message}\n`);
  process.exit(1);
});

