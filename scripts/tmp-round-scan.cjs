#!/usr/bin/env node
// 本轮临时产物扫描/清理：列出 canonicalRoot 下自 --since 起新增/改动的顶层条目。
// 默认只扫描；--apply 只清理本轮可清条目（受保护项/已登记证据/分享包产物/超期件不删）。
'use strict'

const fs = require('fs')
const path = require('path')
const sweeper = require('./tmp-sweeper.js')

const DAY = 24 * 60 * 60 * 1000
/** --apply 的默认最大回溯与隔离区保留期；更早的 since 需要 --force，避免一条命令清空整个临时根。 */
const MAX_BACKDATE_MS = 7 * DAY
const TRASH_RETENTION_MS = 7 * DAY
const HEARTBEAT = path.join(sweeper.CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'heartbeat.log')
// 分享包产物：默认不自动删，留给"每轮结束询问"；只有显式 --include-share-package 才纳入清理。
const SHARE_PATTERNS = [/^Qoder-Optimization/i, /share-package/i, /install-package/i, /^pkg-/i,
  /^qoder-download/i, /^qoder-consumer-home/i, /^qo-[^\n]*(?:pkg|release)/i]
// 回滚点/取证目录：即使清理分享包产物也不动（不要用 ^qo- 宽前缀，普通任务日志也会被误保护）。
const ALWAYS_PROTECT = [/^QO-(?:REL|AUDIT|FIX)-/i, /^qo-(?:deploy|wip)-/i]

// 取值型开关：缺值时**必须失败关闭**。旧写法 `a === '--only' && argv[i+1]` 在缺值时
// 静默跳过该开关，于是 `--apply --mark-evidence`（本想只写标记）变成真删、
// `--apply --only`（本想限定范围）变成清掉全部推荐项、`--session` 缺值变成连别人的一起删。
// 2026-11-12 实测三种形态都退 0 且目录真被删（probe-t18b A1/A2/A3 修前红）。
const VALUE_FLAGS = new Set(['--evidence-docs', '--mark-evidence', '--task', '--doc', '--session', '--only', '--since', '--root'])

function parseArgs(argv) {
  const opts = { since: Date.now() - DAY, sinceSet: false, root: null, json: false, apply: false,
    includeSharePackage: false, only: [], force: false, session: null, includeModified: false, trash: null,
    evidenceDocs: [], markEvidence: [], task: null, docs: [], argErrors: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      if (v === undefined || v === '' || v.startsWith('--')) {
        opts.argErrors.push(a + ' 缺少取值'
          + (v === undefined || v === '' ? '' : '（下一个词 "' + v + '" 是另一个开关）')
          + '：拒绝继续。静默丢掉这个开关会把「只写标记」变成删除、把范围限制变成全量清理。')
        continue
      }
    }
    if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--include-share-package') opts.includeSharePackage = true
    else if (a === '--force') opts.force = true
    else if (a === '--include-modified') opts.includeModified = true
    else if (a === '--trash') opts.trash = true
    else if (a === '--no-trash') opts.trash = false
    else if (a === '--evidence-docs' && argv[i + 1]) opts.evidenceDocs.push(path.resolve(argv[++i]))
    else if (a === '--mark-evidence' && argv[i + 1]) opts.markEvidence.push(path.resolve(argv[++i]))
    else if (a === '--task' && argv[i + 1]) opts.task = String(argv[++i]).trim()
    else if (a === '--doc' && argv[i + 1]) opts.docs.push(path.resolve(argv[++i]))
    else if (a === '--session' && argv[i + 1]) opts.session = String(argv[++i]).trim()
    else if (a === '--only' && argv[i + 1]) opts.only.push(path.resolve(argv[++i]))
    else if (a === '--since' && argv[i + 1]) {
      const v = argv[++i]
      const t = /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v)
      if (Number.isFinite(t)) { opts.since = t; opts.sinceSet = true }
    } else if (a === '--root' && argv[i + 1]) opts.root = path.resolve(argv[++i])
    else if (a === '--help') {
      console.log('用法：node tmp-round-scan.cjs [--since <ISO时间|毫秒>] [--root <目录>] [--json] [--apply] [--include-share-package] [--only <精确路径>]...')
      console.log('  [--force] [--session <8位会话id>] [--include-modified] [--trash|--no-trash] [--evidence-docs <目录>]...')
      console.log('默认只扫描。--apply 只清理本轮可清条目，必须显式给 --since；受保护项、已登记证据、分享包产物与超期件不删。')
      console.log('默认只自动删"本轮新建"的条目；仅被修改的旧目录只列清单（--only 精确指定或 --include-modified 才删）。')
      console.log('--apply 要求 since 在 7 天内且 root 为 canonicalRoot；越界需 --force。--session 只自动删名字含该令牌的本会话产物。')
      console.log('--only 可重复，只处理临时根的直接子条目；并行会话共用 D:/tmp 时用它按精确路径清理本任务产物。')
      console.log('删除默认移入 <root>/.trash（7 天后自动回收），--no-trash 才永久删除；每次 --apply 写 <root>/.last-cleanup 台账。');
      console.log('--evidence-docs <目录> 可重复：扫描其中 .md，被登记为证据路径的条目即使无 .keep/.evidence.json 也保留。');
      console.log('--mark-evidence <目录> 可重复：把用户的「保留」答复落成目录内 .evidence.json（只写不删，不与 --apply 同批）。');
      console.log('  必须三字段齐：--task <任务ID> --session <会话id> --doc <登记文档路径>（--doc 可重复）；已有标记一律不改写。');
      console.log('取值型开关（--since/--root/--only/--session/--task/--doc/--evidence-docs/--mark-evidence）缺值即退 2，不静默丢弃。')
      console.log('分享包流程默认必须扫描后询问清理范围。')
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

/** 隔离区回收：只删除**本脚本自己按 ISO 时间戳命名**且超过保留期的批次。
 *  旧实现按 mtime 匹配 `.trash` 下任意条目并永久删除，两个后果都实测到了：
 *  ① 用户手工放进隔离区的东西 9 天后被静默永久删除（匹配型删除越界，红线）；
 *  ② 批次目录 mtime 被刷新后永不回收，隔离区无限堆积。
 *  时间戳就是批次出生时间，比 mtime 更可靠；非批次名一律不动。 */
const TRASH_BATCH_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/
function batchBornMs(name) {
  const m = TRASH_BATCH_RE.exec(String(name))
  if (!m) return null
  const t = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + 'Z')
  return Number.isFinite(t) ? t : null
}
function purgeTrash(root, now) {
  const dir = path.join(root, '.trash')
  let list
  try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return 0 }
  let removed = 0
  for (const e of list) {
    const born = batchBornMs(e.name)
    if (born === null) continue
    if (now - born < TRASH_RETENTION_MS) continue
    const full = path.join(dir, e.name)
    try {
      fs.rmSync(full, { recursive: e.isDirectory(), force: true })
      removed += 1
    } catch (err) {}
  }
  return removed
}

function trashBatchDir(root, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return path.join(root, '.trash', stamp)
}

/** C10：扫描指定文档目录里的 .md，收集被登记为证据的绝对路径（正斜杠与反斜杠两种写法都认）。 */
function collectRegisteredEvidence(docRoots) {
  const found = new Set()
  if (!Array.isArray(docRoots) || !docRoots.length) return found
  const walk = (dir, depth) => {
    if (depth > 6) return
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of list) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.md$/i.test(e.name)) continue
      let text = ''
      try { text = fs.readFileSync(full, 'utf8') } catch (err) { continue }
      for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s`'")\]，。；]+/g)) {
        const raw = m[0].replace(/[.,;:]+$/, '')
        found.add(raw.replace(/\\/g, '/').toLowerCase())
        found.add(raw.toLowerCase())
      }
    }
  }
  for (const r of docRoots) walk(r, 0)
  return found
}

/** C10：清理台账。没有它就无法归因「谁删了证据」——本项目已实际踩到。
 *  写失败必须**报出来并让退出码非 0**：旧实现 catch 后吞掉，删了东西却报成功（实测退 0），
 *  等于把 C10 存在的理由规避掉。返回 null＝成功，返回字符串＝失败原因。 */
function writeCleanupLedger(root, record) {
  try {
    fs.writeFileSync(path.join(root, '.last-cleanup'), JSON.stringify(record, null, 1))
    return null
  } catch (e) {
    return String((e && e.message) || e)
  }
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

function entryTag(e, opts, isOnlyEntry) {
  if (e.excluded) return '[已登记证据，保留] '
  if (e.protected) return '[分享包产物/受保护，保留] '
  if (e.keep) return '[.keep 证据，保留] '
  // C10：被文档登记的证据目录必须点名原因，否则人读输出会把它标成「本轮新建」，看不出为什么没删。
  if (e.registered) return '[文档登记证据，保留] '
  if (opts.session && !e.sessionOwned && !isOnlyEntry(e)) return '[非本会话，保留] '
  if (!e.created && !opts.includeModified && !isOnlyEntry(e)) return '[仅修改，保留] '
  return e.created ? '[本轮新建] ' : ''
}

/** 临时根解析：--root 优先，否则配置里的 canonicalRoot，否则历史默认根。 */
function resolveRoot(opts, cfg) {
  const canonical = typeof cfg.canonicalRoot === 'string' && path.isAbsolute(cfg.canonicalRoot)
    ? path.resolve(cfg.canonicalRoot) : sweeper.defaultRoot()
  return { canonical, root: opts.root ? path.resolve(opts.root) : canonical }
}

/** C10 / T-18：把用户的「保留」答复落成目录内 `.evidence.json`（任务ID / 会话 / 登记文档路径三字段齐）。
 *  只写不删；已有标记一律不改写——那可能是别的会话登记的证据。退出码：0 全部写成，3 有跳过，1 有失败，2 参数不合法。 */
function markEvidence(opts) {
  if (opts.apply) {
    console.error('--mark-evidence 只写标记，不与 --apply 同批执行：先标记，再单独跑清理。')
    return 2
  }
  const missing = []
  if (!opts.task) missing.push('--task <任务ID>')
  if (!opts.session) missing.push('--session <会话id>')
  if (!opts.docs.length) missing.push('--doc <登记文档路径>')
  if (missing.length) {
    console.error('--mark-evidence 需要三字段齐，缺：' + missing.join('、'))
    return 2
  }
  const { root } = resolveRoot(opts, sweeper.loadConfig() || {})
  const written = []
  const skipped = []
  const failed = []
  for (const dir of opts.markEvidence) {
    const target = path.resolve(dir)
    let st
    try { st = fs.statSync(target) } catch (e) { failed.push({ path: target, error: '目录不存在' }); continue }
    if (!st.isDirectory()) { failed.push({ path: target, error: '不是目录' }); continue }
    const rel = path.relative(root, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      failed.push({ path: target, error: '不在临时根内（root=' + root + '）；只给本根下的证据目录打标记' })
      continue
    }
    if (sweeper.isForbidden(target)) {
      failed.push({ path: target, error: '硬否决路径（.git / node_modules / .trash / 客户端目录）' })
      continue
    }
    const marker = path.join(target, '.evidence.json')
    if (fs.existsSync(marker)) {
      skipped.push({ path: target, marker, reason: '已有 .evidence.json，不改写他人标记' })
      continue
    }
    const record = { schema: 1, taskId: opts.task, session: opts.session, docs: opts.docs,
      path: target, at: new Date().toISOString(), by: 'tmp-round-scan.cjs --mark-evidence' }
    try {
      fs.writeFileSync(marker, JSON.stringify(record, null, 1))
      written.push({ path: target, marker, taskId: opts.task, session: opts.session, docs: opts.docs })
    } catch (e) {
      failed.push({ path: target, error: String((e && e.message) || e) })
    }
  }
  const result = { mode: 'mark-evidence', root, written, skipped, failed }
  if (opts.json) {
    console.log(JSON.stringify(result))
  } else {
    console.log('证据标记（只写不删）：写成 ' + written.length + ' 项，跳过 ' + skipped.length + ' 项，失败 ' + failed.length + ' 项。')
    for (const w of written) console.log('  已标记：' + w.marker + '（task=' + w.taskId + ' session=' + w.session + ' docs=' + w.docs.length + '）')
    for (const s of skipped) console.log('  跳过：' + s.path + '（' + s.reason + '）')
    for (const f of failed) console.log('  失败：' + f.path + '（' + f.error + '）')
    if (written.length) console.log('带标记的目录在 tmp-sweeper 与 tmp-round-scan --apply 下整棵保留。')
  }
  return failed.length ? 1 : (skipped.length ? 3 : 0)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.argErrors.length) {
    for (const m of opts.argErrors) console.error(m)
    return 2
  }
  if (opts.apply && !opts.sinceSet) {
    console.error('--apply 必须显式给 --since <本轮开始时间>，避免把其他任务的产物一起清掉。')
    return 2
  }
  if (opts.session && !/^[A-Za-z0-9_-]{4,64}$/.test(opts.session)) {
    console.error('--session 必须是 4-64 位字母/数字/_/-（通常是 8 位会话 id）。')
    return 2
  }
  if (opts.markEvidence.length) return markEvidence(opts)
  const cfg = sweeper.loadConfig() || {}
  const { canonical, root } = resolveRoot(opts, cfg)
  const rootKey = root.toLowerCase()
  const now = Date.now()
  const guards = { force: opts.force === true, backdatedSince: false, rootOverride: false }
  if (opts.apply) {
    if (opts.since > now + 5000) {
      console.error('--since 不能晚于当前时间：' + new Date(opts.since).toISOString())
      return 2
    }
    if (opts.since < now - MAX_BACKDATE_MS) {
      if (!opts.force) {
        console.error('--since 早于 7 天，--apply 可能清掉历史产物；确认范围后加 --force。')
        return 2
      }
      guards.backdatedSince = true
    }
    if (rootKey !== path.resolve(canonical).toLowerCase()) {
      if (!opts.force) {
        console.error('--apply 只允许 canonicalRoot（' + canonical + '）；其他目录需 --force。')
        return 2
      }
      guards.rootOverride = true
    }
  }
  const onlySet = new Set(opts.only.map((p) => p.toLowerCase()))
  for (const p of onlySet) {
    if (path.dirname(p) !== rootKey) {
      console.error('--only 必须是临时根的直接子条目：' + p)
      return 2
    }
  }
  const isOnly = (e) => onlySet.has(path.resolve(e.path).toLowerCase())
  const ex = sweeper.buildExclude(cfg)
  const protect = buildProtect(cfg, opts.includeSharePackage)
  // C10：目录删除默认进隔离区，只有显式 --no-trash 才永久删除。
  // 事故背景：用户选「全部保留」后，未加标记的证据目录仍被普通自动清理永久删除且无副本可恢复。
  const useTrash = opts.trash === null ? true : opts.trash
  // C10：被仓库文档以路径形式登记为证据的目录，即使没有 .keep/.evidence.json 也保留。
  const registeredEvidence = collectRegisteredEvidence(opts.evidenceDocs)
  const isRegistered = (full) => {
    if (!registeredEvidence.size) return false
    const norm = String(full).replace(/\\/g, '/').toLowerCase()
    const forms = [norm, String(full).toLowerCase()]
    for (const f of forms) if (registeredEvidence.has(f)) return true
    // 文档登记的常常是目录**内部**的某个文件（如 …/qo-t15-evidence/readlogs/read-R01.md）。
    // 只比顶层条目全等 ⇒ 登记等于没登记，整棵证据目录照删（2026-11-12 实测父目录被删）。
    // 前缀带 '/' 保证按路径段匹配：evidence-parent-2 不会被 evidence-parent/ 误保护。
    const prefix = norm + '/'
    for (const p of registeredEvidence) if (p.startsWith(prefix)) return true
    return false
  }
  const keepCache = new Map()
  const entries = []
  if (fs.existsSync(root)) {
    const deadline = Date.now() + 500
    let list = []
    try { list = fs.readdirSync(root, { withFileTypes: true }) } catch (e) {}
    for (const e of list) {
      const full = path.join(root, e.name)
      if (e.isSymbolicLink()) {
        entries.push({ name: e.name, path: full, dir: false, bytes: 0, files: 0, truncated: false,
          excluded: true, protected: true, link: true, created: false, birthKnown: false, keep: true,
          sessionOwned: true, mtime: 0 })
        continue
      }
      let st
      try { st = fs.statSync(full) } catch (err) { continue }
      if (st.mtimeMs < opts.since) continue
      // 台账是清理机制自身的产物：可见但永不可清，否则复扫会把它当本轮新条目。
      const excluded = e.name === '.last-cleanup'
        || sweeper.isExcluded(full, ex, e.name) || sweeper.isForbidden(full)
      const size = e.isDirectory() ? dirSize(full, deadline) : { bytes: st.size, files: 1, truncated: false }
      const birth = st.birthtimeMs || 0
      entries.push({ name: e.name, path: full, dir: e.isDirectory(), bytes: size.bytes,
        files: size.files, truncated: size.truncated, excluded, protected: isProtected(e.name, protect),
        created: birth > 0 && birth >= opts.since, birthKnown: birth > 0,
        keep: sweeper.hasKeepMarker(full, root, keepCache),
        registered: isRegistered(full),
        sessionOwned: !opts.session || e.name.toLowerCase().includes(opts.session.toLowerCase()),
        mtime: st.mtimeMs })
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
  const candidates = scoped.filter((e) => {
    if (e.excluded || e.protected || e.keep || e.registered) return false
    if (isOnly(e)) return true
    if (opts.session && !e.sessionOwned) return false
    return opts.includeModified || e.created
  })
  const candidateSet = new Set(candidates.map((e) => path.resolve(e.path).toLowerCase()))
  const preserved = scoped.filter((e) => !candidateSet.has(path.resolve(e.path).toLowerCase()))
  const protectedEntries = scoped.filter((e) => e.protected && !e.excluded)
  const registeredList = scoped.filter((e) => e.registered && !e.excluded).map((e) => e.path)
  const modifiedKept = scoped.filter((e) => !e.excluded && !e.protected && !e.keep
    && !e.created && !isOnly(e) && !opts.includeModified)
  const sessionSkipped = scoped.filter((e) => !e.excluded && !e.protected && !e.keep && e.created
    && opts.session && !e.sessionOwned && !isOnly(e))

  const deleted = []
  const failed = []
  const trashed = []
  let purgedTrash = 0
  let cleanupLedgerError = null
  if (opts.apply) {
    const batchDir = useTrash ? trashBatchDir(root, now) : null
    for (const e of candidates) {
      try {
        if (useTrash) {
          fs.mkdirSync(batchDir, { recursive: true })
          const dest = path.join(batchDir, e.name)
          fs.renameSync(e.path, dest)
          trashed.push({ from: e.path, to: dest })
        } else {
          fs.rmSync(e.path, { recursive: e.dir, force: true })
        }
        deleted.push(e.path)
      } catch (err) {
        failed.push({ path: e.path, error: String((err && err.message) || err) })
      }
    }
    purgedTrash = purgeTrash(root, now)
    const ledgerError = writeCleanupLedger(root, { schema: 1, at: new Date(now).toISOString(),
      since: new Date(opts.since).toISOString(), root,
      includeSharePackage: opts.includeSharePackage, trash: useTrash,
      deleted: deleted.length, trashed: trashed.length, failed: failed.length,
      preserved: preserved.length, registeredEvidence: registeredList.length,
      paths: deleted.slice(0, 200) })
    heartbeat('ROUND-' + (opts.includeSharePackage ? 'APPLY-SHARE' : 'APPLY')
      + ' root=' + root + ' since=' + new Date(opts.since).toISOString()
      + ' deleted=' + deleted.length + ' failed=' + failed.length
      + ' protected=' + protectedEntries.length
      + (opts.session ? ' session=' + opts.session : '')
      + (useTrash ? ' trash=' + trashed.length : '')
      + (ledgerError ? ' ledgerError=' + ledgerError.slice(0, 80) : ''))
    cleanupLedgerError = ledgerError
  }

  const result = { root, since: new Date(opts.since).toISOString(), now: new Date(now).toISOString(),
    apply: opts.apply, includeSharePackage: opts.includeSharePackage, only: opts.only, unmatchedOnly,
    force: opts.force, session: opts.session, trash: useTrash, entries, stale,
    staleNote: 'reference-only: the overdue list may come from another machine or package config; verify existence, ownership and references locally before cleanup',
    protected: protectedEntries.map((e) => e.path),
    recommended: {
      clean: candidates.map((e) => e.path),
      preserve: preserved.map((e) => e.path),
      modified: modifiedKept.map((e) => e.path),
      sessionSkipped: sessionSkipped.map((e) => e.path),
    },
    guards, trashed, purgedTrash, deleted, failed, registeredEvidence: registeredList,
    ledgerError: cleanupLedgerError }

  if (opts.json) {
    console.log(JSON.stringify(result))
    return failed.length || cleanupLedgerError ? 1 : 0
  }
  console.log('本轮临时根：' + root + '（since ' + new Date(opts.since).toISOString() + '）')
  if (opts.session) console.log('仅自动清理名字含会话令牌 ' + opts.session + ' 的条目；--only 指定项不受限制。')
  if (useTrash) console.log('分享包产物将移入 ' + path.join(root, '.trash') + '（保留 7 天）。')
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
      console.log('  ' + (e.dir ? 'D' : 'F') + ' ' + fmtBytes(e.bytes).padStart(8) + '  '
        + entryTag(e, opts, isOnly) + e.path)
    }
  }
  console.log('超期件（仅供参考，可能与本机现状不一致）：' + (stale.length ? stale.length + ' 项（' + stale.slice(0, 5).map((f) => f.path).join('、') + '）' : '无'))
  if (opts.apply) {
    console.log((opts.only.length ? '已按指定路径' : '已按推荐范围') + '清理本轮条目 ' + deleted.length + ' 项'
      + (failed.length ? '，失败 ' + failed.length + ' 项' : '') + '。')
    if (useTrash && trashed.length) {
      console.log('已移入隔离区 ' + path.dirname(trashed[0].to) + '（' + trashed.length + ' 项，7 天后自动回收）。')
    }
    if (purgedTrash) console.log('隔离区回收超期批次 ' + purgedTrash + ' 个。')
    if (protectedEntries.length) {
      console.log('保留受保护/分享包产物 ' + protectedEntries.length + ' 项：'
        + protectedEntries.slice(0, 5).map((e) => e.path).join('、') + '。')
    }
    if (registeredList.length) {
      console.log('保留文档登记证据 ' + registeredList.length + ' 项（即使无 .keep/.evidence.json 也不删）：'
        + registeredList.slice(0, 5).join('、') + '。')
    }
    if (modifiedKept.length) {
      console.log('保留本轮仅修改的旧条目 ' + modifiedKept.length + ' 项（如确需删除，用 --only 精确指定或 --include-modified）。')
    }
    if (sessionSkipped.length) {
      console.log('保留非本会话条目 ' + sessionSkipped.length + ' 项（名字不含会话令牌 ' + opts.session + '）。')
    }
    for (const f of failed) console.log('  失败：' + f.path + '（' + f.error + '）')
    if (cleanupLedgerError) {
      console.log('清理台账写入失败（' + cleanupLedgerError + '）：删除已执行但没有台账，无法归因「谁删了证据」。'
        + '请手工补记 ' + path.join(root, '.last-cleanup') + '（本次退出码按失败计）。')
    }
    console.log('请在最终回复中反馈本次删除/保留结果。自动清理命令请加 --json，收尾门禁会校验 deleted/preserve 覆盖。')
  } else {
    console.log('建议清理范围（推荐）：仅本轮新建条目 ' + candidates.length + ' 项；仅修改的旧条目 ' + modifiedKept.length
      + ' 项默认保留；超期件 ' + stale.length + ' 项只作参考，如要清理须逐条核对本机存在性、归属与证据引用。保留证据/受保护项 ' + preserved.length + ' 项。')
    console.log('自动清理：加 --apply --json 并显式给 --since（7 天内）；分享包流程默认必须扫描并弹窗询问，只有本轮获得明确授权才可加 --include-share-package。')
  }
  return failed.length || cleanupLedgerError ? 1 : 0
}

process.exitCode = main()
