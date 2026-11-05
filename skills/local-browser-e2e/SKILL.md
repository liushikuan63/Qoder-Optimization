---
name: local-browser-e2e
description: 补充网页关键路径的浏览器验收与 Playwright 稳定测试；用于真实交互、受影响页面或 E2E 缺陷，不用于纯后端改动。
license: MIT
metadata:
  origin: local-adaptation
---

# 本地浏览器端到端验证

先从本次改动和实际路由确定页面、用户路径与验收条件，包含属于本任务的已暂存/未暂存修改，不默认 main 为基线。确认 dev server、URL、端口和产物属于目标 checkout；启动服务沿现有项目脚本。

## 工具与测试
- 优先现有浏览器控制能力或项目已安装的 Playwright/Cypress。能力缺失时查已有工具；不为一个冒烟测试全局安装 agent-browser 或另一套测试框架。无法驱动浏览器时，保留可做的静态/服务验证并明确 UI 未验证。
- 已有 Playwright 测试优先用语义 role、label 或稳定 test id 定位。采用自动等待的 locator/断言，按具体 UI 或请求结果等待；不把固定 sleep、全站 networkidle 或反复重试当作通用修复。
- 等待特定网络事件时在触发操作之前建立等待，避免竞态。测试隔离数据与登录状态；并行只在服务、账户和生成物互不干扰时使用。
- 关键路径覆盖输入、提交、可见结果和失败反馈，同时检查控制台及相关请求。布局改动需实际截图与适当视口；截图本身不能证明行为正确。
- 不稳定失败保留初次失败与 trace/截图，查 selector、数据竞争、异步顺序和环境差异。重试后成功单独报告，不隐藏原始失败。

## 结果边界
逐项报告通过、失败、未执行及原因。真实 OAuth、支付、邮件/短信发送等需要相应授权；mock 或跳过不等于真实流程通过。Web 验证不替代 Tauri、Android、Cocos 等原生端验收。本次实现请求已授权的相关缺陷继续修复，不每次失败重新询问是否继续。

参考：[Playwright 官方测试建议](https://playwright.dev/docs/best-practices)，具体 API 按项目锁定版本确认。

## 动效与主题

本次涉及动画、SVG 或主题切换时，按需读取[动效与主题的可观察验收](references/motion-and-theme.md)：检查真实计算样式、可区分的时间/几何状态、循环边界及 reduced-motion 下的非动画功能。检查随本次影响选择，不扩成所有前端任务的固定审计。
