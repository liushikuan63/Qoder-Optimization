# Qoder / Electron 客户端网络取证细节

> 本机实测于 2026-10-28；版本与路径会变化，以现场为准。

## 日志

- 运行日志：`~/.qoder/logs/runs/<ts>/qodercli.log`；CN 侧在 `~/.qoder-cn/logs/runs/...`。
- 错误聚合：`grep -n "ERROR" | tail`，记录 `networkMode` 与 `route.kind`。
- `resolved-ip` = 字面 IP 直连；`domain` = 系统 DNS。
- 主进程日志：`%APPDATA%\com.qoder.app.stable\logs\<会话>\main.log`（CN：`com.qodercn.app.stable`）。

## 实测判据

- 按日志 IP 直连 0/12，按域名 3/3 ⇒ HTTPDNS 直连路径坏，域名路径好。
- `QODER_HTTPDNS=0` 后 `networkMode=direct`，路由变为“系统 DNS 优先、fallback IP 兜底”。
- 写用户级环境变量：

```powershell
reg export HKCU\Environment "$env:TEMP\env-backup.reg"
[Environment]::SetEnvironmentVariable('QODER_HTTPDNS','0','User')
[Environment]::GetEnvironmentVariable('QODER_HTTPDNS','User')
```

- 必须完全退出客户端（托盘、所有 Qoder.exe）再启动，否则旧进程仍用旧环境。
- Git Bash 调 `reg query //v`、`tasklist //FI` 要用双斜杠，否则 MSYS 当路径转换。
- CLI 端到端验证前先剥掉宿主注入的 SDK 环境：
  `env -u QODER_AGENT_SDK_ENTRYPOINT -u QODER_CONFIG_DIR ...`，否则报 `sdk_invalid_args`。

## 混淆 bundle 里的开关

- `app.asar.unpacked` 下的 `*.obf.mjs` 常是单行超大文件；`grep -o -E ".{N}pat.{M}"` 会超时或被 huge-output-guard 拦。
- 用一次性 Node 探针：`fs.readFileSync(p,'latin1')` + `indexOf` 循环切片，带 before/after 与命中上限。
- 先按导出别名反查真实名，再展开前缀函数与取值表，确认环境变量名与可接受值；最后读调用点确认关闭后的分支。

## webview 面板

- `[Campaign]` 事件 + 真实浏览器资源耗时用于判断第三方统计是否拖过加载门槛。
- 登录成功但权益面板转圈：先查面板资源，不要混进模型链路。
