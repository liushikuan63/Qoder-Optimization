# hooks 接线（三层机制里的"机制"层，不接不生效）

`scripts/` 里的守卫脚本**只放在磁盘上不会自己跑**——必须在 `settings.json` 的 `hooks.<事件名>` 里接线。
本目录给一份改占位符即可用的接线：`hooks.example.json`（把 `<客户端目录>` 换成你**实际安装的那一个**——`~/.qoder`（国际版）或 `~/.qoder-cn`（CN）；把 `<node>` 换成 node 绝对路径），
并**并入** `settings.json` 的 `hooks` 段（已存在别整文件覆盖）。
**只装了一个客户端**（单端装配）：`<客户端目录>` 全换成那一个（`.qoder` 或 `.qoder-cn`），**另一侧不要建目录、也不要挂第二份**。
脚本里的状态 / 台账 / 索引按 `scripts/client-root.js` 解析到 HOME 下**实际存在**的那一侧；同步类脚本发现只有一侧时只报"单端模式"并退 0，不会 mkdir 出另一个目录。
双客户端都装才各挂一份：只挂一侧会让另一侧静默失效，周检的"两侧接线一致性"就是查这个。

## 事件 × 脚本（与本机现役接线一致）

| 事件 | 脚本 | 超时(s) | 作用 |
|---|---|---|---|
| `UserPromptSubmit` | `rules-reminder.js` | 10 | 每轮注入精简纪律（最易被忽略的兜底）+ 回注本轮请求原文；命中"再次检查 / 重复检查 / 循环检查"等复核词时追加复核协议摘要（`recheck-protocol.cjs`，普通轮不追加） |
| `UserPromptSubmit` | `session-budget.js` | 10 | 上下文体积 / 压缩次数 / 接续队列分档提醒 |
| `UserPromptSubmit` | `fact-ledger.cjs --hook` | 10 | 硬事实登记簿：把 ≤12 条长期硬约束按目录隔离注入每轮；无登记时**零输出**（不占 token）；`/fact` 增删查清 |
| `Stop` | `stop-gate.js` | 10 | 收尾门禁：拦住"声明下一步却没做 / 该弹窗没弹 / 无视觉证据 / 明确记忆请求无成功证据 / 无主张踢皮球"；只读 / 交接 / 旧队列不催办 |
| `SessionStart` | `global-config-guard.js` | 15 | 开台体检：两侧漂移 + 悬空引用（含 `skills/<技能>/scripts/x` 形态），健康时零输出 |
| `SessionStart` | `session-budget.js` | 10 | 同上（开会话时也看一眼预算与磁盘水位） |
| `PreToolUse` | `edit-guard.js` | 10 | 改不可回滚文件前的备份提醒（advisory，不拦截） |
| `PreToolUse` | `huge-output-guard.js` | 10 | 拦"整读大文件 / 无输出限流"的命令（防大会话被传输层掐断） |
| `PreToolUse` | `commit-scope-guard.js` | 10 | 提交前拦 `git add -A` / `.` 这类宽范围暂存 |
| `PreToolUse` | `cua-cursor-guard.js` | 10 | 拦手搓 Win32/SendInput 级桌面原语，改走 CUA 驱动 |
| `PreToolUse` | `risky-match-guard.js` | 10 | 拦按模式/镜像名杀进程、无 WHERE 的破坏性 SQL 等匹配型危险操作；**还兼作两个门禁的 Pre 入口**：① 认证锁库（末尾委托 `auth-lock-core.js`；core 缺失时该半边会静默失效，故崩错写进本守卫台账 `auth-lock-pre-error|...`，开关 `~/.qoder/auth-lock-guard.json`）② **记忆优先**（本会话一次记忆都没读过就要动远程 / 数据库 / 服务启停 / 对外部署时，拦一次并给出查记忆指引；每类只提醒一次，读过记忆即静默放行；关：本守卫配置文件写 `{"memoryFirst":false}`，整守卫关是 `{"disabled":true}`） |
| `PreToolUse` | `win-path-guard.js` | 10 | 拦 Bash 命令里混进 Windows 原生路径（`C:\…` 交给 Git Bash 会变成 `C:…`）与盘符形态误判；命中就给可粘贴的 `/c/…` 改法。本机 matcher `^Bash$` |
| `PostToolUse` | `cua-cursor-guard.js` | 10 | 同上（提交后再兜一道） |
| `PostToolUse` | `auth-lock-guard.js` | 10 | **认证失败计数器**：只看工具返回里的认证/锁定类签名，按目标（服务别名/主机/账号任一相同）累计，满 3 次后由上面那个 Pre 入口硬拦该目标的一切连接动作（防"重试到把数据库账号锁死"——锁定阈值约 10 次，且只能人工解锁）；`--status` 查看、`--clear ALL` 人工解除。可选 `matcher` 缩小触发面（本机用 `^Bash$|mcp_call|mcp__dbhub__.*`） |
| `PostToolUse` | `attempt-lock-guard.js` | 10 | **同类连败计数器**：判据在 `attempt-lock-core.js`，同一目标（family + 去开关后的前三个词）连续失败 3 次即由 Pre 入口硬拦下一次同类调用，成功一次清零；覆盖构建 / 测试 / 部署，不限于数据库认证。解封 `attempt-lock-guard.js --clear`，关 `~/.qoder/attempt-lock.json`。本机 matcher `^Bash$` |
| `PostToolUse` | `tool-payload-guard.js` | 10 | **返回侧体积**：单条工具返回 >2MB（`TPG_BYTES`）当场提示改用摘要推进，同会话同工具只提醒一次；补 Pre 守卫拦不住的"返回才知道多大"。本机 matcher `^Bash$|^Read$|^Agent$|^Task$|mcp_call` |

## 还需要知道的

- `hook-crash-guard.js` **不需要单独接线**：它是被其它 hook 脚本 `require` 的库（`require("./hook-crash-guard.js").install("<名字>")`），把崩溃写进 `hooks-crash.log` 交给周检，保持 fail-open 语义。
- `byok-modelconfigs-guard.js` 也不接线：手动或周检调用的工具。
- **接续记忆与追回（continuity）**：`PreCompact` / `PostCompact` / `UserPromptSubmit` / `SessionStart` / `PostToolUse` 这 5 个 hook 不在本模板里，默认不采集；由 `scripts/install-continuity.cjs` 在用户明确同意后单独接线，不要从模板直接复制。
- **拦截语义**：只有 `exit 2` 或 `deny` JSON 真拦截；其余非零退出码 / 超时 / 崩溃默认**放行（fail-open）**——别把 hook 当安全边界，硬权限仍交权限系统。
- **自证在跑**：每个 hook 都要能自证——`rules-reminder` 写心跳日志、各脚本带 `--selftest` 或 `.test.js`、`global-config-guard --check` 会报接线缺失与"指向不存在的脚本"。接完线**新开一次会话**再跑几轮，确认台账 / 心跳有记录。
- 说明全文见 `../scripts/README-rule-enforcement.md`（三层机制全貌与阈值/选型依据）。
