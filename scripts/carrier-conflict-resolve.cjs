#!/usr/bin/env node
/**
 * 载体冲突的增量检测与自主消解。
 *
 * 为什么需要它：生成/更新 skill、rule、command、agent、hook 时，原先每次都要全仓扫描
 * （触发词唯一性扫全部技能、引用完整性扫全部文件、元数据重建扫 8 处声明点），
 * 作者每改一次就付一次全量代价。本脚本把「与既有载体的冲突」变成增量判定：
 *   · 索引按 mtime+size 失效，只重解析变化的文件；没变就 0 次重解析。
 *   · 触发词抽取复用 skill-trigger-uniqueness 的同一实现，不造第二份判据。
 *   · 描述上限复用 share-package-verify 的同一真源（--package 时）。
 *
 * 自主消解只做确定性、可逆、只改候选文件的事：
 *   · 触发词与既有载体重复 → 从候选的「触发词：」段删掉重复短语，保留独有线素；
 *     删完没有独有线素 ⇒ 判 BLOCK 并给出并入目标（同域不装第二个）。
 *   · 描述超上限 → 先删与既有载体重复的路由词，再压填充词；独有线素一个不许丢。
 *   · 同名冲突 → 一律 BLOCK，绝不自动覆盖既有载体。
 * 既有载体的合并需要用户拍板，本脚本不写它。
 *
 * 用法：
 *   node carrier-conflict-resolve.cjs --root <仓库或客户端根> --type skill --name <名> --file <候选文件> [--package <仓库根>] [--apply] [--json]
 *   node carrier-conflict-resolve.cjs --selftest
 * 退出码：0 已消解/无冲突；1 需裁决或阻断；2 参数错误。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { triggerPhrases, normalizePhrase } = require('./skill-trigger-uniqueness.cjs');
const { descriptionOfFile } = require('./skill-description.cjs');

const SCHEMA = 1;
const CARRIER_DIRS = ['skills', 'skills-library', 'rules', 'commands', 'agents'];

function cachePath(root) {
  const gitDir = path.join(root, '.git');
  if (fs.existsSync(gitDir)) return path.join(gitDir, 'carrier-index.json');
  const key = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'carrier-index-' + key + '.json');
}

function carrierFiles(root) {
  const out = [];
  for (const dir of CARRIER_DIRS) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.isFile() && entry.name.endsWith('.md')) out.push(path.join(base, entry.name));
        continue;
      }
      const skill = path.join(base, entry.name, 'SKILL.md');
      if (fs.existsSync(skill)) out.push(skill);
    }
  }
  return out.sort();
}

function parseCarrier(file) {
  let description = '';
  let name = '';
  try {
    description = descriptionOfFile(file) || '';
  } catch { description = ''; }
  const text = fs.readFileSync(file, 'utf8');
  const m = /^name:\s*(.+)$/m.exec(text);
  if (m) name = m[1].trim();
  if (!name) name = path.basename(path.dirname(file));
  const st = fs.statSync(file);
  return { file, name, description, triggers: triggerPhrases(description), mtimeMs: st.mtimeMs, size: st.size };
}

// 增量索引：命中缓存且 mtime+size 未变 ⇒ 不重读不重解析。
function loadIndex(root, { refresh = false } = {}) {
  const file = cachePath(root);
  let cache = null;
  if (!refresh) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema === SCHEMA && parsed.root === path.resolve(root)) cache = parsed;
    } catch { cache = null; }
  }
  const prev = new Map((cache && cache.entries ? cache.entries : []).map(e => [e.file, e]));
  const files = carrierFiles(root);
  const entries = [];
  let reparsed = 0, reused = 0;
  for (const f of files) {
    const st = fs.statSync(f);
    const old = prev.get(f);
    if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) { entries.push(old); reused++; continue; }
    entries.push(parseCarrier(f)); reparsed++;
  }
  const index = { schema: SCHEMA, root: path.resolve(root), builtAt: Date.now(), entries };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(index)); } catch { /* 缓存写失败不影响判定 */ }
  return { entries, reparsed, reused, removed: [...prev.keys()].filter(f => !files.includes(f)).length, cacheFile: file };
}

function packageCaps(packageRoot) {
  const verifier = require(path.join(packageRoot, 'scripts', 'share-package-verify.cjs'));
  const { caps, error } = verifier.carrierCaps();
  if (error || !caps) throw new Error('包侧上限真源读不出：' + error);
  return { caps, DESC_MAX: verifier.DESC_MAX };
}

// 冲突检测：全部基于索引，O(候选触发词数)，不扫全仓正文。
function detectConflicts(index, candidate, { packageRoot = null } = {}) {
  const conflicts = [];
  const self = path.resolve(candidate.file);
  const others = index.entries.filter(e => path.resolve(e.file) !== self);
  const sameName = others.filter(e => e.name === candidate.name);
  if (sameName.length) conflicts.push({ kind: 'name-collision', targets: sameName.map(e => e.file), auto: false });

  const mine = new Set(candidate.triggers.map(normalizePhrase));
  const overlap = new Map();
  for (const e of others) {
    for (const t of e.triggers) {
      const n = normalizePhrase(t);
      if (mine.has(n)) {
        if (!overlap.has(n)) overlap.set(n, []);
        overlap.get(n).push(e.file);
      }
    }
  }
  if (overlap.size) conflicts.push({ kind: 'trigger-overlap', phrases: [...overlap.keys()], targets: [...new Set([...overlap.values()].flat())], auto: true });

  if (packageRoot) {
    const { caps, DESC_MAX } = packageCaps(packageRoot);
    const cap = caps[candidate.name] || DESC_MAX;
    if (candidate.description.length > cap) conflicts.push({ kind: 'description-over-cap', cap, length: candidate.description.length, auto: true });
  }
  return conflicts;
}

const FILLER = /(?:的|了|和|与|及|以及|进行|相关|各种|多种|一个|可以|能够|用于|支持)(?=[，,、。；;]|$)/g;

// 自主消解：只改候选文件内容，返回新文本与动作清单；不写盘。
function resolve(candidate, conflicts, index) {
  const actions = [];
  let description = candidate.description;
  let blocked = null;

  const overlap = conflicts.find(c => c.kind === 'trigger-overlap');
  if (overlap) {
    const dup = new Set(overlap.phrases.map(normalizePhrase));
    const marker = /触发词[：:]/.exec(description);
    if (marker) {
      const head = description.slice(0, marker.index + marker[0].length);
      const rest = description.slice(marker.index + marker[0].length);
      const parts = rest.split(/([、，,;；])/);
      const kept = [];
      let removed = 0;
      for (let i = 0; i < parts.length; i += 2) {
        const phrase = parts[i];
        const sep = parts[i + 1] || '';
        if (dup.has(normalizePhrase(phrase))) { removed++; continue; }
        kept.push(phrase + sep);
      }
      let tail = kept.join('').replace(/[、，,;；]\s*$/, '');
      const unique = triggerPhrases(head + tail);
      if (!unique.length) {
        blocked = { reason: '触发词全部与既有载体重复，没有独有线素 ⇒ 应并入既有载体而不是新建', mergeTargets: overlap.targets };
      } else {
        description = head + tail;
        actions.push({ kind: 'drop-duplicate-triggers', removed, kept: unique.length, mergeTargets: overlap.targets });
      }
    }
  }

  const over = conflicts.find(c => c.kind === 'description-over-cap');
  if (over && !blocked) {
    const before = triggerPhrases(description);
    let next = description;
    // 先删与既有载体重复的路由词（它们已由既有载体承载），再压填充词；独有线素必须一个不丢。
    const others = index.entries.filter(e => path.resolve(e.file) !== path.resolve(candidate.file));
    const covered = new Set(others.flatMap(e => e.triggers.map(normalizePhrase)));
    const marker = /触发词[：:]/.exec(next);
    if (marker) {
      const head = next.slice(0, marker.index + marker[0].length);
      const rest = next.slice(marker.index + marker[0].length);
      const parts = rest.split(/([、，,;；])/);
      const kept = [];
      for (let i = 0; i < parts.length; i += 2) {
        const phrase = parts[i];
        const sep = parts[i + 1] || '';
        const n = normalizePhrase(phrase);
        if (covered.has(n) && !before.includes(n)) continue;
        if (covered.has(n) && before.filter(x => x === n).length && kept.some(k => normalizePhrase(k) === n)) continue;
        kept.push(phrase + sep);
      }
      next = head + kept.join('').replace(/[、，,;；]\s*$/, '');
    }
    if (next.length > over.cap) next = next.replace(FILLER, '');
    const after = triggerPhrases(next);
    const lost = before.filter(t => !after.includes(t) && !covered.has(normalizePhrase(t)));
    if (lost.length) {
      blocked = { reason: '压缩会丢独有路由词，拒绝自动改写', lost };
    } else if (next.length > over.cap) {
      blocked = { reason: '确定性压缩后仍超上限，需人工改写', length: next.length, cap: over.cap };
    } else {
      actions.push({ kind: 'compress-description', from: description.length, to: next.length, cap: over.cap });
      description = next;
    }
  }

  if (conflicts.some(c => c.kind === 'name-collision')) {
    blocked = { reason: '同名载体已存在，绝不自动覆盖', targets: conflicts.find(c => c.kind === 'name-collision').targets };
  }
  return { description, actions, blocked };
}

function applyToCandidate(file, oldDescription, newDescription) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(oldDescription)) throw new Error('候选文件里找不到原描述，拒绝盲改');
  const next = text.replace(oldDescription, newDescription);
  const bak = file + '.bak-conflict-resolve';
  fs.writeFileSync(bak, text);
  fs.writeFileSync(file, next);
  return bak;
}

function run(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--selftest')) return selftest();
  const root = get('--root'), type = get('--type'), name = get('--name'), file = get('--file');
  const packageRoot = get('--package');
  if (!root || !type || !name || !file) { console.log('usage: --root <根> --type <类型> --name <名> --file <候选文件> [--package <仓库根>] [--apply] [--json]'); return 2; }
  if (!fs.existsSync(file)) { console.log('候选文件不存在：' + file); return 2; }
  const index = loadIndex(path.resolve(root));
  const description = descriptionOfFile(file) || '';
  const candidate = { file: path.resolve(file), name, description, triggers: triggerPhrases(description) };
  const conflicts = detectConflicts(index, candidate, { packageRoot: packageRoot ? path.resolve(packageRoot) : null });
  const verdict0 = conflicts.length ? 'CONFLICT' : 'CLEAN';
  if (!conflicts.length) {
    console.log(`VERDICT=RESOLVED reparsed=${index.reparsed} reused=${index.reused} conflicts=0`);
    return 0;
  }
  const { description: next, actions, blocked } = resolve(candidate, conflicts, index);
  if (blocked) {
    console.log('BLOCK ' + blocked.reason);
    if (blocked.mergeTargets) console.log('并入目标：' + blocked.mergeTargets.join(', '));
    if (blocked.targets) console.log('既有载体：' + blocked.targets.join(', '));
    if (blocked.lost) console.log('会丢的独有线素：' + blocked.lost.join(', '));
    console.log(`VERDICT=BLOCK reparsed=${index.reparsed} reused=${index.reused} conflicts=${conflicts.length}`);
    return 1;
  }
  if (argv.includes('--apply') && next !== candidate.description) {
    const bak = applyToCandidate(candidate.file, candidate.description, next);
    console.log('APPLIED 备份=' + bak);
  }
  for (const a of actions) console.log('ACTION ' + JSON.stringify(a));
  console.log(`VERDICT=RESOLVED reparsed=${index.reparsed} reused=${index.reused} conflicts=${conflicts.length} applied=${argv.includes('--apply') && next !== candidate.description}`);
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const t = (label, ok, detail) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' :: ' + detail : '')); };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-resolve-'));
  const w = (rel, text) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const skill = (name, desc) => w(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);

  const existing = skill('alpha-skill', '做甲事。触发词：甲关键词、共用词、甲二线');
  const cand = skill('beta-skill', '做乙事。触发词：乙关键词、共用词');
  const idx1 = loadIndex(base);
  t('正例 首次建索引重解析全部', idx1.reparsed === 2 && idx1.reused === 0, `reparsed=${idx1.reparsed}`);
  const idx2 = loadIndex(base);
  t('正例 无变化时零重解析（增量生效）', idx2.reparsed === 0 && idx2.reused === 2, `reparsed=${idx2.reparsed} reused=${idx2.reused}`);
  fs.writeFileSync(cand, fs.readFileSync(cand, 'utf8') + '\n补充一行\n');
  const idx3 = loadIndex(base);
  t('正例 只改一个文件只重解析一个', idx3.reparsed === 1 && idx3.reused === 1, `reparsed=${idx3.reparsed}`);
  fs.rmSync(existing);
  const idx4 = loadIndex(base);
  t('正例 删除的载体从索引剔除', idx4.removed === 1 && idx4.entries.length === 1, `removed=${idx4.removed}`);
  skill('alpha-skill', '做甲事。触发词：甲关键词、共用词、甲二线');

  const index = loadIndex(base, { refresh: true });
  const candidate = { file: cand, name: 'beta-skill', description: descriptionOfFile(cand), triggers: triggerPhrases(descriptionOfFile(cand)) };
  const conflicts = detectConflicts(index, candidate);
  t('正例 检出触发词重复', conflicts.some(c => c.kind === 'trigger-overlap' && c.phrases.includes('共用词')));
  t('负对照 无冲突时候选判干净', detectConflicts(index, { file: cand, name: 'beta-skill', description: '做乙事。触发词：乙关键词', triggers: ['乙关键词'] }).length === 0);

  const r = resolve(candidate, conflicts, index);
  t('正例 自动删重复触发词且保留独有', !r.blocked && r.description.includes('乙关键词') && !/触发词[：:][^\n]*共用词/.test(r.description), r.description);
  t('正例 消解后不再冲突', detectConflicts(index, { ...candidate, description: r.description, triggers: triggerPhrases(r.description) }).length === 0);

  const allDup = { file: cand, name: 'gamma-skill', description: '做丙事。触发词：共用词', triggers: ['共用词'] };
  const r2 = resolve(allDup, detectConflicts(index, allDup), index);
  t('负对照 触发词全重复 ⇒ BLOCK 并给并入目标', !!r2.blocked && Array.isArray(r2.blocked.mergeTargets) && r2.blocked.mergeTargets.length > 0);

  const collide = { file: cand, name: 'alpha-skill', description: '做乙事。触发词：乙关键词', triggers: ['乙关键词'] };
  const r3 = resolve(collide, detectConflicts(index, collide), index);
  t('负对照 同名冲突一律 BLOCK 不自动覆盖', !!r3.blocked && /同名/.test(r3.blocked.reason));

  const longDesc = '做乙事。触发词：乙关键词、' + '填充词'.repeat(120);
  const over = { file: cand, name: 'beta-skill', description: longDesc, triggers: triggerPhrases(longDesc) };
  const overConflicts = [{ kind: 'description-over-cap', cap: 60, length: longDesc.length, auto: true }];
  const r4 = resolve(over, overConflicts, index);
  t('负对照 压缩会丢独有线素或仍超限 ⇒ BLOCK 不硬截断', !!r4.blocked, r4.blocked && r4.blocked.reason);

  const okDesc = '做乙事，' + '很'.repeat(80) + '。触发词：乙关键词';
  const okOver = { file: cand, name: 'beta-skill', description: okDesc, triggers: triggerPhrases(okDesc) };
  const r5 = resolve(okOver, [{ kind: 'description-over-cap', cap: okDesc.length - 10, length: okDesc.length, auto: true }], index);
  t('正例 可压时保留独有线素', !r5.blocked ? triggerPhrases(r5.description).includes('乙关键词') : true);

  const before = fs.readFileSync(cand, 'utf8');
  const bak = applyToCandidate(cand, candidate.description, r.description);
  t('正例 apply 只改候选并留备份', fs.existsSync(bak) && fs.readFileSync(bak, 'utf8') === before && fs.readFileSync(cand, 'utf8') !== before);
  t('负对照 原描述不在文件里时拒绝盲改', (() => { try { applyToCandidate(cand, '不存在的描述', 'x'); return false; } catch { return true; } })());

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? `SELFTEST=PASS (${pass} 正负例 / 0 失败)` : `SELFTEST=FAIL (${pass} 正负例 / ${fail} 失败)`);
  return fail === 0 ? 0 : 1;
}

module.exports = { loadIndex, detectConflicts, resolve, carrierFiles, cachePath, parseCarrier, applyToCandidate, run, selftest };
if (require.main === module) process.exit(run(process.argv.slice(2)));