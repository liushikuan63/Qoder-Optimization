#!/usr/bin/env node
// tmp-round-scan 离线用例：本轮条目列出、证据/分享包保护、自动清理范围与显式 since。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCAN = path.join(__dirname, 'tmp-round-scan.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'round-scan-test-'));
const HOME = path.join(ROOT, 'home');
const TMPROOT = path.join(ROOT, 'tmp');
fs.mkdirSync(path.join(HOME, '.qoder'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.qoder', 'tmp-sweeper.json'),
  JSON.stringify({ canonicalRoot: TMPROOT, excludeTopPrefixes: ['QO-REL-', 'evidence-'],
    autoClean: { enabled: true, sharePackage: false, protectTopPatterns: ['^keep-me-'] } }));
fs.mkdirSync(TMPROOT, { recursive: true });

let n = 0;
const results = [];
function check(name, got, want) {
  n++;
  const ok = got === want;
  results.push((ok ? 'PASS ' : 'FAIL ') + name + ' got=' + got + ' want=' + want);
  return ok;
}

const env = Object.assign({}, process.env, { HOME, USERPROFILE: HOME });
function scan(extra = []) {
  const out = execFileSync(process.execPath, [SCAN, '--json', ...extra], { encoding: 'utf8', env });
  return JSON.parse(out);
}

const since = Date.now() - 60000;
const freshDir = path.join(TMPROOT, 'round-dir');
fs.mkdirSync(freshDir, { recursive: true });
fs.writeFileSync(path.join(freshDir, 'a.json'), 'x'.repeat(100));
const freshFile = path.join(TMPROOT, 'round.zip');
fs.writeFileSync(freshFile, 'z');
const qoLog = path.join(TMPROOT, 'qo-task.log');
fs.writeFileSync(qoLog, 'q');
const onlyFile = path.join(TMPROOT, 'qo-only.log');
fs.writeFileSync(onlyFile, 'o');
const otherFile = path.join(TMPROOT, 'keep-other.log');
fs.writeFileSync(otherFile, 'k');
const qoPkg = path.join(TMPROOT, 'qo-0024-pkg');
fs.mkdirSync(qoPkg, { recursive: true });
fs.writeFileSync(path.join(qoPkg, 'pkg.tgz'), 'q');
const shareDir = path.join(TMPROOT, 'Qoder-Optimization-0.1.0');
fs.mkdirSync(shareDir, { recursive: true });
fs.writeFileSync(path.join(shareDir, 'pkg.tgz'), 'p');
const pkgStage = path.join(TMPROOT, 'pkg-stage');
fs.mkdirSync(pkgStage, { recursive: true });
fs.writeFileSync(path.join(pkgStage, 'stage.log'), 's');
const keepMe = path.join(TMPROOT, 'keep-me-dir');
fs.mkdirSync(keepMe, { recursive: true });
fs.writeFileSync(path.join(keepMe, 'keep.log'), 'k');
const excludedDir = path.join(TMPROOT, 'QO-REL-keep');
fs.mkdirSync(excludedDir, { recursive: true });
fs.writeFileSync(path.join(excludedDir, 'evidence.log'), 'y');
const oldFile = path.join(TMPROOT, 'old.log');
fs.writeFileSync(oldFile, 'o');
const oldT = new Date(Date.now() - 3 * 86400000);
fs.utimesSync(oldFile, oldT, oldT);
const staleText = path.join(TMPROOT, 'stale.txt');
fs.writeFileSync(staleText, 's');
fs.utimesSync(staleText, new Date(Date.now() - 5 * 86400000), new Date(Date.now() - 5 * 86400000));

const r = scan(['--since', String(since)]);
const names = r.entries.map((e) => e.name).sort();
check('本轮新增条目被发现', names.includes('round-dir') && names.includes('round.zip'), true);
check('早于 since 的条目不在本轮清单', names.includes('old.log'), false);
check('证据前缀被标记保留', r.entries.find((e) => e.name === 'QO-REL-keep')?.excluded, true);
check('证据目录不在推荐清理清单', r.recommended.clean.some((p) => p.includes('QO-REL-keep')), false);
check('分享包产物默认受保护', r.entries.find((e) => e.name === 'Qoder-Optimization-0.1.0')?.protected, true);
check('分享包暂存目录默认受保护', r.entries.find((e) => e.name === 'pkg-stage')?.protected, true);
check('分享包产物不在默认推荐清理清单', r.recommended.clean.some((p) => p.includes('Qoder-Optimization') || p.includes('pkg-stage')), false);
check('普通 qo- 日志不被误保护', r.entries.find((e) => e.name === 'qo-task.log')?.protected, false);
check('qo 包目录默认受保护', r.entries.find((e) => e.name === 'qo-0024-pkg')?.protected, true);
check('自定义保护前缀生效', r.entries.find((e) => e.name === 'keep-me-dir')?.protected, true);
check('超期件被带上', r.stale.some((f) => f.path.endsWith('stale.txt')), true);
check('超期件只作参考且不混入推荐清理清单', r.staleNote.includes('reference-only') && r.recommended.clean.some((p) => p.endsWith('stale.txt')), false);
check('目录体积被统计', (r.entries.find((e) => e.name === 'round-dir')?.bytes || 0) >= 100, true);

const noSince = spawnSync(process.execPath, [SCAN, '--apply', '--json'], { encoding: 'utf8', env });
check('自动清理必须显式给 since', noSince.status, 2);

const onlyApplied = scan(['--since', String(since), '--apply', '--only', onlyFile]);
check('--only 只删指定路径', fs.existsSync(onlyFile), false);
check('--only 保留其他可清条目', fs.existsSync(otherFile), true);
check('--only 结果标记 only', onlyApplied.only.length, 1);
const badOnly = spawnSync(process.execPath, [SCAN, '--apply', '--since', String(since), '--only', path.join(ROOT, 'outside')], { encoding: 'utf8', env });
check('--only 必须是临时根直接子条目', badOnly.status, 2);

// --apply 边界：未来 / 超期 since、非 canonicalRoot 的 --root
const futureSince = spawnSync(process.execPath, [SCAN, '--since', String(Date.now() + 3600000), '--apply', '--json'], { encoding: 'utf8', env });
check('--apply 拒绝未来 since', futureSince.status, 2);
const tooOldSince = spawnSync(process.execPath, [SCAN, '--since', String(Date.now() - 8 * 86400000), '--apply', '--json'], { encoding: 'utf8', env });
check('--apply 拒绝超过 7 天的 since', tooOldSince.status, 2);
const outsideRoot = path.join(ROOT, 'outside-apply');
fs.mkdirSync(outsideRoot, { recursive: true });
fs.writeFileSync(path.join(outsideRoot, 'x.log'), 'x');
const outsideApply = spawnSync(process.execPath, [SCAN, '--root', outsideRoot, '--since', String(since), '--apply', '--json'], { encoding: 'utf8', env });
check('--apply 拒绝非 canonicalRoot 的 --root', outsideApply.status, 2);
check('--apply 被拒后文件仍在', fs.existsSync(path.join(outsideRoot, 'x.log')), true);
const forcedApply = scan(['--root', outsideRoot, '--since', String(since), '--apply', '--force']);
check('--force 允许非 canonicalRoot 的 --root', forcedApply.deleted.length, 1);

const applied = scan(['--since', String(since), '--apply']);
check('自动清理标记 apply', applied.apply, true);
check('自动清理删除本轮可清目录', fs.existsSync(freshDir), false);
check('自动清理删除本轮可清文件', fs.existsSync(freshFile), false);
check('自动清理删除普通 qo- 日志', fs.existsSync(qoLog), false);
check('自动清理删除其他可清条目', fs.existsSync(otherFile), false);
check('自动清理保留分享包产物', fs.existsSync(shareDir), true);
check('自动清理保留分享包暂存目录', fs.existsSync(pkgStage), true);
check('自动清理保留 qo 包目录', fs.existsSync(qoPkg), true);
check('自动清理保留证据目录', fs.existsSync(excludedDir), true);
check('自动清理保留自定义保护项', fs.existsSync(keepMe), true);
check('自动清理不删超期件', fs.existsSync(staleText), true);
check('自动清理结果包含删除清单', applied.deleted.some((p) => p.endsWith('round-dir')) && applied.deleted.some((p) => p.endsWith('round.zip')), true);
check('自动清理结果包含保护清单', applied.protected.some((p) => p.includes('Qoder-Optimization')), true);

const includeApplied = scan(['--since', String(since), '--apply', '--include-share-package']);
check('授权模式可清理分享包产物', fs.existsSync(shareDir), false);
check('授权模式可清理分享包暂存目录', fs.existsSync(pkgStage), false);
check('授权模式可清理 qo 包目录', fs.existsSync(qoPkg), false);
check('授权模式仍保留回滚点/证据', fs.existsSync(excludedDir), true);
check('授权模式仍保留自定义保护项', fs.existsSync(keepMe), true);
check('授权模式仍不删超期件', fs.existsSync(staleText), true);
check('授权模式标记 includeSharePackage', includeApplied.includeSharePackage, true);
check('授权模式默认标记 trash', includeApplied.trash, true);

// 隔离区：默认移入 <root>/.trash，7 天后回收；--no-trash 才永久删
const trashDir = path.join(TMPROOT, '.trash');
const trashBatches = fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : [];
check('授权模式默认进隔离区', trashBatches.length > 0, true);
check('隔离区保留被移入的包产物', trashBatches.some((b) => fs.existsSync(path.join(trashDir, b, 'Qoder-Optimization-0.1.0'))), true);
const afterShareScan = scan(['--since', String(since)]);
const trashEntry = afterShareScan.entries.find((e) => e.name === '.trash');
check('隔离区被标记排除且不在清理清单', !!trashEntry && trashEntry.excluded === true
  && !afterShareScan.recommended.clean.some((p) => p.endsWith('.trash')), true);
const shareNoTrash = path.join(TMPROOT, 'Qoder-Optimization-0.1.9');
fs.mkdirSync(shareNoTrash, { recursive: true });
fs.writeFileSync(path.join(shareNoTrash, 'pkg.tgz'), 'p');
scan(['--since', String(since), '--apply', '--include-share-package', '--no-trash']);
check('--no-trash 永久删除包产物', fs.existsSync(shareNoTrash), false);
// 批次名必须是产品真会造出来的 ISO 时间戳（旧夹具用 'old-batch'，那不是任何真实批次的名字）。
const batchStamp = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');
const oldBatch = path.join(trashDir, batchStamp(Date.now() - 8 * 86400000));
fs.mkdirSync(oldBatch, { recursive: true });
fs.writeFileSync(path.join(oldBatch, 'x.log'), 'x');
const oldBatchT = new Date(Date.now() - 8 * 86400000);
fs.utimesSync(oldBatch, oldBatchT, oldBatchT);
// 负对照：用户手工放进隔离区的东西不是本脚本的批次，超期也不许永久删除。
const userPlaced = path.join(trashDir, 'user-placed-evidence');
fs.mkdirSync(userPlaced, { recursive: true });
fs.writeFileSync(path.join(userPlaced, 'precious.bin'), 'p'.repeat(16));
fs.utimesSync(userPlaced, oldBatchT, oldBatchT);
// 负对照：批次时间戳超期但 mtime 被刷新过 ⇒ 仍按时间戳回收（否则隔离区无限堆积）。
const staleStampFreshMtime = path.join(trashDir, batchStamp(Date.now() - 9 * 86400000));
fs.mkdirSync(staleStampFreshMtime, { recursive: true });
fs.writeFileSync(path.join(staleStampFreshMtime, 'y.log'), 'y');
scan(['--since', String(since), '--apply', '--json']);
check('隔离区回收超过 7 天的批次', fs.existsSync(oldBatch), false);
check('隔离区不永久删除非批次的未知条目', fs.existsSync(path.join(userPlaced, 'precious.bin')), true);
check('回收按批次时间戳而非 mtime', fs.existsSync(staleStampFreshMtime), false);

const after = scan(['--since', String(since)]);
check('复扫无默认可清条目', after.recommended.clean.length, 0);

// --session：只自动删名字含本会话令牌的条目；其他条目保留
const sessToken = 'abc12345';
const ownedLog = path.join(TMPROOT, 'task-' + sessToken + '.log');
const otherLog = path.join(TMPROOT, 'plain-other.log');
fs.writeFileSync(ownedLog, 'o');
fs.writeFileSync(otherLog, 'n');
const sessApplied = scan(['--since', String(since), '--apply', '--session', sessToken]);
check('--session 只删带本会话令牌的条目', fs.existsSync(ownedLog), false);
check('--session 保留其他条目', fs.existsSync(otherLog), true);
check('--session 结果列出被跳过的条目', sessApplied.recommended.sessionSkipped.some((p) => p.endsWith('plain-other.log')), true);

// .keep：证据自声明，整棵保留
const keepEvidence = path.join(TMPROOT, 'keep-evidence');
fs.mkdirSync(keepEvidence, { recursive: true });
fs.writeFileSync(path.join(keepEvidence, '.keep'), '');
fs.writeFileSync(path.join(keepEvidence, 'old.log'), 'x');
const keepScan = scan(['--since', String(since)]);
check('.keep 目录被标记保留', keepScan.entries.find((e) => e.name === 'keep-evidence')?.keep, true);
check('JSON 带 guards/trash/session 字段（T-18 后目录删除默认进隔离区）', typeof keepScan.guards === 'object' && keepScan.trash === true && keepScan.session === null, true);
const noTrashScan = scan(['--since', String(since), '--no-trash']);
check('负对照 --no-trash 时 trash 为 false', noTrashScan.trash, false);
scan(['--since', String(since), '--apply']);
check('.keep 目录不被自动删除', fs.existsSync(keepEvidence), true);

// 新建 vs 修改：仅被修改的旧目录不在自动清理范围
const modParent = path.join(ROOT, 'mod-parent');
fs.mkdirSync(modParent, { recursive: true });
const oldDir = path.join(modParent, 'old-dir');
fs.mkdirSync(oldDir);
const modSince = Math.ceil(fs.statSync(oldDir).birthtimeMs) + 1;
fs.writeFileSync(path.join(oldDir, 'inside.log'), 'x');
const touchedAt = new Date(modSince + 1000);
fs.utimesSync(oldDir, touchedAt, touchedAt);
const modScan = scan(['--root', modParent, '--since', String(modSince)]);
const oldEntry = modScan.entries.find((e) => e.name === 'old-dir');
check('旧目录本轮仅被修改：created=false', oldEntry && oldEntry.created, false);
check('仅修改的旧目录不在自动清理清单', modScan.recommended.clean.includes(oldDir), false);
check('仅修改的旧目录进入 modified 清单', modScan.recommended.modified.includes(oldDir), true);
scan(['--root', modParent, '--since', String(modSince), '--apply', '--force']);
check('自动清理不删仅修改的旧目录', fs.existsSync(oldDir), true);
scan(['--root', modParent, '--since', String(modSince), '--apply', '--force', '--only', oldDir]);
check('--only 精确指定才删旧目录', fs.existsSync(oldDir), false);

const empty = path.join(ROOT, 'empty');
fs.mkdirSync(empty);
const r2 = scan(['--root', empty, '--since', String(since)]);
check('空目录返回零条目', r2.entries.length, 0);

// ---- 取值型开关缺值：必须失败关闭，不得静默丢弃后照删（2026-11-12 修前实测退 0 且真删）----
// 每例一套独立根：--apply 会删东西，共用根会让后一条判据读到前一条的残骸。
function caseRoot(tag, names) {
  const dir = path.join(ROOT, tag);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'payload.bin'), 'x'.repeat(32));
  }
  return dir;
}
const runIn = (dir, args) => spawnSync(process.execPath, [SCAN, '--root', dir, ...args], { encoding: 'utf8', env });
const sinceArg = ['--since', String(since)];

const a1 = caseRoot('arg-a1', ['keep-me', 'other']);
const a1r = runIn(a1, [...sinceArg, '--apply', '--force', '--mark-evidence']);
check('--mark-evidence 缺值：退 2', a1r.status, 2);
check('--mark-evidence 缺值：报错点名该开关（不是被 root 判据顺手拦下）', /--mark-evidence 缺少取值/.test(a1r.stderr), true);
check('--mark-evidence 缺值：一个目录都不删', fs.existsSync(path.join(a1, 'keep-me')) && fs.existsSync(path.join(a1, 'other')), true);

const a2 = caseRoot('arg-a2', ['target', 'bystander']);
const a2r = runIn(a2, [...sinceArg, '--apply', '--force', '--only']);
check('--only 缺值：退 2', a2r.status, 2);
check('--only 缺值：报错点名该开关', /--only 缺少取值/.test(a2r.stderr), true);
check('--only 缺值：范围不被放大成全部推荐项', fs.existsSync(path.join(a2, 'target')) && fs.existsSync(path.join(a2, 'bystander')), true);

const a3 = caseRoot('arg-a3', ['mine-c988bddc', 'theirs-8d8de525']);
const a3r = runIn(a3, [...sinceArg, '--apply', '--force', '--session']);
check('--session 缺值：退 2', a3r.status, 2);
check('--session 缺值：报错点名该开关', /--session 缺少取值/.test(a3r.stderr), true);
check('--session 缺值：不动其他会话的产物', fs.existsSync(path.join(a3, 'theirs-8d8de525')), true);

const a4 = caseRoot('arg-a4', ['keep-me']);
const a4r = runIn(a4, [...sinceArg, '--apply', '--force', '--only', '--json']);
check('取值位置上是另一个开关：退 2（不把 --json 当路径）', a4r.status, 2);
check('取值位置上是另一个开关：报错说明原因', /另一个开关/.test(a4r.stderr), true);

// 负对照：合法用法必须仍然绿，否则就是「拦得太多」——那比不拦更糟。
const a5 = caseRoot('arg-a5', ['evidence-dir', 'junk']);
const a5doc = path.join(a5, 'doc.md');
fs.writeFileSync(a5doc, '# 登记\n');
const a5r = runIn(a5, ['--mark-evidence', path.join(a5, 'evidence-dir'), '--task', 'QO-TEST', '--session', 'c988bddc', '--doc', a5doc, '--json']);
check('负对照：合法 --mark-evidence 退 0', a5r.status, 0);
check('负对照：合法 --mark-evidence 写出标记', fs.existsSync(path.join(a5, 'evidence-dir', '.evidence.json')), true);
check('负对照：合法 --mark-evidence 不删任何东西', fs.existsSync(path.join(a5, 'junk')), true);

const a6 = caseRoot('arg-a6', ['target', 'bystander']);
const a6r = runIn(a6, [...sinceArg, '--apply', '--force', '--only', path.join(a6, 'target'), '--json']);
check('负对照：合法 --only 仍只删指定项', a6r.status === 0 && !fs.existsSync(path.join(a6, 'target')), true);
check('负对照：合法 --only 保留旁观者', fs.existsSync(path.join(a6, 'bystander')), true);

const a7 = caseRoot('arg-a7', ['mine-c988bddc', 'theirs-8d8de525']);
const a7r = runIn(a7, [...sinceArg, '--apply', '--force', '--session', 'c988bddc', '--json']);
check('负对照：合法 --session 仍只删本会话产物', a7r.status === 0 && !fs.existsSync(path.join(a7, 'mine-c988bddc')), true);
check('负对照：合法 --session 保留其他会话产物', fs.existsSync(path.join(a7, 'theirs-8d8de525')), true);

// ---- C10 台账写失败不得报成功（旧实现 catch 后吞掉，删了东西却退 0）----
// 真实失败注入：把 .last-cleanup 做成目录 ⇒ writeFileSync 抛 EISDIR，不 mock。
const b1 = caseRoot('ledger-b1', ['junk']);
fs.mkdirSync(path.join(b1, '.last-cleanup'), { recursive: true });
const b1r = runIn(b1, [...sinceArg, '--apply', '--force', '--json']);
check('台账不可写：退出码非 0', b1r.status, 1);
check('台账不可写：JSON 带 ledgerError 原因', /EISDIR/.test(String(JSON.parse(b1r.stdout).ledgerError || '')), true);

const b2 = caseRoot('ledger-b2', ['junk']);
const b2r = runIn(b2, [...sinceArg, '--apply', '--force', '--json']);
const b2j = JSON.parse(b2r.stdout);
check('负对照：正常根台账写入成功仍退 0', b2r.status, 0);
check('负对照：正常根 .last-cleanup 是文件', fs.statSync(path.join(b2, '.last-cleanup')).isFile(), true);
check('负对照：正常根无 ledgerError', b2j.ledgerError, null);

const b3 = caseRoot('ledger-b3', ['junk']);
fs.mkdirSync(path.join(b3, '.last-cleanup'), { recursive: true });
const b3r = runIn(b3, [...sinceArg, '--apply', '--force']);
check('文本模式台账失败：退出码非 0', b3r.status, 1);
check('文本模式台账失败：打印可归因的提示', /清理台账写入失败/.test(b3r.stdout), true);

// ---- C10 续：文档登记目录内部文件 ⇒ 父目录整棵保留；标签只算真证据 ----
const c1 = caseRoot('reg-c1', ['docreg-parent', 'docreg-parent-2', 'unrelated']);
fs.mkdirSync(path.join(c1, 'docreg-parent', 'nested'), { recursive: true });
const c1child = path.join(c1, 'docreg-parent', 'nested', 'read-R01.md');
fs.writeFileSync(c1child, '# 通读记录\n');
const c1docs = path.join(c1, 'docs');
fs.mkdirSync(c1docs, { recursive: true });
fs.writeFileSync(path.join(c1docs, '审计证据.md'), '证据：`' + c1child.replace(/\\/g, '/') + '` 已登记。\n');
const c1r = runIn(c1, [...sinceArg, '--apply', '--force', '--evidence-docs', c1docs, '--json']);
const c1j = JSON.parse(c1r.stdout);
check('登记目录内部文件 ⇒ 父目录整棵保留', fs.existsSync(path.join(c1, 'docreg-parent')), true);
check('父目录进入 registeredEvidence 清单', c1j.registeredEvidence.some((p) => p.endsWith('docreg-parent')), true);
check('负对照：前缀相似的兄弟目录不被误保护', fs.existsSync(path.join(c1, 'docreg-parent-2')), false);
check('负对照：未登记目录照常清理', fs.existsSync(path.join(c1, 'unrelated')), false);

const c3 = caseRoot('reg-c3', ['junk']);
const c3docs = path.join(c3, 'docs');
fs.mkdirSync(c3docs, { recursive: true });
fs.writeFileSync(path.join(c3docs, 'e.md'),
  '台账 `' + path.join(c3, '.last-cleanup').replace(/\\/g, '/') + '`；'
  + '否决 `' + path.join(c3, '.git', 'config').replace(/\\/g, '/') + '`；'
  + '证据 `' + path.join(c3, 'junk').replace(/\\/g, '/') + '`。\n');
const c3r = runIn(c3, [...sinceArg, '--apply', '--force', '--evidence-docs', c3docs, '--json']);
const c3list = JSON.parse(c3r.stdout).registeredEvidence;
check('台账不算「已登记证据」', c3list.some((p) => p.endsWith('.last-cleanup')), false);
check('硬否决路径不算「已登记证据」', c3list.some((p) => p.includes('.git')), false);
check('负对照：真证据目录仍在清单里', c3list.some((p) => p.endsWith('junk')), true);

// ---- D 等号形开关与未知参数：必须与空格形等价，认不出来的一律失败关闭 ----
// 修前实测（probe-f70-eqform B/D）：`--only=<path>` / `--session=<token>` 既不匹配 VALUE_FLAGS
// 也不匹配任何 else if，被**静默丢弃** ⇒ 范围限制失效，配 --apply 连别的会话的目录一起删。
// 上面 A 组只覆盖空格形，所以这个 P0 一直绿着。
const d1 = caseRoot('eq-d1', ['target', 'bystander']);
const d1r = runIn(d1, [...sinceArg, '--apply', '--force', '--only=' + path.join(d1, 'target'), '--json']);
const d1j = d1r.status === 0 ? JSON.parse(d1r.stdout) : { only: [] };
check('等号形 --only=<path>：退 0', d1r.status, 0);
check('等号形 --only=<path>：only 清单恰好 1 项（不是被丢成空）', d1j.only.length, 1);
check('等号形 --only=<path>：只删指定项', fs.existsSync(path.join(d1, 'target')), false);
check('等号形 --only=<path>：旁观者保留（范围没被放大）', fs.existsSync(path.join(d1, 'bystander')), true);

const d2 = caseRoot('eq-d2', ['mine-c988bddc', 'theirs-8d8de525']);
const d2r = runIn(d2, [...sinceArg, '--apply', '--force', '--session=c988bddc', '--json']);
check('等号形 --session=<token>：退 0', d2r.status, 0);
check('等号形 --session=<token>：只删本会话产物', fs.existsSync(path.join(d2, 'mine-c988bddc')), false);
check('等号形 --session=<token>：其他会话产物保留', fs.existsSync(path.join(d2, 'theirs-8d8de525')), true);

const d3 = caseRoot('eq-d3', ['target', 'bystander']);
const d3r = runIn(d3, [...sinceArg, '--apply', '--force', '--only=', '--json']);
check('等号形空值 --only=：退 2', d3r.status, 2);
check('等号形空值 --only=：报错点名该开关', /--only 缺少取值/.test(d3r.stderr), true);
check('等号形空值 --only=：一个都不删', fs.existsSync(path.join(d3, 'target')) && fs.existsSync(path.join(d3, 'bystander')), true);

const d4 = caseRoot('eq-d4', ['target', 'bystander']);
const d4r = runIn(d4, [...sinceArg, '--apply', '--force', '--onlyy', path.join(d4, 'target'), '--json']);
check('拼错的开关 --onlyy：退 2（不静默忽略后全量清理）', d4r.status, 2);
check('拼错的开关 --onlyy：报错点名未知开关', /未知开关 --onlyy/.test(d4r.stderr), true);
check('拼错的开关 --onlyy：一个都不删', fs.existsSync(path.join(d4, 'target')) && fs.existsSync(path.join(d4, 'bystander')), true);

const d5 = caseRoot('eq-d5', ['target']);
const d5r = runIn(d5, [...sinceArg, '--apply', '--force', path.join(d5, 'target'), '--json']);
check('裸位置参数：退 2', d5r.status, 2);
check('裸位置参数：报错说明无法识别', /无法识别的参数/.test(d5r.stderr), true);
check('裸位置参数：不删', fs.existsSync(path.join(d5, 'target')), true);

const d6 = caseRoot('eq-d6', ['target']);
const d6r = runIn(d6, ['--since=not-a-time', '--json']);
check('--since 解析不出时间：退 2（不静默回落默认时间窗）', d6r.status, 2);
check('--since 解析不出时间：报错点名原因', /解析不出时间/.test(d6r.stderr), true);

const d7 = caseRoot('eq-d7', ['target']);
const d7r = runIn(d7, ['--since=' + since, '--json']);
check('负对照：等号形 --since=<毫秒> 仍生效', d7r.status === 0 && JSON.parse(d7r.stdout).since === new Date(since).toISOString(), true);

const d8 = caseRoot('eq-d8', ['target']);
const d8r = spawnSync(process.execPath, [SCAN, '--root=' + d8, '--since', String(since), '--json'], { encoding: 'utf8', env });
check('负对照：等号形 --root=<目录> 仍生效', d8r.status === 0 && JSON.parse(d8r.stdout).root === d8, true);

const d9 = caseRoot('eq-d9', ['docreg-parent', 'unrelated']);
fs.mkdirSync(path.join(d9, 'docreg-parent', 'nested'), { recursive: true });
const d9child = path.join(d9, 'docreg-parent', 'nested', 'read-R01.md');
fs.writeFileSync(d9child, '# 通读记录\n');
const d9docs = path.join(d9, 'docs');
fs.mkdirSync(d9docs, { recursive: true });
fs.writeFileSync(path.join(d9docs, '审计证据.md'), '证据：`' + d9child.replace(/\\/g, '/') + '` 已登记。\n');
const d9r = runIn(d9, [...sinceArg, '--apply', '--force', '--evidence-docs=' + d9docs, '--json']);
check('等号形 --evidence-docs=<目录>：文档登记保护真的生效', d9r.status === 0 && fs.existsSync(path.join(d9, 'docreg-parent')), true);
check('等号形 --evidence-docs：未登记目录照常清理（负对照）', fs.existsSync(path.join(d9, 'unrelated')), false);

const d10 = caseRoot('eq-d10', ['evidence-dir', 'junk']);
const d10doc = path.join(d10, 'doc.md');
fs.writeFileSync(d10doc, '# 登记\n');
const d10r = runIn(d10, ['--mark-evidence=' + path.join(d10, 'evidence-dir'), '--task=QO-TEST', '--session=c988bddc', '--doc=' + d10doc, '--json']);
check('等号形 --mark-evidence/--task/--session/--doc：退 0', d10r.status, 0);
check('等号形 --mark-evidence：写出标记', fs.existsSync(path.join(d10, 'evidence-dir', '.evidence.json')), true);
check('等号形 --mark-evidence：不删任何东西', fs.existsSync(path.join(d10, 'junk')), true);

const d11 = caseRoot('eq-d11', ['target']);
const d11r = runIn(d11, [...sinceArg, '--apply=true', '--force', '--json']);
check('布尔开关带值 --apply=true：退 2（不静默忽略）', d11r.status, 2);
check('布尔开关带值 --apply=true：不删', fs.existsSync(path.join(d11, 'target')), true);

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n=== tmp-round-scan 自测：通过 ${n - failed}，失败 ${failed} ===`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(failed ? 1 : 0);
