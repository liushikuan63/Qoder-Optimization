#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const HELP = `用法: node line-refs.mjs <doc.md> [--preview=N]

列出文档内全部链接的解析结果：
  - #Lx / #Lx-Ly 锚点：文件总行数、越界/缺失判定、首末行内容预览（供人工核对语义）
  - 其他本地链接：存在性检查与计数
  - 非 HTTPS 外链、-svn/副本 路径：直接列为问题
有任一坏引用时退出码 1，全部正常退出码 0。`

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP)
  process.exit(0)
}
const positional = argv.filter(a => !a.startsWith('-'))
if (positional.length !== 1) {
  console.error(HELP)
  process.exit(2)
}
const previewLen = (() => {
  const hit = argv.find(a => /^--preview=\d+$/.test(a))
  const n = hit ? Number(hit.slice('--preview='.length)) : 120
  return Number.isFinite(n) ? Math.max(40, n) : 120
})()

const docPath = path.resolve(positional[0])
let text
try {
  text = fs.readFileSync(docPath, 'utf8')
} catch (error) {
  console.error(`无法读取文档: ${docPath} (${error.code ?? error.message})`)
  process.exit(2)
}
const docDir = path.dirname(docPath)
const clip = value => {
  const trimmed = value.trim()
  return trimmed.length > previewLen ? `${trimmed.slice(0, previewLen)}…` : trimmed
}

function statOf (file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    return { exists: true, total: lines.length, lines }
  } catch {
    return { exists: false, total: 0, lines: [] }
  }
}

const lineRefs = []
const plainLinks = []
const problems = []

for (const match of text.matchAll(/\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
  const label = match[1].trim()
  const target = match[2].trim()
  if (/^https:\/\//.test(target)) continue
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    problems.push(`[PROTOCOL] ${label} -> ${target}（非 HTTPS 外链）`)
    continue
  }
  const hashAt = target.indexOf('#')
  const relative = hashAt >= 0 ? target.slice(0, hashAt) : target
  const anchor = hashAt >= 0 ? target.slice(hashAt + 1) : ''
  if (!relative) continue
  if (/-svn|副本/.test(relative)) problems.push(`[SCOPE] ${label} -> ${target}（-svn/副本 路径不得引用）`)
  let resolved
  try {
    resolved = path.resolve(docDir, decodeURIComponent(relative))
  } catch {
    problems.push(`[BAD_URL] ${label} -> ${target}（路径解码失败）`)
    continue
  }
  if (!/^L/.test(anchor)) {
    plainLinks.push({ label, target, resolved })
    continue
  }
  const range = anchor.match(/^L(\d+)(?:-L(\d+))?$/)
  if (!range) {
    problems.push(`[BAD_ANCHOR] ${label} -> ${target}（锚点不是 Lx 或 Lx-Ly）`)
    continue
  }
  const start = Number(range[1])
  const end = Number(range[2] ?? range[1])
  const stat = statOf(resolved)
  let status = 'OK'
  if (!stat.exists) status = 'MISSING'
  else if (start < 1 || end < start || end > stat.total) status = 'OUT_OF_RANGE'
  lineRefs.push({ label, target, resolved, start, end, status, stat })
}

const out = []
out.push(`文档: ${docPath}`)
out.push('')
out.push(`== 行号引用（${lineRefs.length} 条） ==`)
for (const ref of lineRefs) {
  out.push(`[${ref.status}] ${ref.label} -> ${ref.target}`)
  out.push(`    解析: ${ref.resolved}`)
  if (ref.status === 'MISSING') {
    out.push('    文件不存在')
  } else {
    const asked = ref.end !== ref.start ? `L${ref.start}-L${ref.end}` : `L${ref.start}`
    out.push(`    总行数=${ref.stat.total}  请求 ${asked}${ref.status === 'OUT_OF_RANGE' ? '  <- 越界' : ''}`)
    out.push(`    L${ref.start}: ${clip(ref.stat.lines[ref.start - 1] ?? '')}`)
    if (ref.end !== ref.start) out.push(`    L${ref.end}: ${clip(ref.stat.lines[ref.end - 1] ?? '')}`)
  }
  out.push('')
}
out.push(`== 其他本地链接（${plainLinks.length} 条） ==`)
for (const link of plainLinks) {
  const ok = fs.existsSync(link.resolved)
  if (!ok) problems.push(`[LINK] ${link.label} -> ${link.target}（文件不存在）`)
  out.push(`[${ok ? 'OK' : 'MISSING'}] ${link.label} -> ${link.target}`)
}
out.push('')
if (problems.length) {
  out.push(`== 问题（${problems.length} 条） ==`)
  for (const problem of problems) out.push(problem)
  out.push('')
}
const bad = lineRefs.filter(ref => ref.status !== 'OK').length
out.push(`汇总: 行号引用 ${lineRefs.length} 条（OK ${lineRefs.length - bad} / 坏 ${bad}），其他本地链接 ${plainLinks.length} 条，问题 ${problems.length} 条`)
console.log(out.join('\n'))
process.exit(bad || problems.length ? 1 : 0)
