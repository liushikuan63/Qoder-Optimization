'use strict';
// one-off: measure the two-way skill gap + trigger collisions between CN and international skill sets
const fs = require('fs');
const path = require('path');
const HOME = (process.env.USERPROFILE || require('os').homedir()).replace(/\\/g, '/');
const CN = HOME + '/.qoder-cn/skills';
const Q = HOME + '/.qoder/skills';  // read-only scanner used by 技能门禁复盘
const dirs = (r) => fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
function descOf(md) {
  // 共用唯一解析真源：此前这里只解码 \" 与 \\，遇到 \n / \t / \uXXXX 会与生产者分歧。
  try { return require('./skill-description.cjs').parseDescription(md); } catch (e) { return ''; }
}
const cn = dirs(CN), q = dirs(Q);
const set = (a) => new Set(a);
const cns = set(cn), qs = set(q);
const cnOnly = cn.filter((n) => !qs.has(n));
const qOnly = q.filter((n) => !cns.has(n));
const both = cn.filter((n) => qs.has(n));
const info = {};
for (const n of [...cn, ...q]) {
  const root = cns.has(n) ? CN : Q;
  const p = path.join(root, n, 'SKILL.md');
  info[n] = { desc: fs.existsSync(p) ? descOf(fs.readFileSync(p, 'utf8')) : '' };
}
const sum = (names) => names.reduce((s, n) => s + info[n].desc.length + n.length + 4, 0);
console.log('CN=' + cn.length + ' INTL=' + q.length + ' 同名=' + both.length + ' CN独有=' + cnOnly.length + ' INTL独有=' + qOnly.length);
console.log('CN 侧当前每轮注入≈' + sum(cn) + ' 字符');
console.log('代价A 把 CN 独有 ' + cnOnly.length + ' 个复制到国际版 ⇒ 国际版每轮 +≈' + sum(cnOnly) + ' 字符（国际版现在≈' + sum(q) + '）');
console.log('代价B 把国际版独有 ' + qOnly.length + ' 个复制到 CN ⇒ CN 每轮 +≈' + sum(qOnly) + ' 字符（会到 ≈' + (sum(cn) + sum(qOnly)) + '）');
console.log('');

// trigger-collision predicate: shared discriminative tokens, and whether the pair cross-references by name
function tokens(s) {
  const t = new Set();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.+-]{3,}/g)) t.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[一-鿿]{2,4}/g)) t.add(m[0]);
  return t;
}
const tk = {};
for (const n of Object.keys(info)) tk[n] = tokens(info[n].desc);
const names = Object.keys(tk);
const pairs = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    let shared = 0;
    for (const t of tk[a]) if (tk[b].has(t)) shared++;
    if (shared < 12) continue;
    const jac = shared / Math.min(tk[a].size, tk[b].size);
    if (jac < 0.22) continue;
    const cross = info[b].desc.includes(a) || info[a].desc.includes(b) || info[b].desc.includes('Not for') || info[a].desc.includes('不用于') || info[a].desc.includes('改用') || info[b].desc.includes('改用') || info[a].desc.includes('见 ') || info[b].desc.includes('见 ');
    pairs.push({ a, b, shared, jac: +jac.toFixed(2), cross });
  }
}
pairs.sort((x, y) => y.jac - x.jac);
console.log('触发重叠对（共享区分性词 ≥12 且占小集合 ≥22%）=' + pairs.length + '，其中**已在 description 里互相指认**=' + pairs.filter((p) => p.cross).length + '，未指认=' + pairs.filter((p) => !p.cross).length);
console.log('--- TOP 12 重叠对 ---');
pairs.slice(0, 12).forEach((p) => console.log('  ' + p.jac + '  shared=' + p.shared + '  crossRef=' + (p.cross ? 'YES' : 'NO ') + '  ' + p.a + '  <->  ' + p.b));
console.log('--- 未互相指认的（这才是"调用会抢"的那批）---');
pairs.filter((p) => !p.cross).slice(0, 10).forEach((p) => console.log('  ' + p.jac + '  ' + p.a + ' <-> ' + p.b));
