---
description: MCP 按需开关——列出 server、启用/禁用单个 server；改 settings.json 前自动备份，默认只预览。触发词：MCP 开关、禁用 MCP、启用 MCP、用完释放、节省 token
---

# /mcp-toggle

把「不再需要的 MCP server」从上下文里释放：保留配置，只切换 `disabled`；默认只预览，`--apply` 才写盘。

## 用法

- `/mcp-toggle` 或 `/mcp-toggle list`：列出当前客户端侧的 server、`disabled` 状态与 `includeTools` / `excludeTools`
- `/mcp-toggle disable <name>`：预览禁用；确认后加 `--apply`
- `/mcp-toggle enable <name>`：预览启用；确认后加 `--apply`
- `--both`：同时处理已存在的另一侧配置（`~/.qoder` / `~/.qoder-cn`），不会新建缺失侧
- `--json`：机器可读输出

底层命令：`node ~/.qoder/scripts/mcp-toggle.cjs --list | --disable <name> [--apply] | --enable <name> [--apply]`

## 纪律

- 默认只预览；写盘必须 `--apply`，脚本会先备份 `settings.json.bak.*`
- 写 `settings.json` 属现役配置面，执行前按平台要求确认
- 改后需 `/mcp reload` 或新会话/重启生效；脚本**不能**卸载当前会话已加载的工具
- 不要禁用当前任务正在使用的 server；收窄工具面优先用 `includeTools` / `excludeTools`

## 验收

1. `--list` 前后 `settings.json` 哈希不变；
2. `--apply` 后目标 server 的 `disabled` 状态符合预期，且同目录出现 `.bak` 备份；
3. 新会话（或 reload）后该 server 的工具不再出现。
