---
name: context-governor
description: 实验性上下文治理：用量报告、逻辑折叠回执与压缩后恢复指针（physicalSavings=0，不代表模型请求已压缩）。hook 默认不接线、零注入，接线与 inject 开关须显式批准。触发词：上下文用量、context-governor、压缩恢复指针、逻辑折叠、fold 句柄、注入开关。不用于：注入文件瘦身（→injected-context-slimming）、接续落盘（→/checkpoint）。
---

# /context-governor（用量取证 → 逻辑折叠 → 压缩后恢复）

用途：把「上下文用了多少、折叠了什么、压缩后怎么追回原文」变成**可核对的回执**，而不是凭感觉说"已经压缩了"。

**诚实口径（先读这条）**：本工具只做**逻辑折叠**——它写自己的账本与句柄，**不改写模型请求**。没有独立物理执行证据时一律 `physicalSavings=0`；不得把折叠回执当成"输入 token 已下降"。用量数字来自 transcript 里宿主写的 usage：部分模型只报 ratio、token 字段恒为 0，此时基准是 `ratio-only`，不要换算成绝对 token 汇报。

## 1. 安装（opt-in，脚本不会自动装）

```bash
node scripts/install-package.cjs --yes --install script:context-governor.cjs --install script:context-governor-hook.cjs
```

不带 `--yes` 先预演。命令条目本身不携带脚本依赖，两个脚本必须像上面这样显式选择。

## 2. CLI 用法

```bash
node scripts/context-governor.cjs report --transcript <会话.jsonl> --json
node scripts/context-governor.cjs fold --summary <摘要.md> --dry-run
node scripts/context-governor.cjs show --range <句柄>
node scripts/context-governor.cjs search --query "<关键词>" --session <会话id>
```

`--dry-run` 只校验不落账；确认后再去掉它提交回执。`show --full` 需要 `--ack-cost`（取回原文本身要花上下文）。数据目录优先级：`--data-dir <目录>` > `CONTEXT_GOVERNOR_DATA` > 默认（Windows 且存在 D: 盘用 `D:/qoder-data/context-governor`，否则 `~/.qoder/context-governor`）。

## 3. hook 接线（默认不接，须用户明确批准）

`scripts/context-governor-hook.cjs` 从 stdin 读一个宿主事件、**永远 exit 0**（fail-open，不替代平台权限）。支持四个事件：

| 事件 | 行为 | 是否注入 |
|---|---|---|
| `PreCompact` | 记录压缩前 usage 快照 | 否 |
| `PostCompact` | 置 `pendingRestore` | 否 |
| `SessionStart` | 有 `pendingRestore` 时发**一条** ≤300 字恢复指针并清标志 | 是（仅一次） |
| `UserPromptSubmit` | 开关打开且使用率 ≥65% 时提示 | 默认否 |

安装器**不会**替你接这个 hook（它只接 `rules-reminder.js`）。要接线：先 `node scripts/backup-file.js <客户端>/settings.json` 备份，再在 `hooks` 里为上述四个事件各加一组，命令形如 `hooks/hooks.example.json` 里的写法：

```text
<node> "<客户端目录>/scripts/context-governor-hook.cjs"
```

`timeout` 给 10 秒即可。接完必须用真实事件验证（第 5 步），不能只看"配置写进去了"。

## 4. inject 开关与阈值

- 开：`CONTEXT_GOVERNOR_INJECT=1`，或在数据目录写 `config.json` 的 `{"inject": true}`；**env 优先**，`=0` 强制关。
- 关（默认）：两者都没有 → `UserPromptSubmit` 零注入，只有压缩后恢复指针仍会发。
- 阈值：soft 65% / pressure 75% / emergency 88%；同级或更低级别的提示有 **8 轮冷却**，升级级别立即提示。
- 状态与诊断：`<数据目录>/hook-state/<会话>.json`、`<数据目录>/hook-state/errors.log`。hook 的数据目录只认 `CONTEXT_GOVERNOR_DATA`（没有 `--data-dir` 参数）。
- 宿主事件没带 `transcript_path` 时快照为 unknown，不注入——这是正常降级，不是故障。

## 5. 验证接线（含负对照）

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"probe","transcript_path":"<会话.jsonl>"}' | node scripts/context-governor-hook.cjs
```

- 正例：开关打开且该 transcript 使用率 ≥65% → stdout 出现一条 `[context-governor]` 提示，exit 0。
- **负对照**：`CONTEXT_GOVERNOR_INJECT=0` 跑同一条事件 → stdout 必须为空。仍有输出就说明开关没生效，别当成接线成功。
- 恢复指针：先喂 `PostCompact` 再喂 `SessionStart`，第二次 `SessionStart` 必须静默（只发一次）。

## 6. 回退

1. 只关注入：`CONTEXT_GOVERNOR_INJECT=0`，或删掉数据目录 `config.json` 里的 `inject`。
2. 摘掉接线：从 `settings.json` 删除第 3 步加的四个事件组（或用备份还原），其余 hook 不动。
3. 彻底移除：删掉已安装的两个脚本与数据目录；账本删除前先确认没有要追回的句柄。

相关：`README-安装说明.md` 的实验性工具节、`scripts/context-governor.test.js` 与 `scripts/context-governor-hook.test.js`（判据与负对照都在里面）。