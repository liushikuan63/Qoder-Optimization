#!/usr/bin/env node
/**
 * 职责：兜底清理**我方**临时产物（AGENTS.md「临时产物用后即删 + 收尾必问」那条的机制层）。
 * 依赖：node（无第三方包）。
 *
 * <p><b>为什么默认只报告、删除要显式 `--apply`</b>：一次性产物（截图 / 探针脚本 / 日志）
 * 的"用完"只有人知道，脚本只能看年龄。默认列清单 + 弹窗确认，才不会出现"清理把还在用的证据删了"。
 *
 * <p><b>安全边界（这个脚本最容易犯的错就是扫太宽）</b>：
 * ① 默认根＝`<os.tmpdir()>/qoder-work`；派生根＝`<os.tmpdir()>/qoder-cli`（会话任务输出）
 *   与 `%LOCALAPPDATA%/Temp/qoder-work`（TEMP 迁盘前的遗留，若存在）；额外根只能由
 *   配置文件 `~/.qoder/tmp-sweeper.json` 的 `extraRoots` 或显式 `--root` 给出。
 * **绝不用 `qoder*` 这类宽前缀**：宿主会为每个会话建 `qoder-XXXX-cwd` 目录（实测数百个），
 * 宽前缀会把 Qoder 自己的会话目录当垃圾删掉，那是把正在跑的会话掀了。
 * ② 硬否决：`qoder-*-cwd`、配置根（CLIENT_ROOT）内、`.git`、`node_modules` 一律跳过；
 *    不跟随目录链接（junction/symlink）。
 * ③ 活跃保护：顶层条目 24h 内有改动 ⇒ 视为活跃会话产物，整棵跳过（`--include-fresh` 可解除）。
 * ④ 删除后回收空目录（只回收本次实际扫描过的顶层目录，根目录本身不动）。
 *
 * ⑤ 证据自声明：目录内 `.keep` / `.evidence.json` ⇒ 整棵保留；`<root>/.trash` 是隔离区，不扫不删；
 *    未分类扩展名不再永久豁免，走 30 天 `other` 兜底。
 *
 * <p>用法：`node tmp-sweeper.js [--apply] [--root <dir>]... [--json] [--include-fresh] [--max-ms <n>]`；
 * `--usage` 只读统计临时根用量（开台水位提醒用）；自测 `node tmp-sweeper.test.js`。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot()

/** 超期阈值（天）：一次性产物按类型分档；未命中的扩展名走 30 天兜底，不能"永远不超期"。 */
const RULES = [
  { kind: 'image', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'], maxAgeDays: 3 },
  { kind: 'text', exts: ['.log', '.txt', '.json', '.md', '.csv', '.html', '.output'], maxAgeDays: 3 },
  { kind: 'media', exts: ['.mp4', '.mov', '.avi', '.mkv', '.wav', '.mp3'], maxAgeDays: 7 },
  { kind: 'archive', exts: ['.zip', '.7z', '.rar', '.tgz', '.tar', '.gz', '.bz2', '.xz'], maxAgeDays: 15 },
  { kind: 'document', exts: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'], maxAgeDays: 15 },
  { kind: 'script', exts: ['.js', '.cjs', '.mjs', '.ts', '.py', '.ps1', '.sh'], maxAgeDays: 15 },
  { kind: 'other', exts: null, maxAgeDays: 30 },
]

const DAY = 24 * 60 * 60 * 1000
const HEARTBEAT = path.join(CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'heartbeat.log')
const CONFIG_PATH = path.join(CLIENT_ROOT, 'tmp-sweeper.json')
/** 顶层条目在这么久内有改动 ⇒ 活跃会话产物，整棵跳过（可用 --include-fresh 解除）。 */
const FRESH_TOP_MS = 24 * 60 * 60 * 1000
/** 显式扫描的默认时间预算；0 = 不限。提醒/自动路径会传更小的值。 */
const DEFAULT_MAX_SCAN_MS = 15000

/** 宿主自己的会话目录形状：`qoder-<随机>-cwd`。任何情况下都不许碰。 */
function isHostSessionDir(p) {
  return p.split(path.sep).some((seg) => /^qoder-[^-]+-cwd$/i.test(seg))
}

/** 硬否决：宿主会话目录、配置根内、.git、node_modules、隔离区、任何链接目录由调用方另行跳过。 */
function isForbidden(p) {
  if (isHostSessionDir(p)) return true
  const rel = path.relative(CLIENT_ROOT, p)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  return p.split(path.sep).some((seg) => seg === '.git' || seg === 'node_modules' || seg === '.trash')
}

function classify(name) {
  const ext = path.extname(name).toLowerCase()
  for (const r of RULES) {
    if (r.exts === null || r.exts.includes(ext)) {
      return r
    }
  }
  return null
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return cfg && typeof cfg === 'object' ? cfg : {}
  } catch (e) {
    return {}
  }
}

/** 排除清单：excludePaths（精确路径或目录前缀）与 excludeTopPrefixes（顶层条目名前缀）。 */
function buildExclude(cfg) {
  const paths = (Array.isArray(cfg.excludePaths) ? cfg.excludePaths : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => path.resolve(s).toLowerCase())
  const prefixes = (Array.isArray(cfg.excludeTopPrefixes) ? cfg.excludeTopPrefixes : [])
    .filter((s) => typeof s === 'string' && s.trim())
  return { paths, prefixes }
}

function isExcluded(p, ex, topName) {
  if (!ex) return false
  const low = p.toLowerCase()
  if (ex.paths.some((x) => low === x || low.startsWith(x + path.sep))) return true
  if (topName && ex.prefixes.some((pre) => topName.startsWith(pre))) return true
  return false
}

/** 证据自声明：目录内放 .keep / .evidence.json 即整棵保留，不再依赖中心前缀清单。 */
const KEEP_MARKERS = ['.keep', '.evidence.json']

function directMarker(dir, cache) {
  const key = path.resolve(dir).toLowerCase()
  if (cache && cache.has(key)) return cache.get(key)
  let hit = false
  for (const m of KEEP_MARKERS) {
    try {
      if (fs.statSync(path.join(dir, m)).isFile()) { hit = true; break }
    } catch (e) {}
  }
  if (cache) cache.set(key, hit)
  return hit
}

/** 从 dir 向上检查到 rootDir（含），命中任一目录的标记即保留。 */
function ancestorMarker(dir, rootDir, cache) {
  let cur = path.resolve(dir)
  const rootLow = rootDir ? path.resolve(rootDir).toLowerCase() : null
  for (let i = 0; i < 16; i++) {
    if (directMarker(cur, cache)) return true
    if (rootLow && cur.toLowerCase() === rootLow) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** 顶层目录内任意子目录带标记 ⇒ 整棵保留（有界递归，避免深树拖慢扫描）。 */
function treeMarker(dir, cache, state) {
  if (directMarker(dir, cache)) return true
  state = state || { n: 0 }
  let list
  try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return false }
  for (const e of list) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue
    if (state.n++ > 2000) return false
    const full = path.join(dir, e.name)
    if (isForbidden(full)) continue
    if (treeMarker(full, cache, state)) return true
  }
  return false
}

function hasKeepMarker(p, rootDir, cache) {
  try {
    const st = fs.statSync(p)
    const base = st.isDirectory() ? p : path.dirname(p)
    return ancestorMarker(base, rootDir, cache || new Map())
  } catch (e) {
    return false
  }
}

/** 我方临时根。名字必须精确等于 `qoder-work`，否则宁可什么都不扫。 */
function defaultRoot() {
  return path.join(os.tmpdir(), 'qoder-work')
}

/** 默认 + 派生 + 配置里的额外根（去重、只留存在的目录）。
 * canonicalRoot（配置）是本机唯一约定的临时目录；默认根若仍存在则作为"历史遗留"兜底扫描。 */
function resolveRoots(argv) {
  const explicit = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      explicit.push(path.resolve(argv[++i]))
    }
  }
  const roots = []
  const add = (d) => {
    try {
      const r = path.resolve(d)
      if (!fs.existsSync(r)) return
      if (roots.some((x) => x.toLowerCase() === r.toLowerCase())) return
      roots.push(r)
    } catch (e) {}
  }
  if (explicit.length) {
    explicit.forEach(add)
  } else {
    const cfg = loadConfig()
    if (typeof cfg.canonicalRoot === 'string' && path.isAbsolute(cfg.canonicalRoot)) add(cfg.canonicalRoot)
    add(defaultRoot())
    add(path.join(os.tmpdir(), 'qoder-cli'))
    if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Temp', 'qoder-work'))
    for (const r of Array.isArray(cfg.extraRoots) ? cfg.extraRoots : []) {
      if (typeof r === 'string' && path.isAbsolute(r)) add(r)
    }
  }
  // 硬否决：宿主会话目录、以及不存在的目录
  return roots.filter((r) => !isHostSessionDir(r) && fs.existsSync(r))
}

function walk(dir, out, opts) {
  opts = opts || {}
  const cache = opts.cache || (opts.cache = new Map())
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const e of entries) {
    if (opts.deadline && Date.now() > opts.deadline) {
      if (opts.state) opts.state.partial = true
      return out
    }
    const full = path.join(dir, e.name)
    if (isForbidden(full) || isExcluded(full, opts.exclude)) {
      continue
    }
    if (e.isSymbolicLink()) {
      continue
    }
    if (e.isDirectory()) {
      if (directMarker(full, cache)) continue
      walk(full, out, opts)
      continue
    }
    if (!e.isFile()) {
      continue
    }
    if (ancestorMarker(dir, opts.rootDir, cache)) {
      continue
    }
    const rule = classify(e.name)
    if (rule === null) {
      continue
    }
    let st
    try {
      st = fs.statSync(full)
    } catch (err) {
      continue
    }
    const ageDays = (Date.now() - st.mtimeMs) / DAY
    if (ageDays > rule.maxAgeDays) {
      out.push({ path: full, kind: rule.kind, ageDays: Math.floor(ageDays), bytes: st.size,
        maxAgeDays: rule.maxAgeDays })
    }
  }
  return out
}

/** 扫一个根：顶层活跃目录整棵跳过；返回超期件与本次实际扫描过的顶层目录。 */
function scanRoot(root, opts) {
  opts = opts || {}
  const found = []
  const scannedDirs = []
  const cache = opts.cache || (opts.cache = new Map())
  let skippedFresh = 0
  let skippedKeep = 0
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return { found, scannedDirs, skippedFresh, skippedKeep, error: true }
  }
  for (const e of entries) {
    if (opts.deadline && Date.now() > opts.deadline) {
      if (opts.state) opts.state.partial = true
      break
    }
    const full = path.join(root, e.name)
    if (isForbidden(full) || e.isSymbolicLink() || isExcluded(full, opts.exclude, e.name)) continue
    if (e.isDirectory() && treeMarker(full, cache)) {
      skippedKeep += 1
      continue
    }
    if (!opts.includeFresh && opts.freshTopMs !== 0) {
      let st
      try { st = fs.statSync(full) } catch (err) { continue }
      if (Date.now() - st.mtimeMs < (opts.freshTopMs || FRESH_TOP_MS)) {
        skippedFresh += 1
        continue
      }
    }
    if (e.isDirectory()) {
      scannedDirs.push(full)
      walk(full, found, Object.assign({}, opts, { rootDir: root, cache }))
    } else if (e.isFile()) {
      if (ancestorMarker(root, root, cache)) continue
      const rule = classify(e.name)
      if (rule === null) continue
      let st
      try { st = fs.statSync(full) } catch (err) { continue }
      const ageDays = (Date.now() - st.mtimeMs) / DAY
      if (ageDays > rule.maxAgeDays) {
        found.push({ path: full, kind: rule.kind, ageDays: Math.floor(ageDays), bytes: st.size,
          maxAgeDays: rule.maxAgeDays })
      }
    }
  }
  return { found, scannedDirs, skippedFresh, skippedKeep, error: false }
}

/** 多根扫描；opts.maxMs 为时间预算（提醒/自动路径用），到点即停并标 partial。 */
function scan(opts) {
  opts = opts || {}
  const roots = opts.roots || resolveRoots([])
  const state = { partial: false }
  const deadline = opts.maxMs && opts.maxMs > 0 ? Date.now() + opts.maxMs : 0
  const cfg = opts.config || loadConfig()
  const exclude = opts.exclude || buildExclude(cfg)
  const scanOpts = { deadline, state, includeFresh: !!opts.includeFresh, freshTopMs: opts.freshTopMs, exclude,
    cache: new Map() }
  const found = []
  const scannedDirs = []
  let skippedFresh = 0
  let skippedKeep = 0
  for (const r of roots) {
    const res = scanRoot(r, scanOpts)
    // 大根（如 D:/tmp 数十万文件）下 spread 实参超调用栈上限，逐条追加
    for (const item of res.found) found.push(item)
    for (const dir of res.scannedDirs) scannedDirs.push(dir)
    skippedFresh += res.skippedFresh
    skippedKeep += res.skippedKeep || 0
    if (state.partial) break
  }
  return { roots, stale: found, scannedDirs, skippedFresh, skippedKeep, partial: state.partial }
}

/** 用量统计要看见隔离区（它仍占磁盘），只否决宿主目录 / 配置根 / .git / node_modules。 */
function isForbiddenExceptTrash(p) {
  if (isHostSessionDir(p)) return true
  const rel = path.relative(CLIENT_ROOT, p)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  return p.split(path.sep).some((seg) => seg === '.git' || seg === 'node_modules')
}

/** 只读用量统计：供开台水位提醒用；带时间/文件数预算，partial 表示数值为下限。 */
function usageScan(roots, maxMs) {
  const state = { partial: false }
  const deadline = maxMs && maxMs > 0 ? Date.now() + maxMs : 0
  let bytes = 0
  let files = 0
  let topEntries = 0
  const stack = roots.map((r) => ({ dir: r, depth: 0 }))
  while (stack.length) {
    if (deadline && Date.now() > deadline) { state.partial = true; break }
    const cur = stack.pop()
    let list
    try { list = fs.readdirSync(cur.dir, { withFileTypes: true }) } catch (e) { continue }
    if (cur.depth === 0) topEntries += list.length
    for (const e of list) {
      const full = path.join(cur.dir, e.name)
      if (isForbiddenExceptTrash(full)) continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push({ dir: full, depth: cur.depth + 1 }); continue }
      if (!e.isFile()) continue
      try { bytes += fs.statSync(full).size; files++ } catch (err) {}
      if (files > 200000) { state.partial = true; break }
    }
  }
  return { roots, bytes, files, topEntries, partial: state.partial }
}

/** 回收空目录（只回收本次实际扫描过的顶层目录；根目录本身不动）。 */
function pruneEmptyDirs(dirs, exclude) {
  let removed = 0
  const rec = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const full = path.join(dir, e.name)
      if (isForbidden(full) || isExcluded(full, exclude)) continue
      rec(full)
    }
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
        removed += 1
      }
    } catch (e) {}
  }
  for (const d of dirs) rec(d)
  return removed
}

function heartbeat(line) {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT), { recursive: true })
    fs.appendFileSync(HEARTBEAT, `${new Date().toISOString()} ${line}\n`)
  } catch (e) {
    // 心跳写不进去不影响清理本身，但也不能因此谎报"已记录"
  }
}

function main(argv) {
  const apply = argv.includes('--apply')
  const readOnly = argv.includes('--read-only')
  if (readOnly && apply) { console.error('--read-only cannot be combined with --apply'); return 2 }
  const asJson = argv.includes('--json')
  const includeFresh = argv.includes('--include-fresh')
  let maxMs = DEFAULT_MAX_SCAN_MS
  const mi = argv.indexOf('--max-ms')
  if (mi >= 0 && argv[mi + 1] && /^\d+$/.test(argv[mi + 1])) maxMs = Number(argv[mi + 1])
  const cfg = loadConfig()
  const freshTopMs = Number.isFinite(cfg.freshTopHours) ? cfg.freshTopHours * 3600000 : FRESH_TOP_MS
  if (argv.includes('--usage')) {
    const roots = resolveRoots(argv)
    const usage = usageScan(roots, maxMs)
    const warnGb = Number.isFinite(cfg.usageWarnGb) ? cfg.usageWarnGb : 5
    const warnEntries = Number.isFinite(cfg.usageWarnEntries) ? cfg.usageWarnEntries : 2000
    const level = usage.bytes >= warnGb * 1024 * 1024 * 1024 || usage.topEntries >= warnEntries ? 'warn' : 'ok'
    if (!readOnly) {
      heartbeat(`USAGE roots=${roots.length} bytes=${usage.bytes} files=${usage.files} top=${usage.topEntries}`
        + `${usage.partial ? ' partial' : ''}`)
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ roots, usage, level, warnGb, warnEntries }, null, 2)}\n`)
    } else {
      process.stdout.write(`临时根用量：${(usage.bytes / 1048576).toFixed(1)}MB / ${usage.files} 个文件 / `
        + `顶层 ${usage.topEntries} 项（阈值 ${warnGb}GB 或 ${warnEntries} 项）⇒ ${level}`
        + `${usage.partial ? '（预算内，数值为下限）' : ''}\n`)
    }
    return 0
  }
  const res = scan({ roots: resolveRoots(argv), includeFresh, maxMs, freshTopMs, config: cfg })
  const found = res.stale
  let deleted = 0
  let failed = 0
  let pruned = 0
  if (apply) {
    for (const f of found) {
      try {
        fs.rmSync(f.path, { force: true })
        deleted += 1
      } catch (e) {
        failed += 1
      }
    }
    if (failed === 0) pruned = pruneEmptyDirs(res.scannedDirs, buildExclude(cfg))
  }
  if (!readOnly) {
    heartbeat(`${apply ? 'APPLY' : 'SCAN'} roots=${res.roots.length} stale=${found.length} deleted=${deleted} failed=${failed} pruned=${pruned} skippedFresh=${res.skippedFresh} skippedKeep=${res.skippedKeep}${res.partial ? ' partial' : ''}`)
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ roots: res.roots, apply, stale: found, deleted, failed, pruned,
      skippedFresh: res.skippedFresh, partial: res.partial }, null, 2)}\n`)
  } else {
    process.stdout.write(`临时产物根：${res.roots.length === 0 ? '（无：默认根不存在且未配置 extraRoots）' : res.roots.join(', ')}\n`)
    if (found.length === 0) {
      process.stdout.write(`没有超期临时件。${res.partial ? '（扫描预算内）' : ''}\n`)
    } else {
      process.stdout.write(`${apply ? '已删除' : '超期待删'} ${found.length} 个（阈值：图/文 >3 天、脚本 >15 天）${res.partial ? '（扫描预算内，数量为下限）' : ''}：\n`)
      for (const f of found) {
        process.stdout.write(`  ${f.ageDays}d ${f.kind.padEnd(6)} ${f.bytes}B  ${f.path}\n`)
      }
      if (!apply) {
        process.stdout.write('\n默认只列清单。确认后再跑：node tmp-sweeper.js --apply\n')
      }
    }
    if (apply) {
      process.stdout.write(`已回收空目录 ${pruned} 个；跳过活跃顶层条目 ${res.skippedFresh} 个。\n`)
    }
  }
  return failed === 0 ? 0 : 1
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = { main, walk, scan, scanRoot, pruneEmptyDirs, classify, isHostSessionDir, isForbidden,
  isForbiddenExceptTrash, isExcluded, buildExclude, loadConfig, resolveRoots, RULES, defaultRoot, CLIENT_ROOT,
  CONFIG_PATH, hasKeepMarker, usageScan, KEEP_MARKERS }
