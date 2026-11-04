# 门控泳道与规模路由门控（Gate Pipeline · 1.0.8）

> 1.0.8 新增。本文件定义小游戏从"空目录"到"可上架"的全链路门控模型，以及 agent 与用户的职责边界。
> 设计经附录强制修订：①端到端 human-in-the-loop 边界表（P0）；⑤门控改为**规模路由门控**（P1，小游戏体量少，不照搬 3A 双 gate）。

## 一、为什么是"规模路由门控"而非固定双 gate

头部 3A 游戏工业链有 `concept-prototype`（玩法原型验证）→ `vertical-slice`（垂直切片验证）两道硬性 gate。但小游戏（尤其 IAA 休闲、个人开发者）体量与风险远低于 3A：

- 强行对每一个 2 周开发周期的休闲小游戏套双 gate，是"为对齐头部而对齐"，产出空壳流程、拖慢交付。
- 真实风险在小游戏里是**分层**的：个人 IAA 单平台休闲游戏风险低（主要是合规骨架 + 包体预算）；含内购 / 多平台 / 企业主体的游戏风险高（支付合规、平台差异、版号/软著矩阵）。

因此本 skill 采用**规模路由门控**：按项目规模/风险路由到 1 道（light）或 2 道（full）gate，而不是无差别双 gate。

## 二、路由规则

| 输入 | 判定 | 走哪条 |
|------|------|--------|
| `--scale light` | 显式轻量 | light（单 gate） |
| `--scale full` | 显式完整 | full（双 gate） |
| `--scale auto`（默认） | 推断：monetization 含 `iap` **或** 目标平台数 ≥ 2 **或** 企业主体 | full |
| `--scale auto`（默认） | 其余（个人 / IAA / 单平台休闲） | light |

推断数据来源（按优先级）：项目态 `.workbuddy/minigame-dev/project-state.json` 的 `monetization` / `platforms` 字段 → `scaffold` 写入的 `game.json` 周边提示 → 默认 `light`。
**诚实约束**：推断不到明确风险信号时，保守走 `light`，不在报告里假装做过 full gate。

## 三、light gate（单 gate，等价于 qa-gate 增强）

通过条件（全部满足才 `pass`）：
1. **结构合法**：`detectProject` 返回 `valid && type==='minigame'`（game.json + game.js 齐全）。
2. **包体预算 ok**：`auditBudget` 按平台读 `platforms.json`，主包/总包/子包不超限。
3. **QA 等价**：复用 `qa-gate` 的结构 + 预算 + 证据判定；证据不完整（build/screenshots/logs/checklist 非齐全）仅 `warn`，不阻断但 `readyForRelease:false`。
4. **产出上线 checklist**：生成 `production/launch-checklist.md`，列明真机预览 / 上传 / 提审 / 合规复核的人工步骤。

不通过条件（硬失败 `fail`，exit 1）：结构非法、或包体超预算。这两项是真错误，不是降级。

## 四、full gate（双 gate，light + 原型/切片）

在 light 全过基础上，额外要求两道设计层闸门：

### 4.1 concept-prototype（玩法原型验证）
- **目的**：在投入完整生产前，确认核心玩法值得做，给出 PIVOT / KILL 判定。
- **机器可验项**：项目须存在 `production/prototype.md`（或 `docs/prototype.md`），且含以下小节：
  - `核心循环`（core loop：输入→反馈→状态变化的最小闭环描述）
  - `PIVOT 条件`（哪些指标/反馈出现即转向）
  - `KILL 条件`（哪些情况直接放弃）
- **诚实约束**：gate-check **只校验该文档存在且三小节齐全**，不替用户写玩法、不臆断"玩法有趣"。文档缺失 → `warn`（level:warn，非硬失败），因为 agent 无法发明游戏设计。

### 4.2 vertical-slice（垂直切片验证）
- **目的**：确认"一条可玩切片"贯通（而非只有骨架），且被合规闸门守护。
- **机器可验项**：
  - `qa-gate` 已达 `pass`（结构 + 预算 + 证据齐全）；
  - 存在 `production/slice-checklist.md`，且含：核心循环可玩切片、关键系统（支付/广告/存档，按变现模式选）清单、合规复核项（版号/实名/防沉迷/内容安全）。
- **诚实约束**：切片"可玩性"本身需真机，agent 只校验清单完整 + qa 已过，不假称"已验证可玩"。

## 五、端到端 human-in-the-loop 边界表（附录① P0 强制）

空目录 → 上架 全链路，**每一步明确谁做、做不到时降级为何**：

| # | 链路步骤 | 执行方 | 说明 | CLI 缺失 / 做不到时 |
|---|----------|--------|------|----------------------|
| 1 | 空目录 → 合规骨架（目录/game.json/game.js/分包/项目态） | agent 自动 | `scaffold.mjs` | —（纯本地，无 CLI 依赖） |
| 2 | 游戏逻辑 / 美术 / 音频 / 关卡填充 | **用户手动** | 编辑器内完成 | agent 只产出骨架，不生成可玩内容 |
| 3 | 本地构建为平台包 | agent 辅助（仅 CLI 存在） | `build.mjs` 原生离线组装；Cocos/Laya 需引擎 CLI | CLI 缺失 → `built:false + installHint` 降级，不假成功 |
| 4 | 运行时截图 / 日志 / 手动清单 | **用户手动** + agent 聚合 | `playtest-evidence.mjs` 只读聚合 | 证据缺 → 仅 `partial/none` 报告，不假 pass |
| 5 | QA 闸门（结构/预算/证据） | agent 自动 | `qa-gate.mjs` | 结构非法/超预算 → 硬失败；证据缺 → warn |
| 6 | 门控泳道（light/full + 原型/切片） | agent 自动 | `gate-check.mjs` | 设计文档缺 → warn，交用户补 |
| 7 | 真机预览 / 上传 / 提审 | **用户手动** | 微信开发者工具 / 开放平台 | agent 产出 checklist，不断言"已上架" |
| 8 | 合规字段与包体预算预检 | agent 自动 | `package-analyzer` + `platforms.json` | — |

**红线**：agent 在任何步骤都**不断言"已上架 / 已通过真机验证"**。上架是用户动作；真机可玩性是用户动作；agent 只产出可核验的工件与 checklist。

## 六、与工具链映射

| 门控层 | 复用脚本 / 纯函数 |
|--------|------------------|
| 结构检测 | `scripts/lib/project-detector.mjs` → `detectProject` |
| 包体预算 | `scripts/build.mjs` → `auditBudget` / `loadPlatforms` |
| 证据聚合 | `scripts/playtest-evidence.mjs` → `collectEvidence` / `classifyCompleteness` |
| 门控编排 + 报告 | `scripts/gate-check.mjs`（本版新增） |
| 多平台命令差异 | `references/data/build-matrix.json` |

## 七、诚实红线

- 不假 pass：任何"证据/设计文档不全"都只 `warn`，`gate` 绝不标 `pass`。
- 不猜上限：预算只信 `platforms.json`（已核实项）；`pending-verify` 平台不构建、不报"通过"。
- 不越界：agent 不做真机验证 / 上架；只产出工件 + checklist + 边界表。
