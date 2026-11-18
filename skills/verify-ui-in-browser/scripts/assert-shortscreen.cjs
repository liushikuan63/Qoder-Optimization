#!/usr/bin/env node
/* 矮屏（低视口高度）布局断言（可失败）。消费同源 iframe harness 导出的测量 JSON：
 * {
 *   viewport: {width, height},
 *   page: {scrollWidth, clientWidth, scrollHeight, clientHeight},
 *   region: {selector, scrollable: bool, scrollHeight, clientHeight} | null,
 *   legitOverflow: null | "原因字符串（如：竖排搜索表单导致的合法纵向溢出）",
 *   keyControls: [{name, top, bottom}]   // 首屏关键操作（搜索/提交/主 CTA）的 rect
 * }
 * 判据（任一不满足即 EXIT 1）：
 *   1 无横向溢出：page.scrollWidth <= page.clientWidth + 1
 *   2 双滚动条缺陷：存在独立滚动区(region.scrollable)时，整页纵向溢出 > 8px 且未声明合法 → FAIL
 *   3 溢出声明义务：整页纵向溢出 > 8px 必须给 legitOverflow 原因，否则 FAIL
 *   4 首屏可操作性：每个 keyControl 的 top >= 0 且 bottom <= viewport.height + 1
 * 用法: node assert-shortscreen.cjs <measurements.json>
 * 负对照：双滚动条/首屏操作被挤出视口的测量必须 EXIT 1；只跑正例出绿是假绿。
 */
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node assert-shortscreen.cjs <measurements.json>');
  process.exit(2);
}
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const fails = [];
const pageOverflow = (m.page.scrollHeight - m.page.clientHeight) || 0;

if (m.page.scrollWidth > m.page.clientWidth + 1) {
  fails.push(`horizontal overflow: scrollWidth ${m.page.scrollWidth} > clientWidth ${m.page.clientWidth}`);
}
if (m.region && m.region.scrollable && pageOverflow > 8 && !m.legitOverflow) {
  fails.push(`double scrollbar: independent region "${m.region.selector}" scrolls AND page overflows ${pageOverflow}px without legit declaration`);
}
if (pageOverflow > 8 && !m.legitOverflow) {
  fails.push(`undeclared vertical overflow ${pageOverflow}px: set legitOverflow reason or fix layout`);
}
for (const c of m.keyControls || []) {
  if (c.top < 0 || c.bottom > m.viewport.height + 1) {
    fails.push(`key control "${c.name}" outside first screen: top=${c.top} bottom=${c.bottom} viewportH=${m.viewport.height}`);
  }
}
if (!(m.keyControls || []).length) {
  fails.push('no keyControls measured: first-screen operability unverified');
}

console.log(`viewport ${m.viewport.width}x${m.viewport.height} pageOverflow=${pageOverflow}px region=${m.region ? m.region.selector : 'none'} legit=${m.legitOverflow || 'none'}`);
if (fails.length) {
  console.log('FAIL: ' + fails.join('; '));
  process.exit(1);
}
console.log('PASS: no horizontal overflow, no undeclared/double scrollbar, all key controls within first screen');