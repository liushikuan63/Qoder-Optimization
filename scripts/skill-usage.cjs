#!/usr/bin/env node
'use strict';
// 技能使用记录与层级建议：只记技能名/时间/来源，不记查询、路径或凭据。
// 建议必须由用户确认后再交给 tier-skills --promote/--demote 执行。
const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const { CORE, RESIDENT_FILE, readResident } = require('./tier-skills.cjs');

const LOG_FILE = 'skills-usage.jsonl';
const DAY = 86400000;
const PROMOTE_DAYS = 30;
const PROMOTE_MIN = 3;
const PROMOTE_LONG_DAYS = 90;
const PROMOTE_LONG_MIN = 5;
const DEMOTE_DAYS = 90;
const DEDUPE_MINUTES = 5;
const RETENTION_DAYS = 365;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const result = { command: '', skill: '', json: false, apply: false, source: 'use', days: RETENTION_DAYS };
  const valueFlags = new Map([['--client-root', 'client'], ['--now', 'now'], ['--source', 'source'], ['--days', 'days']]);
  const seen = new Set();
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'help') { result.help = true; continue; }
    if (name === 'json' || name === 'apply') {
      if (seen.has(name)) throw new Error('重复参数：' + arg);
      seen.add(name); result[name] = true; continue;
    }
    if (!valueFlags.has(arg)) throw new Error('未知参数：' + arg);
    if (seen.has(name)) throw new Error('重复参数：' + arg);
    seen.add(name);
    const value = argv[++i];
    if (!value || !value.trim() || value.startsWith('-')) throw new Error(arg + ' 需要明确值');
    result[valueFlags.get(arg)] = value;
  }
  result.command = words.shift() || '';
  result.skill = words.shift() || '';
  if (words.length) throw new Error('多余参数：' + words.join(' '));
  if (result.command === 'log') {
    if (!result.skill) throw new Error('用法：skill-usage.cjs log <技能名> [--source use]');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(result.skill)) throw new Error('技能名必须为小写字母、数字或连字符');
    if (!/^[a-z][a-z0-9-]*$/.test(result.source)) throw new Error('--source 必须为小写字母、数字或连字符');
  } else if (!['report', 'suggest', 'prune'].includes(result.command)) {
    throw new Error('用法：skill-usage.cjs <log|report|suggest|prune> ...');
  }
  if (result.client) result.client = path.resolve(result.client);
  result.days = Number(result.days);
  if (!Number.isInteger(result.days) || result.days < 1) throw new Error('--days 必须为正整数');
  if (result.now !== undefined) {
    result.nowMs = Date.parse(result.now);
    if (!Number.isFinite(result.nowMs)) throw new Error('--now 需要 ISO 时间');
  }
  return result;
}

function usageFile(root) { return path.join(root, LOG_FILE); }

function appendUsage(file, skill, source, nowMs = Date.now(), dedupeMinutes = DEDUPE_MINUTES) {
  const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('使用记录不是普通文件：' + file);
  if (stat) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-50);
    for (const line of lines.reverse()) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item && item.skill === skill && item.source === source && Number.isFinite(Date.parse(item.ts))
        && nowMs - Date.parse(item.ts) >= 0 && nowMs - Date.parse(item.ts) < dedupeMinutes * 60000) return false;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date(nowMs).toISOString(), skill, source }) + '\n', { mode: 0o600 });
  return true;
}

function readUsage(file) {
  if (!fs.existsSync(file)) return { entries: [], invalid: 0 };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('使用记录不是普通文件：' + file);
  const entries = [];
  let invalid = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { invalid++; continue; }
    const ms = item && Date.parse(item.ts);
    if (!item || typeof item.skill !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.skill)
      || typeof item.source !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.source) || !Number.isFinite(ms)) {
      invalid++; continue;
    }
    entries.push({ ts: new Date(ms).toISOString(), ms, skill: item.skill, source: item.source });
  }
  return { entries, invalid };
}

function aggregate(entries, nowMs) {
  const skills = new Map();
  for (const item of entries) {
    if (item.ms > nowMs) continue;
    const row = skills.get(item.skill) || { total: 0, d30: 0, d90: 0, first: item.ts, last: item.ts, sources: {} };
    row.total++;
    if (nowMs - item.ms <= PROMOTE_DAYS * DAY) row.d30++;
    if (nowMs - item.ms <= PROMOTE_LONG_DAYS * DAY) row.d90++;
    if (item.ts < row.first) row.first = item.ts;
    if (item.ts > row.last) row.last = item.ts;
    row.sources[item.source] = (row.sources[item.source] || 0) + 1;
    skills.set(item.skill, row);
  }
  return skills;
}

function installedTiers(root) {
  const tiers = new Map();
  const index = path.join(root, 'skills-index.json');
  if (fs.existsSync(index)) {
    try {
      const data = JSON.parse(fs.readFileSync(index, 'utf8'));
      for (const entry of Array.isArray(data.entries) ? data.entries : []) {
        if (!entry || typeof entry.name !== 'string' || !['core', 'library'].includes(entry.tier)) continue;
        if (typeof entry.path !== 'string' || !fs.existsSync(entry.path)) continue;
        tiers.set(entry.name, entry.tier);
      }
    } catch {}
  }
  for (const [tier, dir] of [['core', 'skills'], ['library', 'skills-library']]) {
    const base = path.join(root, dir);
    let names = [];
    try { names = fs.readdirSync(base); } catch {}
    for (const name of names) {
      if (!tiers.has(name) && fs.existsSync(path.join(base, name, 'SKILL.md'))) tiers.set(name, tier);
    }
  }
  return tiers;
}

function suggestTiers(root, nowMs) {
  const { entries, invalid } = readUsage(usageFile(root));
  const stats = aggregate(entries, nowMs);
  const tiers = installedTiers(root);
  const extras = readResident(path.join(root, RESIDENT_FILE));
  const extraSet = new Set(extras);
  const promote = [], demote = [];
  for (const [skill, row] of stats) {
    const tier = tiers.get(skill);
    if (!tier) continue;
    if (tier === 'library' && (row.d30 >= PROMOTE_MIN || row.d90 >= PROMOTE_LONG_MIN)) {
      promote.push({ action: 'promote', skill, from: 'library', to: 'core', d30: row.d30, d90: row.d90, last: row.last });
    }
    if (tier === 'core' && extraSet.has(skill) && !CORE.includes(skill)) {
      const idleDays = Math.floor((nowMs - Date.parse(row.last)) / DAY);
      if (idleDays >= DEMOTE_DAYS) demote.push({ action: 'demote', skill, from: 'core', to: 'library', last: row.last, idleDays });
    }
  }
  promote.sort((a, b) => b.d30 - a.d30 || b.d90 - a.d90 || a.skill.localeCompare(b.skill));
  demote.sort((a, b) => b.idleDays - a.idleDays || a.skill.localeCompare(b.skill));
  return { promote, demote, invalid, tiers, stats };
}

function printReport(root, nowMs, json) {
  const { entries, invalid } = readUsage(usageFile(root));
  const stats = aggregate(entries, nowMs);
  const tiers = installedTiers(root);
  const rows = [...stats.entries()].map(([skill, row]) => ({ skill, tier: tiers.get(skill) || 'missing', ...row }))
    .sort((a, b) => b.d30 - a.d30 || b.total - a.total || a.skill.localeCompare(b.skill));
  if (json) {
    console.log(JSON.stringify({ schema: 1, now: new Date(nowMs).toISOString(), file: usageFile(root), invalid, skills: rows }, null, 2));
    return;
  }
  if (!rows.length) { console.log('NO_USAGE 尚无使用记录；/skill-load --record 或 skill-usage.cjs log <名> 后才有数据。'); return; }
  console.log(`使用记录：${usageFile(root)}；无效行 ${invalid}`);
  console.log('技能\t层级\t30天\t90天\t总计\t最近使用');
  for (const row of rows) console.log(`${row.skill}\t${row.tier}\t${row.d30}\t${row.d90}\t${row.total}\t${row.last}`);
}

function cmdSuggest(options, nowMs) {
  const root = options.client;
  const result = suggestTiers(root, nowMs);
  if (options.json) {
    console.log(JSON.stringify({ schema: 1, now: new Date(nowMs).toISOString(), thresholds: { promote: { days: PROMOTE_DAYS, min: PROMOTE_MIN }, promoteLong: { days: PROMOTE_LONG_DAYS, min: PROMOTE_LONG_MIN }, demote: { days: DEMOTE_DAYS } }, suggestions: [...result.promote, ...result.demote], invalid: result.invalid }, null, 2));
    return;
  }
  if (!result.promote.length && !result.demote.length) { console.log('NO_SUGGESTIONS 现有使用记录未达到晋升/降级阈值。'); return; }
  for (const item of result.promote) console.log(`PROMOTE ${item.skill} (library -> core) 30d=${item.d30} 90d=${item.d90} last=${item.last}`);
  for (const item of result.demote) console.log(`DEMOTE  ${item.skill} (core -> library) idle=${item.idleDays}d last=${item.last}`);
  console.log('\nNEXT_ACTION: ASK_TIER_CHANGE — 必须用 AskUserQuestion 向用户确认后，再运行：');
  if (result.promote.length) console.log('  node ~/.qoder/scripts/tier-skills.cjs --promote ' + result.promote.map(x => x.skill).join(',') + ' --apply');
  if (result.demote.length) console.log('  node ~/.qoder/scripts/tier-skills.cjs --demote ' + result.demote.map(x => x.skill).join(',') + ' --apply');
}

function cmdPrune(options, nowMs) {
  const root = options.client;
  const file = usageFile(root);
  const { entries } = readUsage(file);
  const keep = entries.filter(item => nowMs - item.ms <= options.days * DAY);
  const removed = entries.length - keep.length;
  if (!options.apply) { console.log(`DRY-RUN prune=${removed} keep=${keep.length} days=${options.days}`); return; }
  if (!removed) { console.log(`PRUNE_NONE keep=${keep.length}`); return; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('使用记录不是普通文件：' + file);
  const temp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temp, keep.map(item => JSON.stringify({ ts: item.ts, skill: item.skill, source: item.source })).join('\n') + (keep.length ? '\n' : ''), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  console.log(`PRUNED removed=${removed} keep=${keep.length}`);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log([
      '用法：skill-usage.cjs <log|report|suggest|prune> ... [--json] [--client-root <目录>] [--now <ISO>]',
      '  log <技能名> [--source use]   记录一次使用（同技能同来源 5 分钟内去重）',
      '  report                        汇总 30/90 天使用次数与最近使用时间',
      '  suggest                       给出晋升/降级建议；必须询问用户后再执行',
      '  prune [--days 365] [--apply]  清理超期记录（默认只预览）',
      '阈值：按需技能 30 天 ≥3 次或 90 天 ≥5 次 → 建议晋升；用户自选常驻 90 天未用 → 建议降级；包内 CORE 默认常驻不建议降级。',
      '只记录技能名、时间与来源；不记录查询、路径或凭据。原生 Skill 调用无法自动观测，需显式 log。',
    ].join('\n'));
    return 0;
  }
  options.client = options.client || clientRoot();
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  if (options.command === 'log') {
    const added = appendUsage(usageFile(options.client), options.skill, options.source, nowMs);
    console.log(added ? 'LOGGED ' + options.skill + ' source=' + options.source : 'SKIP duplicate within ' + DEDUPE_MINUTES + 'm');
    return 0;
  }
  if (options.command === 'report') { printReport(options.client, nowMs, options.json); return 0; }
  if (options.command === 'suggest') { cmdSuggest(options, nowMs); return 0; }
  if (options.command === 'prune') { cmdPrune(options, nowMs); return 0; }
  return 2;
}

module.exports = { LOG_FILE, appendUsage, readUsage, aggregate, installedTiers, suggestTiers, PROMOTE_DAYS, PROMOTE_MIN, PROMOTE_LONG_DAYS, PROMOTE_LONG_MIN, DEMOTE_DAYS };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('SKILL_USAGE_ERROR: ' + error.message); process.exitCode = 2; }
}
