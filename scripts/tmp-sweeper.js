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
 * <p>用法：`node tmp-sweeper.js [--apply] [--root <dir>]... [--json] [--include-fresh] [--max-ms <n>]`；
 * 自测 `node tmp-sweeper.test.js`。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot()

/** 超期阈值（天）：图片 / 文本类一次性产物 3 天，脚本类 15 天（脚本常被复用作模板，留久一点）。 */
const RULES = [
  { kind: 'image', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'], maxAgeDays: 3 },
  { kind: 'text', exts: ['.log', '.txt', '.json', '.md', '.csv', '.html', '.output'], maxAgeDays: 3 },
  { kind: 'script', exts: ['.js', '.cjs', '.mjs', '.ts', '.py', '.ps1', '.sh', '.mjs'], maxAgeDays: 15 },
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

/** 硬否决：宿主会话目录、配置根内、.git、node_modules、任何链接目录由调用方另行跳过。 */
function isForbidden(p) {
  if (isHostSessionDir(p)) return true
  const rel = path.relative(CLIENT_ROOT, p)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  return p.split(path.sep).some((seg) => seg === '.git' || seg === 'node_modules')
}

function classify(name) {
  const ext = path.extname(name).toLowerCase()
  for (const r of RULES) {
    if (r.exts.includes(ext)) {
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

/** 我方临时根。名字必须精确等于 `qoder-work`，否则宁可什么都不扫。 */
function defaultRoot() {
  return path.join(os.tmpdir(), 'qoder-work')
}

/** 默认 + 派生 + 配置里的额外根（去重、只留存在的目录）。 */
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
    add(defaultRoot())
    add(path.join(os.tmpdir(), 'qoder-cli'))
    if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Temp', 'qoder-work'))
    const cfg = loadConfig()
    for (const r of Array.isArray(cfg.extraRoots) ? cfg.extraRoots : []) {
      if (typeof r === 'string' && path.isAbsolute(r)) add(r)
    }
  }
  // 硬否决：宿主会话目录、以及不存在的目录
  return roots.filter((r) => !isHostSessionDir(r) && fs.existsSync(r))
}

function walk(dir, out, opts) {
  opts = opts || {}
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
      walk(full, out, opts)
      continue
    }
    if (!e.isFile()) {
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
  let skippedFresh = 0
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return { found, scannedDirs, skippedFresh, error: true }
  }
  for (const e of entries) {
    if (opts.deadline && Date.now() > opts.deadline) {
      if (opts.state) opts.state.partial = true
      break
    }
    const full = path.join(root, e.name)
    if (isForbidden(full) || e.isSymbolicLink() || isExcluded(full, opts.exclude, e.name)) continue
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
      walk(full, found, opts)
    } else if (e.isFile()) {
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
  return { found, scannedDirs, skippedFresh, error: false }
}

/** 多根扫描；opts.maxMs 为时间预算（提醒/自动路径用），到点即停并标 partial。 */
function scan(opts) {
  opts = opts || {}
  const roots = opts.roots || resolveRoots([])
  const state = { partial: false }
  const deadline = opts.maxMs && opts.maxMs > 0 ? Date.now() + opts.maxMs : 0
  const cfg = opts.config || loadConfig()
  const exclude = opts.exclude || buildExclude(cfg)
  const scanOpts = { deadline, state, includeFresh: !!opts.includeFresh, freshTopMs: opts.freshTopMs, exclude }
  const found = []
  const scannedDirs = []
  let skippedFresh = 0
  for (const r of roots) {
    const res = scanRoot(r, scanOpts)
    found.push(...res.found)
    scannedDirs.push(...res.scannedDirs)
    skippedFresh += res.skippedFresh
    if (state.partial) break
  }
  return { roots, stale: found, scannedDirs, skippedFresh, partial: state.partial }
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
    heartbeat(`${apply ? 'APPLY' : 'SCAN'} roots=${res.roots.length} stale=${found.length} deleted=${deleted} failed=${failed} pruned=${pruned} skippedFresh=${res.skippedFresh}${res.partial ? ' partial' : ''}`)
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
  loadConfig, resolveRoots, RULES, defaultRoot, CLIENT_ROOT, CONFIG_PATH }
