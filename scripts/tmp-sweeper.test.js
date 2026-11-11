#!/usr/bin/env node
/**
 * 职责：tmp-sweeper.js 的自测——每条判据都要能失败，且**含"不该触发的对照组必绿"**。
 * 依赖：node。用法：`node tmp-sweeper.test.js`（退 0 = 全绿）。
 *
 * <p>为什么要有对照组：清理类脚本最容易犯的错不是漏检，而是**误删**。
 * 只测"超期的被列出来"，一个"把所有文件都列出来"的实现也能全绿。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const sweeper = require('./tmp-sweeper.js')

let pass = 0
let fail = 0
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-work-test-'))

function touch(file, ageDays, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text === undefined ? 'x' : text)
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  fs.utimesSync(file, t, t)
  return file
}

function ageDir(dir, ageDays) {
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  fs.utimesSync(dir, t, t)
}

function listed(files) {
  const out = []
  sweeper.walk(root, out)
  const set = new Set(out.map((f) => path.relative(root, f.path).replace(/\\/g, '/')))
  return files.map((f) => set.has(f))
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`  FAIL  ${name}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}\n`)
  }
}

const staleImg = touch(path.join(root, 'shot-old.png'), 5)
const freshImg = touch(path.join(root, 'shot-new.png'), 0)
const staleScript = touch(path.join(root, 'probe-old.cjs'), 16)
const freshScript = touch(path.join(root, 'probe-new.cjs'), 1)
const oddExt = touch(path.join(root, 'data-xyzzy.qdx'), 40)
const oddFresh = touch(path.join(root, 'data-fresh.qdx'), 1)
const oldZip = touch(path.join(root, 'pkg-old.zip'), 20)
const freshZip = touch(path.join(root, 'pkg-new.zip'), 5)
const nestedStale = touch(path.join(root, 'sub/old-log.log'), 4)
const staleOutput = touch(path.join(root, 'task-old.output'), 4)
// 证据自声明：目录内 .keep ⇒ 整棵保留；.trash 是隔离区，永不入扫描
const keepDir = path.join(root, 'keep-me')
fs.mkdirSync(keepDir, { recursive: true })
fs.writeFileSync(path.join(keepDir, '.keep'), '')
touch(path.join(keepDir, 'old-shot.png'), 5)
ageDir(keepDir, 5)
touch(path.join(root, '.trash/20260101/old-shot.png'), 90)
ageDir(path.join(root, '.trash/20260101'), 90)
ageDir(path.join(root, '.trash'), 90)
// 宿主会话目录形状：即使躺在临时根里、即使超期，也绝不能被列、更不能被删
const hostDirName = 'qoder-AB12CD34-cwd'
const hostStale = touch(path.join(root, hostDirName, 'inside.png'), 90)
// sub 目录本身必须是"老目录"，否则会被顶层活跃保护整棵跳过
ageDir(path.join(root, 'sub'), 4)

check('超期图片被列出', listed(['shot-old.png']), [true])
check('新鲜图片不被列（对照组，防"全列"式误删）', listed(['shot-new.png']), [false])
check('超期脚本被列出', listed(['probe-old.cjs']), [true])
check('15 天内的脚本不被列（脚本阈值比图片宽）', listed(['probe-new.cjs']), [false])
check('未分类扩展名按 other 30 天兜底：超期被列出', listed(['data-xyzzy.qdx']), [true])
check('未分类扩展名未超期不列（对照组）', listed(['data-fresh.qdx']), [false])
check('压缩包按 archive 15 天：超期被列出', listed(['pkg-old.zip']), [true])
check('压缩包 15 天内不列（对照组）', listed(['pkg-new.zip']), [false])
check('.keep 目录整棵保留', listed(['keep-me/old-shot.png']), [false])
check('.trash 隔离区不扫', listed(['.trash/20260101/old-shot.png']), [false])
check('子目录里的超期件也能扫到', listed(['sub/old-log.log']), [true])
check('.output（会话任务输出）按文本类识别', listed(['task-old.output']), [true])
check('qoder-*-cwd 里的超期件不被列（硬否决）', listed([`${hostDirName}/inside.png`]), [false])
check('isHostSessionDir 认得这个形状', [
  sweeper.isHostSessionDir(path.join(os.tmpdir(), 'qoder-AB12CD34-cwd')),
  sweeper.isHostSessionDir(path.join(os.tmpdir(), 'qoder-work')),
], [true, false])

// 活跃保护：顶层目录 24h 内有改动 ⇒ 整棵跳过；--include-fresh 可解除
const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-work-active-'))
touch(path.join(activeRoot, 'live-session/old.png'), 5)   // 目录 mtime = 现在（刚创建）
const activeScan = sweeper.scan({ roots: [activeRoot], maxMs: 5000 })
const activeScanAll = sweeper.scan({ roots: [activeRoot], maxMs: 5000, includeFresh: true })
check('活跃顶层目录整棵跳过（超期件也不列）', activeScan.stale.length, 0)
check('活跃保护会计数', activeScan.skippedFresh >= 1, true)
check('--include-fresh 解除活跃保护后能列出', activeScanAll.stale.length, 1)
fs.rmSync(activeRoot, { recursive: true, force: true })

// --apply：删该删的、留该留的
const rc = sweeper.main(['--root', root, '--apply', '--json'])
const stillThere = (f) => fs.existsSync(f)
check('--apply 退出码 0', rc, 0)
check('--apply 真的删掉了超期图片', stillThere(staleImg), false)
check('--apply 真的删掉了超期脚本', stillThere(staleScript), false)
check('--apply 真的删掉了子目录超期日志', stillThere(nestedStale), false)
check('--apply 删掉了超期 .output', stillThere(staleOutput), false)
check('--apply 没碰新鲜图片', stillThere(freshImg), true)
check('--apply 没碰 15 天内的脚本', stillThere(freshScript), true)
check('--apply 删掉了 other 兜底超期件', stillThere(oddExt), false)
check('--apply 没碰 other 未超期件', stillThere(oddFresh), true)
check('--apply 没碰压缩包未超期件', stillThere(freshZip), true)
check('--apply 没碰 .keep 目录', stillThere(path.join(keepDir, 'old-shot.png')), true)
check('--apply 没碰 .trash 隔离区', stillThere(path.join(root, '.trash/20260101/old-shot.png')), true)
check('--apply 没碰宿主会话目录里的文件', stillThere(hostStale), true)
check('--apply 回收了被清空的子目录', stillThere(path.join(root, 'sub')), false)

// --usage：只读用量统计，不删任何文件
const usageRun = spawnSync(process.execPath, [path.join(__dirname, 'tmp-sweeper.js'), '--root', root, '--usage', '--json'], { encoding: 'utf8' })
let usageOut = null
try { usageOut = JSON.parse(usageRun.stdout) } catch (e) {}
check('--usage 返回字节数与顶层条目', !!usageOut && usageOut.usage.bytes > 0 && usageOut.usage.topEntries > 0, true)
check('--usage 不删除文件', fs.existsSync(freshImg) && fs.existsSync(oddFresh), true)
check('--usage 计入 .trash 占用', !!usageOut && usageOut.usage.bytes >= 1, true)

// 把宿主会话目录本身当 --root 传进来，也必须被拒
check('显式 --root 指到宿主会话目录也会被拒',
  sweeper.isHostSessionDir(path.join(root, hostDirName)), true)

// 多根解析：默认根 + qoder-cli + C 盘遗留 qoder-work + 配置 extraRoots；排除清单两条通道
{
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-sweeper-multi-'))
  const home = path.join(sb, 'home'); fs.mkdirSync(path.join(home, '.qoder'), { recursive: true })
  const tmp = path.join(sb, 'tmp'); fs.mkdirSync(tmp, { recursive: true })
  const lad = path.join(sb, 'localappdata'); fs.mkdirSync(lad, { recursive: true })
  const excluded = path.join(sb, 'excluded-root'); fs.mkdirSync(excluded, { recursive: true })
  const extra = path.join(sb, 'extra-root'); fs.mkdirSync(extra, { recursive: true })
  const canonical = path.join(sb, 'canonical-root'); fs.mkdirSync(canonical, { recursive: true })
  touch(path.join(tmp, 'qoder-work/default-old.png'), 5)
  touch(path.join(tmp, 'qoder-cli/ws/sess/tasks/old.output'), 5)
  ageDir(path.join(tmp, 'qoder-cli/ws'), 5)
  touch(path.join(lad, 'Temp/qoder-work/legacy-old.log'), 5)
  touch(path.join(canonical, 'canonical-old.png'), 5)
  touch(path.join(excluded, 'excluded-old.json'), 5)
  touch(path.join(extra, 'extra-old.json'), 5)
  touch(path.join(extra, 'QO-REL-old/evidence.json'), 5)
  ageDir(path.join(extra, 'QO-REL-old'), 5)
  fs.writeFileSync(path.join(home, '.qoder', 'tmp-sweeper.json'), JSON.stringify({
    canonicalRoot: canonical, extraRoots: [excluded, extra], excludePaths: [excluded], excludeTopPrefixes: ['QO-REL-'],
  }))
  const r = spawnSync(process.execPath, [path.join(__dirname, 'tmp-sweeper.js'), '--json'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, QODER_HOME: path.join(home, '.qoder'), HOME: home, USERPROFILE: home,
      TEMP: tmp, TMP: tmp, TMPDIR: tmp, LOCALAPPDATA: lad },
  })
  let out = null
  try { out = JSON.parse(r.stdout) } catch (e) {}
  check('多根：canonicalRoot + 遗留默认根 + qoder-cli + C 盘遗留 + 两个配置额外根都被解析', out ? out.roots.length : -1, 6)
  check('多根：canonicalRoot 排在最前（唯一约定目录）', out && out.roots[0] === canonical, true)
  check('多根：未排除根里的超期件都被找到', out ? out.stale.length : -1, 5)
  check('排除清单：excludePaths 的根整个不扫', out ? out.stale.some((f) => f.path.includes('excluded-root')) : true, false)
  check('排除清单：excludeTopPrefixes 命中的证据目录不扫', out ? out.stale.some((f) => f.path.includes('QO-REL-')) : true, false)
  fs.rmSync(sb, { recursive: true, force: true })
}

fs.rmSync(root, { recursive: true, force: true })
process.stdout.write(`\n=== tmp-sweeper 自测：通过 ${pass}，失败 ${fail} ===\n`)
process.exit(fail === 0 ? 0 : 1)
