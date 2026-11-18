---
name: spa-loading-hang-triage
description: Web SPA「加载慢/持续转圈」的取证与修复：按入口缓存、路由分包 404、请求悬挂/超时、页面 loading 复位四条链路定位；用主包 404、瞬时分包 404、持续分包 404、接口悬挂、HTTP 203 五类故障注入验收；修复模板含 index no-store、启动看门狗、分包重试浮层、请求超时、首屏兜底与轮询防叠加。触发词：SPA 转圈、无限加载、白屏、分包 404、chunk 加载失败、请求悬挂、203 误跳登录。不用于 Electron 客户端转圈。
---

# Web SPA 加载卡死诊断

## 适用

- Web SPA 打开后一直转圈/白屏/加载慢，或首屏有时成功有时失败。
- 不适用于：Electron 客户端转圈（→ `electron-app-stuck-spinner-triage`）、静态资源断链取证（→ `static-asset-breakage-triage`）、无头截图方法（→ `headless-spa-screenshot`）。

## 0. 先建真实浏览器基线

- 用真实浏览器（含 SSO 登录）走完整路径，记录 console、network、页面可见状态；`curl` 200 不算基线。
- 分别测：首次打开、刷新、路由切换、弱网/缓存命中。记录失败发生在哪一步。
- 等待判据要能失败：等网络静默 + 断言行数/关键 DOM，不以「等空表/等 svg」代替。

## 1. 四条链路取证

1. **入口缓存**：`index.html` 是否 `Cache-Control: no-store`；有几个入口（主入口/子应用）都要查；Service Worker 是否缓存旧壳。
2. **路由分包 404**：抓失败 chunk 的 URL 与 base path；确认部署后旧 chunk 是否保留；是否有重试浮层与可见错误。
3. **请求悬挂/超时**：请求层是否配置 timeout；超时是否真的进入错误分支；轮询是否叠加。
4. **loading 复位**：请求失败/路由失败时全局 loading 是否复位；首屏是否有兜底。

## 2. 启动看门狗

- 主包本身 404 时，`global.tsx` 里的看门狗来不及执行——必须把兜底内联进 `index.html`。
- 首屏兜底建议 15s：显示可见的重试按钮与错误提示，浅色背景下保证对比度。
- 请求层建议 30s 超时；超时必须走错误分支，不能静默变成空数据。

## 3. 请求层语义

- `HTTP 203` 属于 2xx，不是鉴权失败；不要据此跳登录。网关返回 203 可能是常态。
- `umi-request` 的 `errorHandler` 若返回 `undefined`，会把超时/reject 变成 resolve，页面误显示无数据；必须 `throw` 或返回 rejected Promise。
- 轮询定时器在组件卸载/路由切换时清理，防止叠加请求。

## 4. 故障注入矩阵（真实浏览器）

| 注入 | 期望 |
|---|---|
| 主包 404 | 内联看门狗生效，显示重试，不无限转圈 |
| 瞬时分包 404（一次后恢复） | 自动重试成功或可见重试浮层 |
| 持续分包 404 | 可见错误 + 重试，不白屏 |
| 接口悬挂 | 30s 超时进入错误分支，loading 复位 |
| HTTP 203 | 正常处理，不跳登录 |

每条注入都配负对照：不注入时必须正常加载。

## 5. 修复模板

- 两个入口都加 `Cache-Control: no-store`。
- `index.html` 内联启动看门狗 + 首屏兜底（15s）+ 重试按钮。
- 路由分包失败：重试 + 可见浮层；增量部署保留旧 chunk 至少一个发布周期。
- 请求层：30s timeout；`errorHandler` 显式 reject；203 不当鉴权失败。
- 全局 loading 在失败路径复位；轮询防叠加。

## 6. 可失败验收

- 正对照：正常网络首屏在预算内出现关键 DOM；五类注入分别得到期望结果。
- 负对照：不注入时必须成功；坏 chunk URL 必须出现重试而不是白屏；203 不得触发登录跳转。
- 截图：真实浏览器截图（静态截图可借 `headless-spa-screenshot`），并核对 console 无未处理错误。
- 部署后复验：从用户入口重新加载，确认加载的是新版本（入口 no-store、chunk hash）。

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 一直转圈但接口 200 | 主包/分包 404，或 loading 未复位 |
| 主包失败时兜底也不执行 | 看门狗在 global.tsx；内联进 index.html |
| 超时后显示无数据 | errorHandler 返回 undefined 被当 resolve；显式 reject |
| 203 后跳登录 | 把 2xx 当鉴权失败；按 203 正常处理 |
| 刷新好、路由切换卡 | 分包加载失败或轮询叠加；查 network 与定时器 |
| 部署后仍加载旧页 | 入口未 no-store；旧 chunk 未保留/未清缓存 |
| 等待判据假绿 | 等空表/等 svg；改为网络静默 + 行数断言 |

## 技术栈参考

umi-request / antd / 双入口的具体写法与实测坑见 `references/umi-antd-spa.md`。
