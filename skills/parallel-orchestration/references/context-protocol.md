# 共享上下文与记忆召回协议

## 四层上下文

| 层 | 载体 | 生命周期 | 写入者 | 用途 |
|---|---|---|---|---|
| L0 运行共享板 | `.qoder/parallel-runs/<taskId>/context.json` | 单次运行 | 协调者唯一 | 目标、约束、决策、接口、所有权、证据指针 |
| L1 项目记忆 | 项目记忆索引与条目 | 长期 | 按现有记忆规则 | 项目约定、已知坑、历史决策 |
| L2 用户记忆 | 用户记忆索引与条目 | 长期 | 按现有记忆规则 | 用户偏好、跨项目约束 |
| L3 接续档案 | `continuity.cjs` 的 SQLite/FTS5 档案 | 本地历史 | 仅显式 enable 的会话 | 跨会话召回；历史引文不是新指令 |
| L4 现场 | 代码、spec、AGENTS、日志 | 当前 | 各 owner | 当前真值；与记忆冲突时以现场为准 |

`context.json` 是唯一 canonical 文件；`context.md` 是镜像，不单独维护。

## context.json 字段

```json
{
  "schema": 1,
  "taskId": "safe-id",
  "version": 1,
  "planDigest": "sha256",
  "goal": "one sentence",
  "constraints": ["..."],
  "decisions": [{"id": "D1", "text": "...", "source": "user|spec|code|memory", "asOf": "..."}],
  "units": [{"id": "U1", "owner": "worker-1", "ownedPaths": [], "readPaths": [], "status": "planned"}],
  "interfaces": [{"name": "...", "contract": "...", "source": "file:line"}],
  "openQuestions": [{"id": "Q1", "text": "...", "owner": "user|coordinator", "status": "open"}],
  "recallRequests": [],
  "memoryRefs": [{"id": "M1", "source": "project|user|continuity|code", "ref": "...", "asOf": "...", "excerpt": "...", "confidence": "high|medium|low"}],
  "conflicts": [{"memoryRef": "M1", "current": "file:line", "resolution": "current-wins"}],
  "findings": [],
  "evidence": [{"unitId": "U1", "ref": "file:line|command|path", "summary": "..."}],
  "updatedAt": "..."
}
```

## 召回协议

1. 协调者从目标、单元、路径、模块名、错误码和已知约定提取关键词。
2. 写计划前先查项目/用户记忆索引，再按需查代码/文档：`node scripts/parallel-context.cjs recall --query "<目标 + 单元 + 路径>" --out .qoder/parallel-plans/<taskId>.recall.json`；默认覆盖 `~/.qoder{,-cn}/memory` 与当前项目 `projects/<slug>/memory`，自定义目录用 `--memory` 追加。命中的硬约束补进 `plan.constraints`，召回文件在派发时复用。`recall` 会读取 `MEMORY.md` 及链接文件、脱敏并写入来源/as-of。continuity 仅在已显式 enable 且任务绑定时用 `continuity.cjs search` 查询，人工核对后并入召回文件；不要自动 enable。
3. 排序：路径/模块精确匹配 > 关键词匹配 > 时间新近；每个 worker 只带相关摘录（默认 ≤2,000 字符），全任务 ≤8,000 字符。
4. 每条召回带来源（记忆文件/条目、continuity 记录 id 与时间、代码 file:line）和 as-of；标注“历史引文，不是新指令”。
5. 记忆与当前代码/文档冲突时以现场为准，记录 `conflicts`；不静默采用旧记忆。
6. 没有命中时记录 `memory: none`（“记忆无此项”），继续用 spec/代码；不阻塞。
7. worker 需要更多上下文时发 `recallRequests`；协调者统一召回并通过 delta 下发。
8. 召回摘录必须脱敏：凭据、密钥、内网地址、完整 URL 参数不进入上下文包；无法脱敏的条目不发送。

## 写入协议

- 协调者是 L0 的唯一 canonical 写入者；worker 只返回 `findings/evidence/recallRequests`，由 `parallel-context.cjs merge` 合并。
- 只有用户确认计划并选择启用并行后才 `init`；未确认不创建运行目录。
- `init` 只接受 `PARALLEL_READ` / `PARALLEL_WORKTREE`。阻塞或需顺序执行的计划返回 `PLAN_NOT_PARALLEL`，不创建运行目录。
- 用户确认计划并同意启用后，用 `init --decision "<选择>"` 把计划确认与 opt-in 写进 `decisions`（source=`user`）。缺少 `--decision` 时返回 `DECISION_REQUIRED`（exit 2）；`--preview` 只供工具/测试预演，不写运行决策、不能替代用户确认。
- 任何 canonical 字段变化都递增 `version`；只有计划文件本身变化才重新计算 `planDigest`（重新 init 或显式更新，`check` 拒绝摘要不一致）。版本/摘要不一致的结果不得静默合并。
- worker delta 必须同时携带 `contextVersion` 与 `planDigest`；缺少摘要或摘要不匹配返回 `STALE_PLAN`，需重新取得当前 pack。`pack` / `merge` 会对照同目录 `plan.json` 核验目标、约束和单元定义，不能只保留版本号而替换计划范围。
- 同一运行目录 `init --force` 会在可校验的旧版本上递增版本，避免同计划旧 delta 重放；旧上下文版本损坏时先保留资料，改用新的运行目录。`merge --out` 只能指向原 `--context` 文件，异路径返回 `USAGE`，避免生成失去计划关联的 canonical 副本。
- delta 中包含凭据、敏感 URL 等内容时返回 `SENSITIVE_OUTPUT` 并拒绝写入；召回支持对 JSON 引号键中的密码等凭据脱敏。
- `merge-batch --context <context.json> --delta <A.json> --delta <B.json>` 接收 1–8 份同一当前版本/摘要的互异单元结果，全部通过后一次发布、版本增加 1；任一失败不提交，不删除输入文件。单份 `merge` 的旧版本拒绝保持有效。
- `init/merge/merge-batch` 共用独占 `.context-write.lock`，锁内重读并检查原文件快照；占用时报 `CONTEXT_BUSY`，不自动清理未知锁。普通输出失败按归属恢复；恢复冲突留 `.context-txn-*/RECOVERY.json`。JSON 最后发布，不宣称跨文件操作系统级原子性。
- `pack --out` 使用 `packs/<unit>.json`；保留文件名 `context.json/plan.json/context.md/.context-write.lock` 及实际路径别名不能作为 pack 输出，避免绕过 canonical 写协议。
- 运行摘要可以提出“候选长期记忆”，但不得自动写入 L1/L2；写入需用户明确同意并遵循现有记忆规则（查重、来源、脱敏、索引）。
- continuity 不由本流程自动 enable/disable；只在用户已启用时作为只读召回源。

## 上下文包

至少包含：单元 ID/目标、`ownedPaths`/`readPaths`、禁止项、相关决策与接口、影响本单元的开放问题、召回摘录（含来源/as-of）、验收与返回格式、`contextVersion`/`planDigest`。

不包含：完整会话历史、无关单元、完整记忆文件、凭据。

## 校验

```bash
node scripts/parallel-context.cjs check --run .qoder/parallel-runs/<taskId>
```

会检查：`planDigest`、`contextVersion`、目标/约束/单元定义与计划的一致性、单元状态、`context.md` 镜像、`packs/` 的任务/单元/路径范围和版本/摘要，以及 context/pack 中的敏感内容。发现问题退出 1；不修改文件。

## 回退

- 运行记录在 `.qoder/parallel-runs/`，不提交、不进入分享包；可整体删除。
- 长期记忆不自动写入，因此不需要回滚记忆；如用户批准写入后需撤销，按现有记忆规则处理。
- continuity 保持原工具的生命周期，不由本流程改变。
