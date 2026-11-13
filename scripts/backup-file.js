#!/usr/bin/env node
// backup-file.js —— 「改文件前先备份」的带裁剪备份器（2026-10-14 用户定策）。
//
// 保留策略（"同一原始文件的备份组"内生效）：
//   ① 至多保留 3 份（取最新的 3 份）
//   ② 每次备份时删除超过 7 天的
//   ③ 但至少保留 1 份（组内全是旧备份时，留最新那一份）
//
// 用法：
//   node backup-file.js <target> [--label <x>]   # 备份 target（生成 target.bak.<时间戳>），随后自动裁剪该组
//   node backup-file.js --prune <target> [--apply]  # 不新建，只裁剪 target 的备份组（默认 dry-run，--apply 才删）
//   node backup-file.js --dir <目录> [--apply]   # 递归扫描目录内全部备份文件，按组裁剪（默认 dry-run）
//
// 备份识别：`<原名>.bak` 后跟 `-` / `_` / `.` 分隔的任意后缀（兼容历史命名：.bak.20261014-0930 / .bak_20261013 / .bak-byok-guard-… / .bak-20261014-restore）。
// 删除动作在 Windows 上进回收站（可还原）；其余平台直接删除。
// 退出码：0 成功；1 参数错 / 目标不存在 / 目录不可读。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 删除一律进回收站（Windows；可还原），失败或非 Windows 才直接删。测试可设 BACKUP_NO_RECYCLE=1 跳过。
function removeFile(p) {
  if (process.platform === 'win32' && process.env.BACKUP_NO_RECYCLE !== '1' && process.env.CI !== 'true') {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${p.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`],
        { encoding: 'utf8', timeout: 8000 });
      return;
    } catch (e) { /* 回退直接删 */ }
  }
  fs.rmSync(p, { force: true });
}

const KEEP_MAX = Number(process.env.BACKUP_KEEP_MAX || 3);
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 7);
const DAY_MS = 86400000;
const BAK_RE = /^(.*)\.bak(?:[-._].*)?$/;

const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const ageDays = (ms) => Math.floor((Date.now() - ms) / DAY_MS);

// A53：判龄必须用「备份自身的时间」，不能用继承来的源文件 mtime。
// 实测 fs.copyFileSync 会继承源文件 mtime（源文件 10 天没改 ⇒ 新备份看起来 10 天前 ⇒ 当场被裁、回滚指针悬空）。
// 只解析 `.bak` 之后的后缀，避免把原文件名里的数字当日期。
function nameTimeMs(name) {
  const idx = name.indexOf('.bak');
  const s = idx >= 0 ? name.slice(idx + 4) : name;
  const valid = (y, mo, d) => y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  let m = s.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (m && valid(+m[1], +m[2], +m[3])) {
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (Number.isFinite(t)) return t;
  }
  m = s.match(/(\d{4})(\d{2})(\d{2})/);
  if (m && valid(+m[1], +m[2], +m[3])) {
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}
// 取 max(mtime, 文件名时间戳) 是**单调安全**的：只会让备份看起来更新，
// 绝不会把按旧口径本该保留的备份判成超期（文件名时间戳比 mtime 旧时仍以 mtime 为准）。
const effectiveTime = (name, st) => {
  const nt = nameTimeMs(name);
  return nt === null ? st.mtimeMs : Math.max(st.mtimeMs, nt);
};

function listBackups(orig) {
  const dir = path.dirname(orig);
  const base = path.basename(orig);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(BAK_RE);
    if (!m || m[1] !== base) continue;
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); if (st.isFile()) out.push({ path: p, name: n, mtime: st.mtimeMs, time: effectiveTime(n, st) }); } catch (e) {}
  }
  out.sort((a, b) => b.time - a.time); // 新 → 旧（按备份自身时间）
  return out;
}

// 纯函数：给定备份列表（新→旧），返回 { kept, del }
// protect：本次刚生成的备份路径集合，永不裁剪（回滚指针不能悬空），即使超出上限也保留。
function plan(backups, protect) {
  const prot = protect || new Set();
  const cap = backups.slice(0, KEEP_MAX);
  const rest = backups.slice(KEEP_MAX);
  const fresh = cap.filter((b) => Date.now() - b.time <= KEEP_DAYS * DAY_MS);
  let kept;
  let del;
  if (fresh.length === 0) {
    kept = cap.slice(0, 1);                    // 全旧 ⇒ 至少留最新 1 份
    del = cap.slice(1);
  } else {
    kept = fresh;
    del = cap.filter((b) => !fresh.includes(b));
  }
  del = del.concat(rest);
  if (prot.size) {
    del = del.filter((b) => !prot.has(b.path));
    for (const b of backups) if (prot.has(b.path) && !kept.includes(b)) kept.push(b);
  }
  return { kept, del };
}

function makeBackup(target, label) {
  const st = fs.statSync(target);
  if (!st.isFile()) throw new Error('目标不是文件：' + target);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const mid = `.bak${label ? '-' + label : ''}.`;
  let bak = `${target}${mid}${ts}`;
  let i = 2;
  while (fs.existsSync(bak)) bak = `${target}${mid}${ts}-${i++}`;
  fs.copyFileSync(target, bak);
  // A53 根因修正：copyFileSync 继承源文件 mtime，这里把副本时间归正为「备份生成时刻」。
  // 失败也不致命：文件名时间戳判龄 + protect 两道兜底仍在。
  try { const now = new Date(); fs.utimesSync(bak, now, now); } catch (e) {}
  return bak;
}

function pruneTarget(target, apply, protect) {
  const backups = listBackups(target);
  const { kept, del } = plan(backups, protect);
  for (const b of del) { if (apply) removeFile(b.path); }
  return { backups, kept, del };
}

function report({ kept, del }, apply, indent = '') {
  for (const b of del) console.log(`${indent}[${apply ? '删除' : '计划删除'}] ${b.name}（${ageDays(b.time)} 天前）`);
  if (del.length) console.log(`${indent}  保留 ${kept.length} 份：` + kept.map((b) => `${b.name}（${ageDays(b.time)}d）`).join('、'));
  return del.length;
}

function walk(dir, fn, depth = 0) {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    // 跳过符号链接 / junction（Windows 目录 junction 会被 lstat 报为 symlink）：防止顺手扫穿到别的盘
    try { if (fs.lstatSync(p).isSymbolicLink()) continue; } catch (e2) { continue; }
    if (e.isDirectory()) walk(p, fn, depth + 1);
    else if (e.isFile()) fn(p);
  }
}

function dirMode(root, apply) {
  if (!fs.existsSync(root)) { console.error('目录不存在：' + root); process.exit(1); }
  // 收集：按 (目录 + 原名) 分组
  const groups = new Map();
  walk(root, (p) => {
    const m = path.basename(p).match(BAK_RE);
    if (!m) return;
    const key = path.join(path.dirname(p), m[1]);
    if (!groups.has(key)) groups.set(key, []);
    try { const st = fs.statSync(p); groups.get(key).push({ path: p, name: path.basename(p), mtime: st.mtimeMs, time: effectiveTime(path.basename(p), st) }); } catch (e) {}
  });
  let totalDel = 0;
  let totalGroups = 0;
  for (const [orig, list] of groups) {
    list.sort((a, b) => b.time - a.time);
    const r = plan(list);
    if (!r.del.length) continue;
    totalGroups++;
    console.log(`· ${orig}（${list.length} 份备份）`);
    if (apply) for (const b of r.del) removeFile(b.path);
    totalDel += report(r, apply, '  ');
  }
  console.log(`\n扫描完成：${groups.size} 组备份，${totalGroups} 组需裁剪，共 ${apply ? '删除' : '计划删除'} ${totalDel} 个文件${apply ? '' : '（dry-run；加 --apply 执行）'}`);
  return totalDel;
}

// ---- CLI ----
const args = process.argv.slice(2);
let mode = 'backup';
let target = '';
let label = '';
let apply = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--prune') mode = 'prune';
  else if (a === '--dir') { mode = 'dir'; target = args[++i] || ''; }
  else if (a === '--apply') apply = true;
  else if (a === '--label') label = args[++i] || '';
  else if (!a.startsWith('--')) target = a;
}

if (mode !== 'dir' && !target) {
  console.error('用法：node backup-file.js <target> [--label x] | --prune <target> [--apply] | --dir <目录> [--apply]');
  process.exit(1);
}

if (mode === 'backup') {
  if (!fs.existsSync(target)) { console.error('目标不存在：' + target); process.exit(1); }
  const bak = makeBackup(target, label);
  console.log('[备份] ' + bak);
  const r = pruneTarget(target, true, new Set([bak]));   // 每次备份顺带裁剪（策略②）；本次新备份永不裁剪（A53）
  if (r.del.length) report(r, true);
  console.log(`[就绪] 当前保留 ${r.kept.length} 份（上限 ${KEEP_MAX} 份 / 保留 ${KEEP_DAYS} 天 / 至少 1 份）`);
} else if (mode === 'prune') {
  if (!fs.existsSync(target)) { console.error('目标不存在：' + target); process.exit(1); }
  const r = pruneTarget(target, apply);
  if (!r.del.length) console.log('[无需裁剪] ' + target + `（当前 ${r.backups.length} 份备份）`);
  else report(r, apply);
} else {
  dirMode(target, apply);
}
