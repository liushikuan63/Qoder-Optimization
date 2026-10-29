#!/usr/bin/env node
/**
 * 职责：C 盘（或指定盘）空间不足时，找出**可安全清理**的早期任务记录 / 缓存并列成清单。
 * 依赖：node（`fs.statfsSync`）。用法：
 *   node disk-sweeper.js [--json] [--apply] [--apply-extra <id,id>] [--archive <dir>] [--restore <manifest>]
 *                        [--root <dir>] [--simulate-free <bytes>] [--verbose]
 *   给 hook 用：node disk-sweeper.js --check   （只打印一行水位，永远退 0）
 *
 * <p><b>为什么默认只列清单</b>：删文件不可逆，而"哪些还在用"只有人知道。
 * 所以本脚本的产出是**清单 + 一句要弹窗问用户的话**，`--apply` 才动手，且只动一档（见下）。
 *
 * <p><b>三档分级（这是本脚本唯一真正难的地方）</b>：
 * 一档＝**我方产物**（临时根、机制自己的 tmp 台账、过期日志），按年龄判定，`--apply` 可删；
 * 三档＝**C 盘其余无用缓存 / 过期内容**（npm / pip / 系统网络缓存 / 崩溃转储 / %TEMP% 残留 / 宿主 cache），
 * 按 id **逐条点名**才可删（`--apply --apply-extra id1,id2`），且只删超限**文件**、不删目录本身；
 * 二档＝**会话记录**（`~/.qoder{,-cn}/projects`，删了就查不到历史），
 * **本脚本永不删除**——只报体积和"要删请你自己敲的完整命令"，把决定权连命令一起交回给人。
 *
 * <p>弹窗纪律：一档次问（归档 / 直删 / 不动），**附带第二问**是否顺带清三档，两问都拿到答复才动手。
 *
 * <p><b>硬否决名单</b>：路径任一段命中即跳过，即使被 `--root` 显式指到：
 * `.git` / `credentials` / `memory` / `rules` / `commands` / `scripts` / `AGENTS.md` / `settings.json`
 * / `qoder-*-cwd`（宿主会话目录）。**规则和记忆不能被"清理磁盘"顺手吃掉**。
 *
 * <p>退出码：0 = 水位正常或纯报告；1 = 水位告警且有一档 / 三档可清理（调用方应弹窗问用户）；2 = 出错。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
// 心跳只写本机实际存在的客户端侧：单端装配不为了记一条心跳去新建另一侧目录
const CLIENT_ROOT = require('./client-root.js').clientRoot()

const DAY = 24 * 60 * 60 * 1000
const WARN_GB = 10
const CRITICAL_GB = 4
const GB = 1073741824

/** 一档：我方产物。年龄阈值故意比 tmp-sweeper 宽，避免两个工具抢同一批文件。 */
function tier1Roots() {
  const home = os.homedir()
  return [
    { dir: path.join(os.tmpdir(), 'qoder-work'), maxAgeDays: 3, what: '一次性临时产物（截图 / 探针 / 日志）' },
    { dir: path.join(home, '.qoder', 'tmp'), maxAgeDays: 30, what: '机制自己的台账与心跳日志' },
    { dir: path.join(home, '.qoder', 'logs'), maxAgeDays: 30, what: '旧日志' },
    { dir: path.join(home, '.qoder-cn', 'tmp'), maxAgeDays: 30, what: '机制自己的台账与心跳日志（CN 侧）' },
    { dir: path.join(home, '.qoder-cn', 'logs'), maxAgeDays: 30, what: '旧日志（CN 侧）' },
  ]
}

/** 二档：会话记录——**永不删**，删了就查不到历史。 */
function tier2Roots() {
  const home = os.homedir()
  return [
    { dir: path.join(home, '.qoder', 'projects'), what: '会话记录 .jsonl（删了就查不到历史）' },
    { dir: path.join(home, '.qoder-cn', 'projects'), what: '会话记录 .jsonl（删了就查不到历史）' },
  ]
}

/**
 * 三档：C 盘其余"无用缓存 / 过期内容"。id 固定（不随目录存在与否漂移），
 * 只有 `--apply --apply-extra <id,..>` 逐条点名才动，且**只删超限文件、绝不删目录本身**
 * ——缓存目录通常被假定存在，连根删掉才是把"清理"做成"弄坏正在用的软件"。
 */
function extraRoots() {
  const home = os.homedir()
  const lad = path.join(home, 'AppData', 'Local')
  return [
    { id: 'npm-cache', dir: path.join(lad, 'npm-cache'), maxAgeDays: 30, what: 'npm 缓存（下次装包重新下载）' },
    { id: 'pip-cache', dir: path.join(lad, 'pip', 'cache'), maxAgeDays: 30, what: 'pip 缓存（下次装包重新下载）' },
    { id: 'inet-cache', dir: path.join(lad, 'Microsoft', 'Windows', 'INetCache'), maxAgeDays: 30, what: '系统网络缓存' },
    { id: 'crash-dumps', dir: path.join(lad, 'CrashDumps'), maxAgeDays: 30, what: '应用崩溃转储（排完错就没用了）' },
    { id: 'wer', dir: path.join(lad, 'Microsoft', 'Windows', 'WER'), maxAgeDays: 60, what: 'Windows 错误报告队列' },
    { id: 'gradle-cache', dir: path.join(home, '.gradle', 'caches'), maxAgeDays: 60, what: 'Gradle 依赖缓存（下次构建重新下载）' },
    { id: 'win-temp', dir: os.tmpdir(), maxAgeDays: 30, what: '%TEMP% 里 30 天未动的残留（宿主 qoder-*-cwd 已被硬否决挡住）' },
    { id: 'qoder-cache', dir: path.join(home, '.qoder', 'cache'), maxAgeDays: 30, what: 'Qoder 缓存（可再生，删后首次打开变慢）' },
    { id: 'qoder-cn-cache', dir: path.join(home, '.qoder-cn', 'cache'), maxAgeDays: 30, what: 'Qoder CN 缓存（同上）' },
  ]
}

const EXTRA_FILE_CAP = 5000
/** 遍历硬上限：缓存目录可能有几十万个条目，宁可报"未扫完"也不要让一次检查卡住几分钟。 */
const VISIT_CAP = 60000

/** 收集三档候选：逐根枚举超限文件，命中上限就标 truncated（宁可少报，不要扫全盘扫到超时）。 */
function collectExtras(roots) {
  const out = []
  for (const r of roots) {
    if (!fs.existsSync(r.dir) || denied(r.dir)) {
      continue
    }
    let files = staleFiles(r.dir, r.maxAgeDays, EXTRA_FILE_CAP)
    const truncated = files.length > EXTRA_FILE_CAP || files.capped === true
    if (truncated) {
      files = files.sort((a, b) => b.bytes - a.bytes).slice(0, EXTRA_FILE_CAP)
    }
    const bytes = files.reduce((n, f) => n + f.bytes, 0)
    if (!files.length) {
      continue
    }
    out.push({ id: r.id, dir: r.dir, what: r.what, maxAgeDays: r.maxAgeDays, files, count: files.length, bytes, truncated })
  }
  return out
}


const DENY_SEGMENTS = ['.git', 'memory', 'rules', 'commands', 'scripts', 'credentials', 'agents.md', 'settings.json']

function denied(p) {
  const segs = p.split(path.sep).map((s) => s.toLowerCase())
  if (segs.some((s) => /^qoder-[^-]+-cwd$/.test(s))) {
    return true
  }
  return segs.some((s) => DENY_SEGMENTS.includes(s))
}

function freeBytes(dir) {
  const st = fs.statfsSync(dir)
  return st.bsize * st.bavail
}

function dirBytes(dir, cap) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (denied(full)) {
        continue
      }
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        total += fs.statSync(full).size
      } catch (e) {
        /* 正在被占用的文件读不到大小就算了，不影响结论 */
      }
    }
    if (cap && total > cap) {
      break
    }
  }
  return total
}

function staleFiles(dir, maxAgeDays, limit) {
  const out = []
  const cutoff = Date.now() - maxAgeDays * DAY
  const stack = [dir]
  let visited = 0
  while (stack.length) {
    if (limit && out.length > limit) {
      break
    }
    if (++visited > VISIT_CAP) {
      out.capped = true
      break
    }
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (denied(full)) {
        continue
      }
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!e.isFile()) {
        continue
      }
      try {
        const st = fs.statSync(full)
        if (st.mtimeMs < cutoff) {
          out.push({ path: full, bytes: st.size, ageDays: Math.floor((Date.now() - st.mtimeMs) / DAY) })
        }
      } catch (e) {
        /* 忽略 */
      }
    }
  }
  return out
}

function parse(argv) {
  const o = { apply: false, json: false, check: false, verbose: false, simulate: null, roots: [],
    archive: null, restore: null, purge: false, applyExtra: null, extraRoots: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') { o.apply = true }
    else if (a === '--json') { o.json = true }
    else if (a === '--read-only') { o.readOnly = true }
    else if (a === '--check') { o.check = true }
    else if (a === '--verbose') { o.verbose = true }
    else if (a === '--purge') { o.purge = true }
    else if (a === '--simulate-free') { o.simulate = Number(argv[++i]) }
    else if (a === '--apply-extra') { o.applyExtra = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean) }
    else if (a === '--root') { o.roots.push(path.resolve(argv[++i])) }
    else if (a === '--extra-root') { o.extraRoots.push(path.resolve(argv[++i])) }
    else if (a === '--archive') { o.archive = path.resolve(argv[++i]) }
    else if (a === '--restore') { o.restore = path.resolve(argv[++i]) }
  }
  return o
}

/**
 * 建议归档盘：**排除系统盘**，按剩余空间从大到小取第一个够用的。
 * 目的很直白——把 C 盘的东西挪到 C 盘不叫清理，叫原地搬家。
 */
function suggestArchiveRoot(minFreeGb) {
  const system = (process.env.SystemDrive || 'C:').toUpperCase().replace(':', '')
  const cands = []
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXY'
    .split('')) {
    if (ch === system) {
      continue
    }
    const dir = `${ch}:\\`
    try {
      const st = fs.statfsSync(dir)
      const freeGb = (st.bsize * st.bavail) / GB
      if (freeGb >= minFreeGb) {
        cands.push({ dir, freeGb })
      }
    } catch (e) {
      /* 盘不存在或不可访问 */
    }
  }
  cands.sort((a, b) => b.freeGb - a.freeGb)
  return cands.length ? path.join(cands[0].dir, 'qoder-archive') : null
}

function slug(p) {
  return p.replace(/^[A-Za-z]:/, '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

/**
 * 归档：复制 → **逐文件核字节** → 才删源；任何一步不过就把源留下并记失败。
 * 顺序不能反：先删后拷等于把"清理"做成"丢数据"。
 */
function archiveFiles(files, destBase) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runDir = path.join(destBase, stamp)
  const moved = []
  const failed = []
  for (const f of files) {
    const target = path.join(runDir, slug(f.group || path.dirname(f.path)), path.basename(f.path))
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(f.path, target)
      if (fs.statSync(target).size !== f.bytes) {
        throw new Error('落盘字节数与源不一致')
      }
      fs.rmSync(f.path, { force: true })
      moved.push({ from: f.path, to: target, bytes: f.bytes, ageDays: f.ageDays,
        mtime: new Date(Date.now() - (f.ageDays || 0) * DAY).toISOString() })
    } catch (e) {
      failed.push({ from: f.path, error: e.message })
    }
  }
  if (moved.length) {
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ moved, failed, at: new Date().toISOString() }, null, 2))
    const bytes = moved.reduce((n, m) => n + m.bytes, 0)
    const lines = [
      `# 归档清单 ${stamp}`,
      '',
      `- 来源：C 盘空间清理（disk-sweeper.js --archive）`,
      `- 共 ${moved.length} 个文件，约 ${(bytes / GB).toFixed(2)} GB；失败 ${failed.length} 个`,
      `- **取回**：\`node ~/.qoder/scripts/disk-sweeper.js --restore "${path.join(runDir, 'manifest.json')}"\``,
      '',
      '## 长期记忆条目（可直接粘进 `~/.qoder/memory/`）',
      '',
      '```markdown',
      `---`,
      `name: archive-${stamp.slice(0, 10)}`,
      `description: 早期任务记录与缓存已归档到 ${runDir}（不在 C 盘），含 ${moved.length} 个文件约 ${(bytes / GB).toFixed(2)} GB；可按下方命令整批取回`,
      `metadata:`,
      `  type: reference`,
      `---`,
      '',
      `**现象**：C 盘水位低于告警线，清理时选择"归档到他盘"而不是直接删除。`,
      `**位置**：\`${runDir}\`（清单 \`manifest.json\` 记录了每个文件的原始路径）`,
      `**取用**：\`node ~/.qoder/scripts/disk-sweeper.js --restore "${path.join(runDir, 'manifest.json')}"\``,
      `（恢复默认保留归档副本；确认不再需要再加 --purge 清掉归档。）`,
      '',
      '## 明细',
      '',
      ...moved.slice(0, 200).map((m) => `- \`${m.from}\` → \`${m.to}\`（${m.bytes}B，${m.ageDays}d）`),
      '```',
      '',
    ]
    fs.writeFileSync(path.join(runDir, 'INDEX.md'), lines.join('\n'))
  }
  return { runDir, moved, failed }
}

/** 回取：复制回原路径，**默认不动归档副本**（回取往往正因为还要用）。 */
function restoreFiles(manifestPath, purge) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const restored = []
  const failed = []
  for (const e of (m.moved || [])) {
    try {
      fs.mkdirSync(path.dirname(e.from), { recursive: true })
      fs.copyFileSync(e.to, e.from)
      if (fs.statSync(e.from).size !== e.bytes) {
        throw new Error('回写字节数与归档不一致')
      }
      restored.push(e.from)
    } catch (err) {
      failed.push({ to: e.to, error: err.message })
    }
  }
  if (purge && restored.length) {
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true })
  }
  return { restored, failed }
}

function main(argv) {
  const opt = parse(argv)
  if (opt.readOnly && (opt.apply || opt.restore || opt.applyExtra || opt.purge || opt.archive)) {
    console.error('--read-only cannot be combined with write operations')
    return 2
  }
  if (opt.restore) {
    let r
    try {
      r = restoreFiles(opt.restore, opt.purge)
    } catch (e) {
      process.stderr.write(`disk-sweeper: 回取失败（${e.message}）\n`)
      return 2
    }
    process.stdout.write(`已回取 ${r.restored.length} 个文件${opt.purge ? '，并清掉归档副本' : '（归档副本保留）'}；失败 ${r.failed.length}\n`)
    for (const f of r.failed.slice(0, 5)) {
      process.stdout.write(`  ${f.to}：${f.error}\n`)
    }
    return r.failed.length ? 1 : 0
  }
  const probe = opt.roots.length ? opt.roots[0] : os.homedir()
  let free
  try {
    free = opt.simulate !== null && Number.isFinite(opt.simulate) ? opt.simulate : freeBytes(probe)
  } catch (e) {
    process.stderr.write(`disk-sweeper: 读不到磁盘水位（${e.message}）\n`)
    return 2
  }
  const freeGb = free / GB
  const level = freeGb < CRITICAL_GB ? 'critical' : (freeGb < WARN_GB ? 'warn' : 'ok')

  if (opt.check) {
    process.stdout.write(`C 盘剩余 ${freeGb.toFixed(1)} GB（告警线 ${WARN_GB} / 危险线 ${CRITICAL_GB}）：${level}\n`)
    return 0
  }

  const t1 = []
  for (const r of (opt.roots.length ? opt.roots.map((d) => ({ dir: d, maxAgeDays: 30, what: '显式指定' })) : tier1Roots())) {
    if (!fs.existsSync(r.dir) || denied(r.dir)) {
      continue
    }
    for (const f of staleFiles(r.dir, r.maxAgeDays)) {
      t1.push({ ...f, group: r.dir, what: r.what })
    }
  }
  const t1Bytes = t1.reduce((n, f) => n + f.bytes, 0)
  const t2 = []
  for (const r of tier2Roots()) {
    if (!fs.existsSync(r.dir) || denied(r.dir)) {
      continue
    }
    const bytes = dirBytes(r.dir, free * 2)
    if (bytes > 100 * 1024 * 1024) {
      t2.push({ dir: r.dir, bytes, what: r.what })
    }
  }

  // `--extra-root` **替换**默认清单（与 `--root` 对一档的语义一致）：自测与"只清某个目录"都靠它
  const extraSet = opt.extraRoots.length
    ? opt.extraRoots.map((d) => ({
      id: path.basename(d).toLowerCase().replace(/[^a-z0-9._-]/g, '-'), dir: d, maxAgeDays: 30, what: '显式指定的缓存目录',
    }))
    : extraRoots()
  const extras = collectExtras(extraSet)
  const extrasBytes = extras.reduce((n, e) => n + e.bytes, 0)

  const archiveSuggested = suggestArchiveRoot(20)
  let deleted = 0
  let failed = 0
  let archived = null
  let extraDeleted = 0

  // 一档只在低水位时动；三档要**逐条点名**才动（点名本身就是用户已经答过第二问）
  const targets = []
  if (opt.apply && level !== 'ok') {
    targets.push(...t1)
  }
  if (opt.applyExtra !== null) {
    if (!opt.apply) {
      process.stderr.write('disk-sweeper: --apply-extra 必须与 --apply 同时给出（避免只打了 id 就误删）\n')
      return 2
    }
    const known = new Map(extras.map((e) => [e.id, e]))
    const unknown = opt.applyExtra.filter((id) => !known.has(id))
    if (unknown.length) {
      process.stderr.write(`disk-sweeper: 三档 id 不存在或本轮没有可清理内容：${unknown.join(', ')}（可点名清单见报告"三档"段）\n`)
      return 2
    }
    for (const id of new Set(opt.applyExtra)) {
      extraDeleted += known.get(id).count
      targets.push(...known.get(id).files.map((f) => ({ ...f, group: id })))
    }
  }
  if (targets.length) {
    if (opt.archive) {
      // 归档到别处再删源：清单留着，日后能整批取回
      if (denied(opt.archive) || targets.some((f) => f.group && opt.archive.startsWith(f.group + path.sep))) {
        process.stderr.write('disk-sweeper: 归档目标落在被清理范围内或被否决名单里，拒绝执行\n')
        return 2
      }
      archived = archiveFiles(targets, opt.archive)
      deleted = archived.moved.length
      failed = archived.failed.length
    } else {
      for (const f of targets) {
        try {
          fs.rmSync(f.path, { force: true })
          deleted += 1
        } catch (e) {
          failed += 1
        }
      }
    }
  }

  if (opt.json) {
    process.stdout.write(`${JSON.stringify({ freeBytes: free, freeGb: Number(freeGb.toFixed(2)), level,
      warnGb: WARN_GB, criticalGb: CRITICAL_GB, tier1: opt.verbose ? t1 : undefined,
      tier1Files: t1.length, tier1Bytes: t1Bytes, tier2: t2,
      extra: extras.map(({ id, dir, what, maxAgeDays, count, bytes, truncated }) => ({ id, dir, what, maxAgeDays, count, bytes, truncated })),
      extraFiles: extras.reduce((n, e) => n + e.count, 0), extraBytes: extrasBytes,
      apply: opt.apply, applyExtra: opt.applyExtra, extraDeleted, deleted, failed,
      archiveSuggested, archivedTo: archived ? archived.runDir : null,
      archivedFailed: archived ? archived.failed.length : 0 }, null, 2)}\n`)
  } else {
    process.stdout.write(`磁盘水位：剩余 ${freeGb.toFixed(1)} GB ⇒ ${level}（告警 ${WARN_GB} GB / 危险 ${CRITICAL_GB} GB）\n`)
    process.stdout.write(`一档（我方可清）：${t1.length} 个文件，约 ${(t1Bytes / GB).toFixed(2)} GB\n`)
    if (opt.verbose) {
      for (const f of t1.slice(0, 40)) {
        process.stdout.write(`  ${f.ageDays}d ${(f.bytes / 1024).toFixed(0)}KB  ${f.path}\n`)
      }
    }
    process.stdout.write(`三档（C 盘其余无用缓存 / 过期内容，逐条点名才可删，只删超限文件不删目录）：${extras.reduce((n, e) => n + e.count, 0)} 个文件约 ${(extrasBytes / GB).toFixed(2)} GB\n`)
    for (const e of extras) {
      process.stdout.write(`  ${e.id.padEnd(14)} ${(e.bytes / GB).toFixed(2)} GB ${String(e.count).padStart(5)} 个 >${e.maxAgeDays}d  ${e.what}${e.truncated ? '（已截断，实际更多）' : ''}\n`)
    }
    process.stdout.write('二档（会话记录，**本脚本永不删除**，要删请自己确认并敲命令）：\n')
    for (const r of t2) {
      process.stdout.write(`  ${(r.bytes / GB).toFixed(2)} GB  ${r.what}  ${r.dir}\n`)
    }
    if (!opt.apply && (t1.length || extras.length)) {
      process.stdout.write('\n⚠ 弹窗问用户，两问一次问全（给出推荐项；未答复时常规项按推荐继续、gated 写入未答复＝未授权）：\n')
      process.stdout.write('  【第一问 · 一档怎么处置】\n')
      process.stdout.write(`    A 归档到他盘再删源（推荐，可回取）：node disk-sweeper.js --apply --archive "${archiveSuggested || '<自行选一个非系统盘目录>'}"\n`)
      process.stdout.write('    B 直接删除（不可回取）：node disk-sweeper.js --apply\n')
      process.stdout.write('    C 本轮不动，只留清单\n')
      process.stdout.write('  【第二问 · 是否顺带清 C 盘其余无用缓存】按上面 id 挑，交给 --apply-extra 点名：\n')
      process.stdout.write(`    node disk-sweeper.js --apply --archive "${archiveSuggested || '<同上>'}" --apply-extra npm-cache,pip-cache,win-temp\n`)
      process.stdout.write('  【第三问 · 是否顺带排查目录迁移】本工具不管迁移——按 /clean-disk 指令跑 `bash ~/.qoder/scripts/disk-migration-candidates.sh` 拿"可迁"候选与分档，与上面两问并入同一次弹窗（迁移执行器须用户亲自在终端跑）\n')
    }
    if (opt.apply) {
      process.stdout.write(archived
        ? `已归档并删源 ${deleted} 个（失败 ${failed}，其中三档点名 ${extraDeleted} 个），清单在 ${path.join(archived.runDir, 'manifest.json')}；`
          + `取回：node disk-sweeper.js --restore "${path.join(archived.runDir, 'manifest.json')}"\n`
        : `已删除 ${deleted} 个文件（一档 + 三档点名，失败 ${failed}）；二档一律未动。\n`)
    }
  }
  try {
    if (opt.readOnly) return failed > 0 ? 2 : (level !== 'ok' && (t1.length || extras.length) ? 1 : 0)
    const hb = path.join(CLIENT_ROOT, 'tmp', 'disk-sweeper', 'heartbeat.log')
    fs.mkdirSync(path.dirname(hb), { recursive: true })
    fs.appendFileSync(hb, `${new Date().toISOString()} ${opt.apply ? 'APPLY' : 'SCAN'} free=${freeGb.toFixed(1)}GB `
      + `level=${level} tier1=${t1.length} extra=${extras.reduce((n, e) => n + e.count, 0)} `
      + `extraPicked=${(opt.applyExtra || []).join('/') || '-'} deleted=${deleted} failed=${failed}\n`)
  } catch (e) {
    /* 心跳写不进不能反过来影响清理结论 */
  }
  return failed > 0 ? 2
    : (level !== 'ok' && (t1.length || extras.length) && !opt.apply ? 1 : 0)
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = { main, denied, tier1Roots, tier2Roots, extraRoots, collectExtras, suggestArchiveRoot,
  archiveFiles, restoreFiles, WARN_GB, CRITICAL_GB }
