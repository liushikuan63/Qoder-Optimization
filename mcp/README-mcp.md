# MCP / 插件接入

## 一、先分清三类能力（别重复装）

| 类型 | 例子 | 怎么来 |
| --- | --- | --- |
| 插件自带工具 | `computer-use`（桌面点击/截图）、`browser-use`（浏览器）、`node-repl`、云 Agent | 装插件即用，**不需要**写 mcpServers |
| 公共 MCP | `context7`（文档检索） | 本包 `install-mcp.cmd` 一键接（HTTP） |
| 自建 / 本地 MCP | `dbhub`（多库只读）、`cua-driver`（桌面驱动）、`workflow-ops`（自建） | 需要装依赖或二进制，见下 |

> 很多人只需要 `computer-use` 插件就能做桌面自动化；`cua-driver` 是可选增强（daemon + 鼠标守卫），没有二进制时不要硬配。

## 二、一键接入（推荐）

双击 `install-mcp.cmd`，或命令行：

```bat
install-mcp.cmd --dry-run      :: 只预览，不改配置
install-mcp.cmd                :: 装 dbhub + 合并 context7/dbhub（已装 cua-driver 时一并注册）
install-mcp.cmd --skip-cua     :: 不碰 cua-driver
install-mcp.cmd --wire-guard   :: 同时接线鼠标抢占守卫（需先把 scripts/ 复制到 ~/.qoder/scripts/）
```

- 幂等：已存在的条目不会覆盖；改 `settings.json` 前自动备份到 `<配置目录>/.backups/`。
- 生成 `dbhub.toml` 模板（连接串自己填，**只写本机**）。
- 不写入任何凭据。

### 离线 / 联网怎么选（脚本会主动问）

- **cua-driver**：`1) 用包内离线版本` / `2) 联网下载最新版` / `3) 跳过` / `4) 仅注册已安装的版本`。
- **dbhub**：`1) 联网安装最新版` / `2) 用包内 tgz`（依赖仍需网络）/ `3) 跳过`。
- 核心 ZIP 不携带离线二进制。需要离线安装时，另取同版本 `Qoder-Optimization-<版本>-offline.zip` 及其 `.sha256`，校验后与核心包解压到同一目录；资产会落在 `mcp/offline/`。包含 cua-driver 0.38.0（MIT，含 `SHA256SUMS` 与许可证）和 dbhub tgz，安装前仍会校验组件 SHA256。
- 联网安装走 GitHub release（`trycua/cua`），下载后同样校验 SHA256；GitHub 不通时直接选离线。
- 无控制台 / 自动化：`install-mcp.cmd --yes --cua offline --dbhub skip --wire-guard`。
- 离线版装完会问「是否设置开机自启（启动文件夹 VBS）」；不自启就每次手动 `cua-driver serve`。

## 三、cua-driver（可选，桌面自动化增强）

1. 安装二进制：优先官方安装器；网络受限时走 `api.github.com` 资产通道下载 zip + `SHA256SUMS` 校验（直连 github.com 常被阻断）。
2. 启动 daemon：`cua-driver serve`；Windows 把启动项放「启动」文件夹 VBS（窗口样式 0），计划任务需要管理员。
3. 注册 MCP：server 名统一用 `cua-computer-use`，command 指向 `cua-driver.exe`、args 为 `["mcp"]`（stdio）；**两侧** `~/.qoder` 与 `~/.qoder-cn` 各注册一次，写完重开会话才出现工具。
4. 接守卫：`scripts/cua-cursor-guard.js` 挂到 `hooks.PreToolUse` + `hooks.PostToolUse`，matcher 用 `mcp_call|mcp__cua[_-]?driver__.*|^Bash$`。
   - 为什么不能用 `mcp__cua[_-]?(?:driver|computer[_-]?use)__.*`：MCP 懒加载下真实 tool_name 是元工具 `mcp_call`，server 名会被规范化成下划线，只写前者会一个都不匹配、守卫静默失效。
   - 它拦的是鼠标抢占：`move_cursor scope:"desktop"` / `click delivery_mode:"foreground"` 会把真实指针搬走且驱动不还原；守卫在动作前快照、动作后还原并复验。
   - 自检：`node <配置目录>/scripts/cua-cursor-guard.test.js`（50 条，含安全路径放行对照）。
5. 验证：`cua-driver --version`、`cua-driver status`、MCP 工具能列出。

## 四、dbhub（多库只读）

1. 依赖：`npm install -g @bytebase/dbhub --registry=https://registry.npmmirror.com`（脚本会自动装）。
2. 连接串写在 `~/.qoder/dbhub.toml` 的 `[[sources]]`（`id` / `dsn` / `lazy` / `connection_timeout` / `query_timeout`），每个源只读。
3. 验证：工具名形如 `execute_sql_<source>`，能列出并跑一条只读查询即接线成功。

## 五、自建 MCP（如 workflow-ops）

启动命令指向本地源码（`node <仓库>/src/index.js`），源码不随包；没有该仓库就不要注册。

> 凭据纪律：连接串 / 口令只写本机文件，不写进规则、记忆、分享包。
