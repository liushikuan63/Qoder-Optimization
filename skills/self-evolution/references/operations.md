# 本地证据日志与回退

工具位置：`~/.qoder/skills/self-evolution/scripts/evolution.js`。默认数据目录：`~/.qoder/evolution`。仅依赖 Node.js 内置模块，不请求网络、不启动模型、不读取完整对话。

## 查看与开关

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js status
node ~/.qoder/skills/self-evolution/scripts/evolution.js pause
node ~/.qoder/skills/self-evolution/scripts/evolution.js resume
```

状态为暂停时停止自动写入。只有当前用户明确要求纠正/撤销等维护，才在相应 `record`、`checkpoint`、`commit` 命令使用 `--user-requested`，并在输入或验证说明中引用该请求。这个参数表达调用原因，不提供新的授权。

`status` 返回的是有限摘要；需要旧主题时定向读取 `records/` 中对应 JSON，勿把整个历史塞入上下文。汇总数字只用于定位证据；仍须检查反例、来源、时间和范围。

## 记录证据

例：以下是格式示例，只有真实发生同类用户要求时才能创建对应记录。

```json
{
  "type": "observation",
  "topic": "ci-evidence-first",
  "scope": "global",
  "summary": "用户明确要求先展示实际失败步骤再讨论原因；已有技能覆盖，复用原技能。",
  "evidence": {
    "task_id": "真实任务或任务卡标识",
    "session_id": "实际可用的会话标识；未知则省略此字段",
    "source": "user",
    "detail": "用户原意的最小必要摘要，不保存完整聊天。"
  },
  "explicit": true,
  "verified": false
}
```

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js record --input 'E:\path\work\evidence.json'
```

`type`：`observation`、`correction`、`capability-gap`、`rejection`。
`source`：`user`、`local-validation`、`memory`、`external`。`explicit=true` 只适用于用户来源。`verified` 表示确实做过验证，不是"认为正确"。不得复制本页示例充当真实学习记录。

范围可写 `global`、`project:D:\具体项目` 或清楚的技术栈范围。来自同一任务、主题和范围的多条记录不会增加独立任务数量。推断推广还需要真实跨会话证据；未知会话不能凑数。

## 对已有文件留快照

准备 checkpoint 输入：

```json
{
  "reason": "本次明确请求或已核实证据，以及拟解决的问题",
  "scope": "global",
  "paths": ["C:\\Users\\Admin\\.qoder\\AGENTS.md"]
}
```

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js checkpoint --input 'E:\path\work\change.json'
```

保存返回的变更 ID；再次确认文件与快照一致，再编辑和实际验证。不要批量重写所有全局文件。

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js commit --id '实际ID' --validation '实际执行的检查及结果'
```

工具允许对 AGENTS.md、settings.json 和个人技能文件做本地快照；不允许 `.system`、插件缓存或其他任意目录。目录合法不等于具备修改授权，仍须遵循技能的行为边界。新文件先在任务工作目录验证，记录安装清单后创建；本工具的已有文件回退不负责卸载新增目录或撤销外部账户状态。

### 改 hooks 时的额外要求

hook 由两部分组成：`~/.qoder/scripts/` 下的脚本 + `settings.json` 的 `hooks` 接线。`settings.json` 在快照白名单内，**脚本目录不在**——所以脚本改动要用 `cp` 手动留备份（建议 `~/.qoder/.backups/<日期>-<tag>/`），并靠版本控制 / 分享包回滚。

改完必须四件都做，缺一不算生效：

1. 脚本自测跑通：`node <脚本>.test.js` 或 `<脚本> --selftest`（含"该拦必拦 + 不该拦不许拦"的对照）；
2. **两侧** `settings.json` 都接线且逐条一致（只挂一侧即静默失效）：`node ~/.qoder/scripts/global-config-guard.js --check` 会报接线缺失、两侧不一致、以及**指向不存在的脚本**；
3. 纳入周检：`node ~/.qoder/scripts/rules-weekly-audit.js --no-fix` 零新增告警；
4. **新开一次会话**确认真的触发（心跳日志 / 门禁台账有记录）——"接线在"不等于"真的跑过"。

**只加严不放松**：不静默削弱或摘掉既有拦截；确要停用某条 hook，显式说明理由并留回退路径。hook 是 fail-open（非零退出码 / 超时默认放行），别当安全边界。

`checkpoint`/`commit` 的名称是本地日志动作，不是 Git commit，也不会提交或推送仓库。

## 回退与冲突

```bash
node ~/.qoder/skills/self-evolution/scripts/evolution.js rollback --id '实际ID'
node ~/.qoder/skills/self-evolution/scripts/evolution.js rollback --id '实际ID' --apply
```

先预览。`--apply` 只在全部文件仍匹配记录的修改后哈希时恢复；先保存现状，再逐文件写入。暂停期间也允许用户要求的回退。

若有其他会话改动，不强行恢复整文件。使用保存的修改前/后内容定位本次差异，创建新的 checkpoint，并合并撤销唯一可确认的区块；不能唯一识别就保留现状并说明具体冲突。用户明确要求维护时可用 `--user-requested`，不用恢复全部自动学习。

文件锁只协调使用此工具的调用；不控制其他编辑器。单文件替换为原子写入，多文件回退不是系统级事务；中途发现并发修改会停止并保存已恢复清单，按清单检查后续工作。

验证失败、尚未 commit 的 checkpoint 不能假装是成功变更。`commit` 仅记录修改后快照，不代表验证成功；可如实登记失败结果后做受保护回退，或根据本次明确差异恢复/修正。

## 双端同步

本机的 Qoder 与 Qoder CN 各自有独立的 `~/.qoder/evolution/` 和 `~/.qoder-cn/evolution/`。两侧规则/技能通过 `scripts/sync-global-config.sh` 保持同步，但经验记录（records/）各自独立积累。跨端同步经验记录时，用 `<本机辅助脚本>/sync-evolution.sh --copy-missing` 只补单边文件（与记忆同步同口径）。

## 周期候选扫描（证据晋升）

```bash
node ~/.qoder/scripts/evolution-candidates.cjs --days 30            # 只打印摘要
node ~/.qoder/scripts/evolution-candidates.cjs --days 30 --json     # 完整 JSON
node ~/.qoder/scripts/evolution-candidates.cjs --days 30 --write    # 写 candidates/YYYY-MM-DD.{md,json}
node ~/.qoder/scripts/evolution-candidates.cjs --help
```

- 数据源四个：记忆 feedback（`metadata.type: feedback`）、Stop 门禁违规台账、`evolution/records/*.json`、`evolution/inbox.jsonl`（Stop hook `evolution-capture.cjs` 自动采集，含轮转归档 `inbox.archive-*.jsonl`）。任一源缺失只降级该源并写入 warnings，不中断。
- `--days` 作用于违规台账、records 与 inbox；feedback 没有统一时间字段，报告会标注。
- feedback 正文中的 UUID 只供定位；Stop 违规台账缺少独立 `task_id` 与范围证据，两者不直接形成全局晋升候选。补充有来源、范围和独立任务/会话的规范 records 后再核对；报告仍不授予实际写入权限。
- inbox 候选的晋升判据：长期要求/纠正需**同时**跨 ≥2 会话与 ≥2 工作目录才建议全局，否则只建议局部；能力缺口需 ≥2 会话或 ≥2 目录；单轮内重复失败（`occurrences` 再大）只算观察；助手自述的「已否证/验证结论」属技术经验，跨会话也只建议局部。`task` 以工作目录名为代理，**不等于独立任务**，每条候选都带这句核对提醒。
- inbox 摘录二次脱敏后才进报告；`verified` 一律 `false`，助手「验证结论」也只是待核对材料，不得当成已验证事实。
- records 的空值/数组、无效或未来时间、不合法主题会被忽略并计入 warnings；非字符串任务/会话身份不作为独立证据。
- 退出码：0 正常（含无候选）；2 参数错误或输出目录不可写。
- 报告不复制记忆正文，只含文件名、描述摘要和关键词计数；覆盖检测是关键词初筛，不是晋升结论。
- 报告默认只读；`--write` 只写 `evolution/candidates/`，不写规则、技能、hook、MCP 或数据库。

### 采集链路存活取证（谁看住看门的人）

采集是每轮 Stop 触发的确定性机制，必须有独立通道确认它还活着；月度报告任务已内置以下只读检查：

```bash
tail -n 3 ~/.qoder/evolution/inbox.jsonl                        # 最近候选与 at 时间戳
tail -n 5 ~/.qoder/tmp/evolution-capture/heartbeat.log          # 最近一次 Stop 触发
node ~/.qoder/scripts/evolution-capture.cjs --report            # 只读汇总：byKind / 跨会话主题
cat ~/.qoder/evolution/control.json                             # enabled=false 即用户已暂停（正常）
```

- `sources.inbox.status=missing` 或 `records=0`：先核对两侧 `settings.json` 的 Stop 组是否同时含 `stop-gate.js` 与 `evolution-capture.cjs`，再看心跳；只取证汇报，不静默补接线。
- `control.json` 的 `enabled` 非布尔＝配置非法，停下报告，**不重置、不改写**。
- 采集 hook 永远 `exit 0`（fail-open），不替代平台权限，也不会因为采集失败挡住收尾。
- 心跳里的 `pending=N` 表示本轮生成了 N 条待弹建议；`ASKED … pending=cleared` 表示本轮已就建议弹窗、状态已消费。只有 `CAPTURE … pending=0` 而用户抱怨"没弹窗"时，先看是不是重复证据、经验族、已拒绝主题或单次能力缺口（都不够格）。
- 心跳 `SKIP_READ_ONLY` 但本轮明明在实施：多半是**上下文压缩摘要**被当成了用户指令（摘要里引用了"只读预览"这类规则原文）。采集已按宿主的 `isCompactSummary` 标记排除摘要，并在尾窗取不到真实指令时按 `backtrackBytes`（默认 8MB）有界回溯；仍出现时先用 `--dry-run --transcript <真实转录>` 看 `scope`，再核对真实指令距文件末尾的字节数是否超了回溯上限。**不要靠放宽只读正则来"修"它**——真只读轮必须继续零采集。
- 心跳 `SKIP_NO_TRANSCRIPT`：**transcript 文件真不存在**（路径错 / 会话还没落盘）。核对 `transcript_path` 与 `~/.qoder/projects/<项目目录>/<会话>.jsonl` 是否存在。
- 心跳 `SKIP_NO_USER_TEXT … parsed=N tail=… back=…`：文件在，但尾窗与有界回溯范围内都没有真实用户指令（全是工具回执 / 注入件 / 压缩摘要 / 后台通知）。这是诚实跳过，不是故障；不臆造指令、不拿摘要顶替。读数用来分辨"窗口太小"还是"真没有指令"。
- **运行中插话也算真实指令**：用户在 Agent 运行中插话的提示被宿主写成 `attachment.queued_command`（`commandMode:"prompt"`），**没有 `role=user` 条目**。识别器 `queuedUserTextOf` 在共享核 `evolution-signal-core.js` 里，采集与门禁都调它。排错要点：`commandMode:"task-notification"` 是后台通知不是指令（判据是 `commandMode`，不是 `<task-notification>` 前缀黑名单）；助手正文里引用的同形 JSON 不算（`message.role==='assistant'` 早退）。若怀疑漏读，用 `--dry-run --transcript <真实转录>` 看 `userTextLen` 是否 >0——**为 0 时后面所有 scope / 候选判据都是空转**。
- **指令与证据的窗口不对称**：指令可由 `backtrackBytes`（默认 8MB）回溯取到，但**证据（助手正文 / 失败工具）只从 `tailBytes`（默认 1MB）尾窗累积**。超长单轮里早期证据滑出尾窗 → 诚实 `NO_SIGNAL`（实测同一份 12MB 转录：1MB→0 候选、4MB→2 候选，`userTextLen` 恒 49）。要覆盖长单轮就调大 `~/.qoder/evolution-capture.json` 的 `tailBytes`，别误判成识别缺陷。
- **宿主什么时候才派发 Stop**：正常交互轮会（实测当天 61 次真实 Stop，含一次完整调用采集并写心跳）；**目标连续续跑期间不产生回合边界事件**（实测 90 分钟零 Stop / 零 UserPromptSubmit，同期 PreToolUse 579 次）。所以"每轮收尾弹窗"在连续续跑里要等运行真正收尾才出现。取证口径：`stop-gate.js` 的 `diag()` 无条件写 `tmp/stop-gate/last-invocation.json`，它的 mtime 就是"最后一次被宿主调用"的硬证据；宿主日志里搜 `"hookEvent":"Stop"` 可数真实派发次数。
- 尾窗与回溯块都**按行边界切字节**（0x0A 不会出现在多字节 UTF-8 序列内部）。按固定字节切再用字符串拼，缝落在汉字中间时两侧各得一个 U+FFFD，而 `JSON.parse` 仍成功 → 关键词静默失配：偏好漏采、只读误判，心跳看起来却正常。`evolution-capture.test.js` 的 ⑯ 组把缝精确造在关键词内部（夹具按**对齐后**的窗口起点解析求填充长度），并带"改回字符串拼必红""尾窗不对齐必红"两条变异对照。
- 门禁侧同口径：`stop-gate.js` 的 `scanTranscript` 也排除 `isCompactSummary`（顶层与 `message` 两处标记都认）。否则摘要会把 `taskScope` 判成只读轮，R19 整轮静默失效——用户要求的收尾弹窗再也不弹。`stop-gate.test.js` 的 `compact-summary-accepted` 变异对照看住这条。

## 收尾建议弹窗与拒绝登记（Stop 门禁 R19）

采集写候选，门禁负责"必须把建议交给用户拍板"。两者共用判据核 `evolution-signal-core.js`（`popupWorthy` / `isEvolutionAsk`），不各抄一份。

```bash
node ~/.qoder/scripts/evolution-capture.cjs --report                  # 只读汇总：byKind / 跨会话主题 / pending 会话数 / declined 主题数
node ~/.qoder/scripts/evolution-capture.cjs --report --json           # 同上，机器可读
node ~/.qoder/scripts/evolution-capture.cjs --dry-run --transcript <path> [--session <id>] [--cwd <dir>]
node ~/.qoder/scripts/evolution-capture.cjs --decline <主题> [--decline <另一个主题>]
```

- 待弹状态：`~/.qoder/tmp/evolution-capture/pending-<会话前8位>.json`，最多 6 条、**24 小时过期**（过期即不再拦）。`--dry-run` 输出 `writes: 0`、`askedEvolution` 与 `wouldPopup`，**零写入**。
- 够格才弹：用户明确的长期偏好 / 明确沉淀 / 重复纠正一次即可；能力缺口、重复失败需 `occurrences ≥ 2` 或跨 ≥2 会话；助手 `已否证：`/`验证结论：` 经验族只进报告不弹窗；重复证据与已拒绝主题不再弹；**本轮已弹过建议卡就不再追加**（每轮最多问一次）。
- 门禁 `R19-evolution-suggestion-not-asked`：有未过期 pending 且本轮没弹过建议卡 → `decision: block`，reason 列出主题、证据次数、推荐载体与摘录。只读 / 仅交接 / 禁记忆 / 已暂停的轮次放行。
- 满足条件＝本轮调用过 `AskUserQuestion` 且卡面文本含「自进化 / 沉淀 / 候选 / 载体 / 采纳 / 学到的」之一。开工确认卡、临时文件清理卡**不算**（测试有对照）。
- 三个真实选项：采纳并落到推荐载体（推荐）/ 改写后采纳 / 本轮跳过。**采纳才动载体**，且仍走 `carrier-preflight` → 备份 → 最小差异 → 实际验证 → `evolution.js record`；弹窗不是授权。
- 跳过登记：`--decline <主题>` 写 `~/.qoder/evolution/suggestions-declined.json`，并把这些主题从所有 pending 撤下（撤空即删文件）。输出 `declined=N removed_from_pending=M total=K`；缺主题参数退出 2。**只过滤弹窗，inbox 证据保留**，月报仍能看到；要恢复弹窗就手工删拒绝表里的对应主题。
- 兜底：R19 在 30 分钟滑动窗口内最多拦 2 次（整会话所有规则合计上限 3 次），超限写 `R19-…-SUPPRESSED` 台账后**可见放行**，不静默摘守卫；台账在 `~/.qoder/tmp/stop-gate/violations.log`。
- 自测：`node ~/.qoder/scripts/evolution-capture.test.js`、`node ~/.qoder/scripts/stop-gate.test.js`、`node ~/.qoder/scripts/evolution-loop.test.js`（真实两个 hook 串跑的闭环，含"改坏采集→门禁放行"的可失败对照）。
