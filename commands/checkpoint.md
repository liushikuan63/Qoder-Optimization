---
name: checkpoint
description: 快速落盘接续点：把「当前状态 / 下一步 / 阻塞点 / 关键入口」写进项目根 .qoder-work-queue.md 并自检可接续。触发词：落盘、接续点、记录当前进度、保存进度、工作队列
---

# /checkpoint（过程落盘 → 自检可接续）

用途：**任何一格做完、或要中断/换会话之前**，30 秒把现场落盘，保证下一个人（或下一次会话）能直接接手。

## 步骤

1. 读一次现有队列（有就更新，不要覆盖别人的在途条目）：
   - 项目根 `.qoder-work-queue.md`；不存在的就新建。
   - 看到 `【…会话…持有】` 标记的条目**不要动**（那是别的会话在做的）。
2. 按这四节组织内容（缺一节就等于接不了手）：
   - `## 当前状态`：做到哪、**明确未做**什么（已完成项用 `- [x]`，可验证的交付单元各占一行，带证据/退出码）。
   - `## 下一步`：第一件事，具体到能直接开工（未完成项用 `- [ ]`，每条 ≥8 个字，写清做什么）。
   - `## 阻塞点`：外部条件（凭据 / 进程 / 上游规格）；没有就写"无"。**写不出具体条件就别写阻塞**——那等于能做。
   - `## 关键入口`：文件路径 + 可复跑命令；指向尚未创建的文件要标「待建」。
   - 为本机增量档案保留独立行 `任务ID：<task-id>` 与 `责任会话：<真实会话ID>`；仅把本任务内容放在独立行 `[continuity:begin <task-id> <真实会话ID>]` 与 `[continuity:end]` 之间，不把其他任务包进该块。缺少或不匹配时不自动保存共享队列。
   - 把当前授权边界、关键决策及理由、已否证方案、证据原始引用写清；引用包含原文件/消息ID及哈希，不从压缩摘要推测原话。
3. **记录内容指纹与作用域**：仅对本轮交付的明确文件记录 SHA-256（`sha256sum <文件>`），同时写任务ID、责任会话、cwd、采样时间与本轮验证命令/退出码。目录逐文件列出哈希；`git status --short`、字节数、mtime 仅作状态旁证，不能替代内容哈希。接手方复算不一致时先查改动归属，不覆盖他人变化；哈希一致也不等于功能已验证。
4. 落盘后自检（必须 exit 0，否则按提示补齐）：
   ```bash
   node ~/.qoder/scripts/work-queue-check.js
   ```
5. 若关键决策不易复述（排除过哪些方案、为什么），在工作注记里补一段「关键决策与理由」——避免下一个人重新论证。
6. **要交接给新会话时，多写两行**：① 「目标 + 可失败的完成判据」；② 一句「接手方先核对本轮授权与任务ID；目标工具仅在用户或系统/开发者明确要求时使用，再按判据逐格推进」。缺这两行，接续方往往接着做却不知道做到哪算完；但目录里有队列不等于已授权实施。

## 可检索接续档案（continuity，随包 scripts/continuity.cjs）

入口：`~/.qoder/scripts/continuity.cjs`（包内 `scripts/continuity.cjs`）。档案根由 `defaultStore()` 决定：Windows 且存在 D 盘＝`D:/qoder-data/context-continuity`，否则 `~/.qoder/context-continuity`；下文 `<档案根>` 指它，也可用 `--store` 显式覆盖。每会话一个 `continuity.sqlite`（记录与 FTS5 索引入库，游标与恢复状态在库内；`scope.json` 与 `last-*.json` 为状态/心跳文件，`auto-bind.json` 为自动绑定策略，旧 `records/*.json` 首次读取自动迁移并保留原件）。不写长期记忆索引、不上传。

- 自动绑定：后续会话在首个 hook 自动绑定并采集（`<档案根>/auto-bind.json` 为 `{"schema":1,"enabled":true}` 时生效，任务ID形如 `AUTO-<日期>-<目录名>`）；手工任务归属用 `enable --cwd "<工作目录>" --session <真实会话ID> --task <task-id>`。已有绑定不被自动改写，显式 `disable` 后不被自动重开；旧档案不能恢复或扩大授权。
- 采集：每格完成后 `capture --cwd "<工作目录>" --session <真实会话ID>`；已知平台提供的当前 transcript_path 时可加 `--transcript "<原始路径>"`，不猜另一会话路径。
- 采集边界：仅用户正文与以 `决策：`、`已否证：`、`验证结论：`、`证据引用：`、`授权边界：` 开头的助手段落被选择；助手说法仍是待核验证据，不自动升级为事实，不保存思考与工具原始输出。自动绑定只决定「是否记录」，不改变该边界，脱敏照旧。
- 压缩与检索：压缩前保存，压缩后经 `SessionStart(compact)` 恢复短引文；若只收到 `PostCompact`，在下次用户提示恢复。检索用 `search --cwd "<工作目录>" --session <档案会话ID> --query "关键词"`；完整记录用 `show` 加同一 cwd/session 与 `--id <检索返回的完整ID>`；旧队列版本需显式加 `--history`。
- 停用：全局关闭把 `auto-bind.json` 的 `enabled` 改为 `false`（无该文件等同关闭）；单会话停用 `disable --cwd "<工作目录>" --session <真实会话ID>`，停用状态优先于策略、不会被自动重开，历史仍可查；跨会话接手先用队列中的原责任会话ID只读检索。
- 自动清理：先干跑看清单再决定是否删除；手工 `--apply` 必须同时带当前 cwd 与 session，避免误清自己：
  ```bash
  node ~/.qoder/scripts/continuity.cjs prune --cwd "<工作目录>" --session <真实会话ID>
  node ~/.qoder/scripts/continuity.cjs prune --apply --cwd "<工作目录>" --session <真实会话ID>
  node ~/.qoder/scripts/continuity.cjs prune --list-quarantine
  node ~/.qoder/scripts/continuity.cjs prune --recover
  ```
  策略在 `<档案根>/prune.json`（`enabled`/`retentionDays`/`orphanGraceDays`/`protectManual`/`quarantineRoot`/`maxStoreBytes`）。口径：自动绑定会话按 retentionDays 未活动清理；来源 transcript 已消失（会话被删除）的孤儿档宽限 orphanGraceDays（会在备用 transcript 根复核）；`enable` 显式命名的任务档案默认永久保留（`--include-manual` 才纳入）；超容量上限按最旧自动档 LRU 清理。活动时间优先取 `scope.createdAt`，缺失才回退 `scope.json` 的 mtime，**不用当前 mtime 延长寿命**；只有 `records/*.json` 的旧档按 legacy 记录数计，不再误判为空。`SessionStart` 每日至多自动执行一次（节流 + 互斥锁），当前会话与新鲜 capture 锁永远排除；移动前再次抢锁并复核活动时间，扫描后又有采集则跳过。删除前整目录移入隔离区，`manifest.json` 先写 `inprogress`、完成后写 `complete`（逐文件 SHA-256）；隔离区保留 3 批 / 7 天且不轮转未完成批次；崩溃后用 `--recover` 把未完成批次移回档案根，`--list-quarantine` 查看批次。每次 apply 追加审计与缓存，干跑两者都不写；真实库日常先用默认干跑核对候选。
- 若本机另装了独立副本（非随包落点），以随包 `scripts/continuity.cjs` 为真源，改一处后同步另一处并核 SHA-256。

## 判据（做到才算完成）

- `work-queue-check.js` exit 0；
- 队列里没有"只有我知道上下文"的条目（每条的下一步都能直接被陌生人执行）；
- 未在结尾追加"回顾式总结"——落盘是给下一次开工用的，不是给本轮汇报用的。
