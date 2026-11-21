/* 列表页布局量测 harness（通用版）：量「列表可视高度 / 外层面板高度 / 分页条底边 / 主容器底边 / 真实横向溢出」
 *
 * 两个入口，用途不同，别混：
 *  - probeSource(options) → **自包含**的零参 async 函数源码字符串，直接当 browser-use evaluate_script 的
 *    function 参数（路由、视口、选择器都已内联）。浏览器侧必须用它：toString() 序列化闭包会丢掉选项常量。
 *  - buildProbe(options) → Node 侧/单元测试用的同逻辑函数，签名 (rt, vw, vh)。
 * 输出 JSON 直接喂 scripts/assert-layout-collapse.cjs。
 *
 * 关键点（都是实测逼出来的）：
 *  1. 横向溢出必须量**真正会滚的容器**：组件库常把 overflow-x 设在外层（值 hidden），外层 scrollWidth-clientWidth
 *     恒为 0，量它就是假绿；要用 options.scrollSelector 指到 overflow-x:auto/scroll 的那一层。脚本会校验
 *     computedStyle 的 overflow-x，不是 auto/scroll 就把该容器记成 unusable，不产出 0 读数。
 *  2. 分页条底边与主容器底边的**差值**才区分「贴边」与「死白」：只看「分页条是否等于容器底」会把贴边当奖励。
 *  3. 与内缩 harness 同理，settle 后取第二次为准。
 *  4. 后台标签页（`visibilityState=hidden`）里 Vue 过渡类不会收尾，路由根节点停在 `position:absolute;
 *     height:100%;transform:translateX(20px)` 的过渡态——列表高度、分页条底边、容器底边全是错的（实测把
 *     「底边比视口低 15px」这类现象伪报成壳层缺陷）。默认 `clearTransitionResidue:true` 先归零动画并摘掉
 *     残留类，再量终态；摘完仍残留记 `transitionStuck`，由 assert-layout-collapse.cjs 判红。
 */

const DEFAULTS = {
  pathPrefix: '',
  mainSelector: '.app-main',
  listSelector: '.el-table',
  paneSelector: '.el-table__body-wrapper',
  paginationSelector: '.el-pagination',
  scrollSelector: '.el-table__body-wrapper .el-scrollbar__wrap',
  alertSelector: '.el-alert',
  errorToastSelector: '.el-message--error,.el-notification--error',
  emptyTextSelector: '.el-table__empty-text',
  settle: 1800,
  recheck: 700,
  loadTimeout: 9000,
  clearTransitionResidue: true,
  probeCss: '',
};

function normalize(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  if (!o.base) throw new Error('probe: base 必填');
  return o;
}

async function runLayoutProbe(o, rt, vw, vh) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // 坑 E（同 harness-inset-probe.cjs）：后台标签页 rAF 被节流 → Vue 过渡类不收尾，路由根节点带
  // position:absolute;height:100%;transform，量出来的 listHeight/底边全是过渡态而不是终态。
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
  const flags = { hostVisibility: null, residueCleared: 0 };
  const old = document.getElementById('lh');
  if (old) old.remove();
  const fr = document.createElement('iframe');
  fr.id = 'lh';
  fr.style.cssText = 'position:fixed;left:0;top:0;border:0;z-index:-1;opacity:0;pointer-events:none';
  fr.style.width = vw + 'px';
  fr.style.height = vh + 'px';
  document.body.appendChild(fr);

  const read = (doc, win) => {
    const am = doc.querySelector(o.mainSelector);
    if (!am) return null;
    const box = am.getBoundingClientRect();
    const h = (sel) => {
      const el = doc.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    const bottom = (sel) => {
      const el = doc.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().bottom) : null;
    };
    const rec = {
      rt, size: vw + 'x' + vh, viewport: { width: vw, height: vh },
      listHeight: h(o.listSelector), paneHeight: h(o.paneSelector),
      paginationBottom: bottom(o.paginationSelector), containerBottom: Math.round(box.bottom),
    };
    // 判「外层面板有没有裁掉表格」必须知道 pane 是不是 list 的祖先：`.el-table`（含表头）本来就比
    // `.el-table__body-wrapper`（只有 body）高，方向搞反就是恒红假判据（本轮实跑抓出来的）。
    const listEl = doc.querySelector(o.listSelector), paneEl = doc.querySelector(o.paneSelector);
    rec.paneIsAncestor = !!(listEl && paneEl && paneEl.contains(listEl));
    const sc = doc.querySelector(o.scrollSelector);
    if (sc) {
      const ovx = win.getComputedStyle(sc).overflowX;
      if (ovx === 'auto' || ovx === 'scroll') {
        rec.hOverflowPx = sc.scrollWidth - sc.clientWidth;
        rec.hOverflowContainer = o.scrollSelector;
      } else {
        rec.hOverflowUnusable = `${o.scrollSelector} overflow-x=${ovx}（不是真实滚动容器，改 scrollSelector）`;
      }
    } else {
      rec.hOverflowUnusable = `未找到 ${o.scrollSelector}`;
    }
    const al = doc.querySelector(o.alertSelector);
    if (al) {
      rec.gateAlert = true;
      rec.alertHeight = Math.round(al.getBoundingClientRect().height);
      rec.alertText = (al.textContent || '').trim().slice(0, 60);
    }
    // 只在「界面确有错误态信号」时要求可解释；真实空集显示空表是对的，不该被判红（禁合成兜底那条纪律）
    rec.alertCount = doc.querySelectorAll(o.alertSelector).length;
    rec.errorToastCount = doc.querySelectorAll(o.errorToastSelector).length;
    const et = doc.querySelector(o.emptyTextSelector);
    if (et) rec.emptyText = (et.textContent || '').trim().slice(0, 60);
    return rec;
  };

  const rec = await new Promise((res) => {
    let done = false;
    let timer = 0;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); res(v); };  // 坑 F：正常完成也要清定时器
    fr.onload = () => {
      (async () => {
        if (done) return;          // loadTimeout 已判过：迟到的读数不再写入，避免超时页伪装成有效数据
        const doc = fr.contentDocument, win = fr.contentWindow;
        flags.hostVisibility = doc.visibilityState;
        if (o.probeCss) {                       // 负对照专用：改坏样式，验证判据真的能抓红
          const s = doc.createElement('style');
          s.id = 'probe-css';
          s.textContent = o.probeCss;
          (doc.head || doc.documentElement).appendChild(s);
          flags.probeCssApplied = true;
        }
        if (o.clearTransitionResidue) {
          const cut = clearResidue(doc);
          await wait(120);
          const cut2 = clearResidue(doc);
          flags.residueCleared = cut.length + cut2.length;
          if (flags.residueCleared) flags.residueSample = cut.concat(cut2).slice(0, 3);
          const stuck = findResidue(doc);
          if (stuck.length) flags.transitionStuck = stuck.length;
        } else {
          const left = findResidue(doc);
          if (left.length) flags.transitionResidue = left.length;
        }
        await wait(o.settle);
        read(doc, win);                  // 第一次只为 settle 观察，不作数
        await wait(o.recheck);
        finish(Object.assign(read(doc, win) || { rt, noMain: true }, flags));
      })();
    };
    fr.src = o.base.replace(/\/$/, '') + o.pathPrefix + (rt === '/' ? '/' : rt);
    timer = setTimeout(() => finish(Object.assign({ rt, timeout: true }, flags)), o.loadTimeout);
  });
  fr.remove();
  return JSON.stringify(rec);
}

function buildProbe(options) {
  const o = normalize(options);
  return (rt, vw, vh) => runLayoutProbe(o, rt, vw, vh);
}

function probeSource(options) {
  const o = normalize(options);
  if (!o.rt || !o.vw || !o.vh) throw new Error('probeSource: 需要 rt、vw、vh（evaluate_script 不会传参）');
  return 'async () => (' + runLayoutProbe.toString() + ')(' + JSON.stringify(o) + ', ' +
    JSON.stringify(o.rt) + ', ' + o.vw + ', ' + o.vh + ')';
}

module.exports = { buildProbe, probeSource, runLayoutProbe, normalize };
