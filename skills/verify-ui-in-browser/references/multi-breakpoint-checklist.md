# 多断点与溢出验收清单

配合 `responsive-craft` 技能使用；任何"响应式/自适应"改动都要按本清单取证，只截桌面一张不算完成。

## 一、视口矩阵

- 必测：**375 / 768 / 1024 / 1440**（手机 / 平板 / 小桌面 / 桌面）。
- 连续拖拽：**280 → 2560px** 缓慢拖动，抓命名断点之间的"in-between"失败（这是 AI 生成响应式最常见的翻车区）。
- 内嵌浏览器视口固定 724×729 时：用多 iframe 预览页（每个 iframe 按目标宽度渲染）或 headless Edge/CDP 指定 `--window-size`，不要用 `resizeTo`。

## 二、断言（每条都要能失败）

1. `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1` —— 无横向溢出。
2. 关键容器与首屏 CTA 的 `getBoundingClientRect().width > 0` 且未被裁切（对比 `clientWidth`）。
3. sticky 元素滚动 200px 后仍在视口内（读 `getComputedStyle().position` + rect.top）。
4. 表格在窄屏有明确策略（横向滚动容器 / 卡片化 / 隐藏非关键列），不能整页溢出。
5. 触控目标 ≥ 44×44px；输入框 `font-size ≥ 16px`（iOS 聚焦不缩放）。
6. `prefers-reduced-motion` 下动画降级；hover-only 交互在触屏有等价路径。

## 三、负对照（证明断言可失败）

准备一个故意坏页：固定 `width: 1200px` 的容器 + 不换行长标识符。
断言必须在该页**判红**；正例页通过才算有效。只跑正例出绿是假绿。

## 四、文本与紧凑组件

- 标题按自然换行，不依赖固定断词；长 URL / 标识符可安全换行。
- chip / tag 集合换行，或提供可操作的 `+n` 展开；截断必须有可访问的完整值路径。
- 徽标含义不能只靠颜色；交互 chip 需要原生语义、可见焦点与状态。
- 输入框 Enter 提交要跳过输入法 composition（`isComposing` / `compositionstart|end`），否则中文选词会误提交。

## 五、证据

- 每个断点一张截图 + 断言脚本输出（含负对照判红记录）。
- SPA 用真实路由打开；编造路径会被 fallback 成 200，必须用 content-type / 特征串对照。
- 拿不到某断点时写明"未实测 + 原因"，不得默认通过。
