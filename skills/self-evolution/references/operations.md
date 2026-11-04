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

- 数据源：记忆 feedback（`metadata.type: feedback`）、Stop 门禁违规台账、`evolution/records/*.json`。任一源缺失只降级该源并写入 warnings，不中断。
- `--days` 只作用于违规台账和 records；feedback 没有统一时间字段，报告会标注。
- feedback 正文中的 UUID 只供定位；Stop 违规台账缺少独立 `task_id` 与范围证据，两者不直接形成全局晋升候选。补充有来源、范围和独立任务/会话的规范 records 后再核对；报告仍不授予实际写入权限。
- records 的空值/数组、无效或未来时间、不合法主题会被忽略并计入 warnings；非字符串任务/会话身份不作为独立证据。
- 退出码：0 正常（含无候选）；2 参数错误或输出目录不可写。
- 报告不复制记忆正文，只含文件名、描述摘要和关键词计数；覆盖检测是关键词初筛，不是晋升结论。
- 报告默认只读；`--write` 只写 `evolution/candidates/`，不写规则、技能、hook 或数据库。
