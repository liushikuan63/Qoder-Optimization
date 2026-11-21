# 多断点与溢出验收清单

配合 `responsive-craft` 技能使用；任何"响应式/自适应"改动都要按本清单取证，只截桌面一张不算完成。

## 一、视口矩阵（宽度 × 高度，两个维度都要测）

- 必测宽度：**375 / 768 / 1024 / 1440**（手机 / 平板 / 小桌面 / 桌面）。
- 必测高度（矮屏族，2026-11-18 补）：**1366×768 / 1280×720**（存量笔记本主力）、**1920×1080**（桌面基线）、**内嵌浏览器实际视口**（如 825×785，以现场实测为准）。只测宽度会漏掉"矮桌面首屏挤爆 / 双滚动条"整族缺陷。
- 连续拖拽：**280 → 2560px** 缓慢拖动，抓命名断点之间的"in-between"失败（这是 AI 生成响应式最常见的翻车区）；高度方向同样从 600 → 1200 缓拖。
- 内嵌浏览器视口固定（如 724×729 / 825×785）时：用多 iframe 预览页（每个 iframe 按目标**宽×高**渲染）或 headless Edge/CDP 指定 `--window-size`，不要用 `resizeTo`。

### 同源 iframe harness（显式宽×高，固定视口下实测矮屏）

在目标站点页面内注入同源 iframe，显式给定 width 与 height，加载后测量 `contentDocument`，测完移除：

```js
const f = document.createElement('iframe');
f.id = 'probe-short';
f.src = location.pathname; // 同源真实路由
f.style.cssText = 'position:fixed;left:0;top:0;width:1366px;height:768px;'
  + 'transform:scale(0.42);transform-origin:0 0;z-index:99999;border:0;';
document.body.appendChild(f);
await new Promise(r => { f.onload = r; });
await new Promise(r => setTimeout(r, 3500)); // 等数据/图表渲染
const d = f.contentDocument, w = f.contentWindow;
const main = d.querySelector('main') || d.body;
const region = d.querySelector('.ant-table-body, [class*=scroll]'); // 独立滚动区按现场选
const measure = {
  viewport: { width: 1366, height: 768 },
  page: { scrollWidth: d.documentElement.scrollWidth, clientWidth: d.documentElement.clientWidth,
          scrollHeight: d.documentElement.scrollHeight, clientHeight: d.documentElement.clientHeight },
  region: region ? { selector: region.className, scrollable: region.scrollHeight > region.clientHeight + 1,
          scrollHeight: region.scrollHeight, clientHeight: region.clientHeight } : null,
  legitOverflow: null, // 合法溢出必须写原因，见下
  keyControls: [...d.querySelectorAll('button[type=submit], .ant-btn-primary, input[placeholder]')]
    .slice(0, 6).map(el => { const r = el.getBoundingClientRect();
      return { name: el.textContent.trim() || el.placeholder || el.className, top: r.top, bottom: r.bottom }; }),
};
console.log(JSON.stringify(measure)); // 导出喂 assert-shortscreen.cjs
f.remove();
```

注意：整页是否可滚要看**真实滚动容器**（如 `main.ant-layout-content`），不是只看 `document`；容器可滚而 document 不可滚时，把容器测量填进 `page`。

## 二、断言（每条都要能失败）

1. `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1` —— 无横向溢出。
2. 关键容器与首屏 CTA 的 `getBoundingClientRect().width > 0` 且未被裁切（对比 `clientWidth`）。
3. sticky 元素滚动 200px 后仍在视口内（读 `getComputedStyle().position` + rect.top）。
4. 表格在窄屏有明确策略（横向滚动容器 / 卡片化 / 隐藏非关键列），不能整页溢出。
5. 触控目标 ≥ 44×44px；输入框 `font-size ≥ 16px`（iOS 聚焦不缩放）。
6. `prefers-reduced-motion` 下动画降级；hover-only 交互在触屏有等价路径。
7. **矮屏首屏可操作性**（高度维度）：关键操作（搜索/提交/主 CTA）的 `rect.bottom <= viewport.height + 1`；被挤出首屏即缺陷，除非有明确的滚动引导且滚动区独立。
8. **双滚动条缺陷**：存在独立滚动区（表格 body / 面板）时，整页纵向溢出 > 8px 即缺陷——用户会看到两条嵌套滚动条；修法是给滚动区 `max-height` 约束或压缩首屏占用，而不是放任整页滚。
9. **合法溢出声明义务**：整页纵向溢出 > 8px 若确属合法（如窄屏竖排搜索表单），必须在测量 JSON 的 `legitOverflow` 写明原因并在汇报中说明；未声明的溢出一律判红。
10. **滚动条视觉语言**（主题化站点必查）：滚动条宽/轨色/thumb 色/hover 取自项目调色板，不留浏览器默认粗亮条；用像素断言取证，见下节。
11. **四向内缩（2026-11-21 补，实测能挡住的缺陷）**：文字与内容块距主容器左/右 ≥12px、上/下 ≥8px；分页条与主容器底边差 8–20px（=0 是贴边、>40 是死白）。用 `scripts/assert-edge-gutter.cjs` 判红绿，量测由 `scripts/harness-inset-probe.cjs` 产出。两档视口都要跑——贴边与视口宽度无关，只在一档出绿说明不了什么。
12. **横向溢出必须量真实滚动容器**：组件库常把 `overflow-x:hidden` 设在外层，其 `scrollWidth-clientWidth` 恒为 0（假绿）；要指到 `overflow-x:auto/scroll` 的内层，`harness-layout-probe.cjs` 会校验计算样式并在不符时记 `hOverflowUnusable`。
13. **覆盖率判据**：断言前声明应测路由清单（来自路由表本身，不手写省略），缺一个即判红；只测被点名的那一页就报「全站通过」是本项目踩过的误报形态。

## 二·五、滚动条像素断言（可失败，2026-11-18 补）

工具：`scripts/assert-scrollbar.py`（Pillow；解释器与库路径由运行环境提供）。

```bash
# 注意：bash 中 # 开头是注释，hex 参数必须加引号或用 = 连接
python scripts/assert-scrollbar.py shot.png "--thumb=#4a7ac0" "--track=#0b1c3a" --width 8 "--forbid=#3460a5,#0f234b"
```

判据：右缘 thumb 连续带宽 == 指定宽（默认 8px）；列内不得出现反例色；暗轨必须真实存在；thumb/track WCAG 对比度 ≥ 3:1。任一不满足 EXIT 1。
**负对照必做**：向页面 body 追加 `!important` 样式注入旧/反相调色板 → 截图 → 断言必须 EXIT 1 → 移除样式 → 复跑 EXIT 0。只跑正例出绿是假绿。
矮屏布局断言用 `scripts/assert-shortscreen.cjs <measurements.json>`（消费上文 harness 导出），判据 7–9 由其机器执行。

## 三、负对照（证明断言可失败）

准备一个故意坏页：固定 `width: 1200px` 的容器 + 不换行长标识符。
断言必须在该页**判红**；正例页通过才算有效。只跑正例出绿是假绿。
矮屏族负对照：固定高度容器 + 整页同时溢出的双滚动条页、关键 CTA 被挤出 768px 首屏的页、旧粗亮滚动条截图——`assert-shortscreen.cjs` / `assert-scrollbar.py` 对它们必须 EXIT 1。

## 四、文本与紧凑组件

- 标题按自然换行，不依赖固定断词；长 URL / 标识符可安全换行。
- chip / tag 集合换行，或提供可操作的 `+n` 展开；截断必须有可访问的完整值路径。
- 徽标含义不能只靠颜色；交互 chip 需要原生语义、可见焦点与状态。
- 输入框 Enter 提交要跳过输入法 composition（`isComposing` / `compositionstart|end`），否则中文选词会误提交。

## 五、证据

- 每个断点（含高度断点）一张截图 + 断言脚本输出（含负对照判红记录与退出码）。
- SPA 用真实路由打开；编造路径会被 fallback 成 200，必须用 content-type / 特征串对照。
- 拿不到某断点时写明"未实测 + 原因"，不得默认通过；浏览器工具不可用时，矮屏断言可用录得的测量 JSON 做 simulation 级自测，但必须标注"非本轮真实浏览器取证"。

## 六、headless 取证陷阱（2026-11-18 实测回写）

- **lazy iframe 在 headless 不加载**：`loading="lazy"` 的 iframe 在 headless Chrome 里 intersection 加载不触发，停留 about:blank（截图整框空白）；真实有视口浏览器正常。取证 harness 用 `Page.addScriptToEvaluateOnNewDocument` 源头忽略 iframe 的 `setAttribute('loading',…)`（改已存在 iframe 的属性不触发加载，必须在创建前拦截）。
- **serve-static 的 SSE 无限刷新_loop**：responsive-craft `serve-static.js` 连接即发 `data: connected`，注入脚本把任何 onmessage 当 reload 指令 → 页面/iframe 无限重载（iframe 截图抓到重置相、多 iframe 时渲染进程崩溃）。取证 harness 同页 stub `window.EventSource`；**serve 根目录不得放取证产物**（`fs.watch` recursive 会把每次落盘变成 reload 事件）。产品侧修复待单独批准。
- **headless 截图通道**：本机 Edge/Chrome `--dump-dom`/`--screenshot` CLI 走 launcher 代理（exit 0 无产物）；可用通道＝CDP `Page.captureScreenshot`，且**不要加 `--disable-gpu`**（多 iframe 页 raster 挂起/崩溃）；capture 前等 iframe `contentDocument` 内容就绪（轮询行数/特征节点），不等固定秒数。
- **像素交叉比对**：复合预览截图的 iframe 内容盒（rect 减 border、clientWidth/Height）与同尺寸单页真渲染截图同 bbox 裁剪比对，差≈0 为一致；负对照＝错位裁剪与均匀背景区 std；背景均匀的页面负对照阈值用「>1 且 >20×正例差」，不用固定绝对值。
