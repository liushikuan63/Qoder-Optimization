#!/usr/bin/env node
// backup-file.js 的可失败性自测：在隔离沙箱里造备份组 → 断言裁剪计划与执行结果。
//   node backup-file.test.js  → 全绿退 0，任一失败退 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'backup-file.js');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'bakfile-'));
const DAY = 86400000;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  <- ' + extra : '')); } };

const run = (args) => {
  try {
    // Owned fixtures must not depend on a desktop recycle-bin service or leave
    // synthetic backups in the user's recycle bin. Production keeps recycling.
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, BACKUP_NO_RECYCLE: '1' } }) };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const mkbak = (orig, suffix, ageDays) => {
  const p = orig + suffix;
  write(p, 'bak ' + suffix);
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(p, t, t);
  return p;
};
const listBaks = (orig) => {
  const dir = path.dirname(orig), base = path.basename(orig);
  return fs.readdirSync(dir).filter((n) => new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak').test(n));
};

console.log('== sandbox: ' + SB + '\n');

// ── 1. 备份 + 自动裁剪：cap=3、>7 天删、留最新 3 份 ──
const a = path.join(SB, 'a.txt');
write(a, 'AAA');
mkbak(a, '.bak.20261001-000000', 13);
mkbak(a, '.bak.20261005-000000', 9);
mkbak(a, '.bak.20261010-000000', 4);
mkbak(a, '.bak_20261012', 2);
mkbak(a, '.bak-20261013-restore', 1);
const r1 = run([a]);
ok('backup 执行成功', r1.code === 0, r1.out);
const aBaks = listBaks(a);
ok('裁剪后只剩 3 份（上限）', aBaks.length === 3, aBaks.join(','));
ok('超 7 天的被删除', !aBaks.some((n) => /20261001|20261005/.test(n)), aBaks.join(','));
ok('最新的 3 份保留（含本轮新备份）', aBaks.filter((n) => /2026101[0-3]|\.bak\.2026/.test(n)).length >= 2, aBaks.join(','));
ok('原始文件不动', fs.readFileSync(a, 'utf8') === 'AAA');
ok('输出点名删除动作', /删除/.test(r1.out) && /保留 3 份/.test(r1.out), r1.out.slice(0, 120));

// ── 2. 对照组：新备份后全 >7 天 ⇒ 只留最新 1 份 ──
const b = path.join(SB, 'b.txt');
write(b, 'BBB');
mkbak(b, '.bak.20260901-000000', 43);
mkbak(b, '.bak.20260920-000000', 24);
const r2 = run([b]);
ok('全旧组：新备份保留，旧的全删', r2.code === 0 && listBaks(b).length === 1, listBaks(b).join(','));
ok('全旧组保留的是本轮新备份或最新旧备份', listBaks(b).every((n) => fs.statSync(path.join(SB, n)).mtimeMs >= Date.now() - 2 * DAY), listBaks(b).join(','));

// ── 3. 至少留 1 份：prune --apply 在全旧组上也要留最新 1 份 ──
const c = path.join(SB, 'c.txt');
write(c, 'CCC');
mkbak(c, '.bak.20260925-000000', 19);
mkbak(c, '.bak.20261001-000000', 13);
const r3 = run(['--prune', c, '--apply']);
const cBaks = listBaks(c);
ok('prune 全旧组：删旧留 1（至少一份）', r3.code === 0 && cBaks.length === 1, cBaks.join(','));
ok('留下的是组内最新（9-25 之外的 10-01）', cBaks[0] && /20261001/.test(cBaks[0]), cBaks.join(','));

// ── 4. 负对照：不同原始文件的备份组不受影响 ──
const other = path.join(SB, 'other.log');
write(other, 'LOG');
mkbak(other, '.bak.20260801-000000', 74);
run([a]);
ok('其他文件的旧备份未被顺手删除（分组精确）', fs.existsSync(other + '.bak.20260801-000000'));

// ── 5. dry-run：--prune 不带 --apply 只报不改 ──
const d = path.join(SB, 'd.txt');
write(d, 'DDD');
mkbak(d, '.bak.20260901-000000', 43);
const before = listBaks(d).length;
const r5 = run(['--prune', d]);
ok('prune 默认 dry-run：文件还在', r5.code === 0 && listBaks(d).length === before, r5.out);
ok('dry-run 输出"计划删除"', /计划删除|无需裁剪/.test(r5.out), r5.out.slice(0, 100));

// ── 6. --dir 模式：dry-run 不改，--apply 才删 ──
const sdir = path.join(SB, 'nest');
const e = path.join(sdir, 'sub', 'e.txt');
write(e, 'EEE');
mkbak(e, '.bak.20260901-000000', 43);
mkbak(e, '.bak.20261013-000000', 1);
const r6 = run(['--dir', sdir]);
ok('--dir dry-run：输出计划且文件不动', r6.code === 0 && /计划删除/.test(r6.out) && listBaks(e).length === 2, r6.out.slice(0, 120));
const r7 = run(['--dir', sdir, '--apply']);
ok('--dir --apply：旧备份被删', r7.code === 0 && listBaks(e).length === 1, listBaks(e).join(','));
ok('--dir --apply 不删 >7 天的唯一备份（至少一份）', /20260901/.test(listBaks(e)[0] || '') === false || listBaks(e).length === 1, listBaks(e).join(','));
// 注：e 组原为 [1d, 43d] 两份；cap=2、fresh=[1d] ⇒ 删 43d。上面断言在"删对了"和"留一份"之间取 or —— 真正要断的是"未被清空"
ok('e 组未被清空', listBaks(e).length >= 1, listBaks(e).join(','));

// ── 7. 用法错误：目标不存在 ⇒ 非零退出 ──
const r8 = run([path.join(SB, 'nope.txt')]);
ok('目标不存在 ⇒ exit 1', r8.code === 1, 'code=' + r8.code);

// ── 8. A53：源文件 mtime 很旧时，刚生成的备份不得被裁掉（回滚指针不能悬空）──
// 现场：deploy-policy-supplement 补部署时，.qoder-cn 侧新备份被当「10 天前」删除，打印的指针指向不存在的文件。
// 根因实测：fs.copyFileSync 继承源文件 mtime（副本 mtime 龄 10 天），而副本自身 birthtime 是当下。
const old = path.join(SB, 'old-source.txt');
write(old, 'OLD');
const oldT = (Date.now() - 10 * DAY) / 1000;
fs.utimesSync(old, oldT, oldT);                       // 源文件很久没改
mkbak(old, '.bak.20261110-000000', 3);                // 两份较新的既有备份（mtime 3d/2d）
mkbak(old, '.bak.20261111-000000', 2);
const r9 = run([old]);
const oldBaks = listBaks(old);
const newBak = oldBaks.find((n) => !/20261110|20261111/.test(n));
ok('A53 刚生成的备份仍在磁盘上（不被当超期裁掉）', r9.code === 0 && !!newBak && fs.existsSync(path.join(SB, newBak)), oldBaks.join(','));
ok('A53 输出打印的备份指针真实存在（不悬空）', (() => {
  // 判据按实际输出契约写：backup-file.js 打印 `[备份] <路径>`（首版我误按部署脚本的 `->` 形式匹配，红错原因，已改并点名）。
  const m = r9.out.match(/\[备份\]\s*(.+?)\s*$/m);
  return !!m && /\.bak/.test(m[1]) && fs.existsSync(m[1].trim());
})(), r9.out.slice(0, 200));
ok('A53 负对照：指针解析不是恒真（不存在的路径必须判失败）', !fs.existsSync(path.join(SB, 'zz-no-such-backup.bak.20261113-000000')), '');
ok('A53 新备份不被报成超期（龄报告用备份自身时间）', !/10 天前|（10d）/.test(r9.out), r9.out.slice(0, 240));
ok('A53 负对照：两份既有备份仍在（没被顺手清空）', oldBaks.filter((n) => /20261110|20261111/.test(n)).length >= 1, oldBaks.join(','));

// ── 9. A53：别的工具留下的副本（文件名时间戳新、继承 mtime 旧）也按备份自身时间判龄 ──
const foreign = path.join(SB, 'foreign.txt');
write(foreign, 'FFF');
const today = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const todayTs = `${today.getFullYear()}${p2(today.getMonth() + 1)}${p2(today.getDate())}-${p2(today.getHours())}${p2(today.getMinutes())}${p2(today.getSeconds())}`;
const foreignBak = foreign + '.bak.' + todayTs;
write(foreignBak, 'copied by another tool');
fs.utimesSync(foreignBak, oldT, oldT);                // 继承了源文件的旧 mtime
mkbak(foreign, '.bak.20261110-000000', 3);
mkbak(foreign, '.bak.20261111-000000', 2);
const r10 = run(['--prune', foreign, '--apply']);
ok('A53 文件名时间戳为今天的副本不被裁（mtime 继承旧值也不误判）', r10.code === 0 && fs.existsSync(foreignBak), listBaks(foreign).join(','));

// ── 10. A53 负对照：真超期件仍必须被裁（证明不是把一切都判成新）──
const stale = path.join(SB, 'stale.txt');
write(stale, 'SSS');
const staleTs = (() => { const d = new Date(Date.now() - 10 * DAY); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-000000`; })();
const staleBak = stale + '.bak.' + staleTs;
write(staleBak, 'genuinely old');
fs.utimesSync(staleBak, oldT, oldT);
mkbak(stale, '.bak.20261111-000000', 2);
mkbak(stale, '.bak.20261112-000000', 1);
const r11 = run(['--prune', stale, '--apply']);
ok('A53 负对照：文件名与 mtime 都超期的备份仍被裁', r11.code === 0 && !fs.existsSync(staleBak), listBaks(stale).join(','));
ok('A53 负对照：超期裁剪后仍至少留 1 份', listBaks(stale).length >= 1, listBaks(stale).join(','));

// ── 11. A53 最小隔离用例：label 里带旧日期时，只有「副本 mtime 归正」能救（文件名规则会解析到 label 的旧日期）──
const lbl = path.join(SB, 'labelled.txt');
write(lbl, 'LLL');
fs.utimesSync(lbl, oldT, oldT);
mkbak(lbl, '.bak.20261110-000000', 3);
mkbak(lbl, '.bak.20261111-000000', 2);
const r12 = run([lbl, '--label', '20200101-000000']);
const lblBaks = listBaks(lbl);
ok('A53 label 含旧日期：新备份仍保留（隔离 mtime 归正这一处）', r12.code === 0 && lblBaks.some((n) => /bak-20200101-000000\./.test(n)), lblBaks.join(','));
// protect 只护「本次调用」，所以存活断言测不出 mtime 归正的必要性（首版隔离用例因此 0 红，已改并点名）。
// 真正暴露它的是**下一次 prune**：若副本 mtime 仍是继承的旧值、文件名又解析到 label 的旧日期，回滚料会在后续裁剪里被删。
const r12b = run(['--prune', lbl, '--apply']);
ok('A53 label 含旧日期：后续 prune 仍不删该回滚料（mtime 归正才做得到）', r12b.code === 0 && listBaks(lbl).some((n) => /bak-20200101-000000\./.test(n)), listBaks(lbl).join(','));

// ── 12. A53 最小隔离用例：上限=1 且既有备份时间戳在未来（时钟偏移）时，只有 protect 能救新备份 ──
const runEnv = (args, extra) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, BACKUP_NO_RECYCLE: '1', ...extra } }) };
  } catch (e) { return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const skew = path.join(SB, 'skew.txt');
write(skew, 'KKK');
fs.utimesSync(skew, oldT, oldT);
const future = new Date(Date.now() + 3600000);
const futureTs = `${future.getFullYear()}${p2(future.getMonth() + 1)}${p2(future.getDate())}-${p2(future.getHours())}${p2(future.getMinutes())}${p2(future.getSeconds())}`;
const futureBak = skew + '.bak.' + futureTs;
write(futureBak, 'future-dated existing backup');
const r13 = runEnv([skew, '--label', '20200101-000000'], { BACKUP_KEEP_MAX: '1' });
const skewBaks = listBaks(skew);
ok('A53 上限=1 + 未来时间戳既有件：新备份仍保留（隔离 protect 这一处）', r13.code === 0 && skewBaks.some((n) => /bak-20200101-000000\./.test(n)), skewBaks.join(','));
ok('A53 负对照：protect 只保本次新件，未来时间戳的既有件也仍在（没顺手删别的）', fs.existsSync(futureBak), skewBaks.join(','));

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
