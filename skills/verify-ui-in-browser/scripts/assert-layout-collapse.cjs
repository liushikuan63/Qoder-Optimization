#!/usr/bin/env node
// 列表页布局塌陷判据（通用版）：主体列表区被压扁 / 分页条下方死白 / 分页条贴底 / 窄屏横向溢出超同类基线 / 错误态不可解释。
// 消费 harness-layout-probe.cjs 产出的量测 JSON。阈值全部可用参数覆盖；横向溢出必须来自**真实滚动容器**
// （组件库里 overflow-x:hidden 的外层恒为 0，量它＝假绿）。
// usage: assert-layout-collapse.cjs <measure.json> [--min-list 200] [--gap-min 8] [--gap-max 20] [--dead-max 40]
//        [--wide-px 1300] [--overflow-wide 0] [--overflow-narrow 200] [--max-alert 90] [--no-gate-check]
const fs = require('fs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: assert-layout-collapse.cjs <measure.json> [options]');
  process.exit(2);
}
const MIN_LIST = Number(arg('min-list', 200));
const GAP_MIN = Number(arg('gap-min', 8));
const GAP_MAX = Number(arg('gap-max', 20));
const DEAD_MAX = Number(arg('dead-max', 40));
const WIDE_PX = Number(arg('wide-px', 1300));
const OVER_WIDE = Number(arg('overflow-wide', 0));
const OVER_NARROW = Number(arg('overflow-narrow', 200));
const MAX_ALERT = Number(arg('max-alert', 90));
const NO_GATE = process.argv.includes('--no-gate-check');

let j = JSON.parse(fs.readFileSync(file, 'utf8'));
if (typeof j === 'string') j = JSON.parse(j);
const arr = Array.isArray(j) ? j : [j];

const R = { checks: [], fail: 0 };
const chk = (name, ok, detail) => { R.checks.push({ name, ok, detail }); if (!ok) R.fail++; };
const first = (...vals) => vals.find(v => v !== undefined && v !== null);

for (const m of arr) {
  const vp = m.viewport || {};
  const label = `${m.size || (vp.width + 'x' + vp.height)}${m.build ? '#' + m.build : ''}${m.rt ? '@' + m.rt : ''}`;
  if (m.timeout || m.noMain) {
    // 超时/缺主容器＝没有可信读数，判红而不是让下面的阈值各报一次「null 不达标」
    chk(`${label} pageLoadedMeasured`, false, m.timeout
      ? 'iframe 加载超时（dev 冷编译或慢接口）→ 无有效读数，预热后重测'
      : '未找到主容器 → 无有效读数');
    continue;
  }
  if (m.transitionStuck || m.transitionResidue) {
    chk(`${label} transitionSettled`, false, m.transitionStuck
      ? `清理后仍有 ${m.transitionStuck} 个过渡类残留（rAF 被节流）→ 高度/底边量的是过渡态，不是终态`
      : `残留 ${m.transitionResidue} 个过渡类且本轮未启用清理 → 高度/底边读数不可信`);
    continue;
  }
  chk(`${label} transitionSettled`, true, m.residueCleared
    ? `已清理 ${m.residueCleared} 个过渡类残留（host=${m.hostVisibility || '?'}）`
    : `无过渡类残留（host=${m.hostVisibility || '?'}）`);
  const list = first(m.listHeight, m.tableHeight), pane = first(m.paneHeight, m.panelHeight);
  const pagBottom = first(m.paginationBottom, m.pagerBottom), boxBottom = first(m.containerBottom, m.pageFillBottom);
  chk(`${label} listHeight>=${MIN_LIST}`, list != null && list >= MIN_LIST, `listHeight=${list}`);
  if (m.paneIsAncestor) {
    chk(`${label} paneHeight>=listHeight`, pane == null || list == null || pane >= list,
      `pane=${pane} list=${list}（pane 是 list 的祖先→面板不该比表格矮，否则表格被裁）`);
  } else {
    chk(`${label} paneHeight>=${MIN_LIST}`, pane == null || pane >= MIN_LIST,
      `pane=${pane}（paneSelector 不是 listSelector 的祖先，只能按下限判塌陷；要判裁切请指向外层面板）`);
  }
  const gap = boxBottom != null && pagBottom != null ? boxBottom - pagBottom : null;
  chk(`${label} paginationGutter ${GAP_MIN}..${GAP_MAX}`, gap != null && gap >= GAP_MIN && gap <= GAP_MAX,
    `gap=${gap} pag=${pagBottom} container=${boxBottom}（贴底＝${gap === 0 ? '贴边缺陷' : '见阈值'}，过大＝死白）`);
  chk(`${label} deadSpaceVsViewport<=${DEAD_MAX}`, pagBottom != null && vp.height != null && Math.abs(vp.height - pagBottom) <= DEAD_MAX,
    `dead=${pagBottom == null || vp.height == null ? 'n/a' : vp.height - pagBottom}`);
  const lim = (vp.width || 0) >= WIDE_PX ? OVER_WIDE : OVER_NARROW;
  chk(`${label} hOverflowPx<=${lim}`, typeof m.hOverflowPx === 'number' && m.hOverflowPx <= lim,
    `hOverflow=${m.hOverflowPx} container=${m.hOverflowContainer || '未标注（须为真实滚动容器）'}`);
  if (!NO_GATE) {
    const signals = (m.alertCount || 0) + (m.errorToastCount || 0);
    const explained = m.gateAlert === true || m.emptyTextSaysGate === true || m.errorExplained === true;
    // 判据语义（本轮实跑纠正）：只在「界面确有错误态信号」时要求可解释；真实空集显示空表是正确的
    chk(`${label} errorStateExplained`, signals === 0 ? true : explained,
      `alert=${m.alertCount} errorToast=${m.errorToastCount} explained=${explained} emptyText=${JSON.stringify(m.emptyText || '')}（有错误信号却不解释＝假绿；空表无信号不是缺陷）`);
    chk(`${label} alertCompact<=${MAX_ALERT}`, m.alertHeight == null || m.alertHeight <= MAX_ALERT, `alertHeight=${m.alertHeight}`);
  }
}

for (const c of R.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  (${c.detail})`);
const injected = arr.filter((m) => m.probeCssApplied).length;
if (injected) console.log(`!! ${injected} 条记录带 probeCssApplied（注入过的负对照轮）——这一轮的 PASS 不能作为交付证据`);
console.log(`\n${R.fail ? 'FAIL' : 'PASS'} ${R.checks.length - R.fail}/${R.checks.length} checks, ${arr.length} sample(s) -> ${file}`);
process.exit(R.fail ? 1 : 0);
