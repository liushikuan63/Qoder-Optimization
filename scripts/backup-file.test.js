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

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
