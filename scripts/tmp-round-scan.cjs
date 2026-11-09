#!/usr/bin/env node
// 本轮临时产物扫描/清理：列出 canonicalRoot 下自 --since 起新增/改动的顶层条目。
// 默认只扫描；--apply 只清理本轮可清条目（受保护项/已登记证据/分享包产物/超期件不删）。
'use strict'

const fs = require('fs')
const path = require('path')
const sweeper = require('./tmp-sweeper.js')

const DAY = 24 * 60 * 60 * 1000
const HEARTBEAT = path.join(sweeper.CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'heartbeat.log')
// 分享包产物：默认不自动删，留给"每轮结束询问"；只有显式 --include-share-package 才纳入清理。
const SHARE_PATTERNS = [/^Qoder-Optimization/i, /share-package/i, /install-package/i, /^pkg-/i,
  /^qoder-download/i, /^qoder-consumer-home/i, /^qo-[^\n]*(?:pkg|release)/i]
// 回滚点/取证目录：即使清理分享包产物也不动（不要用 ^qo- 宽前缀，普通任务日志也会被误保护）。
const ALWAYS_PROTECT = [/^QO-(?:REL|AUDIT|FIX)-/i, /^qo-(?:deploy|wip)-/i]

function parseArgs(argv) {
  const opts = { since: Date.now() - DAY, sinceSet: false, root: null, json: false, apply: false,
    includeSharePackage: false, only: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--include-share-package') opts.includeSharePackage = true
    else if (a === '--only' && argv[i + 1]) opts.only.push(path.resolve(argv[++i]))
    else if (a === '--since' && argv[i + 1]) {
      const v = argv[++i]
      const t = /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v)
      if (Number.isFinite(t)) { opts.since = t; opts.sinceSet = true }
    } else if (a === '--root' && argv[i + 1]) opts.root = path.resolve(argv[++i])
    else if (a === '--help') {
      console.log('用法：node tmp-round-scan.cjs [--since <ISO时间|毫秒>] [--root <目录>] [--json] [--apply] [--include-share-package] [--only <精确路径>]...')
      console.log('默认只扫描。--apply 只清理本轮可清条目，必须显式给 --since；受保护项、已登记证据、分享包产物与超期件不删。')
      console.log('--only 可重复，只处理临时根的直接子条目；并行会话共用 D:/tmp 时用它按精确路径清理本任务产物。')
      console.log('分享包流程默认必须扫描后用 AskUserQuestion 询问；仅在本轮获得明确授权时才加 --include-share-package 自动清理包产物。')
      process.exit(0)
    }
  }
  return opts
}

function dirSize(dir, deadline) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    if (Date.now() > deadline || files > 20000) return { bytes, files, truncated: true }
    const cur = stack.pop()
    let list
    try { list = fs.readdirSync(cur, { withFileTypes: true }) } catch (e) { continue }
    for (const e of list) {
      const full = path.join(cur, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(full); continue }
      try { bytes += fs.statSync(full).size; files++ } catch (err) {}
    }
  }
  return { bytes, files, truncated: false }
}

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'
  return n + 'B'
}

function buildProtect(cfg, includeSharePackage) {
  const patterns = []
  if (!includeSharePackage) patterns.push(...SHARE_PATTERNS)
  patterns.push(...ALWAYS_PROTECT)
  const auto = cfg && cfg.autoClean && typeof cfg.autoClean === 'object' ? cfg.autoClean : {}
  const extra = Array.isArray(auto.protectTopPatterns) ? auto.protectTopPatterns : []
  for (const p of extra) {
    try { patterns.push(new RegExp(String(p), 'i')) } catch (e) {}
  }
  return patterns
}

function isProtected(name, patterns) {
  return patterns.some((re) => re.test(name))
}

function heartbeat(line) {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT), { recursive: true })
    fs.appendFileSync(HEARTBEAT, new Date().toISOString() + ' ' + line + '\n')
  } catch (e) {}
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.apply && !opts.sinceSet) {
    console.error('--apply 必须显式给 --since <本轮开始时间>，避免把其他任务的产物一起清掉。')
    return 2
  }
  const cfg = sweeper.loadConfig() || {}
  const root = opts.root || (typeof cfg.canonicalRoot === 'string' && path.isAbsolute(cfg.canonicalRoot)
    ? cfg.canonicalRoot : sweeper.defaultRoot())
  const rootKey = path.resolve(root).toLowerCase()
  const onlySet = new Set(opts.only.map((p) => p.toLowerCase()))
  for (const p of onlySet) {
    if (path.dirname(p) !== rootKey) {
      console.error('--only 必须是临时根的直接子条目：' + p)
      return 2
    }
  }
  const ex = sweeper.buildExclude(cfg)
  const protect = buildProtect(cfg, opts.includeSharePackage)
  const entries = []
  if (fs.existsSync(root)) {
    const deadline = Date.now() + 500
    let list = []
    try { list = fs.readdirSync(root, { withFileTypes: true }) } catch (e) {}
    for (const e of list) {
      const full = path.join(root, e.name)
      if (e.isSymbolicLink()) {
        entries.push({ name: e.name, path: full, dir: false, bytes: 0, files: 0, truncated: false,
          excluded: true, protected: true, link: true })
        continue
      }
      let st
      try { st = fs.statSync(full) } catch (err) { continue }
      if (st.mtimeMs < opts.since) continue
      const excluded = sweeper.isExcluded(full, ex, e.name) || sweeper.isForbidden(full)
      const size = e.isDirectory() ? dirSize(full, deadline) : { bytes: st.size, files: 1, truncated: false }
      entries.push({ name: e.name, path: full, dir: e.isDirectory(), bytes: size.bytes,
        files: size.files, truncated: size.truncated, excluded, protected: isProtected(e.name, protect) })
    }
  }
  entries.sort((a, b) => b.bytes - a.bytes)
  const stale = sweeper.scan({ roots: [root], maxMs: 1000 }).stale
  const scoped = onlySet.size
    ? entries.filter((e) => onlySet.has(path.resolve(e.path).toLowerCase()))
    : entries
  const unmatchedOnly = onlySet.size
    ? [...onlySet].filter((p) => !scoped.some((e) => path.resolve(e.path).toLowerCase() === p))
    : []
  const candidates = scoped.filter((e) => !e.excluded && !e.protected)
  const preserved = scoped.filter((e) => e.excluded || e.protected)
  const protectedEntries = scoped.filter((e) => e.protected && !e.excluded)

  const deleted = []
  const failed = []
  if (opts.apply) {
    for (const e of candidates) {
      try {
        fs.rmSync(e.path, { recursive: e.dir, force: true })
        deleted.push(e.path)
      } catch (err) {
        failed.push({ path: e.path, error: String((err && err.message) || err) })
      }
    }
    heartbeat('ROUND-' + (opts.includeSharePackage ? 'APPLY-SHARE' : 'APPLY')
      + ' root=' + root + ' since=' + new Date(opts.since).toISOString()
      + ' deleted=' + deleted.length + ' failed=' + failed.length
      + ' protected=' + protectedEntries.length)
  }

  const result = { root, since: new Date(opts.since).toISOString(), apply: opts.apply,
    includeSharePackage: opts.includeSharePackage, only: opts.only, unmatchedOnly, entries, stale,
    staleNote: 'reference-only: the overdue list may come from another machine or package config; verify existence, ownership and references locally before cleanup',
    protected: protectedEntries.map((e) => e.path),
    recommended: { clean: candidates.map((e) => e.path), preserve: preserved.map((e) => e.path) },
    deleted, failed }

  if (opts.json) {
    console.log(JSON.stringify(result))
    return failed.length ? 1 : 0
  }
  console.log('本轮临时根：' + root + '（since ' + new Date(opts.since).toISOString() + '）')
  if (opts.only.length) {
    console.log('仅处理指定路径 ' + opts.only.length + ' 项'
      + (unmatchedOnly.length ? '（其中 ' + unmatchedOnly.length + ' 项本轮未命中）' : '') + '。')
    for (const p of unmatchedOnly) console.log('  未命中：' + p)
  }
  if (!entries.length) {
    console.log('本轮没有新增/改动的顶层条目。')
  } else {
    console.log('新增/改动顶层条目 ' + entries.length + ' 项：')
    for (const e of entries) {
      const tag = e.excluded ? '[已登记证据，保留] ' : (e.protected ? '[分享包产物/受保护，保留] ' : '')
      console.log('  ' + (e.dir ? 'D' : 'F') + ' ' + fmtBytes(e.bytes).padStart(8) + '  ' + tag + e.path)
    }
  }
  console.log('超期件（仅供参考，可能与本机现状不一致）：' + (stale.length ? stale.length + ' 项（' + stale.slice(0, 5).map((f) => f.path).join('、') + '）' : '无'))
  if (opts.apply) {
    console.log((opts.only.length ? '已按指定路径' : '已按推荐范围') + '清理本轮条目 ' + deleted.length + ' 项'
      + (failed.length ? '，失败 ' + failed.length + ' 项' : '') + '。')
    if (protectedEntries.length) {
      console.log('保留受保护/分享包产物 ' + protectedEntries.length + ' 项：'
        + protectedEntries.slice(0, 5).map((e) => e.path).join('、') + '。')
    }
    for (const f of failed) console.log('  失败：' + f.path + '（' + f.error + '）')
    console.log('请在最终回复中反馈本次删除/保留结果。')
  } else {
    console.log('建议清理范围（推荐）：仅本轮可清条目 ' + candidates.length + ' 项；超期件 ' + stale.length + ' 项只作参考，如要清理须逐条核对本机存在性、归属与证据引用。保留证据/受保护项 ' + preserved.length + ' 项。')
    console.log('自动清理：加 --apply 并显式给 --since；分享包流程默认必须扫描并弹窗询问，只有本轮获得明确授权才可加 --include-share-package 自动清理包产物。')
  }
  return failed.length ? 1 : 0
}

process.exitCode = main()
