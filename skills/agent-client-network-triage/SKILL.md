---
name: agent-client-network-triage
description: AI 编码客户端（Electron+Node SDK）网络异常的分层排查。触发词：Qoder 连不上服务、ECONNRESET、networkMode、httpdns、resolved-ip 直连失败、fake-ip、TUN 代理、webview 面板打不开、QODER_HTTPDNS。含按日志 IP 与按域名的成功率矩阵、代理规则与出站归属、用户级环境变量修复。不用于浏览器网页（edge-net-check）或 OAuth 换证（oauth-login-failure-triage）。
---

# AI 编码客户端网络异常分层排查

## 适用

Electron + Node SDK 的编码客户端（Qoder、Codex 类）报“网络异常 / 连不上服务 / 面板一直转圈”。目标是区分：单路径坏、DNS/HTTPDNS 坏、代理分流坏、应用自身 webview 资源拖垮。

Qoder 的日志路径、字段与开关见 [references/qoder-electron.md](references/qoder-electron.md)。

## 1. 读客户端自己的运行日志

- 找到最近一次 run 的日志（如 `~/.qoder/logs/runs/<ts>/qodercli.log`），聚合 `ERROR`。
- 记录 `networkMode`（httpdns / direct / proxy）与 `route.kind`：
  - `resolved-ip` = 字面 IP 直连；
  - `domain` = 系统 DNS 按域名。
- 这一步决定后面是查 DNS、查代理，还是查应用层。

## 2. 成功率矩阵：按 IP vs 按域名

对日志里出现过的每个 IP：

```bash
curl --noproxy '*' --resolve <host>:443:<ip> https://<host>/<path> -o /dev/null -w '%{http_code}\n'
curl --noproxy '*' https://<host>/<path> -o /dev/null -w '%{http_code}\n'
```

- 按 IP 全坏、按域名全好 ⇒ 单路径（直连 IP）坏，改走系统 DNS / 代理；
- 按域名也坏 ⇒ 全线坏，继续查代理/出口；
- 两者都时好时坏 ⇒ 看是否按接口分流或负载均衡。

同时做一条不存在的路径/域名负对照，区分“服务端返回错误”与“客户端没发出请求”。

## 3. 查本机代理形态与出站归属

- 找代理监听口（mixed port），读代理配置的 `mode` / `enhanced-mode`（fake-ip）/ `rules`；常见规则会把客户端域名强制 `DIRECT`。
- 用 `Get-NetTCPConnection -OwningProcess <core-pid>` 抓实际出站 IP，与 HTTPDNS 答案比对。
- TUN / fake-ip 下，应用拿到的是假 IP；按 IP 直连会失败，这是设计而非服务故障。
- 代理的 `config.yaml` 可能是生成物；改规则要改真源（见 `proxy-rule-surgery`）。

## 4. 定位应用侧开关

- 若日志显示 `networkMode=httpdns` 且 `resolved-ip` 直连失败，常见修复是关闭 HTTPDNS，让路由变为“系统 DNS 优先、fallback IP 兜底”。
- 开关可能在环境变量或混淆 bundle 里；检索方法见 `electron-asar-code-forensics`（单行 bundle 用 Node `indexOf` 探针，不用 `grep` 取上下文）。
- 改用户级环境变量前先 `reg export HKCU\Environment` 备份；写入后回读，明确告知**需完全退出客户端（含托盘/所有进程）再启动**才生效。

## 5. 重启后复验

- 新 run 日志里 `networkMode` 已变为目标模式，且不再出现原 `ECONNRESET`。
- 关键接口按域名与按 IP 各打一次，成功率矩阵改变。
- 面板类功能要真开一次，截图或日志证明加载完成；只看进程起来不算。

## 6. webview 面板被第三方资源拖垮

- 登录/权益/活动面板可能加载第三方统计；`main.log` 里的 `[Campaign]` 等事件可定位。
- 用真实浏览器量资源耗时，判断是否超过 webview 的加载门槛。
- 修复优先级：阻断/代理该第三方资源 > 加超时 > 改客户端代码；不要把“面板打不开”误判成模型链路故障。

## 边界

- 区分认证/账号类失败与网络类失败；认证失败不要靠重试（见 `byok-model-retry`）。
- 不擅自改系统代理、TUN 或全局规则；改用户级环境变量属独立变更，先说明影响与回滚。
- 只在隔离/可回滚范围内做探针；不把内网地址与凭据写进日志或汇报。

## 相关

- 浏览器网页打不开：`edge-net-check`（命令）。
- 桌面客户端更新失败：`desktop-update-push-triage`。
- 本机反代问题：`local-reverse-proxy-triage`。
- 混淆 bundle 检索：`electron-asar-code-forensics`。
