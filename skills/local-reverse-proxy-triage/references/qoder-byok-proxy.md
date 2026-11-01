# Qoder BYOK 本地反代专用细节

> 通用判据见 SKILL.md；这里只放本机实测的端口、字段与阈值。

## 进程与端点

- 默认监听 `127.0.0.1:18765`；provider 的 `baseUrl` 指向 `http://127.0.0.1:<port>/v1`。
- 健康端点 `/_health` 回显 `version`、`timeoutMs`、`earlyHeadersMs`、源码 SHA 前 12 位。
- 启动/守护可能由 `.vbs` 或计划任务拉起；改脚本不会自动生效，必须重启 node。
- 旧 cmd 窗口可能重新拉起无开关实例，`taskkill` 要带 `/T` 杀父链。

## 关键环境变量（以磁盘脚本为准）

| 变量 | 作用 | 实测注意 |
|---|---|---|
| `BYOK_UA_PROXY_TIMEOUT_MS` | 代理总超时 | 默认 300s；调小做冒烟会自建断网 |
| `BYOK_UA_PROXY_EARLY_HEADERS_MS` | SSE 早期头阈值 | 默认 50000；0 = 关闭；≥总超时会自动收紧到 TIMEOUT-1 |
| `BYOK_UA_PROXY_HEARTBEAT_MS` | 心跳间隔 | 默认 5000；注释心跳不重置客户端计时 |
| `BYOK_UA_PROXY_RETRY_BIND_MS` | EADDRINUSE 重试 | 默认 30s；前一实例退出后自动接管 |
| `BYOK_UA_PROXY_UPSTREAM` | 上游地址 | 用于确认代理指向 |

## 日志判据

- `outcome=CLIENT_DISCONNECTED elapsed_ms≈59900` 且该 id 没有 `REQ ... phase=headers` ⇒ 客户端 60s 首包超时，不是代理故障。
- `UPSTREAM_HEADERS_TIMEOUT` = 代理自己的头超时，默认 300s，不会在 60s 触发。
- `UPSTREAM_ERROR kind=rate_limit|upstream_canceled|unauthorized|error_event` = 上游把错误塞在 200 的 SSE 正文里；看到即查上游。
- 客户端日志不记上游 401；要按 `byok:<provider-uuid>/<model>` 的 turn 行定位 provider，再用脚本直连复现。

## 改动验收的历史坑

- 协议用错（`EPROTO`）、断言自洽错误、旧进程抢占端口，都曾让“改完看起来生效”变成假绿。
- 首包窗口 ≈ 早期头阈值 + 60s；20s 阈值时断开点集中在 80s，50s 阈值后正常请求不再撞 80s。
- 非 2xx 上游在早期头之后到达时，状态码已发出无法改，只能以 SSE `upstream_http_error` 事件收尾并保留原文。
