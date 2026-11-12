#!/usr/bin/env node
'use strict';
// 审计覆盖台账生成器（T-12 / A6 / A9）。
// 枚举必须确定性：**遍历全历史 + 按提交日期过滤**，禁用 `git log --since`——
// 后者会剪枝遍历，本轮实测同一窗口 709 vs 590、漏扫 123 个文件。
// 台账只如实记录缺口：unauditedCount > 0 时输出 PARTIAL，绝不输出「全量已覆盖」。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LEVELS = new Set(['static', 'simulation', 'runtime', 'artifact']);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Windows 盘符绝对路径（`D:/…`、`D:\…`）会被 SCHEME 命中——单字母 + 冒号长得就像 URI scheme。
// 若按 scheme 跳过存在性核对，「全部标已审 + 证据指向不存在的 D:/…」就能凭空造出满覆盖
// （2026-11-12 本机实测：709 个文件全部伪登记 → COVERAGE FULL / unaudited=0 / --check exit 0）。
// 现实里没有单字母的 URI scheme，所以盘符一律按路径核存在。
const DRIVE_PATH = /^[a-zA-Z]:/;
const COMMIT_HEADER = /^([0-9a-f]{40})\t(\d+)$/;
const MAX_BUFFER = 256 * 1024 * 1024;

function git(repo, args) {
  // core.quotepath 默认会把非 ASCII 路径转义成 "\345\256\211…" 字面量：
  // 那种 key 既对不上真实文件（exists 误判已删），也永远匹配不上按真实路径写的审计登记。
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) throw new Error('GIT_FAILED: ' + String((r.stderr || r.error?.message || '')).trim().slice(0, 200));
  return r.stdout;
}

// 全历史遍历，再按提交日期过滤。返回窗口内的提交与文件并集（含已删文件）。
function enumerateWindow(repo, sinceMs, untilMs, ref = 'HEAD') {
  const out = git(repo, ['log', '--pretty=%H%x09%ct', '--name-only', ref]);
  const files = new Map();
  const commits = [];
  let current = null;
  for (const line of out.split('\n')) {
    const header = COMMIT_HEADER.exec(line);
    if (header) {
      const at = Number(header[2]) * 1000;
      current = at >= sinceMs && at <= untilMs ? { sha: header[1], at } : null;
      if (current) commits.push(current);
      continue;
    }
    const file = line.trim();
    if (!file || !current) continue;
    const prev = files.get(file);
    if (!prev || current.at > prev.lastCommitAt) files.set(file, { lastCommitAt: current.at, sha: current.sha });
  }
  return { commits, files };
}

// 对照用：`git log --since` 的剪枝枚举。只用于证明粒度缺口，不作为台账来源。
function enumerateWithSince(repo, sinceIso, ref = 'HEAD') {
  const out = git(repo, ['log', '--since=' + sinceIso, '--pretty=%H', '--name-only', ref]);
  const files = new Set();
  for (const line of out.split('\n')) {
    const value = line.trim();
    if (!value || /^[0-9a-f]{40}$/.test(value)) continue;
    files.add(value);
  }
  return files;
}

function loadRecords(file, repo, windowFiles) {
  const invalid = [];
  const outOfWindow = [];
  const byPath = new Map();
  if (!file) return { byPath, invalid, outOfWindow };
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error('RECORDS_UNREADABLE: ' + error.message); }
  if (!value || value.schema !== 1 || !Array.isArray(value.entries)) throw new Error('RECORDS_SCHEMA: 需要 schema=1 与 entries 数组');
  for (const entry of value.entries) {
    const reject = reason => invalid.push({ path: entry && entry.path, reason });
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) { reject('缺少 path'); continue; }
    const key = entry.path.replace(/\\/g, '/');
    if (byPath.has(key)) { reject('同一文件重复登记'); continue; }
    if (!LEVELS.has(entry.level)) { reject('level 必须是 static|simulation|runtime|artifact'); continue; }
    if (typeof entry.evidenceRef !== 'string' || !entry.evidenceRef.trim()) { reject('缺少 evidenceRef，不得标已审'); continue; }
    // 无 scheme 的 evidenceRef 按路径处理，必须真实存在——否则「全部标已审」就能凭空造出满覆盖
    // 盘符绝对路径虽然命中 SCHEME，仍必须按路径核存在（见 DRIVE_PATH 注释）
    if (DRIVE_PATH.test(entry.evidenceRef) || !SCHEME.test(entry.evidenceRef)) {
      const target = path.isAbsolute(entry.evidenceRef) ? entry.evidenceRef : path.resolve(repo, entry.evidenceRef);
      if (!fs.existsSync(target)) { reject('evidenceRef 指向的文件不存在: ' + entry.evidenceRef); continue; }
    }
    if (!windowFiles.has(key)) outOfWindow.push(key);
    byPath.set(key, { level: entry.level, evidenceRef: entry.evidenceRef, auditedAt: entry.auditedAt || null });
  }
  return { byPath, invalid, outOfWindow };
}

function buildLedger(options) {
  const repo = path.resolve(options.repo || process.cwd());
  const untilMs = options.until ? Date.parse(options.until) : Date.now();
  const sinceMs = options.since ? Date.parse(options.since) : untilMs - (Number(options.days) || 10) * 86400000;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) throw new Error('INVALID_WINDOW');
  if (sinceMs > untilMs) throw new Error('INVALID_WINDOW: since 晚于 until');
  const { commits, files } = enumerateWindow(repo, sinceMs, untilMs, options.ref || 'HEAD');
  const { byPath, invalid, outOfWindow } = loadRecords(options.records, repo, files);
  // 「现存」有两个口径：当前工作树（决定能不能逐行通读）与枚举 ref 当时（决定台账可复现）。
  // 两者都记，免得 HEAD 前进后同一窗口的 existing 数字漂移却无法解释。
  const atRef = new Set(git(repo, ['ls-tree', '-r', '--name-only', options.ref || 'HEAD']).split('\n').map(line => line.trim()).filter(Boolean));
  const entries = [...files.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([file, meta]) => {
    const record = byPath.get(file);
    return {
      path: file,
      exists: fs.existsSync(path.join(repo, file)),
      existsAtRef: atRef.has(file),
      audited: Boolean(record),
      level: record ? record.level : null,
      evidenceRef: record ? record.evidenceRef : null,
      lastCommitAt: new Date(meta.lastCommitAt).toISOString(),
    };
  });
  const auditedCount = entries.filter(item => item.audited).length;
  const unauditedCount = entries.length - auditedCount;
  return {
    schema: 1,
    repo,
    ref: options.ref || 'HEAD',
    enumeration: 'full-history-walk+commit-date-filter',
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), days: options.days ?? null },
    commits: commits.length,
    totalFiles: entries.length,
    existingFiles: entries.filter(item => item.exists).length,
    existingAtRef: entries.filter(item => item.existsAtRef).length,
    deletedFiles: entries.filter(item => !item.exists).length,
    auditedCount,
    unauditedCount,
    coverage: unauditedCount === 0 && invalid.length === 0 ? 'FULL' : 'PARTIAL',
    invalidRecords: invalid,
    outOfWindow,
    files: entries,
  };
}

function main(argv) {
  const options = {};
  let asJson = false, check = false, compareSince = false;
  const flags = new Set(['--repo', '--days', '--since', '--until', '--records', '--out', '--ref']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { asJson = true; continue; }
    if (arg === '--check') { check = true; continue; }
    if (arg === '--compare-since') { compareSince = true; continue; }
    if (!flags.has(arg)) { console.error('INVALID_ARGUMENT: ' + arg); return 2; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) { console.error('INVALID_ARGUMENT: ' + arg + ' 需要值'); return 2; }
    options[arg.slice(2)] = value;
  }
  if (options.days !== undefined && (!/^\d{1,4}$/.test(options.days) || Number(options.days) < 1 || Number(options.days) > 3650)) {
    console.error('INVALID_ARGUMENT: --days 必须是 1..3650 的整数');
    return 2;
  }
  let ledger;
  try { ledger = buildLedger(options); }
  catch (error) { console.error(error.message); return 2; }
  if (compareSince) {
    const pruned = enumerateWithSince(ledger.repo, ledger.window.since, ledger.ref);
    const full = new Set(ledger.files.map(item => item.path));
    ledger.sinceComparison = {
      fullHistoryFiles: full.size,
      sinceFiles: pruned.size,
      missedBySince: [...full].filter(file => !pruned.has(file)).sort(),
    };
  }
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), JSON.stringify(ledger, null, 1) + '\n');
  }
  if (asJson) console.log(JSON.stringify(ledger, null, 1));
  else {
    console.log(`COVERAGE ${ledger.coverage} commits=${ledger.commits} totalFiles=${ledger.totalFiles} existing=${ledger.existingFiles} deleted=${ledger.deletedFiles} audited=${ledger.auditedCount} unaudited=${ledger.unauditedCount}`);
    console.log(`window ${ledger.window.since} .. ${ledger.window.until} enumeration=${ledger.enumeration}`);
    for (const item of ledger.invalidRecords) console.log(`INVALID_RECORD ${item.path} :: ${item.reason}`);
    for (const item of ledger.outOfWindow) console.log(`OUT_OF_WINDOW ${item}`);
    if (ledger.sinceComparison) {
      const c = ledger.sinceComparison;
      console.log(`SINCE_COMPARISON full=${c.fullHistoryFiles} since=${c.sinceFiles} missedBySince=${c.missedBySince.length}`);
    }
    if (ledger.coverage === 'FULL') console.log('全量已覆盖（unaudited=0，且无非法登记）');
    // 措辞刻意不含「全量已覆盖」四字：下游按该短语判「是否宣称满覆盖」时，缺口提示本身不得触发它
    else console.log(`覆盖不完整：${ledger.unauditedCount} 个文件未逐行通读，${ledger.invalidRecords.length} 条登记非法；禁止宣称完整覆盖`);
  }
  if (!check) return 0;
  return ledger.coverage === 'FULL' ? 0 : 1;
}

module.exports = { buildLedger, enumerateWindow, enumerateWithSince, loadRecords, LEVELS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));