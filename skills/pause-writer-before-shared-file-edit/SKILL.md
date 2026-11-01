---
name: pause-writer-before-shared-file-edit
description: "编辑会被并行会话/自动机制改写的文件（技能 description、记忆索引、台账、evolution 状态）时的防竞态流程：先证明有并发写入方（mtime+字节数）→ 官方 CLI 暂停（evolution.js pause，不手写 control.json）→ 暂停后重新扫描再动手 → 扫描红当「暂定」，复跑一次再判 → 改完 resume 并记录基线。触发词：并发写入、并行会话改了我的文件、description 被回滚、悬空引用假红、mtime/size 变了、evolution pause/resume。"
---

# 编辑共享文件前的防竞态流程

## 适用场景

编辑以下文件时，若怀疑有并行会话或自动机制（self-evolution、周检、其他 agent）同时在写：
- 技能 `description`（self-evolution 会 trim、周检会修悬空引用）
- 记忆索引 `MEMORY.md`（多会话可能同时追加）
- 台账 / 状态文件（`control.json`、`work-queue.md`、`evolution` 日志）
- 任何 `mtime` 近期变化且非本会话修改的文件

## 流程

### 1. 检测并发写入方

动手前先看目标文件的 `mtime` 与字节数：

```bash
stat -c '%Y %s' <file>   # Linux/Git Bash
# 或 PowerShell: (Get-Item <file>).LastWriteTime; (Get-Item <file>).Length
```

若 `mtime` 在最近 5 分钟内且非本会话改动，或字节数与预期不符（如本轮剪到 298 字，3 分钟后变回 842），说明有别的写入方在动。**停下，不要继续编辑**。`mtime` 与字节数只是线索，不能单独证明改动归属；要结合哈希、内容差异和本轮自己的写入记录判断。

### 2. 暂停写入方

用官方 CLI 暂停 self-evolution 的自动调整：

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js pause
```

**不要手写 `control.json`**——脚本会做格式校验、原子写入和状态记录；手写容易写错字段或漏掉时间戳。

暂停后脚本输出 `Self-evolution paused; status and rollback remain available`。

### 3. 暂停后重新扫描

暂停后再跑一次原本报红的检查（如 `rules-weekly-audit.js`、`carrier-preflight`）：

- 若红消失 → 之前的红是对方正在写文件的瞬时快照，现在可以安全编辑
- 若红仍在 → 真实问题，按正常流程处理

**不要把第一次扫到的红直接当结论批准**。本轮 DANGLING-REF 与 NO-SKILL-MD 两条红都是对方正在写文件的瞬时快照，复跑即消失；若照批准直接"删掉失效引用"就会删掉一条真实存在的 20KB 脚本引用。

### 4. 编辑并记录基线

确认安全后编辑目标文件。编辑完立刻记录基线（mtime + 字节数 + 哈希），用于后续比对：

```bash
stat -c '%Y %s' <file>
sha256sum <file>
```

### 5. 恢复写入方

编辑完成并确认无冲突后，恢复 self-evolution。**只恢复本轮由本技能亲自暂停的写入方**；若暂停状态不是本轮建立、或无法确认归属，保持暂停并报告，不得擅自 resume。

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js resume
```

## 不适用场景

- 独占文件（本会话独占、无并行写入方）
- 普通代码文件编辑（git 已提供并发保护）
- 只读扫描（不修改目标文件）

## 关键纪律

- **先证明有并发写入方再暂停**：不要仅凭怀疑就暂停，用 mtime + 字节数说话
- **暂停后必须复跑再判**：瞬时快照≠真实问题
- **不要手写 control.json**：用官方 CLI
- **改完立刻 resume**：暂停是临时状态，不要长期保持
- **记录基线**：编辑后的 mtime + 字节数 + 哈希用于后续比对
