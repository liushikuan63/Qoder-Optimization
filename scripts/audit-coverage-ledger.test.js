#!/usr/bin/env node
'use strict';
// T-12 / A6 / A9：审计覆盖台账的可失败验证。
// 核心负对照①：日期倒挂（子提交比父提交旧）时 `git log --since` 会剪掉整个祖先线，
//             窗口内真实改过的文件一个都不列；全历史遍历 + 提交日期过滤必须列出来。
// 核心负对照②：把全部文件标已审但 evidenceRef 指向不存在的文件 → 必须拒绝，不得变成满覆盖。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildLedger, enumerateWindow, enumerateWithSince } = require('./audit-coverage-ledger.cjs');

const SCRIPT = path.join(__dirname, 'audit-coverage-ledger.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-coverage-'));
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

function g(dir, args, env) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || '').trim());
  return r.stdout;
}
function repoFixture(label) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 'audit@example.invalid']);
  g(dir, ['config', 'user.name', 'audit fixture']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}
function commit(dir, file, content, iso) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  g(dir, ['add', '--', file]);
  g(dir, ['commit', '-qm', iso + ' ' + file], { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
}
function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const WINDOW = { since: '2026-11-01T00:00:00Z', until: '2026-11-11T00:00:00Z' };
function paths(ledger) { return ledger.files.map(item => item.path); }

// ── 负对照①：日期倒挂下 --since 剪枝漏扫，全历史遍历不漏 ──
{
  const dir = repoFixture('inverted');
  commit(dir, 'new-parent.txt', 'new\n', '2026-11-08T00:00:00Z');
  commit(dir, 'old-child.txt', 'old\n', '2026-10-01T00:00:00Z');
  const ledger = buildLedger({ repo: dir, ...WINDOW });
  const pruned = enumerateWithSince(dir, WINDOW.since);
  check('A9 负对照：--since 在日期倒挂时漏掉窗口内文件', pruned.size === 0, 'sinceFiles=' + pruned.size);
  check('A9 全历史遍历 + 提交日期过滤列出该文件', paths(ledger).includes('new-parent.txt'), JSON.stringify(paths(ledger)));
  check('A9 窗口外的旧提交文件不被纳入', !paths(ledger).includes('old-child.txt'));
  const c = cli(['--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--compare-since', '--json']);
  const j = JSON.parse(c.out);
  check('A9 --compare-since 显式呈报漏扫清单', j.sinceComparison.missedBySince.includes('new-parent.txt') && j.sinceComparison.sinceFiles === 0, JSON.stringify(j.sinceComparison));
}

// ── F34：非 ASCII 路径不得被 git core.quotepath 转义成八进制字面量 ──
{
  const dir = repoFixture('unicode');
  const cn = 'README-安装说明.md';
  const nested = '技能/说明.md';
  commit(dir, cn, '# 安装\n', '2026-11-05T00:00:00Z');
  commit(dir, nested, '# 说明\n', '2026-11-06T00:00:00Z');
  const ledger = buildLedger({ repo: dir, ...WINDOW });
  const list = paths(ledger);
  check('F34 中文文件名按真实 UTF-8 路径入台账', list.includes(cn) && list.includes(nested), JSON.stringify(list));
  check('F34 不出现八进制转义字面量', !list.some(p => /\\[0-7]{3}/.test(p) || p.startsWith('"')), JSON.stringify(list));
  const cnEntry = ledger.files.find(item => item.path === cn);
  check('F34 现存中文文件 exists=true（不被误判已删）', Boolean(cnEntry && cnEntry.exists && cnEntry.existsAtRef), JSON.stringify(cnEntry));
  check('F34 existing 计数含两个中文文件', ledger.existingFiles === 2 && ledger.deletedFiles === 0, `existing=${ledger.existingFiles} deleted=${ledger.deletedFiles}`);

  const evidence = path.join(dir, 'evidence.log');
  fs.writeFileSync(evidence, 'read line by line\n');
  const recordsFile = path.join(dir, 'records.json');
  fs.writeFileSync(recordsFile, JSON.stringify({
    schema: 1,
    entries: [
      { path: cn, level: 'static', evidenceRef: 'evidence.log' },
      { path: nested, level: 'static', evidenceRef: 'evidence.log' },
    ],
  }));
  const covered = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('F34 按真实路径登记可达成 FULL', covered.coverage === 'FULL' && covered.unauditedCount === 0 && covered.outOfWindow.length === 0,
    `coverage=${covered.coverage} unaudited=${covered.unauditedCount} outOfWindow=${JSON.stringify(covered.outOfWindow)}`);

  // 负对照：拿 git 转义后的字面量登记不得命中（否则等于用假路径凑覆盖）
  const escaped = '"README-\\345\\256\\211\\350\\243\\205\\350\\257\\264\\346\\230\\216.md"';
  fs.writeFileSync(recordsFile, JSON.stringify({ schema: 1, entries: [{ path: escaped, level: 'static', evidenceRef: 'evidence.log' }] }));
  const wrong = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('F34 负对照：转义字面量登记不命中真实文件', wrong.auditedCount === 0 && wrong.outOfWindow.length === 1 && wrong.coverage === 'PARTIAL',
    `audited=${wrong.auditedCount} outOfWindow=${wrong.outOfWindow.length}`);
}

// ── 确定性：绝对窗口钉住后 HEAD 前进不改变窗口文件集 ──
{
  const dir = repoFixture('pinned');
  commit(dir, 'in-window.txt', 'a\n', '2026-11-05T00:00:00Z');
  const before = buildLedger({ repo: dir, ...WINDOW });
  commit(dir, 'later.txt', 'b\n', '2026-11-20T00:00:00Z');
  const after = buildLedger({ repo: dir, ...WINDOW });
  check('A9 HEAD 前进后绝对窗口文件集完全一致', JSON.stringify(paths(before)) === JSON.stringify(paths(after)), JSON.stringify({ before: paths(before), after: paths(after) }));
  check('A9 台账记录枚举方式与窗口边界', after.enumeration === 'full-history-walk+commit-date-filter' && after.window.since === '2026-11-01T00:00:00.000Z' && after.window.until === '2026-11-11T00:00:00.000Z');
}

// ── 相对窗口不可复现（这就是必须钉绝对边界的原因）──
{
  const dir = repoFixture('relative');
  commit(dir, 'october.txt', 'a\n', '2026-10-28T00:00:00Z');
  commit(dir, 'november.txt', 'b\n', '2026-11-05T00:00:00Z');
  const a = buildLedger({ repo: dir, days: 10, until: '2026-11-11T00:00:00Z' });
  const b = buildLedger({ repo: dir, days: 10, until: '2026-11-06T00:00:00Z' });
  check('A9 同样「近 10 天」在不同锚点给出不同文件集（相对窗口不可复现）',
    JSON.stringify(paths(a)) !== JSON.stringify(paths(b)) && paths(b).includes('october.txt') && !paths(a).includes('october.txt'),
    JSON.stringify({ a: paths(a), b: paths(b) }));
}

// ── 缺口必须显式呈报，不得声称全量已覆盖 ──
{
  const dir = repoFixture('gap');
  commit(dir, 'a.txt', 'a\n', '2026-11-05T00:00:00Z');
  commit(dir, 'b.txt', 'b\n', '2026-11-06T00:00:00Z');
  const ledger = buildLedger({ repo: dir, ...WINDOW });
  check('unauditedCount > 0 且 coverage=PARTIAL', ledger.unauditedCount === 2 && ledger.coverage === 'PARTIAL' && ledger.auditedCount === 0);
  const c = cli(['--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--check']);
  check('--check 在有缺口时 exit 1', c.code === 1, 'exit=' + c.code);
  check('有缺口时不得输出「全量已覆盖」', !c.out.includes('全量已覆盖') && /unaudited=2/.test(c.out) && /禁止宣称完整覆盖/.test(c.out), c.out.split('\n')[0]);
  check('逐文件带 audited 与 level 字段', ledger.files.every(item => item.audited === false && item.level === null));
}

// ── 合法登记 → 满覆盖；非法登记 → 拒绝（负对照②）──
{
  const dir = repoFixture('records');
  commit(dir, 'a.txt', 'a\n', '2026-11-05T00:00:00Z');
  commit(dir, 'b.txt', 'b\n', '2026-11-06T00:00:00Z');
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'read-log.md'), '# 逐行通读记录\n');
  const recordsFile = path.join(dir, 'records.json');
  const write = entries => fs.writeFileSync(recordsFile, JSON.stringify({ schema: 1, entries }));
  const good = [
    { path: 'a.txt', level: 'static', evidenceRef: 'evidence/read-log.md' },
    { path: 'b.txt', level: 'runtime', evidenceRef: 'evidence/read-log.md' },
  ];
  write(good);
  const full = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('合法登记后 coverage=FULL、unaudited=0', full.coverage === 'FULL' && full.unauditedCount === 0 && full.auditedCount === 2, JSON.stringify(full.invalidRecords));
  const okRun = cli(['--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--records', recordsFile, '--check']);
  check('满覆盖时 --check exit 0 且才允许说全量已覆盖', okRun.code === 0 && okRun.out.includes('全量已覆盖'), 'exit=' + okRun.code);

  write(good.map(entry => ({ ...entry, evidenceRef: 'evidence/does-not-exist.md' })));
  const fake = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('负对照：全部标已审但证据文件不存在 → 拒绝且仍判 PARTIAL',
    fake.coverage === 'PARTIAL' && fake.unauditedCount === 2 && fake.invalidRecords.length === 2, JSON.stringify(fake.invalidRecords));
  const fakeRun = cli(['--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--records', recordsFile, '--check']);
  check('负对照：伪造满覆盖时 --check exit 1 且不输出全量已覆盖', fakeRun.code === 1 && !fakeRun.out.includes('全量已覆盖') && /INVALID_RECORD/.test(fakeRun.out), 'exit=' + fakeRun.code);

  write([{ path: 'a.txt', level: 'guessed', evidenceRef: 'evidence/read-log.md' }, good[1]]);
  const badLevel = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('非法 level 被拒（只认四级）', badLevel.invalidRecords.length === 1 && /level 必须是/.test(badLevel.invalidRecords[0].reason));

  write([{ path: 'a.txt', level: 'static', evidenceRef: '' }, good[1]]);
  check('空 evidenceRef 被拒', buildLedger({ repo: dir, ...WINDOW, records: recordsFile }).invalidRecords.length === 1);

  write([good[0], good[0], good[1]]);
  check('同一文件重复登记被拒', buildLedger({ repo: dir, ...WINDOW, records: recordsFile }).invalidRecords.some(item => /重复登记/.test(item.reason)));

  write([...good, { path: 'outside.txt', level: 'static', evidenceRef: 'evidence/read-log.md' }]);
  const outside = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('窗口外登记被单列且不计入覆盖', outside.outOfWindow.includes('outside.txt') && outside.auditedCount === 2 && outside.totalFiles === 2);

  write([{ path: 'a.txt', level: 'artifact', evidenceRef: 'transcript:abc123' }, good[1]]);
  const scheme = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('带 scheme 的 evidenceRef 按锚点处理（不当路径核存在）',
    scheme.invalidRecords.length === 0 && scheme.auditedCount === 2 && scheme.files.find(item => item.path === 'a.txt').level === 'artifact', JSON.stringify(scheme.invalidRecords));

  write([{ path: 'a.txt', level: 'artifact', evidenceRef: 'https://example.com/read-log.md' }, good[1]]);
  const urlScheme = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('多字母 scheme（https:）仍按锚点处理，不被盘符判据误伤', urlScheme.invalidRecords.length === 0 && urlScheme.auditedCount === 2, JSON.stringify(urlScheme.invalidRecords));

  // ── 负对照③：Windows 盘符绝对路径长得像 scheme（`D:` 命中 /^[a-z][a-z0-9+.-]*:/），
  //    若按 scheme 跳过存在性核对，「全部标已审 + 指向不存在的 D:/… 」就能凭空造出满覆盖。
  //    本机实测：709 个文件全部伪登记 → COVERAGE FULL / unaudited=0 / --check exit 0。
  const driveMissing = path.resolve(dir, 'evidence', 'no-such-drive-evidence.md');
  const driveForms = [driveMissing, driveMissing.replace(/\\/g, '/'), 'Q:/qo-coverage-definitely-missing.md'];
  for (const ref of driveForms) {
    write(good.map(entry => ({ ...entry, evidenceRef: ref })));
    const driveFake = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
    check('负对照：盘符绝对路径伪证据被拒（' + ref.slice(0, 24) + '…）',
      driveFake.coverage === 'PARTIAL' && driveFake.unauditedCount === 2 && driveFake.invalidRecords.length === 2
      && driveFake.invalidRecords.every(item => /不存在/.test(item.reason)), JSON.stringify(driveFake.invalidRecords));
    const driveRun = cli(['--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--records', recordsFile, '--check']);
    check('负对照：盘符伪证据 --check exit 1 且不得输出全量已覆盖', driveRun.code === 1 && !driveRun.out.includes('全量已覆盖') && /INVALID_RECORD/.test(driveRun.out), 'exit=' + driveRun.code);
  }

  // 正向对照：真实存在的盘符绝对路径必须照常接受（证明修的是误分类，不是把绝对路径一律拒掉）
  const driveReal = path.resolve(dir, 'evidence', 'read-log.md');
  write(good.map(entry => ({ ...entry, evidenceRef: driveReal })));
  const driveOk = buildLedger({ repo: dir, ...WINDOW, records: recordsFile });
  check('正向对照：存在的盘符绝对路径证据被接受且 coverage=FULL', driveOk.invalidRecords.length === 0 && driveOk.coverage === 'FULL' && driveOk.auditedCount === 2, JSON.stringify(driveOk.invalidRecords));

  // 变异负对照：把盘符守卫摘掉，同一份伪登记必须重新变成满覆盖——证明上面的红确实由该守卫产生
  const mutant = path.join(root, 'ledger-mutant-drive.cjs');
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const guard = 'if (DRIVE_PATH.test(entry.evidenceRef) || !SCHEME.test(entry.evidenceRef)) {';
  const hits = original.split(guard).length - 1;
  check('变异命中调用点（盘符守卫存在且唯一）', hits === 1, 'hits=' + hits);
  fs.writeFileSync(mutant, original.replace(guard, 'if (!SCHEME.test(entry.evidenceRef)) {'));
  write(good.map(entry => ({ ...entry, evidenceRef: driveForms[0] })));
  const mutRun = spawnSync(process.execPath, [mutant, '--repo', dir, '--since', WINDOW.since, '--until', WINDOW.until, '--records', recordsFile, '--check'], { encoding: 'utf8' });
  check('变异负对照：摘掉盘符守卫后同一伪登记又变满覆盖（判据能失败）',
    mutRun.status === 0 && /COVERAGE FULL/.test(mutRun.stdout) && /全量已覆盖/.test(mutRun.stdout), 'exit=' + mutRun.status);
}

// ── 已删文件与两个「现存」口径 ──
{
  const dir = repoFixture('deleted');
  commit(dir, 'kept.txt', 'a\n', '2026-11-05T00:00:00Z');
  commit(dir, 'gone.txt', 'b\n', '2026-11-06T00:00:00Z');
  g(dir, ['rm', '-q', 'gone.txt']);
  g(dir, ['commit', '-qm', 'remove gone'], { GIT_COMMITTER_DATE: '2026-11-07T00:00:00Z', GIT_AUTHOR_DATE: '2026-11-07T00:00:00Z' });
  const ledger = buildLedger({ repo: dir, ...WINDOW });
  check('已删文件仍计入窗口并单列', ledger.totalFiles === 2 && ledger.deletedFiles === 1 && ledger.existingFiles === 1, JSON.stringify({ total: ledger.totalFiles, deleted: ledger.deletedFiles }));
  const gone = ledger.files.find(item => item.path === 'gone.txt');
  check('exists 看当前工作树、existsAtRef 看枚举 ref', gone.exists === false && gone.existsAtRef === false);
  const atOld = buildLedger({ repo: dir, ...WINDOW, ref: 'HEAD~1' });
  check('钉到旧 ref 时 existsAtRef 反映当时存在', atOld.files.find(item => item.path === 'gone.txt').existsAtRef === true);
}

// ── 参数与错误路径 ──
{
  const dir = repoFixture('args');
  commit(dir, 'a.txt', 'a\n', '2026-11-05T00:00:00Z');
  check('--days 非数字 → exit 2', cli(['--repo', dir, '--days', 'abc']).code === 2);
  check('--days 超上限 → exit 2', cli(['--repo', dir, '--days', '99999']).code === 2);
  check('--since 缺值 → exit 2', cli(['--repo', dir, '--since']).code === 2);
  check('未知参数 → exit 2', cli(['--repo', dir, '--nope']).code === 2);
  check('since 晚于 until → exit 2', cli(['--repo', dir, '--since', '2026-11-09T00:00:00Z', '--until', '2026-11-01T00:00:00Z']).code === 2);
  check('records 不是有效 JSON → exit 2', (() => { fs.writeFileSync(path.join(dir, 'bad.json'), '{'); return cli(['--repo', dir, '--records', path.join(dir, 'bad.json')]).code === 2; })());
  check('非 git 目录 → exit 2', cli(['--repo', path.join(root, 'args', 'evidence-missing')]).code === 2);
}

// ── 真实仓库基线（可复现测量，ref 不存在时跳过而不是假绿）──
{
  const repo = path.resolve(__dirname, '..');
  const probe = spawnSync('git', ['cat-file', '-e', 'e3596a2^{commit}'], { cwd: repo, encoding: 'utf8' });
  if (probe.status === 0) {
    const ledger = buildLedger({ repo, ref: 'e3596a2', since: '2026-11-01T00:00:00Z', until: '2026-11-11T02:43:42Z' });
    check('真实仓库基线：钉住 ref 与绝对窗口得 709 个文件', ledger.totalFiles === 709, 'totalFiles=' + ledger.totalFiles);
    check('真实仓库基线：未逐行通读时 unauditedCount 等于文件数', ledger.unauditedCount === ledger.totalFiles && ledger.coverage === 'PARTIAL');
    const walk = enumerateWindow(repo, Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-11T02:43:42Z'), 'e3596a2');
    check('真实仓库基线：本仓库当前历史在该窗口下 --since 与全历史遍历一致（剪枝需日期倒挂才触发）',
      enumerateWithSince(repo, '2026-11-01T00:00:00Z', 'e3596a2').size === walk.files.size, 'walk=' + walk.files.size);
  } else {
    console.log('SKIP  真实仓库基线（e3596a2 不在本检出中）');
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? '\ncoverage ALL PASS' : `\ncoverage FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);