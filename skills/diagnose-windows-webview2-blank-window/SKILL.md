---
name: diagnose-windows-webview2-blank-window
description: "诊断 Windows WebView2 壳应用白屏、无限转圈或卡在那正在登录（new Outlook olk.exe 与 Microsoft.OutlookForWindows、Edge 系 AppX、任何持有 EBWebView user-data-dir 的应用）。先抓真实窗口把渲染空白与登录流程停滞分开，再按 --user-data-dir 与父进程归属 msedgewebview2、读应用自己的日志，最后用被代理与直连对照证明或否证 WinINET 系统代理继承。用于桌面 WebView2 应用什么都不显示或登录不完。普通浏览器标签打不开网页用 /edge-net-check。"
when_to_use: Windows 桌面应用（WebView2 / 套壳）打开后白屏、空白、一直转圈或卡在登录页不动时
---

# Diagnose Windows WebView2 blank window

## Overview

WebView2 套壳应用的"白屏"绝大多数不是渲染坏了，而是**登录/取资源的网络流程卡死**，页面停在白底卡片上看着像渲染故障。
固定顺序：**① 截图定性 → ② 按 `--user-data-dir` 归属进程 → ③ 读应用自身日志 → ④ 代理 vs 直连对照**。
跳步就会把时间花在 GPU 驱动、硬件加速策略、WebView2 运行时"缺失"这些假嫌疑人上（本机 2026-10-06 实测白查了一轮）。

适用：`olk.exe` / `Microsoft.OutlookForWindows`（新版 Outlook）、Edge 系 AppX、任何有 `EBWebView` 目录的 WinUI/Electron 混合套壳应用。
**不适用**：浏览器标签页打不开网页 ⇒ 走 `/edge-net-check`。

## Step 1 — 跑只读诊断脚本

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<本技能目录>/<本机辅助脚本>/wv2-blank-diag.ps1" -Capture
```

参数（都有可用默认值，一般只加 `-Capture`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-AppxName` | `Microsoft.OutlookForWindows` | 换应用时改成它的包名；传 `-AppxName ''` 跳过包检查 |
| `-ProcessName` | `olk` | 宿主进程名片段（**新版 Outlook 是 `olk`，不是 `Outlook`**） |
| `-UdfHint` | `%LOCALAPPDATA%\Microsoft\Olk` | 期望的 WebView2 UDF 根目录，用于归属与读日志 |
| `-LogPattern` | `olk_*.log` | 日志文件名模式；**别用 `*.log`**，会选中推送后台任务的日志而看不到登录链路 |
| `-BypassHosts` | 微软认证域清单 | 用于核对 `ProxyOverride` 缺了哪几个域，换应用时按需替换 |
| `-Capture` | 关 | 截图主窗口。**会还原最小化窗口**，PNG 可能含隐私内容，默认写到 `%TEMP%\qoder-work\`，看完即删 |

只读——不改注册表、不重启进程。每段打印 `>> OK` / `>> INFO` / `>> RED` / `>> NORUN`，末尾给 `ok/no-run/red` 计数。
**判读纪律**：`NORUN` 是"这一节没取到证据"，不得当成正常；应用没在跑时第 3、4 节必然 RED——那是"没得看"，不是"渲染坏了"。

## Step 2 — 用截图定性（这一步决定后面查什么）

必须真看画面，不能凭窗口标题和进程数推断：

- **白底 + 登录卡片 / 头像 / "正在登录到新的…"字样** ⇒ 流程卡住，直奔 Step 5 的代理排查。
- **纯白、无任何控件、侧栏顶栏都不在** ⇒ 才可能是渲染层问题（GPU 策略 / 运行时）。
- **界面完整但内容区空** ⇒ 数据层或后端接口问题，看日志里的网络错误码。

`-Capture` 会附带打印 `distinct-color-buckets` 与 `near-white%` 作为客观辅助：**桶数 ≤3 才像"渲染层死了的纯色填充"**，桶数多但大面积白＝页面已经渲染出来、只是停在白色卡片上（流程卡住）。这个读数只做辅助，结论仍以肉眼看 PNG 为准。

截图的三个硬坑：
1. 窗口最小化时矩形是 `-32000,-32000,...`，直接截会得到 160×28 的废图——**先还原再截**。
2. 截前必须 `SetProcessDPIAware`，否则高 DPI 下尺寸与坐标全错。
3. 锁屏状态下任何窗口激活都会被拒（LockApp 持前台），截图前确认已解锁。

## Step 3 — 把 msedgewebview2 进程归属到宿主

机器上常驻几十个 `msedgewebview2.exe`（SearchHost、PowerToys、腾讯系应用都在用），**总数毫无意义**。正确做法：

- 从每条命令行里抠 `--user-data-dir=` 分组计数，再对每组看父进程名与可执行路径；
- 新版 Outlook 的 UDF 是 `%LOCALAPPDATA%\Microsoft\**Olk**\EBWebView`——**按 `Outlook` 正则匹配会得到 `outlook-scoped=0` 的假结论**，而 `%LOCALAPPDATA%\Microsoft\Outlook` 不存在是正常状态，不是缺陷。

## Step 4 — 读应用自身日志

新版 Outlook：`%LOCALAPPDATA%\Microsoft\Olk\logs\olk_<stamp>.log`，tab 分隔。要点：

- **文件名与内容时间戳都是 UTC**（`055528` = 本地 13:55），跟本地时间轴对齐前先 +8h，否则会把因果顺序读反。
- 取 token 结果：grep `OneAuthInternalLog` + `is_successful`、`GetTokenLocalLog ... result=`（`result=1` 为成功）。
- 页面导航：grep `WebView SourceChanged` 看 `uri=`；出现 `.../mail/` 说明已进邮箱。
- 失败形状：`ERR_PROXY_`、`ERR_TIMED_OUT`、`ERR_NAME_NOT_RESOLVED`、`ERR_CONNECTION_RESET`。
- 旁边两个文件有诊断价值：`updated.txt`（刚被写 ⇒ 自动更新重置了本地数据，必然要求重新登录）、`HostAnomaly.txt`。
- 日志很长，**只 grep 不整读**；单条工具返回超 20KB 就会挤爆上下文。

## Step 5 — 代理 vs 直连对照（本机真正的根因层）

Chromium/WebView2 应用**无条件继承 WinINET 系统代理**。代理节点退化时应用会静挂在网络初始化上，白屏且没有任何错误提示。

一条脚本里同时测两种路径才是铁证（`HttpClientHandler.UseProxy=false`，或 `HttpWebRequest.Proxy=$null`）：

| 观测 | 结论 |
|---|---|
| 例外域直连快、走代理 12s 超时 | 代理链路是瓶颈 |
| `417 Expectation Failed` | **代理自己回的**，不是站点响应，别当成"站点通了" |
| 某域 DNS 解析为空 | hosts/加速器接管过，另查，不属于代理例外能修的 |

先读现场三样：`HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，以及代理端口上监听的进程（`Get-NetTCPConnection -State Listen -LocalPort <port>` 拿到 pid 再查进程）。

## Step 6 — 修复：给认证域加代理例外（改注册表，动手前要确认）

前置：向用户说明改动内容与回滚步骤，拿到确认再执行。

1. **备份**（必做）：
   ```
   reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" <备份路径>\internet-settings.reg /y
   ```
   在 Git Bash 里 `reg.exe` 的 `/y` 会被转成盘符路径导致**静默不产出文件**——从 PowerShell/原生 cmd 跑，或加 `MSYS_NO_PATHCONV=1`；跑完必须确认文件真的存在。
2. **追加例外**到 `ProxyOverride`（保留原有的局域网段，别整串覆盖）。实测有效的微软认证/资源域：
   ```
   login.live.com;*.live.com;*.live.net;*.microsoft.com;*.microsoftonline.com;*.microsoftonline.us;*.office.com;*.office365.com;*.office.net;*.outlook.com;*.static.microsoft;*.microsoftauth-intl.com;*.msauth.net;*.msftauth.net
   ```
3. **广播设置变更**，否则运行中的进程不刷新：`wininet.dll` 的 `InternetSetOptionW` 依次发 `INTERNET_OPTION_SETTINGS_CHANGED(39)` 与 `INTERNET_OPTION_REFRESH(37)`。
4. **同步写进代理工具自己的例外字段**（本机为 v2rayN `guiConfigs\guiNConfig.json` 的 `systemProxyExceptions`），改前先复制 `.bak-<tag>` 备份。
   PowerShell 默认写文件带 **UTF-8 BOM**，JSON 解析会直接失败——用 `New-Object System.Text.UTF8Encoding $false` 显式无 BOM 写，写完用 `ConvertFrom-Json` 复验解析通过。

## Step 7 — 复验（要能失败）

1. 临时把 `ProxyEnable` 置 1，**`finally` 里还原成进入本步前的原值**（不是写死 0）。
2. 三条对照必须齐全：例外域（应走直连、明显变快）＋ **一个非例外域**（如 `https://www.gstatic.com/generate_204`，应仍走代理返回 204——它证明例外没把代理废掉）＋ 一个纯直连不受影响的站点。
3. 端到端跑真实业务：拉起应用、轮询日志直到 `is_successful=true` 且 `WebView SourceChanged` 落到业务页，再截图目视确认界面元素齐全。**只有端到端 + 截图算完成**，探测通不算。
4. 截图看完即删（里面是用户的邮件标题/正文）。
5. **必须点名的遗留风险**：代理工具进程内存里仍是旧例外时，它一保存配置就会用内存值重写 `ProxyOverride`，把修复冲掉。修复后要么重启该工具，要么让用户在它的"系统代理例外"里手动粘一遍同一串——**这条不做完，第二天故障会原样复发**。

## 已踩过的弯路（不要重复）

| 现象 | 误判 | 事实 |
|---|---|---|
| 白屏 | 怀疑 GPU / 显卡驱动 / HDR | 驱动正常、`HardwareGPUAcceleration` 与 `disablehardwareacceleration` 均未设置；显示日志里的 HDR 事件（Id 4125）是噪声 |
| EdgeUpdate 客户端键 `pathname` 为空 | 判定 WebView2 运行时坏了 | 运行时完好，看 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<ver>\msedgewebview2.exe` 是否存在 |
| 按 `Outlook` 匹配 webview2 进程得 0 个 | 判定应用没用 WebView2 | 目录名是 `Olk` |
| 28 个 `msedgewebview2.exe` | 当成应用证据 | 与宿主无关，必须先按 UDF 归属 |
| 从 Git Bash 跑 `powershell -Command "..."` | 反复语法错 | `$_` 被 bash 吞、串里的 `|` 崩 PS5 解析 ⇒ **一律写成 .ps1 用 `-File` 跑** |
| PS 里自定义函数叫 `H` | 神秘 `Get-History` 参数绑定错 | 撞了内置别名 ⇒ 用 `Sec` 之类全名 |
| `$count + '文字'` 拼接 | 脚本崩在该行 | PowerShell 会把字符串往 int 强转报 InvalidCast ⇒ 用 `('{0} 文字' -f $count)` 或让字面量打头 |
| 截到一个有标题但 16×16 的窗口 | 当成"截图成功" | 那是托盘 / 辅助窗口 ⇒ 主窗判据必须带尺寸下限（脚本用 300×200），否则视觉结论是假绿 |
| 日志目录里挑最新的 `*.log` | 读到后台任务日志以为应用没登陆 | 新版 Outlook 会把 `olkPushNotificationBackgroundTask_*.log` 写得更新 ⇒ 固定用 `olk_*.log` |

## Resources

- `<本机辅助脚本>/wv2-blank-diag.ps1`：Step 1 的只读诊断量具，七段：包形态 / 运行时 / 进程归属 / 窗口与截图 / WinINET 代理状态 / 代理与直连对照 / 应用日志摘要，并打印分段判读与 `ok/no-run/red` 计数。加 `-Capture` 才截图。
  本机 2026-10-07 实跑过四种输入：默认（Outlook 未启动 ⇒ 第 3/4 节如实报 RED）、托盘应用（只有 16×16 辅窗 ⇒ 报 NORUN 呾不报 OK）、大窗口应用（1294×1399 + 像素桶数）、不存在的进程与 UDF（全链 RED）。
  **未实跑的一支**：`ProxyEnable=1` 且代理节点退化时的判红分支——验证它需要故意弄坏系统代理，本轮不做；该分支的写法沿用来源会话（2026-10-06）已实测过的探测顺位。
- 相关记忆：系统代理与 WebView2 继承、第三方窗口截图取证、PowerShell 脚本编码坑——本机事实以脚本实跑输出为准，记忆只作背景。
