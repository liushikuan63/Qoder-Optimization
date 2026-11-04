---
last_verified: 2026-09-03
verify_cycle: 90
next_verify: 2026-12-02
primary_source: 国内适老化/无障碍设计指南 + WCAG 2.1 AA；真机验证交用户/专业服务
---

# 无障碍与适老化合规（Accessibility & Aging-Friendly）

> 1.0.9 新增。对齐 AlterLab GameForge 的 Accessibility Specialist 与国内适老化/无障碍要求。
> 本文件是 `accessibility-gate.mjs` 的方法论来源；闸门只做静态信号 + 章节存在性检查，
> **真机无障碍验证由用户/专业服务完成**（agent 不做渲染判定，不假 pass）。

---

## 1. 五类适配清单（accessibility-gate.mjs 必需章节）

`accessibility-gate.mjs` 检查 `production/accessibility-checklist.md` 是否含以下 5 类章节：
**色觉 / 听觉 / 运动 / 认知 / 适老化**。每类要点如下。

### 1.1 色觉（Color Vision）
- [ ] 不以纯红(#FF0000) / 纯绿(#00FF00)作为**唯一**状态区分（色盲不可辨）；须配文字/图标/形状。
- [ ] 关键信息对比度达标（正文 ≥ 4.5:1，大字 ≥ 3:1）。
- [ ] 提供高对比度模式或主题。

### 1.2 听觉（Hearing）
- [ ] 关键音频反馈（得分/警告/完成）有视觉替代（图标/文字闪烁/震动）。
- [ ] 字幕/文本覆盖重要语音信息。
- [ ] 音量可独立调节，不强制绑定背景音乐。

### 1.3 运动（Motor）
- [ ] 不依赖精确快速连点/长按；提供宽容点击区域与误触保护。
- [ ] 关键操作可单手/单指完成；支持较大多点触控热区。
- [ ] 动画/闪烁频率 < 3Hz（避免光敏癫痫风险）。

### 1.4 认知（Cognitive）
- [ ] 文案简洁、指引明确，首屏即告知核心目标（联动 ftue-design.md）。
- [ ] 失败/错误有明确可执行的下一步提示，不堆术语。
- [ ] 流程可逆（误操作后易回退）。

### 1.5 适老化（Aging-Friendly）
- [ ] 字体可放大且布局不崩；默认正文不小于平台适老基准。
- [ ] 按钮/点击区尺寸适配老年用户；避免过小热区。
- [ ] 关键操作有二次确认（避免误触大额付费/删除）。

---

## 2. 与未成年保护联动

- 适老化与未成年保护互补：未成年人界面同样需大字/高对比/明确指引（联动 anti-addiction-sop.md）。
- 付费二次确认对未成年账号为**强制关闭入口**（见 economy-balance.md §4 限额），非仅 UX 优化。

---

## 3. 与合规红线联动

- 无障碍文案不得含违规词（联动 sensitive-word-gate / content-security.md）。
- 适老化宣传不得虚假（"最适合老人"等绝对化用语违反 ad-law.md 极限词红线）。

---

## 4. 与执行层接线

| 动作 | 工具 | 说明 |
|------|------|------|
| 静态风险扫描 + 章节检查 | `node tests/accessibility-gate.mjs --project <路径> --json` | 色盲字面扫描 + checklist 章节校验 |
| 真机验证 | 用户/专业服务 | agent 不做渲染判定 |

> 自检模式（无 --project）：验证 accessibility.md 存在 + 本脚本语法，确认子系统接线。
