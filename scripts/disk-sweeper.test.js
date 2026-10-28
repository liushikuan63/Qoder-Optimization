#!/usr/bin/env node
/**
 * 职责：disk-sweeper.js 的自测。**水位低不等于能删对**，所以判据分三组：
 * ① 水位分级（用 `--simulate-free` 驱动，不需要真把盘填满）；
 * ② 一档按年龄删对（旧的删、新的留）；
 * ③ 硬否决与二档**永不删**——哪怕文件再旧、哪怕 `--root` 显式指过去。
 * 依赖：node。用法：`node disk-sweeper.test.js`。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const sweeper = require('./disk-sweeper.js')

let pass = 0
let fail = 0
const GB = 1073741824
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disksweep-case-'))

function touch(file, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x'.repeat(2048))
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  fs.utimesSync(file, t, t)
  return file
}
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`  FAIL  ${name}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}\n`)
  }
}
function rawAll(args) {
  const chunks = []
  const real = process.stdout.write.bind(process.stdout)
  process.stdout.write = (c) => { chunks.push(String(c)); return true }
  let rc = 0
  try {
    rc = sweeper.main(args)
  } finally {
    process.stdout.write = real
  }
  let parsed = null
  try {
    parsed = JSON.parse(chunks.join(''))
  } catch (e) {
    /* 非 --json 分支 */
  }
  return { rc, out: chunks.join(''), j: parsed }
}
function run(args) {
  // --extra-root 指到一个空目录：自测绝不能去扫真实的 npm / %TEMP% 缓存（几十万个条目）
  return rawAll(['--root', root, '--json', '--extra-root', path.join(root, 'no-extra-here')].concat(args))
}

const stale = touch(path.join(root, 'old-run.log'), 60)
const fresh = touch(path.join(root, 'new-run.log'), 1)
// 硬否决样本：路径里带 memory / .git / qoder-*-cwd，即使 60 天也不许动
const inMemory = touch(path.join(root, 'memory', 'note.md'), 60)
const inGit = touch(path.join(root, '.git', 'old-object'), 60)
const hostCwd = touch(path.join(root, 'qoder-AB12CD34-cwd', 'stale.png'), 60)

const LOW = 2 * GB
const OK = 500 * GB

check('水位 500GB 判 ok', run(['--simulate-free', String(OK)]).j.level, 'ok')
check('水位 8GB 判 warn', run(['--simulate-free', String(8 * GB)]).j.level, 'warn')
check('水位 2GB 判 critical', run(['--simulate-free', String(LOW)]).j.level, 'critical')
check('--check 永远退 0（hook 里不能因为它把会话卡住）',
  (() => {
    const real = process.stdout.write.bind(process.stdout)
    process.stdout.write = () => true
    let rc = 9
    try { rc = sweeper.main(['--check', '--simulate-free', String(LOW)]) } finally { process.stdout.write = real }
    return rc
  })(), 0)

const scan = run(['--simulate-free', String(LOW)])
check('一档只数到那个过期文件（新文件被年龄挡住）', scan.j.tier1Files, 1)
check('水位低 + 有一档可清理 ⇒ 退 1 提示要弹窗', scan.rc, 1)
check('水位正常时同样有旧文件也不报退 1', run(['--simulate-free', String(OK)]).rc, 0)

const applied = run(['--simulate-free', String(LOW), '--apply'])
check('--apply 删掉过期日志', fs.existsSync(stale), false)
check('--apply 没碰 1 天内的新文件（对照组）', fs.existsSync(fresh), true)
check('--apply 没碰 memory 目录下的旧文件（硬否决）', fs.existsSync(inMemory), true)
check('--apply 没碰 .git 下的旧文件（硬否决）', fs.existsSync(inGit), true)
check('--apply 没碰宿主 qoder-*-cwd 里的旧文件（硬否决）', fs.existsSync(hostCwd), true)
check('--apply 后退出码回到 0', applied.rc, 0)
check('二档目录被列出但从未被删',
  [Array.isArray(applied.j.tier2), fs.existsSync(path.join(os.homedir(), '.qoder'))], [true, true])

// ---------- 归档档：删之前先搬走，且必须能整批取回 ----------
const archiveDir = path.join(root, '..', 'disksweep-archive-case')
const toArchive = touch(path.join(root, 'old-run2.log'), 45)
const stillMemory = touch(path.join(root, 'memory', 'keep.md'), 45)

const ar = run(['--simulate-free', String(LOW), '--apply', '--archive', archiveDir])
check('归档后源文件消失', fs.existsSync(toArchive), false)
const man = path.join(ar.j.archivedTo, 'manifest.json')
check('清单 manifest.json 已写出', fs.existsSync(man), true)
check('INDEX.md 已写出（含可粘贴的长期记忆条目）',
  fs.existsSync(path.join(ar.j.archivedTo, 'INDEX.md')), true)
const manifest = JSON.parse(fs.readFileSync(man, 'utf8'))
check('清单里记了原始路径与字节数',
  [manifest.moved.length, manifest.moved[0].from === toArchive, manifest.moved[0].bytes > 0], [1, true, true])
check('归档副本真的落盘了', fs.existsSync(manifest.moved[0].to), true)
check('归档时也没碰 memory 目录（硬否决同样生效）', fs.existsSync(stillMemory), true)
check('INDEX.md 里有 restore 命令',
  fs.readFileSync(path.join(ar.j.archivedTo, 'INDEX.md'), 'utf8').includes('--restore'), true)

const back = run(['--restore', man])
check('回取后原路径恢复', fs.existsSync(toArchive), true)
check('回取默认保留归档副本（回取正因为还要用）', fs.existsSync(manifest.moved[0].to), true)
check('回取退出码 0', back.rc, 0)
run(['--restore', man, '--purge'])
check('--purge 才清掉归档副本', fs.existsSync(manifest.moved[0].to), false)

// copyFile may refresh mtime; rejection needs its own stale input.
const nestedSource = touch(path.join(root, 'nested-control.log'), 60)
const nested = run(['--simulate-free', String(LOW), '--apply', '--archive', path.join(root, 'inside')])
check('归档目标在一档范围内时拒绝且源文件保留', [nested.rc, fs.existsSync(nestedSource)], [2, true])

// ---------- 三档：C 盘其余无用缓存 / 过期内容，**逐条点名**才可删 ----------
const cacheA = path.join(root, 'fakelib-cache')
const cacheB = path.join(root, 'otherlib-cache')
const cacheC = path.join(root, 'thirdlib-cache')
const cacheOldA = touch(path.join(cacheA, 'blob-60d.bin'), 60)
const cacheNewA = touch(path.join(cacheA, 'blob-1d.bin'), 1)
const cacheOldB = touch(path.join(cacheB, 'blob-60d.bin'), 60)
const cacheOldC = touch(path.join(cacheC, 'blob.bin'), 60)
const emptyT1 = fs.mkdtempSync(path.join(os.tmpdir(), 'disksweep-empty-'))
const EX = ['--root', emptyT1, '--json', '--extra-root', cacheA, '--extra-root', cacheB,
  '--simulate-free', String(LOW)]

const exScan = rawAll(EX)
check('三档按 id 列出可点名候选', exScan.j.extra.map((e) => e.id), ['fakelib-cache', 'otherlib-cache'])
check('三档候选只数超限文件（1 天内的不算）', exScan.j.extra[0].count, 1)
check('一档为空、只有三档候选时也要退 1（该弹窗）', exScan.rc, 1)
check('未点名时三档一个不删', fs.existsSync(cacheOldA), true)

const exNoApply = rawAll(EX.concat(['--apply-extra', 'fakelib-cache']))
check('--apply-extra 缺 --apply 时拒绝（退 2）', exNoApply.rc, 2)
check('拒绝时缓存文件仍在', fs.existsSync(cacheOldA), true)

const exBadId = rawAll(EX.concat(['--apply', '--apply-extra', 'nope']))
check('未知 id 直接退 2（不猜用户想清哪个）', exBadId.rc, 2)
check('未知 id 时一个不删', [fs.existsSync(cacheOldA), fs.existsSync(cacheOldB)], [true, true])

const exNamed = rawAll(EX.concat(['--apply', '--apply-extra', 'fakelib-cache']))
check('点名的缓存删掉超限文件', fs.existsSync(cacheOldA), false)
check('点名也只删超限文件，1 天内的留着（对照组）', fs.existsSync(cacheNewA), true)
check('未点名的另一个缓存整目录不动（隔离）', fs.existsSync(cacheOldB), true)
check('extraDeleted 计数与实删一致', exNamed.j.extraDeleted, 1)
check('三档删文件不删目录本身（缓存目录必须还在）', fs.existsSync(cacheA), true)

const exOkLevel = rawAll(['--root', emptyT1, '--json', '--extra-root', cacheB, '--simulate-free', String(OK),
  '--apply', '--apply-extra', 'otherlib-cache'])
check('水位正常但用户点了名，仍可清（显式决策不被水位挡）', fs.existsSync(cacheOldB), false)
check('这一趟退出码 0', exOkLevel.rc, 0)

const arch2 = path.join(root, '..', 'disksweep-archive-extra')
const exArch = rawAll(['--root', emptyT1, '--json', '--extra-root', cacheC, '--simulate-free', String(LOW),
  '--apply', '--apply-extra', 'thirdlib-cache', '--archive', arch2])
check('三档同样支持归档到他盘（源没了、清单在）',
  [fs.existsSync(cacheOldC), fs.existsSync(path.join(exArch.j.archivedTo, 'manifest.json'))], [false, true])
fs.rmSync(arch2, { recursive: true, force: true })

const cacheD = path.join(root, 'fourthlib-cache')
touch(path.join(cacheD, 'blob.bin'), 60)
const exText = rawAll(['--root', emptyT1, '--extra-root', cacheD, '--simulate-free', String(LOW)])
check('报告里带第二问：是否顺带清 C 盘其余无用缓存', exText.out.includes('第二问'), true)
check('报告给出可点名的 --apply-extra 命令', exText.out.includes('--apply-extra'), true)

check('suggestArchiveRoot 会排除系统盘',
  sweeper.suggestArchiveRoot(999999), null)

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(archiveDir, { recursive: true, force: true })
fs.rmSync(arch2, { recursive: true, force: true })
fs.rmSync(emptyT1, { recursive: true, force: true })
check('denied 认得 memory 与 .git', [
  sweeper.denied(path.join(root, 'memory', 'a.md')),
  sweeper.denied(path.join(root, '.git', 'a')),
  sweeper.denied(path.join(root, 'plain', 'a.log')),
], [true, true, false])

fs.rmSync(root, { recursive: true, force: true })
process.stdout.write(`\n=== disk-sweeper 自测：通过 ${pass}，失败 ${fail} ===\n`)
process.exit(fail === 0 ? 0 : 1)
