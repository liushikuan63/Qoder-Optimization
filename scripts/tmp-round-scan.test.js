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
const oldBatch = path.join(trashDir, 'old-batch');
fs.mkdirSync(oldBatch, { recursive: true });
fs.writeFileSync(path.join(oldBatch, 'x.log'), 'x');
const oldBatchT = new Date(Date.now() - 8 * 86400000);
fs.utimesSync(oldBatch, oldBatchT, oldBatchT);
scan(['--since', String(since), '--apply', '--json']);
check('隔离区回收超过 7 天的批次', fs.existsSync(oldBatch), false);

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

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n=== tmp-round-scan 自测：通过 ${n - failed}，失败 ${failed} ===`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(failed ? 1 : 0);
