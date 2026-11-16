#!/usr/bin/env node
'use strict';
/**
 * 生产就绪审查报告校验器。
 *
 * 只判「报告自身是否诚实、完整、可核对」，不判产品好坏，也不判严重度定得对不对：
 *  - 清单 ID 全覆盖：漏项＝假装检查过，判红；
 *  - finding / pass 必须有真实存在且落在被审查仓库内的证据；
 *  - not-applicable / unverified 必须写理由；
 *  - 没查的项不许带严重度（否则前十排序被污染）；
 *  - 前十必须等于「严重度降序 → 风险类别 → ID」的确定排序前缀。
 *
 * 清单解析不出 ID、或清单自身有重号，一律 exit 2（环境/真源错误），绝不静默跳过——
 * 否则覆盖判据空对空恒真。
 *
 * 用法：node readiness-report-check.cjs <report.json> [--checklist <清单.md>] [--json]
 * 退出码：0 通过（可带 advisory）／1 有违约／2 用法或环境错误
 */
const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['saas', 'web-app', 'api-service', 'internal-service', 'cli', 'library', 'desktop', 'mobile', 'agent-config']);
const VERDICTS = new Set(['finding', 'pass', 'not-applicable', 'unverified']);
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const RISKS = ['data-leak', 'money-loss', 'outage', 'other'];
const MAX_TOP = 10;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const ID_ROW = /^\|\s*([A-Z]{2,4}-\d{2})\s*\|/gm;
const DEFAULT_CHECKLIST = path.join(__dirname, '..', 'skills', 'production-readiness-audit', 'references', 'checklist.md');

const text = value => typeof value === 'string' && value.trim().length > 0;
const severityRank = value => SEVERITIES.indexOf(value);
const riskRank = value => RISKS.indexOf(value);

/** 从清单 markdown 解析 ID 全集（表格首列）。重复号由调用方判错，不在这里静默去重。 */
function checklistIds(markdown) {
  return [...String(markdown).matchAll(new RegExp(ID_ROW.source, 'gm'))].map(match => match[1]);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function checkEvidence(entry, root, label, violations) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    violations.push(`${label}: evidence 条目必须是对象`);
    return false;
  }
  if (!text(entry.path)) {
    violations.push(`${label}: evidence 缺 path`);
    return false;
  }
  if (/[\u0000-\u001f]/.test(entry.path)) {
    violations.push(`${label}: evidence path 含控制字符`);
    return false;
  }
  const abs = path.resolve(root, entry.path);
  if (!isInside(root, abs)) {
    violations.push(`${label}: evidence 越出被审查仓库（${entry.path}）`);
    return false;
  }
  let stat = null;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    violations.push(`${label}: evidence 文件不存在或不是普通文件（${entry.path}）`);
    return false;
  }
  if (entry.line !== undefined) {
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      violations.push(`${label}: evidence line 必须是 ≥1 的整数`);
      return false;
    }
    let lines = null;
    try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length; } catch { lines = null; }
    if (lines === null) {
      violations.push(`${label}: evidence 文件读不出，无法核对行号（${entry.path}）`);
      return false;
    }
    if (entry.line > lines) {
      violations.push(`${label}: evidence line ${entry.line} 超出文件行数 ${lines}（${entry.path}）`);
      return false;
    }
  }
  return true;
}

/**
 * @param {object} report 已解析的报告对象
 * @param {{checklist: string}} options 清单原文（真源由调用方读入）
 * @returns {{ok: boolean, violations: string[], advisory: string[], readings: object}}
 */
function verify(report, options = {}) {
  const violations = [];
  const advisory = [];
  const ids = checklistIds(options.checklist);
  if (!ids.length) throw Object.assign(new Error('清单解析不出任何 ID：覆盖判据无法执行'), { code: 'CHECKLIST_UNPARSEABLE' });
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicated.length) throw Object.assign(new Error('清单存在重号：' + [...new Set(duplicated)].join(',')), { code: 'CHECKLIST_DUPLICATE_ID' });
  const known = new Set(ids);

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, violations: ['报告必须是 JSON 对象'], advisory, readings: { checklistIds: ids.length } };
  }
  if (report.schema !== 1) violations.push(`schema 必须是 1（实际 ${JSON.stringify(report.schema)}）`);

  const product = report.product;
  let root = null;
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    violations.push('缺 product 对象');
  } else {
    if (!text(product.name)) violations.push('product.name 不能为空');
    if (!KINDS.has(product.kind)) violations.push(`product.kind 非法：${JSON.stringify(product.kind)}（可选 ${[...KINDS].join('/')}）`);
    if (!text(product.root) || !path.isAbsolute(product.root)) {
      violations.push('product.root 必须是绝对路径');
    } else {
      let stat = null;
      try { stat = fs.statSync(product.root); } catch { stat = null; }
      if (!stat || !stat.isDirectory()) violations.push(`product.root 不是存在的目录：${product.root}`);
      else root = fs.realpathSync.native(product.root);
    }
  }

  const items = Array.isArray(report.items) ? report.items : null;
  if (!items || !items.length) {
    violations.push('items 必须是非空数组：空报告不算审查过');
    return { ok: false, violations, advisory, readings: { checklistIds: ids.length, items: 0 } };
  }

  const seen = new Map();
  const findings = [];
  const tally = { finding: 0, pass: 0, 'not-applicable': 0, unverified: 0 };
  let evidenceChecked = 0;

  items.forEach((item, index) => {
    const label = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      violations.push(`${label}: 必须是对象`);
      return;
    }
    const id = item.id;
    if (!text(id) || !known.has(id)) {
      violations.push(`${label}: ID 不在清单内（${JSON.stringify(id)}）`);
      return;
    }
    if (seen.has(id)) {
      violations.push(`${label}: ID 重复（${id}）`);
      return;
    }
    seen.set(id, item);
    const verdict = item.verdict;
    if (!VERDICTS.has(verdict)) {
      violations.push(`${id}: verdict 非法（${JSON.stringify(verdict)}）`);
      return;
    }
    tally[verdict] += 1;

    if (verdict === 'finding') {
      if (!SEVERITIES.includes(item.severity)) violations.push(`${id}: finding 缺合法 severity`);
      if (!RISKS.includes(item.risk)) violations.push(`${id}: finding 缺合法 risk`);
      if (!text(item.note)) violations.push(`${id}: finding 必须写清风险是什么（note）`);
      if (!Array.isArray(item.evidence) || !item.evidence.length) {
        violations.push(`${id}: finding 必须给证据，无证据的问题不算发现`);
      } else if (root) {
        for (const entry of item.evidence) if (checkEvidence(entry, root, id, violations)) evidenceChecked += 1;
      }
      if (SEVERITIES.includes(item.severity) && RISKS.includes(item.risk)) findings.push(item);
    } else if (verdict === 'pass') {
      if (!Array.isArray(item.evidence) || !item.evidence.length) {
        violations.push(`${id}: pass 必须给证据，「看起来没问题」不算通过`);
      } else if (root) {
        for (const entry of item.evidence) if (checkEvidence(entry, root, id, violations)) evidenceChecked += 1;
      }
    } else if (verdict === 'not-applicable') {
      if (!text(item.reason)) violations.push(`${id}: not-applicable 必须写为什么不适用`);
      if (item.severity !== undefined) violations.push(`${id}: not-applicable 不许带 severity`);
    } else {
      if (!text(item.reason)) violations.push(`${id}: unverified 必须写为什么无法确认`);
      if (item.severity !== undefined) violations.push(`${id}: unverified 不许带 severity（没查的项不能排严重度）`);
      if (item.risk !== undefined) violations.push(`${id}: unverified 不许带 risk`);
    }
  });

  const missing = ids.filter(id => !seen.has(id));
  if (missing.length) {
    violations.push(`清单有 ${missing.length} 项未定性（漏项＝假装检查过）：${missing.slice(0, 12).join(',')}${missing.length > 12 ? '…' : ''}`);
  }

  const ordered = findings.slice().sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity)
    || riskRank(a.risk) - riskRank(b.risk)
    || String(a.id).localeCompare(String(b.id), 'en'));
  const expected = ordered.slice(0, MAX_TOP).map(item => item.id);
  const top = report.top;
  if (!Array.isArray(top)) {
    violations.push('top 必须是数组（没有问题时给空数组）');
  } else {
    const topDup = top.filter((id, index) => top.indexOf(id) !== index);
    if (topDup.length) violations.push(`top 有重复 ID：${[...new Set(topDup)].join(',')}`);
    const notFinding = top.filter(id => !findings.some(item => item.id === id));
    if (notFinding.length) violations.push(`top 含非 finding 项：${notFinding.join(',')}`);
    if (top.length !== expected.length) violations.push(`top 应为 ${expected.length} 条（min(10, finding 数)），实际 ${top.length} 条`);
    if (JSON.stringify(top) !== JSON.stringify(expected)) {
      violations.push(`top 顺序不符合「严重度→风险类别→ID」规则；期望 [${expected.join(',')}]，实际 [${top.join(',')}]`);
    }
  }

  const unverifiedShare = tally.unverified / items.length;
  const notApplicableShare = tally['not-applicable'] / items.length;
  if (unverifiedShare > 0.3) advisory.push(`无法确认占比 ${(unverifiedShare * 100).toFixed(1)}% > 30%：结论覆盖不足，别当「已审查完毕」`);
  if (notApplicableShare > 0.6) advisory.push(`不适用占比 ${(notApplicableShare * 100).toFixed(1)}% > 60%：回头核对产品类型判断是否过窄`);
  if (!root) advisory.push('product.root 不可用：证据存在性未核对（已判违约，修好路径后重跑）');

  return {
    ok: violations.length === 0,
    violations,
    advisory,
    readings: {
      checklistIds: ids.length, items: items.length, ...tally,
      topCount: Array.isArray(top) ? top.length : 0, evidenceChecked,
    },
  };
}

function readReport(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Object.assign(new Error('报告不是普通文件：' + file), { code: 'REPORT_UNREADABLE' });
  if (stat.size > MAX_REPORT_BYTES) throw Object.assign(new Error('报告超过 4MiB：' + file), { code: 'REPORT_TOO_LARGE' });
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw Object.assign(new Error('报告不是有效 JSON：' + error.message), { code: 'REPORT_INVALID_JSON' }); }
}

function main(argv) {
  const args = [...argv];
  let reportFile = null;
  let checklistFile = DEFAULT_CHECKLIST;
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') json = true;
    else if (arg === '--checklist') {
      if (!args[0] || args[0].startsWith('--')) throw Object.assign(new Error('--checklist 缺值'), { code: 'USAGE' });
      checklistFile = args.shift();
    } else if (arg.startsWith('--')) throw Object.assign(new Error('未知参数：' + arg), { code: 'USAGE' });
    else if (reportFile === null) reportFile = arg;
    else throw Object.assign(new Error('只接受一个报告文件'), { code: 'USAGE' });
  }
  if (!reportFile) throw Object.assign(new Error('用法：readiness-report-check.cjs <report.json> [--checklist <清单.md>] [--json]'), { code: 'USAGE' });

  const report = readReport(reportFile);
  const checklist = fs.readFileSync(checklistFile, 'utf8');
  const result = verify(report, { checklist });
  if (json) console.log(JSON.stringify({ schema: 1, verdict: result.ok ? 'OK' : 'VIOLATIONS', ...result }, null, 1));
  else {
    console.log(`清单 ${result.readings.checklistIds} 项；报告 ${result.readings.items} 项；finding=${result.readings.finding} pass=${result.readings.pass} 不适用=${result.readings['not-applicable']} 无法确认=${result.readings.unverified}`);
    for (const violation of result.violations) console.log('违约 ' + violation);
    for (const item of result.advisory) console.log('提示 ' + item);
    console.log(result.ok ? 'VERDICT=OK' : 'VERDICT=VIOLATIONS');
  }
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { verify, checklistIds, readReport, SEVERITIES, RISKS, KINDS, MAX_TOP, DEFAULT_CHECKLIST };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.log(JSON.stringify({ schema: 1, verdict: 'ERROR', code: error.code || 'ERROR', message: error.message }));
    process.exitCode = 2;
  }
}