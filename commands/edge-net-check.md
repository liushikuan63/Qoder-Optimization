---
description: 浏览器（Edge/Chrome）打不开网页时 10 秒定性——代理残留 / hosts 劫持无服务 / 加速器回源抖动。触发词：浏览器打不开、网页打不开、网络打不开、代理残留、hosts 劫持
---

# /edge-net-check

本机 2026-09-24 实测过的三种故障形状，一次跑完分层判读。**只读，不改任何配置。**

## 步骤

1. **跑量具**：`node ~/.qoder/scripts/edge-net-check.cjs`（约 15–60 秒，含 9 秒超时项）
   判红指向加速器时加 `--fix`：脚本会重启 Watt(Steam++) 并复测，打印 `最大耗时 A -> B`。
   **`--fix` 只在有判红项时才动进程**（无判红 ⇒ 输出"不动任何进程"）。
2. **按三段判读**（脚本自己会打 `>> 判红` / `>> 正常`）：
   - `1) 系统代理`：`ProxyEnable=1` 且端口**无监听** ⇒ 浏览器全站打不开、其他程序正常。
     处置：`(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings').ProxyServer`
     记下后把 `ProxyEnable` 置 0（改前先 `reg save` 备份该键）。
   - `2) hosts 劫持条目` 很多而 `加速器=未运行` ⇒ 被劫持域名此刻全废（`ERR_CONNECTION_REFUSED`）。
     处置：启动 Watt Toolkit 或清掉 hosts 的 `# Steam++ Start/End` 块。
   - `3) 完整 HTTPS 请求耗时`：走 `加速器MITM` 的域 >3s 或 `ERR ETIMEOUT`，
     而 `真实站点` 对照 <800ms ⇒ 抖动在加速器回源线路，**同一域名连测 3–4 次看离散度**，
     单次快不能结案（实测同域 138ms / 2028ms / 7035ms / 9018ms）。
3. **要浏览器侧铁证**（页面白屏但命令行看着正常时）：用 browser-use 在目标页跑
   `performance.getEntriesByType('resource')` 取逐资源耗时——量具只到 TLS/HTTP 层，
   页面真实卡顿看**资源域是否在劫持名单里**（如 `github.githubassets.com`）。
   **先排除缓存**：逐资源耗时中位数为 `0ms` ＝ 命中 HTTP 缓存，这个 `load_ms` 不能用来证明网络改善
   （实测踩过：缓存命中得到 `load_ms 2330ms`，被误读成"重启加速器修好了"）。
   要量冷路径就用一次性新域名 + `cache:'no-store'`，或直接看本脚本第 3 段。

## 回滚点

改 hosts 前必须整份备份并 `cmp` 校验：
`Copy-Item C:\Windows\System32\drivers\etc\hosts <备份>` → 改 → 复验 →
还原用 `Copy-Item <备份> C:\Windows\System32\drivers\etc\hosts -Force; Clear-DnsClientCache`。
**注意：Watt Toolkit 会自愈重写 hosts**（实测手改的注释项在数秒内被恢复成生效项），
所以收敛劫持面只能在 Watt 界面里关对应服务的加速，或先退出 Watt。
