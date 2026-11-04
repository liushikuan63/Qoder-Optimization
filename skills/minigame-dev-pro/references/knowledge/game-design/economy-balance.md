---
last_verified: 2026-09-03
verify_cycle: 90
next_verify: 2026-12-02
primary_source: 微信小游戏官方文档/《网络游戏管理办法》防沉迷条款；量化模型为方法论，具体阈值须项目实测校准
---

# 经济系统量化平衡与付费伦理（Economy Balance & Monetization Ethics）

> 1.0.9 新增。本文件是 `economy-design.md`（设计模式）的**量化互补层**：把"水龙头-水槽"直觉落成
> 可计算的 source/sink 模型，并用 `balance-check.mjs --model economy` 做数值验证；同时明确付费伦理
> 与合规闸门（防沉迷 / 版号 / IAP）的硬边界。**设计模式见 economy-design.md，本文件只讲量化与伦理。**

---

## 1. 货币 source/sink 建模（可计算）

把每个货币视为一个**蓄水池**，每 tick（如每日 / 每局）的净变化：

```
Δbalance = Σ sources.perTick − Σ sinks.perTick
```

- **source（产出源）**：关卡通关、签到、任务、广告激励、付费购买、活动。
- **sink（消耗口）**：升级、随机抽取/抽卡、建造、复活、加速、外观购买。
- **平衡目标**：长期 `sinkCoverage = Σsinks / Σsources ≈ 1`（见 balance-check.mjs 输出 `sinkCoverage`）。

### 量化判定（对齐 balance-check.mjs --model economy 输出）

| 输出字段 | 含义 | 健康区间 |
|---------|------|---------|
| `classification` | inflation / deflation / stable | **stable** |
| `sinkCoverage` | 消耗/产出比 | **≈1（0.95–1.05）** |
| `slopePerTick` | 每 tick 净变化斜率 | 接近 0（相对 start < 5%） |
| `minBalance` / `maxBalance` | 模拟区间 | 不触 0（紧缩）、不无界膨胀 |

> 模型输入 schema（P0 输入契约）：`{"start":1000,"sources":[{"name":"通关","perTick":120,"vol"?:5}],"sinks":[{"name":"抽卡","perTick":110,"vol"?:5}]}`。
> `vol` 为每 tick 随机扰动标准差（可选），用于模拟真实波动；缺省为确定性线性。

### 设计意图（与 economy-design.md 一致）

让免费玩家"每天差一点点"——这个"一点点"是广告/付费的转化空间，但**不能让免费玩家卡死**（见 §3 伦理）。

---

## 2. 难度曲线量化（对齐 balance-check.mjs --model difficulty）

```
curve: [{"level":1,"clearProb":0.85}, ...]   // clearProb ∈ (0,1)
```

- 模拟 N 名玩家爬塔，记录每关留存与单关流失。
- `spikeLevel` / `spikeDrop`：最大留存断崖（单关流失）。
- **健康阈值**：`spikeDrop ≤ 0.15`（超过即提示下调该关 clearProb 或加前置引导）。
- 与 gate-check 的 concept-prototype（PIVOT/KILL）联动：难度断崖过陡 = 核心价值假设待验证。

---

## 3. 付费伦理（硬边界，不可为转化牺牲）

1. **不逼迫付费**：免费路径必须可推进（参考 economy-design.md §2.3 三类玩家模拟）。付费只提供"加速/外观/便利"，不构成付费墙（paywall）阻断核心进度。
2. **随机机制合规**：抽奖/开箱/抽卡属**随机概率玩法**，须公示概率（国内监管要求：网游随机道具须公布抽取概率与保底）；不得伪装成"必得"，不得诱导非理性消费。
3. **明示与告知**：付费前明确价格、虚拟货币兑换比例、退款规则（参照 compliance/ad-law.md 广告法与虚假宣传红线）。
4. **不制造赌博暗示**：不得以"再充一点就出"的话术施压；保底机制须真实生效。

---

## 4. 与防沉迷联动（未成年人保护，P0）

> 详见 `references/knowledge/sop/anti-addiction-sop.md` 与 compliance 红线。

- **8 周岁以下**：禁止任何充值（含内购/IAP）。游戏内付费入口对未成年账号必须关闭。
- **8–16 周岁**：单次充值 ≤ 50 元，月累计 ≤ 200 元（以此类限额为基准，以最新官方规则为准）。
- **16–18 周岁**：单次 ≤ 100 元，月累计 ≤ 400 元。
- **时长限制**：仅周五/六/日及法定节假日 20:00–21:00 可玩 1 小时。
- **经济系统影响**：付费货币产出不可绕过实名年龄闸门；source 中"付费购买"对未成年须按年龄限额截断。

> 数值设计须把"未成年充值限额"作为 source 上限的硬约束写入 balance-spec.json，再跑 balance-gate 验证。

---

## 5. 与版号 / IAP 联动

- **内购（IAP）须有版号**：无版号的小游戏不可开通虚拟支付/内购（参照 iap-eligibility.mjs 闸门与 compliance/national-law.md）。
- **平台分流**：微信小游戏 iOS 虚拟支付仅 Android 支持（iOS 标注未开放，禁止套用小程序 API，见 1.0.5 事实纠错）；抖音按平台规则分流。
- **经济建模前提**：含 IAP 的项目，source 含"付费购买"前必须先确认版号/资质就绪（gate-check 路由会自动升 `full` 双 gate）。

---

## 6. 与执行层接线

| 动作 | 工具 | 说明 |
|------|------|------|
| 经济模拟 | `node scripts/balance-check.mjs --model economy --in ./econ.json --json` | 产出 classification / sinkCoverage / 趋势 |
| 难度模拟 | `node scripts/balance-check.mjs --model difficulty --in ./diff.json --json` | 定位 spikeLevel |
| 阈值门控 | `node tests/balance-gate.mjs --project <路径> --json` | 读 balance-spec.json，越阈=硬失败 |
| 测试计划 | `node scripts/qa-plan.mjs --project <路径>` | 生成含数值回归项的 qa-plan.md |

> 流程见 `references/engine/execution-protocol.md` 流程7（数值评审 / 运营复盘）。
