# 并行写的隔离、核验与恢复

并发数只决定同时启动多少 worker。写任务还必须约束它读到哪个基线、可以修改哪些路径、结果属于哪个计划，以及由谁集成。

## 先划分依赖，再创建工作树

1. 用 `parallel-plan.cjs <plan.json> --json` 核对计划，把输出的完整 `planDigest` 与路径范围展示给用户。计划确认和显式写并行 opt-in 沿用已有授权；命令行开关只是记录操作者的选择，不证明用户实际批准。
2. 同一波次的写路径不得彼此重叠，也不得与其他 worker 的读路径重叠；目录与子文件同样算重叠。需要读前一个写者产物时，用 `dependsOn` 排到后续波次。
3. `parallel-write.cjs prepare` 只准备**一波无依赖任务**。先集成并验证前序波次，再从新基线为下一波创建计划和 worktree；把全计划都建在旧基线后仅延迟启动，无法满足读写依赖。

```text
node scripts/parallel-write.cjs prepare --plan <单波计划.json> --repo <干净仓库根目录> --out <仓库外全新目录> --approved-plan <完整planDigest> --write-opt-in
```

要求 Git 2.38+、Node.js，以及可用的本地 Git 文件系统。输出目录的父目录须已存在，目录本身须全新且位于所有注册 worktree 和 Git common dir 之外。脏源工作树、符号链接或 submodule 源树会拒绝，保留原内容供核对。

每个单元获得真实且锁定的独立工作树，分支为 `codex/parallel-<runId前缀>-<序号>-<unitId>`；`run.json` 记录完整基线提交、计划摘要、Git common dir、管理目录、分支与恢复清单。worker 只在自己的工作树提交线性历史，禁止合并其他分支、改共享 Git 配置、hooks 或其他已有 refs。只读单元不得提交文件改动。

准备工具会隔离 `GIT_*` 环境覆盖，关闭 Git hooks、fsmonitor 和内容过滤器；自定义 merge driver 按失败处理。不会执行项目安装、测试、网络连接或部署。依赖自定义过滤器才能还原的工程须另行评估，不能把未还原的内容当作已具备运行环境。

## 核验每一个提交，再核验组合结果

```text
node scripts/parallel-write.cjs verify --run <运行目录>/run.json
```

核验包括：

- 原仓库身份、HEAD、干净状态、原有 refs 和共享配置仍匹配记录；工作树注册、管理目录、锁与分支也须一致。
- worker 没有暂存、未暂存或未忽略的未跟踪改动，写 worker 已提交结果；每个提交均是当前基线后的线性历史。
- **逐个提交**核对 `ownedPaths`，而非只看最终差异。临时越界后再还原仍会被拒绝；重命名同时检查旧、新路径，删除同样检查，链接和 submodule 不作为普通文件放行。
- 用 Git `merge-tree` 对这些精确 heads 顺序计算集成结果。目录重命名等 Git 冲突仍会拒绝，即使文本路径看似互斥。
- 预演后再次核对源和 worker 的 HEAD、状态与共享配置/refs；期间变化就停止，重新核对。

成功返回 `READY_FOR_REVIEW`、每个 worker 的 `head/commits/changedPaths` 与 `integrationTree`。该命令可能计算新的 Git 对象，但不修改已有分支、暂存区或工作文件，也不自动合并。审阅这些精确 heads 后再串行集成，集成后的源码必须重跑项目测试；结果不等于功能、安装或部署验收。

Git worktree 共享 refs、配置、hooks 与对象库，**不是文件系统或权限沙箱**。检查主要约束可集成的源码变更，不证明 worker 从未写过 ignored 文件、外部目录或外部服务；这些边界仍由宿主权限和 worker 契约约束。`run.json` 是本地操作记录，不是签名授权凭据。

## 并行结果回传不串行丢失

每个 worker delta 原样带回 pack 的 `contextVersion` 和 `planDigest`。同一轮的多份结果用：

```text
node scripts/parallel-context.cjs merge-batch --context <context.json> --delta <A.json> --delta <B.json> --json
```

1–8 份 delta 必须对应同一当前版本和计划，单元不得重复；任何一份过期、越权字段、敏感内容或格式错误都使整批失败。全部通过才提交一次，版本只增加 1；输入文件保留。跨版本结果仍须重新取得当前 pack 后重报，不能通过批次绕过版本检查。

`init/merge/merge-batch` 共用 `.context-write.lock`，锁内重读并核对原文件快照。`pack --out` 使用 `packs/<unit>.json`，不得指向 `context.json/plan.json/context.md/.context-write.lock` 或其路径别名。未知锁或其他写者占用时返回 `CONTEXT_BUSY`，不擅自删除锁或接管工作。

## 失败后保留可以核对的现场

- prepare 中断或失败时，`run.json` 标为 `PREPARE_FAILED` 并保留已创建的工作树、分支和恢复路径。不要原目录重复准备，不要强制清理；先读回实际 Git 注册和改动，再决定处置。
- verify 拒绝时保留全部 worker 提交与文件。路径越界先审查，基线推进需重新规划；冲突回到协调者顺序处理，不自动 reset、stash、clean 或覆盖。
- 上下文输出先暂存，canonical JSON 最后发布；普通失败按文件归属恢复。若非合作写者改了内容或恢复失败，返回 `CONTEXT_RECOVERY_REQUIRED`，保留 `.context-txn-*/RECOVERY.json` 与 before 文件。多文件发布不是操作系统级整体原子事务；异常退出后用 `check` 核对 JSON、计划和镜像再接续。
- 收口前由协调者核对产物、集成和测试证据。有改动或归属不明的 worktree 不删除；仅在确认无待保留内容后，按记录的精确路径解锁并移除，不用强制删除替代验收。
