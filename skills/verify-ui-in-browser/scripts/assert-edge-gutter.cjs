#!/usr/bin/env node
// 四向内缩（gutter）判据：文字与内容块是否贴到主容器边缘。消费 harness-inset-probe.js 产出的量测 JSON。
// 阈值默认来自 16px 布局契约（左右 ≥12、上下 ≥8，含亚像素与滚动条误差），可用参数覆盖。
// 判据本身必须能失败：同一脚本喂「修复前/旧构建」量测应报红，喂「修复后」应通过。
// usage: assert-edge-gutter.cjs <measure.json> [--expect /a,/b,...] [--min-x 12] [--min-y 8] [--block-inset 1] [--no-coverage]
const fs = require('fs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: assert-edge-gutter.cjs <measure.json> [--expect r1,r2] [--min-x N] [--min-y N] [--block-inset N] [--no-coverage]');
  process.exit(2);
}
const MIN_X = Number(arg('min-x', 12));
const MIN_Y = Number(arg('min-y', 8));
const BLOCK_INSET = Number(arg('block-inset', 1));
const NO_COVERAGE = process.argv.includes('--no-coverage');

let j = JSON.parse(fs.readFileSync(file, 'utf8'));
if (typeof j === 'string') j = JSON.parse(j); // 兼容 evaluate_script 落盘的双编码
// 三种形态都要认：整批 {viewport,routes:[...]}、数组、单条路由对象（浏览器里只跑一个路由时的落盘形态）
const routes = Array.isArray(j) ? j : (j.routes || (j.rt ? [j] : []));
if (!routes.length) {
  console.error('FAIL 量测件里一条路由都没有：' + file + '（检查 harness 是否真的跑完、落盘的到底是量测 JSON 还是日志）');
  process.exit(1);
}
const EXPECT = arg('expect', '').split(',').filter(Boolean);
// Git Bash 会把以 / 开头的参数当路径转换（/,/source,… → D:/software/Git/…），覆盖率会假报缺失
if (EXPECT.some((p) => /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\'))) {
  console.error('FAIL --expect 被 shell 改写成 Windows 路径了：先 `export MSYS2_ARG_CONV_EXCL="*"` 再重跑（细则见 references/edge-gutter-layout-checklist.md）');
  process.exit(2);
}

const R = { checks: [], fail: 0 };
const chk = (name, ok, detail) => { R.checks.push({ name, ok, detail }); if (!ok) R.fail++; };

if (!NO_COVERAGE) {
  if (!EXPECT.length) {
    chk('coverage:routes-declared', false, '用 --expect r1,r2,... 声明应覆盖的路由；不检查覆盖率请加 --no-coverage');
  } else {
    const seen = new Set(routes.map(r => r.rt));
    chk(`coverage:${EXPECT.length} route(s) measured`, EXPECT.every(p => seen.has(p)),
      `missing=${EXPECT.filter(p => !seen.has(p)).join(',') || 'none'} extra=${[...seen].filter(p => !EXPECT.includes(p)).join(',') || 'none'}`);
  }
}

for (const m of routes) {
  const t = m.tx || {};
  if (m.timeout || m.noAppMain) {
    // 超时/缺主容器的记录没有可信读数，必须判红——不能让它悄悄走进后面的阈值检查
    chk(`${m.rt} pageLoadedMeasured`, false, m.timeout
      ? `iframe 未在 ${m.loadTimeoutMs || '?'}ms 内加载完成（dev 冷编译或慢接口）→ 该路由无有效读数，预热后重测`
      : `未找到主容器（${m.rt}）→ 该路由无有效读数`);
    continue;
  }
  if (m.transitionStuck) {
    chk(`${m.rt} transitionSettled`, false,
      `清理后仍有 ${m.transitionStuck} 个过渡类残留（rAF 被节流）→ 整列几何带 transform，读数不可信：把标签页切前台复测，或按壳层缺陷立项`);
    continue;
  }
  if (m.transitionResidue) {
    chk(`${m.rt} transitionSettled`, false,
      `页面残留 ${m.transitionResidue} 个过渡类且本轮未启用清理 → 右/底轴会系统性偏移（实测 20px）`);
    continue;
  }
  chk(`${m.rt} transitionSettled`, true, m.residueCleared
    ? `已清理 ${m.residueCleared} 个过渡类残留（host=${m.hostVisibility || '?'}，样例 ${JSON.stringify((m.residueSample || []).slice(0, 2))}）`
    : `无过渡类残留（host=${m.hostVisibility || '?'}）`);
  if (!m.tn) {
    chk(`${m.rt} textSampled`, false, `tn=${m.tn}（没取到可见文本＝判据失效，不是通过）`);
    continue;
  }
  chk(`${m.rt} textInsetLeft>=${MIN_X}`, t.L >= MIN_X, `L=${t.L} @「${m.wl || ''}」`);
  chk(`${m.rt} textInsetRight>=${MIN_X}`, t.R >= MIN_X, `R=${t.R} @「${m.wr || ''}」`);
  chk(`${m.rt} textInsetTop>=${MIN_Y}`, t.T >= MIN_Y, `T=${t.T}`);
  chk(`${m.rt} textInsetBottom>=${MIN_Y}`, t.B >= MIN_Y, `B=${t.B}`);
  chk(`${m.rt} noFlushBlock`, (m.bh || []).length === 0,
    (m.bh || []).join(' / ') || `bn=${m.bn} L=${(m.bx || {}).L} R=${(m.bx || {}).R}`);
  if (m.unstable) chk(`${m.rt} measurementStable`, false, `两次量测差 >2px：first=${JSON.stringify(m.unstable.first)} second=${JSON.stringify(m.unstable.second)}`);
}

for (const c of R.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  (${c.detail})`);
const injected = routes.filter((m) => m.probeCssApplied).length;
if (injected) console.log(`!! ${injected} 条记录带 probeCssApplied（注入过的负对照轮）——这一轮的 PASS 不能作为交付证据`);
console.log(`\n${R.fail ? 'FAIL' : 'PASS'} ${R.checks.length - R.fail}/${R.checks.length} checks, ${routes.length} route(s), viewport=${j.viewport || 'n/a'}, blockInsetFloor=${BLOCK_INSET} -> ${file}`);
process.exit(R.fail ? 1 : 0);
