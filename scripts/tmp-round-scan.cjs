#!/usr/bin/env node
// 本轮临时产物扫描：列出 canonicalRoot 下自 --since 起新增/改动的顶层条目，
// 并带上超期件清单。用于"使用分享包 / 部署 / 合并入站包"后的清理询问。
'use strict'

const fs = require('fs')
const path = require('path')
const sweeper = require('./tmp-sweeper.js')

const DAY = 24 * 60 * 60 * 1000

function parseArgs(argv) {
  const opts = { since: Date.now() - DAY, root: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--since' && argv[i + 1]) {
      const v = argv[++i]
      const t = /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v)
      if (Number.isFinite(t)) opts.since = t
    } else if (a === '--root' && argv[i + 1]) opts.root = path.resolve(argv[++i])
    else if (a === '--help') {
      console.log('用法：node tmp-round-scan.cjs [--since <ISO时间|毫秒>] [--root <目录>] [--json]')
      console.log('默认 since=24 小时前，root=tmp-sweeper.json 的 canonicalRoot（缺省为系统临时根下的 qoder-work）。')
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

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cfg = sweeper.loadConfig() || {}
  const root = opts.root || (typeof cfg.canonicalRoot === 'string' && path.isAbsolute(cfg.canonicalRoot)
    ? cfg.canonicalRoot : sweeper.defaultRoot())
  const ex = sweeper.buildExclude(cfg)
  const entries = []
  if (fs.existsSync(root)) {
    const deadline = Date.now() + 500
    let list = []
    try { list = fs.readdirSync(root, { withFileTypes: true }) } catch (e) {}
    for (const e of list) {
      const full = path.join(root, e.name)
      let st
      try { st = fs.statSync(full) } catch (err) { continue }
      if (st.mtimeMs < opts.since) continue
      const excluded = sweeper.isExcluded(full, ex, e.name) || sweeper.isForbidden(full)
      const size = e.isDirectory() ? dirSize(full, deadline) : { bytes: st.size, files: 1, truncated: false }
      entries.push({ name: e.name, path: full, dir: e.isDirectory(), bytes: size.bytes,
        files: size.files, truncated: size.truncated, excluded })
    }
  }
  entries.sort((a, b) => b.bytes - a.bytes)
  const stale = sweeper.scan({ roots: [root], maxMs: 1000 }).stale
  const candidates = entries.filter((e) => !e.excluded)
  const preserved = entries.filter((e) => e.excluded)

  if (opts.json) {
    console.log(JSON.stringify({ root, since: new Date(opts.since).toISOString(), entries, stale,
      recommended: { clean: candidates.map((e) => e.path), preserve: preserved.map((e) => e.path) } }))
    return
  }
  console.log('本轮临时根：' + root + '（since ' + new Date(opts.since).toISOString() + '）')
  if (!entries.length) {
    console.log('本轮没有新增/改动的顶层条目。')
  } else {
    console.log('新增/改动顶层条目 ' + entries.length + ' 项：')
    for (const e of entries) {
      console.log('  ' + (e.dir ? 'D' : 'F') + ' ' + fmtBytes(e.bytes).padStart(8) + '  '
        + (e.excluded ? '[已登记证据，保留] ' : '') + e.path)
    }
  }
  console.log('超期件：' + (stale.length ? stale.length + ' 项（' + stale.slice(0, 5).map((f) => f.path).join('、') + '）' : '无'))
  console.log('建议清理范围（推荐）：本轮可清条目 ' + candidates.length + ' 项 + 超期件 ' + stale.length + ' 项；保留证据目录 ' + preserved.length + ' 项。')
  console.log('删除前必须用 AskUserQuestion 征得确认；执行时只用精确路径，不删已登记证据与回滚点。')
}

main()
