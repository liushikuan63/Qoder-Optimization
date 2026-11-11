# 计划 schema 与判定

## 只读计划示例

```json
{
  "schema": 1,
  "taskId": "AUDIT-1",
  "goal": "审阅两个独立模块",
  "mode": "auto",
  "constraints": ["只读，不改文件"],
  "units": [
    {
      "id": "U1",
      "kind": "read",
      "title": "审阅模块 A",
      "dependsOn": [],
      "ownedPaths": [],
      "readPaths": ["src/a"],
      "acceptance": ["列出风险并给出 file:line"],
      "evidence": ["file:line", "命令输出"]
    },
    {
      "id": "U2",
      "kind": "read",
      "title": "审阅模块 B",
      "dependsOn": [],
      "ownedPaths": [],
      "readPaths": ["src/b"],
      "acceptance": ["列出风险并给出 file:line"],
      "evidence": ["file:line", "命令输出"]
    }
  ],
  "resources": {
    "sharedFiles": [],
    "sharedServices": [],
    "databaseWrites": false,
    "production": false,
    "destructive": false,
    "credentials": false,
    "externalSideEffects": false
  },
  "execution": { "maxConcurrency": 2, "isolation": "none", "workerTool": "Explore" },
  "budget": { "maxWorkers": 4, "maxRounds": 2 }
}
```

预期：退出 0，`PARALLEL_READ`，`waves: U1,U2`。

## worktree 写计划示例

```json
{
  "schema": 1,
  "taskId": "EDIT-1",
  "goal": "在两个互斥文件做小改",
  "mode": "auto",
  "constraints": ["仅改动 ownedPaths", "不碰共享资源"],
  "units": [
    {
      "id": "U1",
      "kind": "write",
      "title": "改 A",
      "dependsOn": [],
      "ownedPaths": ["src/a.js"],
      "readPaths": ["src/a.js", "test/a.test.js"],
      "acceptance": ["测试通过"],
      "evidence": ["git diff", "测试退出码"]
    },
    {
      "id": "U2",
      "kind": "write",
      "title": "改 B",
      "dependsOn": [],
      "ownedPaths": ["src/b.js"],
      "readPaths": ["src/b.js", "test/b.test.js"],
      "acceptance": ["测试通过"],
      "evidence": ["git diff", "测试退出码"]
    }
  ],
  "resources": {
    "sharedFiles": [],
    "sharedServices": [],
    "databaseWrites": false,
    "production": false,
    "destructive": false,
    "credentials": false,
    "externalSideEffects": false
  },
  "execution": { "maxConcurrency": 2, "isolation": "worktree", "workerTool": "general-purpose" },
  "budget": { "maxWorkers": 4, "maxRounds": 2 }
}
```

预期：退出 0，`PARALLEL_WORKTREE`，`requiresUserOptIn: true`；用户显式 opt-in 后才派发。确认前用 `--preview` 取只读摘要（`stage=PRE_CONFIRMATION_DRAFT`，零写入）供开工确认卡展示；确认后加 `--markdown .qoder/parallel-plans/<taskId>.md` 生成正式计划文档（`stage=FORMAL_PLAN_DOC`），文档必须包含单元/依赖/写入路径/验收、波次、审批状态和 vibecoding 映射；未生成正式文档不得派发。`--preview` 不能替代正式文档；未答复/取消/改串行用 `--record-downgrade <reason> --state-dir <dir>` 追加降级记录与覆盖缺口清单。

## 判定与退出码

| 结果 | 含义 | 退出码 | 动作 |
|---|---|---|---|
| `PARALLEL_READ` | ≥2 个独立只读单元 | 0 | **先展示计划并询问方案是否合适**；确认后并行只读 |
| `PARALLEL_WORKTREE` | ≥2 个互斥写单元 + worktree | 0 | **先展示计划与写范围，取得方案确认和显式写并行 opt-in**；确认后派发 |
| `SEQUENTIAL_REQUIRED` | 依赖链、并发上限 1、无独立波次 | 2 | 顺序执行（不提供并行开关） |
| `BLOCKED_HUMAN` | 生产/数据库/破坏性/凭据/外部副作用/共享服务/共享文件写 | 2 | 先请人决定 |
| `INVALID_PLAN` | 同文件写、缺 `ownedPaths`、缺 worktree、成环、超限、字段非法 | 1 | 修正计划 |

判定可并行时，`--json` 结果还包含 `requiresPlanApproval: true`、`requiresUserOptIn: true` 与 `optInKind: read-only|worktree-write`；必须先写出计划文档、展示摘要并询问方案是否合适，未收到明确确认前不得派发。用户选择调整时改计划并重跑校验；拒绝或取消时顺序执行，并在汇报中说明“未获并行授权”。

需要用户确认的计划（`PARALLEL_READ` / `PARALLEL_WORKTREE`）不带 `--markdown` 时返回 `PLAN_DOC_REQUIRED`（exit 2），不输出 verdict；`--preview` 仅用于测试或工具预演，不能替代计划文档或用户确认。

## 硬门槛

- 同文件/共享文件会被两个 worker 写：`INVALID_PLAN` 或 `BLOCKED_HUMAN`。
- 生产、共享数据库写、迁移、部署、破坏性操作、凭据/密钥处理：`BLOCKED_HUMAN`。
- 依赖成环、未知依赖、空单元、重复 id、缺验收/证据：`INVALID_PLAN`。
- 任何含写者的并行计划（包括一写一读）若 `isolation != worktree`：`INVALID_PLAN`；`Explore` 只能接收只读单元。
- `maxConcurrency` 1–4；并行模式需 ≥2；超过单元数或 `maxWorkers`：`INVALID_PLAN`。

## 路径规则

- `ownedPaths`/`readPaths` 用相对路径，不接受绝对路径、`..`、通配符。
- 重叠判断会统一分隔符和大小写；`src\a.js` 与 `SRC/A.JS` 视为同一路径；`src` 与 `src/a.js` 的目录/文件祖先关系也算写入重叠。
- `dependsOn` 不得包含重复单元 ID；无效依赖返回 `INVALID_PLAN`，不进入拓扑执行。
- 一个路径同一时刻只能有一个写者。
- 计划保留路径原始大小写并纳入 `planDigest`。提交验收按宿主文件系统语义核对：Linux 的 `src/A.js` 不能冒用 `src/a.js` 的授权，Git 路径中的字面反斜杠也不能当作目录分隔符。Windows 使用 native realpath 统一短文件名与长文件名后核对仓库/工作树身份。
- 同一波次内，写者 `ownedPaths` 与其他单元 `readPaths` 重叠返回 `READ_WRITE_CONFLICT`；用明确 `dependsOn` 表达读写顺序，后续波次从集成后的新基线创建工作树。

## Git 配置与工作目录绑定

`prepare` 支持已经启用 `extensions.worktreeConfig` 的正常仓库；记录源与每个工作树的实际 Git 目录，以及有效配置来源文件（含条件 include 和 `config.worktree` 存在性）的身份与内容摘要。回执只保存摘要，不保存配置值。每次干净检查前后都核对实际工作目录和配置，重定向或配置漂移返回非零，并保留全部工作树与提交。

新工作树先以 `--no-checkout` 注册，再在目标 Git 目录中发现并禁用可执行过滤器，核验目录身份后物化文件；不使用强制覆盖的检出操作。这样源目录中尚未生效的条件过滤器，也不能在首次检出时先执行。

旧版 `run.json` 缺少 `sourceConfigDigest` 或单元 `configDigest` 时，`verify` 返回 `CONFIG_BINDING_REQUIRED`，不会补造旧基线或删除已有成果；保留工作树和提交，先人工复核，或在整合成果后从干净的新基线重新 `prepare`。配置与身份的前后校验仍不构成安全沙箱，也不授权其他写入者修改共享 Git 配置。
