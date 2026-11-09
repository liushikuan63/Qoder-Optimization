---
name: umi3-to-umi4-upgrade
description: "umi3 → umi4 / webpack5 升级后的回归排查与恢复：document.ejs 被静默取消（headScripts/links 恢复、#root 注入与 loading 约定）、深色主题样式回归（elementsFromPoint 归因、CSS module hash）、产物/全局变量/无头浏览器三层验证；含 mv 改名备份与字节断言。触发词：umi4 升级、document.ejs 失效、umi 样式回归、升级后白块、loading 不显示、headScripts、CSS module hash、webpack5 迁移；不用于：部署后用户端未生效、一般构建报错。"
---

# umi3 → umi4 升级回归

## 0. 先确认是不是同一类问题

升级后 build 通过但页面异常，优先查这三类（本机实测全部踩过）：

1. 模板消失：`dist/index.html` 里没有原 `document.ejs` 的特征串。
2. 样式丢失/白块：入口 CSS 顺序变化、antd 样式被拆进异步 chunk、CSS module hash 规则失效。
3. loading/全局脚本缺失：模板里的内联脚本、全局变量、loading 占位不再生效。

## 1. document.ejs 被静默取消

umi4 不再支持 `document.ejs`，且 build **零报错**。恢复方式：

1. **先取证**：`grep -n "umi_locale_url_applied\|<你的模板特征串>" dist/index.html`，确认模板确实没进产物。
2. **在 `.umirc.ts` 用 `headScripts` / `links` 重建**：
   - 内联脚本必须排在 bundle 之前；`headScripts` 里的内联脚本加 `defer` 对内联无效，别指望它延后。
   - 全局 config 脚本保持同步加载与原顺序。
3. **body 内容动态注入**：用 `headScripts` 里的 JS 轮询 `getElementById('root')`，出现后再注入；**不要用 `DOMContentLoaded`**——它会等 umi.js 执行完，慢网络下 loading 不显示。React 渲染后用 `MutationObserver` 移除占位并加超时兜底。
4. **页 chunk 懒加载期**用官方约定 `src/loading.tsx`。

验证：产物 grep 命中模板特征串 + `window.<全局量>`（如 `SVGEDITOR`）早于界面可用 + 无头浏览器节流后的 E2E 能看到 loading 与最终界面。

## 2. 深色主题样式回归

1. **定位白块**：`document.elementsFromPoint(x, y)` 逐点取层，按 body / layout 容器 / 具体组件分层归因，别靠截图猜。
2. **三类已实证根因**：
   - 入口 import 顺序反转（umi.css 与主题样式先后颠倒）。
   - antd 样式散落在异步 chunk（如 `layouts__index.*.chunk.css`），不在入口 `umi.css`。
   - CSS module hash 规则失效：旧构建产物里的 `xxx___hash` 类名硬编码在样式或组件里，升级后对不上。
3. **修复顺序**：源头改色 → 删掉依赖旧 hash 的死规则 → `html, body` 兜底背景色。
4. **产物断言要抗 minify**：`#000033` 会被压成 `#003`，按原色值 grep 会 0 命中；断言前先确认压缩后的实际形态。
5. 部署用 `mv` 改名做备份（`risky-match-guard` 会拦 `rm -rf`，别硬来），然后跑无头浏览器注入 token 做生产复验。

## 3. 三层验证（缺一不算修好）

1. **产物层**：`dist/index.html` 特征串、`window` 全局量、CSS 关键色/类名。
2. **运行时层**：无头浏览器（视口不可用时用 playwright `addInitScript` 注入登录态）走完整路径。
3. **节流层**：限速/慢网下确认 loading、首屏与懒加载 chunk 都正常。

## 常见坑

| 现象 | 原因 |
|---|---|
| build 成功但模板没了 | umi4 取消 document.ejs（官方 issue 确认无模板支持） |
| 内联脚本不按预期延后 | `defer` 对内联脚本无效 |
| loading 永远不显示 | 用 DOMContentLoaded 注入，等待 umi.js |
| 白块定位不准 | 只截图不用 elementsFromPoint |
| 色值断言 0 命中 | minify 改写（`#000033`→`#003`） |
| 样式在入口找不到 | antd/布局样式被拆进异步 chunk |
| 旧类名突然失效 | CSS module hash 规则变化，旧 hash 硬编码 |

## 相关

- 部署后用户端仍跑旧代码：`user-side-deploy-verify`
- 构建产物部署自验：`frontend-hash-deploy-verify`
