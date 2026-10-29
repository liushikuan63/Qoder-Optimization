#!/usr/bin/env node
/**
 * 职责：兜底清理**我方**临时产物（AGENTS.md「临时产物用后即删 + 收尾必问」那条的机制层）。
 * 依赖：node（无第三方包）。
 *
 * <p><b>为什么默认只报告、删除要显式 `--apply`</b>：一次性产物（截图 / 探针脚本 / 日志）
 * 的"用完"只有人知道，脚本只能看年龄。默认列清单 + 弹窗确认，才不会出现"清理把还在用的证据删了"。
 *
 * <p><b>安全边界（这个脚本最容易犯的错就是扫太宽）</b>：只接受两类根——
 * ① 我方临时根 `<os.tmpdir()>/qoder-work`（名字必须精确等于它）；② `--root` 显式传入的目录。
 * **绝不用 `qoder*` 这类宽前缀**：宿主会为每个会话建 `qoder-XXXX-cwd` 目录（实测数百个），
 * 宽前缀会把 Qoder 自己的会话目录当垃圾删掉，那是把正在跑的会话掀了。
 * 因此这里还有一条硬否决：路径任何一段以 `qoder-` 开头且以 `-cwd` 结尾的一律跳过，
 * 即使被 `--root` 指到也不动——判据要能失败，所以自测里专门种了一个这种目录。
 *
 * <p>用法：`node tmp-sweeper.js [--apply] [--root <dir>] [--json]`；自测 `node tmp-sweeper.test.js`。
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
  { kind: 'text', exts: ['.log', '.txt', '.json', '.md', '.csv', '.html'], maxAgeDays: 3 },
  { kind: 'script', exts: ['.js', '.cjs', '.mjs', '.ts', '.py', '.ps1', '.sh', '.mjs'], maxAgeDays: 15 },
]

const DAY = 24 * 60 * 60 * 1000
const HEARTBEAT = path.join(CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'heartbeat.log')

/** 宿主自己的会话目录形状：`qoder-<随机>-cwd`。任何情况下都不许碰。 */
function isHostSessionDir(p) {
  return p.split(path.sep).some((seg) => /^qoder-[^-]+-cwd$/i.test(seg))
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

/** 我方临时根。名字必须精确等于 `qoder-work`，否则宁可什么都不扫。 */
function defaultRoot() {
  return path.join(os.tmpdir(), 'qoder-work')
}

function resolveRoots(argv) {
  const roots = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      roots.push(path.resolve(argv[++i]))
    }
  }
  if (roots.length === 0) {
    const d = defaultRoot()
    if (fs.existsSync(d)) {
      roots.push(d)
    }
  }
  // 硬否决：宿主会话目录、以及不存在的目录
  return roots.filter((r) => !isHostSessionDir(r) && fs.existsSync(r))
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (isHostSessionDir(full)) {
      continue
    }
    if (e.isDirectory()) {
      walk(full, out)
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
  const roots = resolveRoots(argv)
  const found = []
  for (const r of roots) {
    walk(r, found)
  }
  let deleted = 0
  let failed = 0
  if (apply) {
    for (const f of found) {
      try {
        fs.rmSync(f.path, { force: true })
        deleted += 1
      } catch (e) {
        failed += 1
      }
    }
  }
  if (!readOnly) heartbeat(`${apply ? 'APPLY' : 'SCAN'} roots=${roots.length} stale=${found.length} deleted=${deleted} failed=${failed}`)
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ roots, apply, stale: found, deleted, failed }, null, 2)}\n`)
  } else {
    process.stdout.write(`临时产物根：${roots.length === 0 ? '（无：' + defaultRoot() + ' 不存在）' : roots.join(', ')}\n`)
    if (found.length === 0) {
      process.stdout.write('没有超期临时件。\n')
    } else {
      process.stdout.write(`${apply ? '已删除' : '超期待删'} ${found.length} 个（阈值：图/文 >3 天、脚本 >15 天）：\n`)
      for (const f of found) {
        process.stdout.write(`  ${f.ageDays}d ${f.kind.padEnd(6)} ${f.bytes}B  ${f.path}\n`)
      }
      if (!apply) {
        process.stdout.write('\n默认只列清单。确认后再跑：node tmp-sweeper.js --apply\n')
      }
    }
  }
  return failed === 0 ? 0 : 1
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = { main, walk, classify, isHostSessionDir, RULES, defaultRoot }
