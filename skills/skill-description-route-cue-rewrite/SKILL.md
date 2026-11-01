---
name: skill-description-route-cue-rewrite
description: "改写或瘦身其他技能 description 的保护性流程：动笔前重新 Read 并与上一轮比对（防并行会话改短）；按七组路由线索盘点去向——反直觉结论、已发生状态的禁止动作、人工解除/回退入口、守卫覆盖面边界、零风险探针、完整触发词、不用于→指向；写入后用 check-description.cjs 验收（逐组短语断言 + 残缺版负对照必须判红 + 单行/无 CRLF/长度明显低于原版）。触发词：description 瘦身、压短描述、路由线索丢失、补回触发词。整技能降量→skill-trim-with-capability-transfer。"
---

# 技能 Description 改写：路由线索保护流程

## 适用与排除

**适用**：改写、瘦身、收敛任何技能 `SKILL.md` 的 frontmatter `description`；或发现某技能 description 被改短、路由线索丢失需要补回。

`description` 是技能的唯一常驻路由层：删掉「只有这一家才提供、且决定它能不能被想起」的线索，技能从此不再被想起。实例（2026-10-22）：`db-credential-auth-lock-safety` 的 description 从 791 字被压到 301 字，跨通道合并计数、锁定后禁止动作、`--clear` 人工解除入口、守卫覆盖面边界、探针地址、触发词、三条不用于全部丢失——用户定性为「把技能的路由线索改没了」。

**不用于**：

- 整技能停用 / 降量 → `skill-trim-with-capability-transfer`
- 周期性收敛体检与批量瘦身 → `converge`
- 通用可失败断言方法论 → `falsifiable-partition-assertions`
- 共享文件并行改动归属存疑（陌生 .bak、md5 不符）→ `concurrent-edit-attribution-check`
- 只改 SKILL.md 正文、不动 description 的更新无需求本技能

## 第 1 步：改写前取证

1. 重新 `Read` 目标 SKILL.md，提取当前 description 原文与长度。
2. 与本会话上一轮读到的版本比对：长度骤降或线索消失 → 文件已被并行会话（如 /converge）改写。如实说明归属，**从残缺版出发按第 2 步清单补回**，不沿用残缺版、不假装线索是自己删的。
3. 把「旧原版」与「残缺版」两份原文留存（会话内或 `~/.qoder/tmp/` 下），它们是第 5 步负对照的输入。
4. 发现陌生 `.bak` 或内容与自己备份不符时，先走 `concurrent-edit-attribution-check` 判归属再动笔。

## 第 2 步：七组路由线索（逐项盘点去向，缺一判红）

对旧 description 逐组判断「改写后是否仍在」。允许换成更短的说法，**不允许整段消失**：

| # | 线索组 | 判据 |
|---|--------|------|
| 1 | 核心反直觉结论 | 该技能最反直觉、最容易做错的那条（实例：跨通道合并计数、换通道不算换目标） |
| 2 | 已发生状态下的禁止动作 | 触发后哪些动作被硬禁（实例：锁定后禁止「再试一次」重连、禁止擅自重启） |
| 3 | 人工解除/回退命令入口 | 完整可复制的命令（实例：`node ~/.qoder/scripts/auth-lock-guard.js --clear`） |
| 4 | 守卫/工具覆盖面边界 | 硬拦覆盖什么、明确不拦什么（实例：PreToolUse 只认数据库客户端形态） |
| 5 | 零风险探针 | 无副作用的验证地址/方法（实例：RFC5737 `192.0.2.1`） |
| 6 | 完整触发词清单 | 报错码/关键字/平台名逐个点名（实例：WRONGPASS、535、Login failed for user） |
| 7 | 三条不用于 → 指向别的技能 | 防抢别的技能的触发，逐条写明去向 |

（七组源自 db-credential 事故的用户纠偏原话；原话按 6 条编号，因人工解除入口与覆盖面边界同条。）

## 第 3 步：长度口径

- 用户给了目标字数（如 ~600）→ 以目标为准。
- 未给 → 新长度 < 原版 × 0.9；774/791 式「约等于没瘦」判红。
- 线索清单全覆盖优先于压长度：两者冲突时保线索、如实说明长度。
- 每轮改写后立即跑检查器看 `len=`，按目标长度起草、逼近，减少返工（事故中 842 → 774 → 679 走了三轮）。

## 第 4 步：写入

1. 改前备份：`node ~/.qoder/scripts/backup-file.js "<SKILL.md 路径>"`。**backup-file.js 把 .bak 落在原文件旁＝技能包内部**，会成为多余分发物——改完把 .bak 逐条点名挪到 `~/.qoder/tmp/`（显式文件名，不通配、不 rm -rf），技能包内不得残留 .bak。
2. 只动 frontmatter 的 description 一行；name 与正文不动（除非另行授权）。
3. 格式：单行；双引号包裹（值含冒号空格时必须引）；内部无裸双引号（引内容用「」）；值内无 CR/LF。

## 第 5 步：断言（scripts/check-description.cjs）

写短语组清单 JSON。**phrases 一律用字面量中文，禁用 `\uXXXX` 转义**——「跨」U+8DE8 误写成「跳」U+8DF3 曾造成一次假红：

```json
{"groups":[
  {"name":"跨通道合并计数","phrases":["MCP/psql/JDBC","跨通道"]},
  {"name":"人工解除入口","phrases":["auth-lock-guard.js --clear"]}
]}
```

正向与负对照一起跑（多个 baseline 逗号分隔，残缺版与旧原版都给）：

```
node scripts/check-description.cjs --file <SKILL.md> --groups <spec.json> --baseline <残缺版路径>,<旧原版路径>
```

- 退出码 0 ＝ 格式断言全过、每组短语至少命中一个、每个 baseline 至少缺一组（判红符合预期）。
- **baseline 全命中 ≠ 通过**：说明短语选得太泛、没有区分力——换成补回后的具体子项短语再跑。
- 不给 `--baseline` 时脚本自动做剥短语变异对照：把全部短语从目标剥掉后必须全 MISS，否则判恒绿。
- 长度对比取各 baseline 中最长者（即旧原版）；无 baseline 时跳过比例判断。
- 固定输出逐组 PASS/MISS ＋ `[判定]` 行，整段贴进汇报。

**只补路由线索、不做瘦身时**（description 变长是预期）：

- `--max-ratio` 的合法范围是 `(0,1)`；传 `1.2` 会被检查器直接拒绝，不要指望放宽到 1 以上。
- 省略 `--baseline`，让检查器走内置剥短语变异对照：把新增短语从目标 description 剥掉后必须全 MISS；同时确认原有短语组仍命中。
- 目标是“新增专有触发词且不丢旧线索”，不是“总长度下降”；不要为了过比例断言而删旧线索。

```
node scripts/check-description.cjs --file <SKILL.md> --groups <spec.json>
```

## 第 6 步：复验

- 写完重新 `Read` 实际文件核对——Edit 成功 ≠ 核验成功；检查器的 `len=` 数字即最终长度证据。
- 重载技能清单（/skills reload 或重启会话）确认加载侧读到的是新 description。

## 资源

- `scripts/check-description.cjs`：description 验收检查器。退出码 0 全绿 / 1 判红 / 2 用法或 IO 错误。`--file` 或 `--desc` 给目标，`--groups` 给短语组清单，`--baseline` 给残缺版/旧版，`--max-len`（默认 1024）、`--max-ratio`（默认 0.9）。
