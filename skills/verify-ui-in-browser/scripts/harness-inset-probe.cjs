/* 四向内缩量测 harness（通用版；由真实前端验收实测校准而来，不是凭空调）
 *
 * 两个入口，用途不同，别混：
 *  - probeSource(options) → 一段**自包含**的 async 函数源码字符串，直接当 browser-use evaluate_script 的
 *    function 参数（或 page.evaluate）。浏览器侧必须用它：Function.prototype.toString() 拿不到闭包里的
 *    选项常量，把 buildProbe 的返回值序列化进浏览器会得到一份引用未定义变量的废码。
 *  - buildProbe(options) → Node 侧/单元测试用的同逻辑函数（签名同样 (vw, vh)）。
 * 负对照：`options.probeCss` 传一段 CSS，harness 把它注入被测 iframe（记录 `probeCssApplied`），用来证明
 * 同一条判据在样式被改坏时确实变红；带该标记的量测件**不得**当交付证据（判据脚本会在摘要里点名）。
 * 每批路由数按「settle+recheck+最坏 loadTimeout」预算，别超单次浏览器调用的墙钟上限（browser-use 约 15s）：
 *  warmed 页面每路由 ≈2.5s 可 3–4 个；冷编译 dev server 每批 1–2 个。输出 JSON 直接喂 scripts/assert-edge-gutter.cjs。
 *
 * 三个必踩过的坑，已写进实现，改选择器时不要退回旧写法：
 *  A. 文本轴排除必须用 e.closest(EXCL)，不能用「父元素自身 className 命中」——表格列头文本的父节点是
 *     <span>/<div class="is-left">，不含表格类名，旧写法会把表头算进文本轴，量出「贴边」假报。
 *  B. 内容块轴要求块**水平完整落在主容器内**才计数——主容器若带内部滚动条，卡片会比 right 多出滚动条宽度，
 *     旧写法把这段伪报成贴边命中。横向溢出本身由 assert-layout-collapse.cjs 的 hOverflowPx 规则单独管。
 *  C. 量测必须 settle 后取**第二次**为准：异步数据/图表落地前后的框不同，首测会假报；两次差 >2px 记
 *     unstable 供复核，不做「多测一次取平均」。
 *  D. `loadTimeout` 到点后**不允许迟到补测**（真实浏览器跑出来的缺陷）：dev server 冷编译某个路由块可占 4s+，
 *     iframe onload 常在超时之后才触发；若仍往同一条记录里写读数，「超时页」就伪装成有效数据、判据照样能全绿。
 *     现在超时即冻结该条记录（只留 `timeout`/`loadTimeoutMs`），由 assert-edge-gutter.cjs 判红。跑冷 dev
 *     时按此预算减少每批路由数（browser-use 单次调用约 15s 上限），或先逐个访问预热一遍再量。
 *  E. 后台标签页（`visibilityState=hidden`）里 rAF 被节流，Vue `<transition>` 的收尾回调不执行，
 *     `*-enter-from` / `*-enter-active` 这类过渡类**永久残留**在路由根节点上。实测后果是整列内容带
 *     `transform: translateX(20px)` 且 `position:absolute;width:100%`：所有右轴读数系统性少 20px、
 *     底边比视口低一截——同一页面会在「PASS / FAIL」之间随机切换，还会把量测伪影误报成壳层缺陷。
 *     默认 `clearTransitionResidue:true`：注入 `transition/animation:none` 并摘掉残留过渡类，取**终态**几何；
 *     摘完仍有残留则记 `transitionStuck` 由判据脚本判红。`residueCleared`/`hostVisibility` 会写进量测件备查。
 *  F. 路由正常量完后**必须清掉 loadTimeout 定时器**（同样是真实浏览器跑出来的）：定时器不清会把
 *     `timeout:true` 盖到已经量完的记录上——数据是好的却被判红，而判红理由与真实原因（冷编译）无关，
 *     排查会被带到「页面加载慢」上去。现在 `finish()` 里 `clearTimeout(timer)`。
 */

const DEFAULTS = {
  pathPrefix: '',
  mainSelector: '.app-main',
  excludeSelector: '.el-table,.el-menu,.el-scrollbar__bar,.el-drawer,.el-dialog,.el-popper',
  blockSelector: '.el-card,.el-alert,.el-tabs,.filter-form',
  readySelector: '.el-table__row,.el-card,.el-form-item,.el-descriptions__label',
  settle: 1800,
  recheck: 700,
  loadTimeout: 9000,
  clearTransitionResidue: true,
  probeCss: '',
  routes: [],
};

function normalize(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  if (!o.base) throw new Error('probe: base 必填');
  if (!o.routes || !o.routes.length) throw new Error('probe: routes 必填');
  return o;
}

async function runInsetProbe(o, vw, vh) {
  const old = document.getElementById('gh');
  if (old) old.remove();
  const fr = document.createElement('iframe');
  fr.id = 'gh';
  fr.style.cssText = 'position:fixed;left:0;top:0;border:0;z-index:-1;opacity:0;pointer-events:none';
  fr.style.width = vw + 'px';
  fr.style.height = vh + 'px';
  document.body.appendChild(fr);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // 坑 E：后台标签页里过渡类不会收尾，先归零动画再摘残留类，量**终态**几何（判据要可复现）
  const RESIDUE = /-(?:enter|leave)(?:-from|-to|-active)?$/;
  const findResidue = (doc) => {
    const hits = [];
    for (const el of Array.from(doc.querySelectorAll('[class]'))) {
      const toks = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      const cut = toks.filter((c) => RESIDUE.test(c));
      if (cut.length) hits.push({ el, cut });
    }
    return hits;
  };
  const clearResidue = (doc) => {
    if (!doc.getElementById('probe-anim-off')) {
      const s = doc.createElement('style');
      s.id = 'probe-anim-off';
      s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      (doc.head || doc.documentElement).appendChild(s);
    }
    const hits = findResidue(doc);
    const names = [];
    for (const h of hits) {
      const keep = String(h.el.getAttribute('class') || '').split(/\s+/).filter((c) => c && !RESIDUE.test(c));
      if (keep.length) h.el.setAttribute('class', keep.join(' ')); else h.el.removeAttribute('class');
      names.push(h.el.tagName.toLowerCase() + ':' + h.cut.join('+'));
    }
    return names;
  };

  const measure = (doc, win) => {
    const am = doc.querySelector(o.mainSelector);
    if (!am) return null;
    const ab = am.getBoundingClientRect();
    const res = { tn: 0, tx: { L: null, R: null, T: null, B: null }, wl: '', wr: '', bn: 0, bx: { L: null, R: null }, bh: [] };
    const w = doc.createTreeWalker(am, 4);
    let n;
    while ((n = w.nextNode())) {
      const e = n.parentElement;
      if (!e || e.closest(o.excludeSelector) || !(n.textContent || '').trim()) continue;          // 坑 A
      const rg = doc.createRange();
      rg.selectNodeContents(e);
      for (const b of Array.from(rg.getClientRects())) {
        if (b.width < 2 || b.height < 2) continue;
        if (b.left < ab.left - 1 || b.right > ab.right + 1 || b.top < ab.top - 1 || b.bottom > ab.bottom + 1) continue;
        res.tn++;
        const L = Math.round((b.left - ab.left) * 10) / 10, R = Math.round((ab.right - b.right) * 10) / 10;
        const T = Math.round((b.top - ab.top) * 10) / 10, B = Math.round((ab.bottom - b.bottom) * 10) / 10;
        if (res.tx.L === null || L < res.tx.L) { res.tx.L = L; res.wl = (e.textContent || '').trim().slice(0, 18); }
        if (res.tx.R === null || R < res.tx.R) { res.tx.R = R; res.wr = (e.textContent || '').trim().slice(0, 18); }
        if (res.tx.T === null || T < res.tx.T) res.tx.T = T;
        if (res.tx.B === null || B < res.tx.B) res.tx.B = B;
      }
    }
    for (const el of Array.from(am.querySelectorAll(o.blockSelector))) {
      const cs = win.getComputedStyle(el);
      if (parseFloat(cs.paddingLeft) >= 12 || parseFloat(cs.paddingRight) >= 12) continue; // 靠 padding 内缩的块不算贴边
      const b = el.getBoundingClientRect();
      if (b.width < 40 || b.bottom < ab.top || b.top > ab.bottom) continue;
      if (b.left < ab.left - 1 || b.right > ab.right + 1) continue;                          // 坑 B
      res.bn++;
      const L = Math.round(b.left - ab.left), R = Math.round(ab.right - b.right);
      res.bx.L = res.bx.L === null ? L : Math.min(res.bx.L, L);
      res.bx.R = res.bx.R === null ? R : Math.min(res.bx.R, R);
      if (L <= 1) res.bh.push((el.className || '').split(' ')[0] + ' L' + L);
      else if (R <= 1) res.bh.push((el.className || '').split(' ')[0] + ' R' + R);
    }
    return res;
  };

  const url = (rt) => o.base.replace(/\/$/, '') + o.pathPrefix + (rt === '/' ? '/' : rt);
  const out = [];
  for (const rt of o.routes) {
    const rec = { rt };
    await new Promise((res) => {
      let done = false;
      let timer = 0;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); res(v); };
      fr.onload = () => {
        (async () => {
          if (done) return;          // 坑 D：loadTimeout 已判过就别再补测——迟到的读数会伪装成有效数据
          const doc = fr.contentDocument, win = fr.contentWindow;
          for (let i = 0; i < 12; i++) {
            const am = doc.querySelector(o.mainSelector);
            const ready = am && doc.querySelectorAll(o.readySelector).length > 0;
            if (ready) break;
            await wait(250);
          }
          if (done) return;
          rec.hostVisibility = doc.visibilityState;                    // 坑 E：hidden 页 rAF 被节流，过渡类不会收尾
          if (o.probeCss) {                                            // 负对照专用：改坏样式，验证判据真的能抓红
            const s = doc.createElement('style');
            s.id = 'probe-css';
            s.textContent = o.probeCss;
            (doc.head || doc.documentElement).appendChild(s);
            rec.probeCssApplied = true;
          }
          if (o.clearTransitionResidue) {
            const cut = clearResidue(doc);
            await wait(120);
            const cut2 = clearResidue(doc);
            rec.residueCleared = cut.length + cut2.length;
            if (rec.residueCleared) rec.residueSample = cut.concat(cut2).slice(0, 3);
            const stuck = findResidue(doc);
            if (stuck.length) rec.transitionStuck = stuck.length;
          } else {
            const left = findResidue(doc);
            if (left.length) rec.transitionResidue = left.length;
          }
          await wait(o.settle);                        // 坑 C
          const m1 = measure(doc, win);
          await wait(o.recheck);
          if (done) return;
          const m2 = measure(doc, win);
          if (!m2) rec.noAppMain = true;
          else {
            Object.assign(rec, m2);
            const d = (a, b) => (a === null || b === null) ? 0 : Math.abs(a - b);
            const unstable = (m1 && ['L', 'R', 'T', 'B'].some(k => d(m1.tx[k], m2.tx[k]) > 2)) ||
              (m1 && m1.bh.length !== m2.bh.length);
            if (unstable) rec.unstable = { first: m1 && m1.tx, second: m2.tx, bh1: m1 && m1.bh, bh2: m2 && m2.bh };
          }
          finish();
        })();
      };
      fr.src = url(rt);
      timer = setTimeout(() => { rec.timeout = true; rec.loadTimeoutMs = o.loadTimeout; finish(); }, o.loadTimeout);
    });
    out.push(rec);
  }
  fr.remove();
  return JSON.stringify({ viewport: vw + 'x' + vh, routes: out });
}

function buildProbe(options) {
  const o = normalize(options);
  return (vw, vh) => runInsetProbe(o, vw, vh);
}

function probeSource(options) {
  const o = normalize(options);
  if (!o.vw || !o.vh) throw new Error('probeSource: 需要 vw 与 vh（evaluate_script 不会传参）');
  return 'async () => (' + runInsetProbe.toString() + ')(' + JSON.stringify(o) + ', ' + o.vw + ', ' + o.vh + ')';
}

module.exports = { buildProbe, probeSource, runInsetProbe, normalize };
