---
name: continuation-state-audit
description: "Audit continuation queues/goal files before resuming，claimed done vs real artifacts，detect stale items；Qoder 异常会话恢复（定位会话、最小窗口读取、单次结构化恢复消息、终态回调＝成功判据）。触发：接续/继续上次/看队列/核对上次完成状态/上次说做完了但没生效/会话恢复/异常会话。Not for goal tracking/checkpoint writes（→goal-driven-execution）。"
---

# Continuation State Audit

Verify that "done" in the queue actually means done in the filesystem, git, and test output — before resuming work.

## When This Fires

- User says "接续 / 继续上次 / 接着做"
- Restoring from an archived session
- Taking over another session's `.qoder-work-queue.md` or goal files
- Suspicion that queue status drifted from reality

## What Existing Skills Don't Cover

| Skill | Covers | Gap |
|---|---|---|
| `checkpoint` | Write "current state / next / blocker / entry" | Doesn't verify the previous "done" was real |
| `goal-driven-execution` | Track current-session goals to completion | Doesn't audit cross-session遗留 queues |
| `verify-before-claim` | Single assertion must be falsifiable | Doesn't reconcile an entire queue ledger vs artifacts |

This skill fills the **reconciliation** gap: queue ledger vs actual artifacts, cross-session.

## Audit Procedure

### 1. Inventory Continuation Carriers

Scan and list all entries from:
- Project root `.qoder-work-queue.md`
- `goals/` directory (if present)
- `B0x` batch cards (if present)

For each entry, note: claimed status (done / in-progress / todo), responsible session, and stated artifact.

### 2. Reconcile Each "Done" Entry

Every "done" entry must have at least one verifiable artifact:

| Claimed artifact type | Verification |
|---|---|
| Code change | `git log` or `git diff` hits this session's commit or working tree |
| Script fix | Script file exists **and** was executed this round (exit code + log timestamp) |
| Checker/validator adjustment | Adjusted checker **re-run** with result saved |
| Backup | `backup-file.js` output exists and md5 matches pre-change state |
| Config change | Target file content matches stated value |
| Credential merge | Pointer file exists, target file has the entry, no plaintext in pointer |

**Drift fingerprint**: record and recompute a content hash (prefer SHA-256) for each explicit artifact, with task/session/cwd and sampling time. Byte size, mtime and `git status --short` are only supporting state evidence, not content fingerprints. On mismatch, establish ownership before updating the ledger; never overwrite another session's changes. A matching hash proves only unchanged bytes, not correctness or successful execution.

### 3. Detect Three Breakpoint Types

- **未 apply**: Script/patch written but never executed (check mtime, log, exit code)
- **未复验**: Checker itself was modified but not re-run
- **提前标完成**: Queue says "done" but artifact is missing or inconsistent

### 4. Correct Breakpoints

For each red breakpoint:
1. Re-run the script / re-validate / re-backup
2. Re-reconcile to confirm it turns green
3. Only then update queue status

**Default is read-only report**. Correction actions require explicit user approval (follow global "preview match scope before risky ops" discipline).

### 5. Update Ledger

- Only change status for entries **verified this round**
- Unverified entries keep original status with note "未验证"
- Never batch-update based on assumption

### 6. Write Next Checkpoint

Call `checkpoint` skill to write the next continuation point, including this round's reconciliation evidence.

## Qoder 注册会话故障审计与恢复分支

场景：用户要求「接续/恢复某个 Qoder 会话」，但会话异常终止或续接失败。本分支审计注册会话状态并做一次受控恢复。

### 定位与最小窗口读取

1. `list_chat_sessions` 定位真实 sessionId（标题/时间匹配，不猜 id）。
2. `read_chat_session` 用**最小窗口**：`turnLimit=2`、`includeToolOutputs=false`、较小字符预算——首轮用 8 轮＋工具输出会产生约 80KB 截断。
3. 输出仍过大时，不整读：针对落盘结果（队列/日志/产物）定点检索。

### 故障分层

| 现象 | 判定 |
|---|---|
| 上一工具正常返回判红（有完整工具结果） | 正常执行路径的问题，按返回内容处理 |
| 后续助手空响应且零工具调用 | **执行前失败**（请求没跑起来），不是业务红——恢复动作不同 |

### 受监督会话的终态取证

- 快照缺少终止原因时，按会话、请求 ID 和日志时区定点读取运行日志，区分输出截断、工具失败、认证错误与网络错误；看到 Write 失败不能直接认定文件未写入或网络有问题。
- 出现 max_output_tokens 等输出上限后，先核对部分文件、内容摘要和队列状态，再用小段编辑续接，不用成功回调或文件存在代替内容验收。
- 审批交互返回 expired 时先读原问答和当前运行态，区分已处理、被替代与仍未批准；自动回调不算用户确认，也不能据此重复授权或绕过平台审批。
- 只有当前授权包含恢复/派发时才发送一次结构化恢复消息；用户要求只核对、只交接或不创建新会话时不派发。请求已接受、运行中、任务完成分别记录，不为消除父会话提醒提前关单。

### 单次恢复与成功判据

1. 只发送**一次**结构化恢复消息：写明断点（做在哪格）、失败项（哪几步红）、下一步第一件事；不用无上下文的「继续」。
2. 成功判据＝**等监督回调并检查终态**，不是 `opening/running/streaming` 状态——那些只证明请求已进入。
3. 恢复仍失败：改用**同目录分叉**（fork same-directory）带同一份队列开新会话，不反复原地重发。

## Script: audit-queue-state.js

Location: `scripts/audit-queue-state.js` (relative to this skill)

Purpose: Scan queue file, check artifact existence/mtime/git-hit for each "done" entry, output red/green table.

Usage:
```bash
node ~/.qoder/skills/continuation-state-audit/scripts/audit-queue-state.js [queue-file-path]
```

Default queue file: `.qoder-work-queue.md` in project root.

Output format:
```
[QUEUE AUDIT] 2026-10-22T10:30:00Z
Scanning: .qoder-work-queue.md

✓ Entry-001: 凭据合并 → git commit abc123, backup exists
✗ Entry-002: 脚本修复 → script exists but never executed (no log)
✗ Entry-003: 校验器调整 → checker modified but not re-run
✓ Entry-004: 配置变更 → file content matches

RED: 2 / 4 entries
- Entry-002: 未 apply
- Entry-003: 未复验
```

Exit codes:
- 0: all green
- 1: red entries detected
- 2: queue file not found or parse error

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Overlap with `checkpoint` / `goal-driven-execution` / `verify-before-claim` | Description explicitly states "cross-session遗留 queue" boundary; first step declares what this skill doesn't replace |
| Audit script false positive (mtime close but content wrong) | Script uses md5 + git diff dual evidence, not just mtime |
| "Audit" becomes "auto-fix" without approval | Default read-only report; correction requires explicit user approval |
| Too many queue entries overflow context | Script output is summary table + red entry details only; green entries collapsed |

## Validation

After creating this skill, verify:

- **Positive control**: Construct a fake legacy queue with one "done" entry but script not executed → skill should detect red
- **Negative control**: Construct a queue with all "done" entries having real artifacts → skill should report green, no false alarms
- **Format check**: SKILL.md frontmatter valid, name matches directory, description ≤1024 chars, body <500 lines
- **Trigger test**: Input "接续上次任务" or "核对队列完成状态" in a session → should trigger this skill
