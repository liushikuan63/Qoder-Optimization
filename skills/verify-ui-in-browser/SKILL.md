---
name: verify-ui-in-browser
description: "前台真实运行验收：网页/客户端/小程序/小游戏/App 的改动必须真跑 + 实际截图并比对预期才算完成，只过单测/构建不算。网页：dev server + 真实浏览器完整路径（含负向用例）、browser-use、SPA fallback 用 content-type 对照；小程序/小游戏：微信开发者工具实际点击 + 截图；App：模拟器/真机 + 截图；客户端：窗口截图。触发：前端验收、UI 验证、打开界面、dev server、playwright。"
---

# 前台真实运行验收

## 概述

前台功能（网页 / 客户端 / 小程序 / 小游戏 / App）不能只靠单测和构建验收 —— 单测覆盖不到真实交互（大量能力门禁与条件渲染都会在真实运行时才暴露）。判据是：**真实运行 + 实际操作 + 截图取证**；网页额外要求「页面证据 + 后端证据」双重取证。

## 一、标准验收流程

1. 启动服务：后端与前端各自起好（示例：`yarn run start:community:hot`，127.0.0.1:8889）。
2. 用真实浏览器走**完整用户路径**，包含**负向用例**（无权限 / 未登录 / 边界输入）。
3. 双重取证：**页面快照 / 截图 + 后端任务事件 / 接口返回**，两者对照。
4. HTTP 判活用对照组：本环境 SPA fallback 会把任意编造路径答成 `200 text/html`，真实 API 回 `application/json` —— 必须用 **content-type / 特征串 / 错误码**区分，否则对照组永远 200，看不出问题。

## 二、browser-use 无可见视口时的处理

**首要排查（2026-10-16 用户口径 —— 先查这个，不要直接降级）**：`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（viewport=0x0 / visibilityState=hidden）的根因**大多是**：① **Qoder 侧边栏（内置浏览器所在面板）没打开**；② **当前会话不在主窗口**。
修法＝**操作电脑**：computer-use `list_windows` 找到 Qoder 主窗口 → `activate_window`（传完整对象 `{app,id,title}`，id 必须字符串）调到前台；需要时把会话切回主窗口并打开侧边栏。本机实测（2026-10-16 某项目 B05）：激活主窗口后 `take_screenshot` **立即恢复**。**不要先反复重试截图**。

以上已排除、确实拿不到视口时再走降级：

- 改用 `evaluate_script` 驱动页面：交互用**原生 setter + dispatchEvent** 触发 React onChange。
- 注意 `textarea` 与 `input` 的 setter 不同；`Illegal invocation` 通常是 prototype setter 用错，或对 `querySelectorAll` 返回的 NodeList 直接调方法。
- 点击开关、断言 DOM 文案与持久化状态都可以用脚本完成。
- 截图拿不到就明确说明"以 DOM 断言代替视觉检查"，**不要谎报看到了界面**。

## 三、视口尺寸限制

内嵌浏览器视口固定 **724×729**，`window.resizeTo` 与各工具均无法调整（browser-use 无 resize 工具，computer-use 的 `get_window` / `perform_secondary_action` 也不支持改窗口尺寸）。

- 窄屏媒体查询分支（如 ≤700px）**无法在真实视口实测**。
- 响应式改动要么用**注入 CSS 模拟桌面态测量**（可行），要么在总结里**显式标注"该断点未实测"**。

## 四、用户说"打开界面"时

- 用**系统默认浏览器**打开目标地址（Windows：`Start-Process <url>`），并**保持服务运行**，而不是只开一个自动化会话。
- 被门禁挡住入口的页面，把打开方式（如控制台片段）一并给用户。
- 这与"自动化验收"是两件事：自动化负责取证，打开界面负责让用户亲自复核，两件都要做。

## 五、非网页前台（小程序 / 小游戏 / App / 客户端）

- **小程序 / 小游戏**：微信开发者工具模拟器实际点击 + 截图；真机预览另算。
- **App**：模拟器或真机 + 截图。
- **桌面客户端**：真实启动窗口 + 截图；Windows 下用 CUA 点击/输入前先读 [references/windows-cua-guardrails.md](references/windows-cua-guardrails.md)（窗口内坐标、守卫拦截、React 受控输入、CEF 截图）。

网页之外的"前台"同样必须**真实运行 + 实际截图**，只过单测 / 构建不算完成。按平台选择手段：

- **小程序 / 小游戏**：调起**微信开发者工具**，在模拟器里实际点击走查并截图；涉及支付、相机、性能等真机相关能力时再走**预览 / 真机调试**。
  - 驱动方式：优先用开发者工具自带的 CLI / 自动化接口；否则用 computer-use MCP 对工具窗口 `launch_app` → `get_window_state` → `click` → 截图。
  - `miniprogram-ci` 的预览 / 上传只是产物交付，**不能替代**模拟器里的实际点击验证。
- **App（移动端）**：模拟器（Android emulator / iOS Simulator）或真机运行，`adb shell screencap` 等取截图；关键流程覆盖正反用例。
- **桌面客户端**：真实启动应用窗口，用窗口截图（computer-use `get_window_state`）取证，不能只看日志。

**共同要求**：

- 截图与预期**逐项比对**，差异要说明是"预期变化"还是"回归"。
- 工具不可用（未安装 / 无图形界面 / 需凭据）时：显式写"**未做视觉验证 + 原因**"，并给出用户可自行验证的最短路径（命令 / 入口），不得以"应该没问题"结案。

## 六、边界

- 启动服务、跑脚本、改代码等本地可逆动作自主推进。
- 端口被并发会话占用时换端口起自己的服务，**不要去杀别人的进程**。
- 视觉证据确实拿不到时，如实降级说明；可失败判据本身的设计原则见 `verify-before-claim`。

## 七、Playwright / Cypress 稳定性（写 E2E 时）

- **优先项目已装的框架**，能力缺失时先查已有工具；不为一个冒烟测试全局新装 agent-browser 或另一套测试框架。
- **语义定位器优先**：`role` / `label` / 稳定 `test id`，不用脆弱的层级或文本位置选择器。用自动等待的 locator / 断言，**按具体 UI 或请求结果等待**；不把固定 `sleep`、全站 `networkidle` 或反复重试当成通用修复。
- **等特定网络事件要在触发操作之前建立等待**，否则竞态（事件先到、监听后建）。
- **隔离数据与登录状态**；并行只在服务、账户与产物互不干扰时用。
- **不稳定失败保留初次失败与 trace / 截图**，查选择器、数据竞争、异步顺序与环境差异；重试后成功要**单独报告**，不隐藏原始失败。
- 真实 OAuth / 支付 / 邮件短信等需相应授权；**mock 或跳过 ≠ 真实流程通过**。Web 验证不替代 Tauri / Android / Cocos 等原生端验收。
- 来源：Codex `local-browser-e2e`（2026-10-11 并入，原技能已停用）。

## 八、深度技巧（SPA / API 捕获 / 组件交互）

需要"把站点操作固化成 API"，或与复杂 SPA（Vue / 组件库 / 图形画布）做深度交互时，见 `references/deep-browser-techniques.md`：XHR/fetch hook 全姿势（三个 prototype 方法同 patch；抓不到先自检 hook）、SPA 导航保 hook、点击策略阶梯（JS 事件 → 真实点击 → 绕 UI 直读路由）、Vue 组件访问与受控输入赋值、双击模拟、自动保存副作用意识。静态反查与对照实验方法论另见记忆 `tooling-frontend-api-archaeology`。
