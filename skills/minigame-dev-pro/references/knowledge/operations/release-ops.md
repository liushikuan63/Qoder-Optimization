---
last_verified: 2026-09-04
verify_cycle: T+90d
next_verify: 2026-12-03
primary_source: 微信/抖音小游戏发行规范 + 各平台官方运营/合规沟通文档（实时联网核验为准）
---

# 发行运营复盘（Release & Live-Ops Post-Mortem）

> 对应工具：`scripts/release-gate.mjs` + `tests/release-gate.mjs`。本文件把"发行复盘清单"落成可校验闭环，杜绝表面功能。

---

## 1. 范围与边界（Human-in-the-loop）

| 事项 | agent 能做 | 必须由人或运营做 | 为什么 |
|------|-----------|----------------|--------|
| 复盘清单章节完整性校验 | ✅ 四节存在性检查 | — | 纯静态 |
| 复盘内容撰写 | ❌ | ✅ 运营/制作人 | 复盘需真实数据与人判断 |
| 真机/官方面审 | ❌ | ✅ 平台官方 | 不在 agent 范围 |
| 上线决策 | ❌ | ✅ 发行负责人 | 业务风险兜底 |

**纪律**：本工具只校验清单章节完整性，不替用户写复盘。清单齐备仅代表**流程闭环就绪**，绝不标"已通过官方审核"。

## 2. 必备章节（release-checklist.md 四节）

```
production/release-checklist.md
# 上线前
  - 包体/性能达标、合规扫描全绿（sensitive-word-gate / ip-compliance-check / map-territory-check / ad-law-gate）
  - 数值平衡评审通过（balance-gate）、无障碍清单齐备（accessibility-gate）
  - 本地化完整（i18n-gate，若出海）、资产规格合规（asset-gate）
# 热更
  - 热更通道可用、回滚预案、灰度策略
# 复盘
  - 留存/付费/LTV 数据模板、Post-Mortem 时间线、改进项 owners
# 合规沟通
  - 用户投诉口径、监管/平台沟通联系人、危机预案
```

- 缺任意一节 → release-gate `warn`（exit 0，标未就绪）。
- 四节齐备 → `skip`（绝不 `pass`）。

## 3. 与数据驱动运营联动

- 复盘数据口径参考 `operations/analytics-ops.md`（D1/D7/DAU/MAU/ARPU/LTV/付费率/eCPM，均标"参考需验证"）。
- 隐私优先：`PIPL` 合规，0 第三方 BI，平台数据合规拆分。

## 4. 发行前完整闸门链路

```
sensitive-word-gate → ip-compliance-check → map-territory-check → ad-law-gate
  → balance-gate → accessibility-gate → (i18n-gate → asset-gate) → release-gate
```

- 任一 fail/warn 未清零前，不进入官方提审。
- 本地 CI 等价物：`scripts/ci-local.mjs`（确定性闸门全跑，不含需联网的 link-audit）。

## 5. 引用

- 数据驱动运营：`operations/analytics-ops.md`
- 数值评审：`game-design/economy-balance.md`
- 本地化：`operations/localization.md`
- 资产：`art-audio/asset-pipeline.md`
- 合规总览：`compliance/compliance-rules.md`
