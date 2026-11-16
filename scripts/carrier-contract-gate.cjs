#!/usr/bin/env node
'use strict';
/**
 * 载体入包契约门（秒级）——新增/修改 skill、rule、command、agent、hook、script 后，
 * 在提交与出包**之前**跑，把过去只有 24–27 分钟全量套件才暴露的冲突提前到秒级。
 *
 * 设计原则：
 *  - 薄编排：已有检测器一律 delegate，不复制判据（避免第二份真源）。
 *  - 只补真缺口：手写技能清单一致性、本批机器专属标识、版本三载体与最新脚注、
 *    HOOKS 表可靠方向、git 跟踪垃圾件。
 *  - 硬拦面必须可失败：每项带正负对照自测；空集不算通过。
 *  - 存量债列 advisory 不阻断（历史 CHANGELOG 脚注、Windows 域技能里的正当盘符路径、
 *    名字像 hook 但属合法 helper 的未接线脚本），避免一上线就大面积误伤。
 *
 * 用法：node scripts/carrier-contract-gate.cjs [--root <仓库>] [--base <git-ref>] [--json] [--selftest]
 * 退出码：0 全绿 / 1 有硬违约 / 2 用法或环境错误
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const DESC_SOURCE = require('./share-package-verify.cjs');
const { parseDescription } = require('./skill-description.cjs');

const CARRIER_DOC = /^(?:skills\/[^/]+\/(?:SKILL\.md|references\/.+\.md)|commands\/.+\.md|agents\/.+\.md|rules\/.+\.md)$/;
const JUNK = /(^|\/)(?:node_modules|backups|logs?|credentials)(\/|$)|\.bak(?:[._-]|\d|$)|(?:~|\.tmp|\.swp|\.orig|\.log|\.pem|\.key)$|(^|\/)(?:Thumbs\.db|desktop\.ini|\.DS_Store)$/i;
// 占位/示例形态不算泄漏（与 share-secret-scan 的 PLACEHOLDER 口径一致）
const PLACEHOLDER = /^(?:<[^>]*>|\{\{.*\}\}|\$\{.*\}|%[A-Za-z_]+%|x{2,}|example|dummy|placeholder|user|admin|Administrator|test|foo|bar|name|用户名|某用户)$/i;

function git(root, args) {
  const r = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
}

// ---------- N1 手写技能清单一致性 ----------
// 判据：分组声明数==实列数；实列合计==catalog 技能数；「（常驻）」标记⊆core；无漏列无幻影。
// 只解析「推荐技能清单」章节，避免把文档其它 **X**（N）： 行误当清单。
function checkDocInventory(docText, catalog) {
  const violations = [];
  const skills = (catalog.entries || []).filter(e => e.category === 'skill');
  const names = new Set(skills.map(e => e.name));
  const core = new Set(skills.filter(e => e.tier === 'core').map(e => e.name));
  if (!skills.length) return { ok: false, violations: ['catalog 无技能条目：清单判据空对空恒真'] };
  const lines = String(docText).split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+.*推荐技能清单/.test(l));
  if (start < 0) return { ok: false, violations: ['文档缺「推荐技能清单」章节：无法核对（不静默跳过）'] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break; }
  const section = lines.slice(start, end).join('\n');
  const groupRe = /^\*\*(.+?)\*\*（(\d+)）：(.+)$/gm;
  const groups = [];
  const listed = new Set();
  const marked = [];
  let m;
  while ((m = groupRe.exec(section))) {
    const items = m[3].split('、').map(s => s.trim()).filter(Boolean);
    const plain = items.map(s => s.replace(/（常驻）\s*$/, '').trim());
    items.forEach((it, i) => { if (/（常驻）\s*$/.test(it)) marked.push(plain[i]); });
    plain.forEach(n => listed.add(n));
    groups.push({ label: m[1], declared: Number(m[2]), actual: items.length });
  }
  if (!groups.length) return { ok: false, violations: ['清单章节里一个分组都没解析到：判据空转（格式变了必须修判据，不是放行）'] };
  for (const g of groups) if (g.declared !== g.actual) violations.push(`分组「${g.label}」声明 ${g.declared} ≠ 实列 ${g.actual}`);
  const sum = groups.reduce((n, g) => n + g.actual, 0);
  if (sum !== skills.length) violations.push(`清单实列合计 ${sum} ≠ catalog 技能数 ${skills.length}`);
  const badMarks = marked.filter(n => !core.has(n));
  if (badMarks.length) violations.push(`「（常驻）」标记但 catalog tier≠core：${badMarks.join(', ')}`);
  const missing = [...names].filter(n => !listed.has(n));
  if (missing.length) violations.push(`catalog 有但清单漏列：${missing.join(', ')}`);
  const phantom = [...listed].filter(n => !names.has(n));
  if (phantom.length) violations.push(`清单列出但 catalog 没有（幻影）：${phantom.join(', ')}`);
  return { ok: violations.length === 0, violations, readings: { groups: groups.length, listed: sum, catalog: skills.length, core: core.size, marked: marked.length } };
}

// ---------- N2 本批新增/修改载体正文里的机器专属标识 ----------
// 批处理模式只扫本批改动件：存量 Windows 域技能里的盘符路径是正当主题内容，一刀切会误伤。
// wholeTree（发布包整体门）放行 bare 机器临时根——D:/tmp 是 AGENTS.md 的 documented 约定示例，
// 会话专属子目录仍由「会话ID后缀任务目录」抓；用户专属根（数据根/仓库 checkout）两种模式都拦。
function machineIdPatterns(homeDir, opts = {}) {
  const wholeTree = !!opts.wholeTree;
  const userName = path.basename(String(homeDir || '')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [
    ['真实家目录', userName ? new RegExp('[A-Za-z]:[\\\\/]{1,2}Users[\\\\/]{1,2}' + userName + '\\b', 'gi') : null],
    // 路径上下文里的会话任务目录：<分隔符><词>-…-<8位hex>。比旧前缀表宽，能抓 context-continuity-<hex> 等；
    // 要求前置路径分隔符，避免散文里普通连字符词误伤；(?![0-9a-f]) 钉死恰好 8 位。
    ['会话ID后缀任务目录', /[\\/][a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{8}(?![0-9a-f])/gi],
    ['内部任务ID', /\bQO-[A-Z][A-Z0-9]*-\d{6,8}\b/g],
    // 用户数据根（如 D:/UserData/.qoder*）：分享包应写 <client-root>/<data-root>，不是本机绝对路径。
    ['用户数据根', /\b[A-Za-z]:[\\/]UserData[\\/]/g],
    // 本机仓库 checkout（X:/…/GitHub/<repo>）：分享包应写 <repo-root>。
    ['本机仓库路径', /\b[A-Za-z]:[\\/][^\s"'`<>|]*[\\/]GitHub[\\/][A-Za-z0-9_.-]+/g],
    wholeTree ? null : ['机器临时根', /\b[A-Za-z]:[\\/]tmp[\\/]/g],
  ];
  return pats.filter(p => p && p[1]);
}
function checkMachineIds(files, homeDir, opts = {}) {
  const violations = [];
  const pats = machineIdPatterns(homeDir, opts);
  let scanned = 0;
  for (const { rel, text } of files) {
    scanned++;
    for (const [label, re] of pats) {
      const g = new RegExp(re.source, re.flags);
      const hits = [...String(text).matchAll(g)].map(m => m[0]);
      const real = hits.filter(h => {
        const tail = h.split(/[\\/]/).pop();
        return !PLACEHOLDER.test(tail);
      });
      if (real.length) violations.push(`${rel}: ${label} ×${real.length}`);
    }
  }
  return { ok: violations.length === 0, violations, readings: { scanned } };
}

// ---------- N3 版本三载体一致 + 最新已发布节脚注 ----------
function checkVersionSync(versionText, catalog, manifest, changelog) {
  const violations = [];
  const advisory = [];
  const version = String(versionText).trim().split(/\r?\n/)[0].replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) violations.push(`VERSION 首行不是 x.y.z：${version}`);
  if (catalog.package?.version !== version) violations.push(`catalog.package.version ${catalog.package?.version} ≠ VERSION ${version}`);
  if (manifest.version !== version) violations.push(`skills-manifest.version ${manifest.version} ≠ VERSION ${version}`);
  const released = [...String(changelog).matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/gm)].map(m => m[1]);
  if (!released.length) violations.push('CHANGELOG 没有任何已发布节：脚注判据空转');
  const footnotes = new Set([...String(changelog).matchAll(/^\[([^\]]+)\]:\s*http/gm)].map(m => m[1]));
  if (released.length && !footnotes.has(released[0])) violations.push(`最新已发布节 [${released[0]}] 缺链接脚注`);
  const historic = released.slice(1).filter(v => !footnotes.has(v));
  if (historic.length) advisory.push(`历史节缺脚注 ${historic.length} 个（存量债，不阻断）：${historic.slice(0, 6).join(',')}${historic.length > 6 ? '…' : ''}`);
  return { ok: violations.length === 0, violations, advisory, readings: { version, released: released.length, footnotes: footnotes.size } };
}

// ---------- N4 HOOKS 表可靠方向：表内脚本必须存在且在 catalog ----------
// 反向（名字像 hook 就必须接线）不成立：hook-crash-guard.js / run-package-hook.cjs 等是合法 helper。
function checkHookWiring(profileText, catalog, existsFn) {
  const violations = [];
  const advisory = [];
  const at = String(profileText).indexOf('const HOOKS');
  if (at < 0) return { ok: false, violations: ['workflow-profile.cjs 找不到 const HOOKS：判据无法执行（不静默跳过）'] };
  const block = String(profileText).slice(at, String(profileText).indexOf('];', at));
  const scripts = [...new Set([...block.matchAll(/'([A-Za-z0-9_.-]+\.(?:js|cjs|mjs|ps1|sh))'/g)].map(m => m[1]))];
  if (!scripts.length) return { ok: false, violations: ['HOOKS 表解析出 0 个脚本：空集不算通过'] };
  const catScripts = new Set((catalog.entries || []).filter(e => e.category === 'script').map(e => e.name));
  for (const s of scripts) {
    if (!catScripts.has(s)) violations.push(`HOOKS 表脚本不在 catalog：${s}`);
    if (!existsFn(s)) violations.push(`HOOKS 表脚本在磁盘不存在：${s}`);
  }
  const hookLike = [...catScripts].filter(s => /-(?:guard|trigger|reminder|hook)\.(?:js|cjs)$/.test(s));
  const unwired = hookLike.filter(s => !scripts.includes(s));
  if (unwired.length) advisory.push(`名字像 hook 但未在 HOOKS 表 ${unwired.length} 个（含合法 helper，需人工判）：${unwired.join(',')}`);
  return { ok: violations.length === 0, violations, advisory, readings: { wired: scripts.length, hookLike: hookLike.length } };
}

// ---------- N5 git 跟踪的垃圾件（会随包发出去） ----------
function checkTrackedJunk(tracked) {
  const violations = [];
  if (!Array.isArray(tracked)) return { ok: false, violations: ['拿不到 git 跟踪清单：判据无法执行'] };
  if (!tracked.length) return { ok: false, violations: ['git 跟踪清单为空：空集不算通过'] };
  const junk = tracked.filter(f => JUNK.test(f));
  if (junk.length) violations.push(`git 跟踪了垃圾件 ${junk.length} 个：${junk.slice(0, 8).join(',')}${junk.length > 8 ? '…' : ''}`);
  return { ok: violations.length === 0, violations, readings: { tracked: tracked.length, junk: junk.length } };
}

// ---------- C4 description 上限（复用 share-package-verify 的同一真源） ----------
function checkDescriptions(skillDir, readFn, listFn) {
  const violations = [];
  const { caps, error } = DESC_SOURCE.carrierCaps();
  if (error) return { ok: false, violations: ['载体上限表不可用：' + error] };
  if (!caps || !Object.keys(caps).length) return { ok: false, violations: ['载体上限表解析出 0 条：不得静默按 300 判所有技能'] };
  let names;
  try { names = listFn(skillDir); } catch (e) { return { ok: false, violations: ['skills/ 读不出：' + (e.code || String(e))] }; }
  if (!names.length) return { ok: false, violations: ['skills/ 里没有任何技能目录：空集不算通过'] };
  let max = 0;
  for (const n of names) {
    const file = path.join(skillDir, n, 'SKILL.md');
    let d;
    try { d = DESC_SOURCE.descOf(file); } catch { d = null; }
    if (d === null || d === undefined) { violations.push(`技能缺 description 或读不出：${n}`); continue; }
    const cap = caps[n] || DESC_SOURCE.DESC_MAX;
    if (d.length > cap) violations.push(`description 超限 ${n}（${d.length}>${cap}）`);
    if (d.length > max) max = d.length;
  }
  return { ok: violations.length === 0, violations, readings: { skills: names.length, max, DESC_MAX: DESC_SOURCE.DESC_MAX } };
}

// ---------- 编排 ----------
function delegate(root, label, args) {
  const r = cp.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  return { ok, violations: ok ? [] : [`${label} exit=${r.status === null ? 'CRASH' : r.status}：${out.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ').slice(0, 400)}`], readings: { exit: r.status } };
}

function batchCarrierDocs(root, base) {
  const set = new Set();
  if (base) {
    const d = git(root, ['diff', '--name-only', base + '...HEAD']);
    if (d) d.split(/\r?\n/).filter(Boolean).forEach(f => set.add(f));
  }
  const w = git(root, ['diff', '--name-only', 'HEAD']);
  if (w) w.split(/\r?\n/).filter(Boolean).forEach(f => set.add(f));
  const u = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (u) u.split(/\r?\n/).filter(Boolean).forEach(f => set.add(f));
  const out = [];
  for (const rel of [...set].sort()) {
    if (!CARRIER_DOC.test(rel)) continue;
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    out.push({ rel, text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

// 全树载体文档（发布包整体门用）：文件系统遍历，不依赖 git——发布包是解包产物，无 .git。
function allCarrierDocs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'backups') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (CARRIER_DOC.test(rel)) out.push({ rel, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  for (const sub of ['skills', 'commands', 'agents', 'rules']) walk(path.join(root, sub), 0);
  return out;
}

function run(root, opts = {}) {
  const readJson = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const catalog = readJson('catalog.json');
  const manifest = readJson('skills-manifest.json');
  const versionText = fs.readFileSync(path.join(root, 'VERSION'), 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const checks = [];
  const push = (id, name, res, kind = 'hard') => checks.push({ id, name, kind, ok: res.ok, violations: res.violations || [], advisory: res.advisory || [], readings: res.readings || {} });

  push('C1', '触发短语唯一性', delegate(root, 'skill-trigger-uniqueness', [path.join(root, 'scripts/skill-trigger-uniqueness.cjs'), '--root', root]));
  push('C2', '技能引用完整性', delegate(root, 'skill-reference-integrity', [path.join(root, 'scripts/skill-reference-integrity.cjs'), '--root', root, '--check']));
  push('C3', '包元数据无漂移', delegate(root, 'pack-share-extras', [path.join(root, 'scripts/pack-share-extras.cjs'), root, '--version', versionText.trim().split(/\r?\n/)[0].replace(/^v/, ''), '--check']));
  push('C4', 'description 上限（同一真源）', checkDescriptions(path.join(root, 'skills'), null, d => fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()));
  push('N1', '手写技能清单一致性', checkDocInventory(fs.readFileSync(path.join(root, 'Qoder-AI编码通用规则.md'), 'utf8'), catalog));
  push('N2', '本批载体正文机器专属标识', checkMachineIds(batchCarrierDocs(root, opts.base), os.homedir()));
  push('N3', '版本三载体与最新脚注', checkVersionSync(versionText, catalog, manifest, changelog));
  push('N4', 'HOOKS 表脚本存在且入 catalog', checkHookWiring(fs.readFileSync(path.join(root, 'scripts/workflow-profile.cjs'), 'utf8'), catalog, s => fs.existsSync(path.join(root, 'scripts', s))));
  const trackedRaw = git(root, ['ls-files']);
  push('N5', 'git 跟踪垃圾件', checkTrackedJunk(trackedRaw === null ? null : trackedRaw.split(/\r?\n/).filter(Boolean)));

  const hard = checks.filter(c => c.kind === 'hard' && !c.ok);
  const advisory = checks.flatMap(c => (c.advisory || []).map(a => c.id + ': ' + a));
  return { ok: hard.length === 0, checks, hard, advisory };
}

// ---------- 自测：每项都要能失败 ----------
function selftest() {
  let pass = 0, fail = 0;
  const t = (name, ok, detail) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
  const cat = (skills) => ({ entries: skills.map(([name, tier]) => ({ id: 'skill:' + name, category: 'skill', name, tier })) });
  const doc = (groups) => '# 文档\n\n## 三、推荐技能清单（按域速查）\n\n' + groups.map(g => `**${g.label}**（${g.declared}）：${g.items.join('、')}`).join('\n') + '\n\n## 四、其他\n';

  // N1
  const goodCat = cat([['alpha', 'core'], ['beta', 'library'], ['gamma', 'library']]);
  const goodDoc = doc([{ label: '甲', declared: 2, items: ['alpha（常驻）', 'beta'] }, { label: '乙', declared: 1, items: ['gamma'] }]);
  t('N1 正例 一致清单判绿', checkDocInventory(goodDoc, goodCat).ok);
  t('N1 负对照 漏列技能判红', !checkDocInventory(doc([{ label: '甲', declared: 2, items: ['alpha（常驻）', 'beta'] }]), goodCat).ok);
  t('N1 负对照 分组声明数不符判红', !checkDocInventory(doc([{ label: '甲', declared: 9, items: ['alpha（常驻）', 'beta'] }, { label: '乙', declared: 1, items: ['gamma'] }]), goodCat).ok);
  t('N1 负对照 常驻标记非core判红', !checkDocInventory(doc([{ label: '甲', declared: 2, items: ['alpha', 'beta（常驻）'] }, { label: '乙', declared: 1, items: ['gamma'] }]), goodCat).ok);
  t('N1 负对照 幻影技能判红', !checkDocInventory(doc([{ label: '甲', declared: 3, items: ['alpha（常驻）', 'beta', 'phantom'] }, { label: '乙', declared: 1, items: ['gamma'] }]), goodCat).ok);
  t('N1 负对照 无分组判红（空转）', !checkDocInventory('# 文档\n\n## 三、推荐技能清单（按域速查）\n\n没有分组\n', goodCat).ok);
  t('N1 负对照 缺章节判红', !checkDocInventory('# 文档\n\n正文\n', goodCat).ok);
  t('N1 负对照 catalog 空判红', !checkDocInventory(goodDoc, cat([])).ok);
  t('N1 章节外的同名格式不被误当清单', checkDocInventory(goodDoc + '\n**无关**（99）：not-a-skill\n', goodCat).ok === true);
  t('N1 负对照 章节内混入幻影仍判红', !checkDocInventory(goodDoc.replace('## 四、其他', '**无关**（99）：not-a-skill\n\n## 四、其他'), goodCat).ok);

  // N2
  // 夹具家目录按 share-secret-scan.cjs 自测的同一惯例拼接合成：写死字面量会被分发敏感扫描判「他人家目录」软红
  // （实测踩过 real.person / example 共 3 处）；而 user / admin / example 这类名字又在本门的 PLACEHOLDER 白名单里，
  // 拿来当「真实家目录」负对照会恒绿。带点的合成名两边都不撞，且正好走到 userName 的正则转义分支。
  const home = ['C:', 'Users', 'fixture.person'].join('/');
  const other = ['C:', 'Users', 'another.person'].join('/');
  const clean = [{ rel: 'skills/x/SKILL.md', text: '临时根用 <tmp-root>，仓库用 <repo-root>；家目录示例 C:/Users/Admin/AppData。' }];
  t('N2 正例 占位与示例判绿', checkMachineIds(clean, home).ok);
  t('N2 负对照 真实家目录判红', !checkMachineIds([{ rel: 'a.md', text: '见 ' + home + '/.qoder/logs' }], home).ok);
  t('N2 负对照 带点用户名转义后仍判红', !checkMachineIds([{ rel: 'a.md', text: '见 ' + other + '/.qoder/logs' }], other).ok);
  t('N2 正例 带点用户名的他人目录不误伤', checkMachineIds([{ rel: 'a.md', text: '见 ' + other + '/.qoder/logs' }], home).ok);
  // 负对照样本一律用合成标识（0badc0de / QO-DEMO / Z: 盘），不把任何真实会话ID、内部任务号或本机临时根写进公开仓库。
  t('N2 负对照 会话ID后缀任务目录判红', !checkMachineIds([{ rel: 'a.md', text: '入口 <tmp-root>/qo-demo-0badc0de/x.cjs' }], home).ok);
  t('N2 负对照 内部任务ID判红', !checkMachineIds([{ rel: 'a.md', text: '任务 QO-DEMO-20990101 已闭合' }], home).ok);
  t('N2 负对照 机器临时根判红', !checkMachineIds([{ rel: 'a.md', text: '产物在 Z:/tmp/foo/bar.log' }], home).ok);
  t('N2 正例 Windows 域正当盘符不误伤', checkMachineIds([{ rel: 'a.md', text: '系统盘 C:/Windows/System32 与程序目录 C:/Program Files' }], home).ok);
  t('N2 正例 空清单判绿但计数为0', checkMachineIds([], home).readings.scanned === 0);
  // 新增模式（用户数据根 / 本机仓库 checkout / 宽会话目录）+ 全树模式放行 bare 临时根。负对照一律合成 Z: 盘。
  t('N2 负对照 用户数据根判红', !checkMachineIds([{ rel: 'a.md', text: 'junction 到 Z:/UserData/.qoder/skills' }], home).ok);
  t('N2 正例 数据根占位判绿', checkMachineIds([{ rel: 'a.md', text: 'junction 到 <data-root>/.qoder/skills' }], home).ok);
  t('N2 负对照 本机仓库checkout判红', !checkMachineIds([{ rel: 'a.md', text: '仓库 Z:/Java/GitHub/demo-repo（main）' }], home).ok);
  t('N2 正例 仓库占位判绿', checkMachineIds([{ rel: 'a.md', text: '仓库 <repo-root>（main）' }], home).ok);
  t('N2 负对照 宽会话目录(context前缀)判红', !checkMachineIds([{ rel: 'a.md', text: '证据 <tmp-root>/context-continuity-0badc0de/x.cjs' }], home).ok);
  t('N2 全树 放行bare临时根约定', checkMachineIds([{ rel: 'a.md', text: '产物在 Z:/tmp/foo.log，按本机习惯替换' }], home, { wholeTree: true }).ok);
  t('N2 批处理 bare临时根仍判红', !checkMachineIds([{ rel: 'a.md', text: '产物在 Z:/tmp/foo.log' }], home, { wholeTree: false }).ok);
  t('N2 全树 仍抓会话专属子目录', !checkMachineIds([{ rel: 'a.md', text: '证据 Z:/tmp/qo-demo-0badc0de/x.cjs' }], home, { wholeTree: true }).ok);
  t('N2 全树 用户数据根仍判红', !checkMachineIds([{ rel: 'a.md', text: 'Z:/UserData/.qoder/skills' }], home, { wholeTree: true }).ok);
  // allCarrierDocs：文件系统遍历收载体文档、滤非载体与垃圾目录（发布包无 git）。
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-all-'));
  try {
    fs.mkdirSync(path.join(fakeRoot, 'skills/alpha/references'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'skills/alpha/node_modules'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'skills/alpha/SKILL.md'), 'x');
    fs.writeFileSync(path.join(fakeRoot, 'skills/alpha/references/r.md'), 'x');
    fs.writeFileSync(path.join(fakeRoot, 'skills/alpha/notes.md'), 'x'); // 非 CARRIER_DOC（技能根杂项）
    fs.writeFileSync(path.join(fakeRoot, 'skills/alpha/node_modules/n.md'), 'x'); // 垃圾目录跳过
    fs.writeFileSync(path.join(fakeRoot, 'commands/c.md'), 'x');
    const got = allCarrierDocs(fakeRoot).map(f => f.rel).sort();
    t('allCarrierDocs 收SKILL/references/commands滤杂项', JSON.stringify(got) === JSON.stringify(['commands/c.md', 'skills/alpha/SKILL.md', 'skills/alpha/references/r.md']), got.join(','));
  } finally { fs.rmSync(fakeRoot, { recursive: true, force: true }); }

  // N3
  const chgOk = '# Changelog\n\n## [Unreleased]\n\n## [0.1.7] - 2026-11-14\n\n正文\n\n## [0.1.6] - 2026-11-13\n\n正文\n\n[0.1.7]: https://example/0.1.7\n[0.1.6]: https://example/0.1.6\n';
  t('N3 正例 三载体一致+脚注齐判绿', checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.7' } }, { version: '0.1.7' }, chgOk).ok);
  t('N3 负对照 catalog 版本不符判红', !checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.6' } }, { version: '0.1.7' }, chgOk).ok);
  t('N3 负对照 manifest 版本不符判红', !checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.7' } }, { version: '0.1.6' }, chgOk).ok);
  t('N3 负对照 最新节缺脚注判红', !checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.7' } }, { version: '0.1.7' }, chgOk.replace('[0.1.7]: https://example/0.1.7\n', '')).ok);
  const historic = checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.7' } }, { version: '0.1.7' }, chgOk.replace('[0.1.6]: https://example/0.1.6\n', ''));
  t('N3 历史缺脚注只 advisory 不阻断', historic.ok && historic.advisory.length === 1);
  t('N3 负对照 无已发布节判红', !checkVersionSync('v0.1.7\n2026-11-14\n', { package: { version: '0.1.7' } }, { version: '0.1.7' }, '# Changelog\n\n## [Unreleased]\n').ok);

  // N4
  const profile = "const HOOKS = [\n  ['PostToolUse', 'a-guard.js', 10],\n  ['Stop', 'b-hook.cjs', 10],\n];\n";
  const catS = { entries: [{ category: 'script', name: 'a-guard.js' }, { category: 'script', name: 'b-hook.cjs' }, { category: 'script', name: 'helper-guard.js' }] };
  t('N4 正例 表内脚本齐全判绿', checkHookWiring(profile, catS, () => true).ok);
  t('N4 负对照 表内脚本不在catalog判红', !checkHookWiring(profile, { entries: [{ category: 'script', name: 'a-guard.js' }] }, () => true).ok);
  t('N4 负对照 表内脚本磁盘缺失判红', !checkHookWiring(profile, catS, s => s !== 'b-hook.cjs').ok);
  t('N4 负对照 无HOOKS判红', !checkHookWiring('const OTHER = 1;', catS, () => true).ok);
  t('N4 负对照 空表判红', !checkHookWiring('const HOOKS = [\n];\n', catS, () => true).ok);
  t('N4 合法helper未接线只advisory', checkHookWiring(profile, catS, () => true).advisory.some(a => a.includes('helper-guard.js')));

  // N5
  t('N5 正例 无垃圾件判绿', checkTrackedJunk(['skills/a/SKILL.md', 'scripts/x.cjs']).ok);
  t('N5 负对照 跟踪.bak判红', !checkTrackedJunk(['README.md.bak.20261109-161613']).ok);
  t('N5 负对照 跟踪node_modules判红', !checkTrackedJunk(['skills/x/node_modules/y/index.js']).ok);
  t('N5 负对照 跟踪.log判红', !checkTrackedJunk(['debug.log']).ok);
  t('N5 负对照 空清单判红', !checkTrackedJunk([]).ok);
  t('N5 负对照 拿不到清单判红', !checkTrackedJunk(null).ok);

  // C4：用真实仓库的 skills 目录做正例，构造超限做负对照
  const repo = path.join(__dirname, '..');
  const realSkills = path.join(repo, 'skills');
  t('C4 正例 真实仓库描述全在上限内', checkDescriptions(realSkills, null, d => fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()).ok);
  t('C4 负对照 空技能目录判红', !checkDescriptions(realSkills, null, () => []).ok);
  t('C4 负对照 目录读不出判红', !checkDescriptions(realSkills, null, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }).ok);
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-gate-selftest-'));
  try {
    fs.mkdirSync(path.join(fakeDir, 'over'), { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'over', 'SKILL.md'), '---\nname: over\ndescription: ' + 'x'.repeat(DESC_SOURCE.DESC_MAX + 1) + '\n---\n\n正文\n');
    const over = checkDescriptions(fakeDir, null, d => fs.readdirSync(d).sort());
    t('C4 负对照 超限描述判红', !over.ok && over.violations.some(v => v.includes('超限')));
    fs.writeFileSync(path.join(fakeDir, 'over', 'SKILL.md'), '---\nname: over\ndescription: ' + 'x'.repeat(DESC_SOURCE.DESC_MAX) + '\n---\n\n正文\n');
    t('C4 边界 恰好上限判绿', checkDescriptions(fakeDir, null, d => fs.readdirSync(d).sort()).ok);
  } finally { fs.rmSync(fakeDir, { recursive: true, force: true }); }
  t('C4 真源 DESC_MAX=300', DESC_SOURCE.DESC_MAX === 300, 'DESC_MAX=' + DESC_SOURCE.DESC_MAX);

  console.log(`${pass} PASS / ${fail} FAIL`);
  console.log(`SELFTEST=${fail === 0 ? 'PASS' : 'FAIL'} (${pass} 正负例 / ${fail} 失败)`);
  return fail === 0 ? 0 : 1;
}

function main(argv) {
  const known = new Set(['--root', '--base', '--json', '--selftest', '--machine-ids', '--scan-all']);
  let root = path.join(__dirname, '..');
  let base = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) { console.error('未知开关：' + a); return 2; }
    if (a === '--root' || a === '--base') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(a + ' 缺值'); return 2; }
      if (a === '--root') root = path.resolve(argv[++i]); else base = argv[++i];
    }
  }
  if (argv.includes('--selftest')) return selftest();
  // 独立机器标识门：供发布 CI 对解包产物整体扫描（--scan-all，无 git 依赖），不要求 catalog.json。
  if (argv.includes('--machine-ids')) {
    const scanAll = argv.includes('--scan-all');
    if (!scanAll && !base) {
      const r = git(root, ['rev-parse', '--verify', 'origin/main']);
      if (r) base = 'origin/main';
    }
    const files = scanAll ? allCarrierDocs(root) : batchCarrierDocs(root, base);
    const res = checkMachineIds(files, os.homedir(), { wholeTree: scanAll });
    if (argv.includes('--json')) { console.log(JSON.stringify({ ok: res.ok, scanAll, violations: res.violations, readings: res.readings }, null, 1)); return res.ok ? 0 : 1; }
    console.log(`${res.ok ? 'GREEN' : 'RED  '} N2 机器专属标识（${scanAll ? '全树' : '本批'}，scanned=${res.readings.scanned}）`);
    for (const v of res.violations) console.log('      违约 ' + v);
    console.log(res.ok ? 'VERDICT=MACHINE_IDS_GREEN' : 'VERDICT=MACHINE_IDS_RED');
    return res.ok ? 0 : 1;
  }
  if (!fs.existsSync(path.join(root, 'catalog.json'))) { console.error('不是分享包仓库根（缺 catalog.json）：' + root); return 2; }
  if (!base) {
    const r = git(root, ['rev-parse', '--verify', 'origin/main']);
    if (r) base = 'origin/main';
  }
  const result = run(root, { base });
  if (argv.includes('--json')) { console.log(JSON.stringify(result, null, 1)); return result.ok ? 0 : 1; }
  for (const c of result.checks) {
    console.log(`${c.ok ? 'GREEN' : 'RED  '} ${c.id} ${c.name}${c.readings && Object.keys(c.readings).length ? ' :: ' + JSON.stringify(c.readings) : ''}`);
    for (const v of c.violations) console.log('      违约 ' + v);
    for (const a of c.advisory || []) console.log('      advisory ' + a);
  }
  console.log(`base=${base || '(无上游，只扫工作区改动)'} hard=${result.hard.length} advisory=${result.advisory.length}`);
  console.log(result.ok ? 'VERDICT=CARRIER_CONTRACT_GREEN' : 'VERDICT=CARRIER_CONTRACT_RED');
  return result.ok ? 0 : 1;
}

module.exports = { checkDocInventory, checkMachineIds, checkVersionSync, checkHookWiring, checkTrackedJunk, checkDescriptions, machineIdPatterns, allCarrierDocs, run, selftest, CARRIER_DOC, JUNK };
if (require.main === module) process.exitCode = main(process.argv.slice(2));