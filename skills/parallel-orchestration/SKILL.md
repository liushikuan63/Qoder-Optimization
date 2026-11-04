---
name: parallel-orchestration
description: 主会话协调的多 agent 并行编排：多模块/跨端/多文件任务开工前必须判定能否并行，可并行时先生成计划文档并询问用户方案是否合适，确认后再启用只读子代理、独立 worktree 或后台会话派发，维护共享上下文与记忆召回，串行合并并重新验收。触发词：并行、多 agent、多agent、协调者、orchestrator、任务拆分、依赖图、worktree、并行编排、共享上下文、记忆召回、并行判断、多模块、跨模块、同时处理、分工、并发、子代理、前后端。
---

# 并行编排

主会话是唯一协调者。默认不自动派发 worker，但**多模块、跨端、多文件或用户明确要求并行/分工的任务，必须主动判定，不得以“默认顺序”为由跳过**。判定为可并行后，**必须先生成计划文档、再询问用户方案是否合适，确认后才取得启用授权**，不得静默跳过、也不得未确认先派发。并行不是“多开几个 agent”，而是**先判定、再生成计划文档、再确认、再共享上下文、再派发、最后统一验收**。

## 什么时候用

- 多个互不依赖的只读调研/审查/验证任务；
- 多个互斥文件、可隔离到独立 worktree 的小改；
- 需要 2–4 个 worker 同时推进、由主会话统一汇总的长任务；
- 用户明确说“并行 / 分工 / 多 agent / 子代理 / 同时处理”，或任务本身横跨多个模块、前后端、多个独立文件（即使没说“并行”）。
- 单文件、单函数、单命令能完成，或存在共享文件/共享服务/数据库/外部副作用的，判定为顺序执行并说明理由，不强行并行。

## 什么时候不用

- 单文件、单函数、单命令就能完成；
- 同一文件、同一共享资源、共享数据库、共享端口/服务、外部副作用；
- 生产/核心服务变更、迁移、部署、破坏性操作、凭据/密钥处理；
- 依赖链必须顺序产出，或验收标准写不出可失败判据；
- 只是为了“看起来并行”而并行；并行调用成本约为单线的 5–20 倍。

## 硬规则

- 由能力路由自动触发（`AUTO_USE`）时同样执行“判定 → 生成计划文档 → 确认”；自动触发不等于自动派发，未确认按顺序执行。
- 判定为 `PARALLEL_READ`/`PARALLEL_WORKTREE` 后，必须先用 `--markdown .qoder/parallel-plans/<taskId>.md` 生成计划文档，再展示计划摘要（单元、波次、读写路径、worker 数、验收/证据、5–20 倍成本），最后用 `AskUserQuestion` 询问“方案是否合适”；未生成文档不得询问或派发，未获确认不得创建运行目录、上下文包或派发 worker。
- 用户明确要求并行/分工时，不得以“用户已经要求”为由跳过计划文档和方案确认；只有用户已对同一份计划逐项确认，才不重复询问。
- 计划确认与启用授权可以合并为同一次询问，但选项必须明确写出启用范围（只读并行 / worktree 写并行）；写并行还必须单独取得显式 opt-in，列出 worktree 隔离方式、`ownedPaths` 与成本。
- 用户选择“调整计划”时，修改 JSON 并重跑校验器后再次展示；用户选择“顺序执行”/取消即按顺序继续并说明“未获并行授权”，不是什么都不做。
- 任务范围、单元或写路径变化时重新确认。`SEQUENTIAL_REQUIRED` 不提供并行开关，`BLOCKED_HUMAN` 只请人决定是否继续。
- 最多 4 个 worker（默认 3）、8 个单元、2 轮；worker 只能一层，不得再嵌套委派。
- 协调者唯一维护共享上下文 canonical；worker 只返回 delta，禁止直接改 `context.json` 或全局记忆。
- 召回统一由协调者执行；worker 禁止直接读全局记忆或 continuity；召回必须带来源与 as-of。
- 召回摘录必须脱敏、限量；不把完整记忆、完整会话或凭据发给 worker。
- 记忆与现场冲突时以现场为准并记录；`contextVersion`/`planDigest` 不一致的结果不得合并。
- 不自动合并、不自动批准权限、不绕过 Qoder 权限或 hooks；worker 的“完成”不是验收。
- `docs/` 不随包；运行时记录放 `.qoder/parallel-runs/`，不提交、不进入分享包。

## 步骤

### 0. 能力探测

确认当前会话可用：`Agent`、内置 `Explore`/`general-purpose`、`isolation: "worktree"`、后台/通知、`create_chat_session` + `supervise`。CLI 有内置 `batch`/`quest` 时优先复用，不重复实现。Desktop 没有已发布团队时不要假设 Agent Teams 可用。

### 1. 判定

先做一次记忆召回，再写计划 JSON：运行 `node ~/.qoder/scripts/parallel-context.cjs recall --query "<目标 + 模块/路径/错误码>" --out .qoder/parallel-plans/<taskId>.recall.json`。默认检索 `~/.qoder{,-cn}/memory` 与当前项目的 `projects/<slug>/memory`；自定义目录用 `--memory` 追加。把命中的硬约束/已知坑补进 `plan.constraints`；没有命中写“记忆无此项”。召回是证据，与当前代码冲突时以现场为准。

写计划 JSON（模板见 [references/plan-schema.md](references/plan-schema.md)），然后运行：

```bash
node ~/.qoder/scripts/parallel-plan.cjs <plan.json> --json --markdown .qoder/parallel-plans/<taskId>.md
```

以上命令按安装后的客户端路径书写（Git Bash）；在源码仓库里把 `~/.qoder/scripts` 换成仓库的 `scripts` 目录。基础安装会随包安装 `parallel-plan.cjs` 与 `parallel-context.cjs`；若两者缺失，先运行 `install-package.cjs` 补基础集。计划文档在用户确认前生成，属于待审计划，不是运行上下文。真实任务不得用 `--preview` 跳过计划文档；`--preview` 只用于测试或工具预演。

退出码与动作：

- `0` + `PARALLEL_READ` + `requiresPlanApproval: true`/`requiresUserOptIn: true`/`optInKind: read-only`：先展示计划并询问方案是否合适，确认后派发只读 worker；
- `0` + `PARALLEL_WORKTREE` + `optInKind: worktree-write`：先展示计划与写范围，取得方案确认和显式写并行 opt-in 后派发 worktree 写 worker；
- `2` + `SEQUENTIAL_REQUIRED`：说明理由，顺序执行（不提供并行开关）；
- `2` + `BLOCKED_HUMAN`：先请人决定，不派发；
- `1` + `INVALID_PLAN`：修正计划，不派发。

不要把 `BLOCKED_HUMAN` 解释成“可以小心地并行”。

#### 1.1 计划预览与方案确认（强制）

判定可并行后，先确认 `.qoder/parallel-plans/<taskId>.md` 已生成，再把文档路径和校验器输出整理成用户能判断的计划摘要，最后用 `AskUserQuestion` 询问方案是否合适。用户明确要求并行时也走这一步，不直接派发。

```text
计划：<taskId> / <goal>
单元：U1 <kind> <title>；owns=<ownedPaths>；reads=<readPaths>；验收=<acceptance>
波次：U1,U2 -> U3（最多 <maxConcurrency> 个并发）
worker：<workerTool> × <N>；成本约为单线 5–20 倍
风险：<同文件/共享资源/合并冲突/权限阻塞等>
```

询问选项至少包含：

- 只读并行：`按此方案启用并行（推荐）— N 个只读 worker` / `调整计划` / `顺序执行 — 不派发 worker`。
- worktree 写并行：`按此方案启用 worktree 写并行（显式 opt-in）— N 个 worker，各自只改 <ownedPaths>` / `调整计划` / `顺序执行 — 不创建 worktree`。

规则：

- 未收到明确肯定答复前，不创建 `.qoder/parallel-runs/`、不写上下文包、不派发 worker；取消、模糊答复或只确认部分选项都按“未获授权”处理。
- 用户选择“调整计划”时，按反馈修改计划 JSON，重跑校验器，再次展示；不能未经确认直接派发。
- 用户选择顺序执行时立即继续，不得以“等待用户决定”停手；在汇报里写明“已判定可并行，用户选择顺序执行”。
- 把选择记入运行上下文 `decisions`（source=`user`）；写并行的 opt-in 必须能在运行记录中追溯。
- 能力探测失败（无 `Agent`/worktree）时在询问前说明，不能承诺做不到的隔离方式。

#### 1.2 与 vibecoding 文档联动

- 多模块、跨会话或需要接续的任务，先按 `vibecoding-doc` 维护 `AGENTS.md` / `spec.md` / `plan.md` / `tasks.md`；并行计划是 `plan.md`/`tasks.md` 的执行细化，不新建第五层文档。
- 计划摘要中的每个单元必须能映射到 `tasks.md` 的任务卡和 `spec.md` 的验收项；没有任务卡/验收就回到 vibecoding 文档补齐，不先拆 worker。
- 已有四层文档时只更新对应章节；需求变了先同步 spec/tasks 再改并行计划，避免 worker 按过期契约执行。

### 2. 共享上下文与召回

在项目内创建运行目录 `.qoder/parallel-runs/<taskId>/`：

```bash
node ~/.qoder/scripts/parallel-context.cjs init --plan <plan.json> --out .qoder/parallel-runs/<taskId> --decision "用户确认计划并启用<只读|worktree写>并行"

# 复用计划阶段的召回文件；计划或单元变化时用新关键词重新检索
node ~/.qoder/scripts/parallel-context.cjs recall --query "<目标 + 单元标题 + 关键路径/错误码>" --out .qoder/parallel-plans/<taskId>.recall.json --max-items 5 --max-chars 1200

# 审阅召回候选：只把与单元路径/验收相关的 refs 留给 pack，删除无关或过期条目
node ~/.qoder/scripts/parallel-context.cjs pack --context .qoder/parallel-runs/<taskId>/context.json --unit U1 --recall .qoder/parallel-plans/<taskId>.recall.json --out .qoder/parallel-runs/<taskId>/packs/U1.json
```

- 召回由协调者完成：`recall` 会检索 `MEMORY.md` 索引及其链接文件，按目标/模块/路径/错误码评分，并对摘录脱敏、限量；每条带 source/ref/asOf/confidence，默认每个 worker ≤2,000 字符；没有命中就写“记忆无此项”，不要编造。
- continuity 仅在已显式 enable 且任务绑定时查询；如需使用，先按已绑定会话执行 `node ~/.qoder/scripts/continuity.cjs search --cwd <项目> --session <会话> --query "<关键词>"`，人工核对后再并入 recall.json；不要自动 enable。
- 每个 worker 的 pack 只带与自身单元相关的召回；不要把完整记忆、完整会话或凭据发给 worker。
- 每条召回带来源、as-of、confidence；摘录先脱敏、再限量（默认每个 worker ≤2,000 字符，可配置）。
- 没有命中就写“记忆无此项”，继续用 spec/代码；不要编造记忆。
- 详细字段、冲突处理、写入权限见 [references/context-protocol.md](references/context-protocol.md)。

### 3. 派发

只读 worker（用户已选择启用后）：

- 用内置 `Explore`；一条消息内并行调用多个 Agent；每个提示词自包含，含范围、读路径、禁止项、验收、证据格式、`contextVersion` 和 `planDigest`。
- 不要求 worker 输出完整文件；要求 `file:line` 证据和结构化结果。

写 worker（用户已显式 opt-in 后）：

- 用 `general-purpose` + Agent 工具的 `isolation: "worktree"`；每个 worker 只写自己的 `ownedPaths`；互不重叠。
- 不在主工作树并发写；不自动合并；未获写并行 opt-in 时不得创建 worktree。
- 需要 CLI 实体隔离时用 `parallel-write.cjs prepare/verify`，按[并行写工作树协议](references/write-worktrees.md)核对单波基线、逐提交路径归属及 Git 冲突。后续依赖波次在前序集成验收后的新基线准备。

长任务：用 `create_chat_session` + `callbackMode: "supervise"`，完成或需要权限时回调；`wait_chat_sessions` 只作兜底。提示词模板见 [references/worker-contracts.md](references/worker-contracts.md)。

### 4. 监控与合并

- 后台任务用完成通知；不 sleep、不轮询；超时/取消用停止能力。
- worker 返回 `findings/evidence/recallRequests/contextVersion/planDigest`；协调者用 `parallel-context.cjs merge` 合并 delta；版本或摘要缺失/不一致时重新取得当前 pack，禁止 worker 直接写 canonical。
- 任一 canonical 字段变化就递增 `version`；受影响 worker 用新版本对齐或重派；旧版本结果不合并。
- 同一版本的多单元结果可用 `merge-batch` 全部验证后一次提交/升版，避免首个结果升版后其余结果无效；canonical 写者共用锁，不清理未知占用。
- 写 worker 的 worktree 按拓扑顺序串行审查/合并；合并前重读目标文件，冲突就停止报告，不覆盖。
- 合并后重新跑验收；worker 自测通过不等于主分支通过。

### 5. 收口

- 报告：判定、worker 数/波次、上下文版本、合并结果、命令与退出码、已验证/未验证/风险。
- 运行摘要可提出长期记忆候选，但不自动写入；写入需用户明确同意并走现有记忆规则。
- 清理无改动的 worktree；保留有改动的 worktree 并报告路径；运行记录按需删除。

## 失败与回退

- worker 失败不自动重跑；最多 1 次有理由的重试，之后报告部分完成/未验证。
- 权限请求由主会话/用户处理；worker 不自动批准、不转派。
- 同文件写、版本不一致、召回泄漏、生产/数据库/部署/凭据门槛：立即停止并行，回到顺序执行或请人决定。
- 回退：移除 `.qoder/parallel-runs/` 运行记录；代码回退按 worktree/分支处理；不涉及数据库迁移。

## 参考

- [references/plan-schema.md](references/plan-schema.md)：计划 JSON、判定与退出码。
- [references/context-protocol.md](references/context-protocol.md)：L0–L4、召回、写入、冲突、脱敏。
- [references/worker-contracts.md](references/worker-contracts.md)：只读/写 worker 提示词与结果格式。
