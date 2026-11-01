---
name: electron-tray-icon-diagnosis
description: "Windows 上 Electron 或 Chromium 应用托盘图标不显示、只在溢出面板出现、或图标在但 tooltip 丢失时的定位阶梯。用 Shell_NotifyIconGetRect 逐 uID 判定注册是否真的到达 shell，用同一张图标做对照注册证明 shell 通道与位图资源正常，再比对 explorer 与应用的完整性级别（UIPI 会静默丢弃低完整性进程发出的 Shell_NotifyIcon），把问题归因到资源、Shell、实例三类。用于托盘图标没了、通知区域看不到某软件、重装或重启后图标消失。网页打不开走 /edge-net-check。"
when_to_use: Windows 桌面应用（尤其 Electron）托盘图标不显示、藏在溢出面板、或 tooltip 丢失需要定责时
argument-hint: "<进程名片段，例如 DSH Desktop>"
---

# Electron 托盘图标不显示（Windows）定位阶梯

## Overview

托盘图标问题只有三类归因——**资源**（位图本身）、**Shell**（explorer 侧拒收所有人）、**实例**（这个进程的注册没到 shell）。
实测经验是绝大多数落在**实例**，而实例侧最常见的原因是**完整性级别（IL）不匹配**，不是图标文件坏、不是 Electron 版本、不是注册表被污染。

固定顺序，不许打乱：**① 只读盘点 → ② 正向对照注册 → ③ GetRect 逐 uID 定生死 → ④ IL 归因 → ⑤ 注册表旁证 → ⑥ 分支（TaskbarCreated）**。
反向走（先改代码 / 先换图标 / 先重启 explorer）会在四个已被否证的假设上耗尽预算——本机一次同类排查耗时约 3 小时，收敛点就是 ③+④ 两条读数。

三条硬事实，决定了整个阶梯的形状：

1. `Shell_NotifyIcon` 是靠向 shell 窗口**发消息**注册的。UIPI 会静默丢弃低完整性进程发给高完整性进程的窗口消息，**不返回错误**——Electron 侧 `new Tray()` 一切正常，界面上就是没有图标。
2. Electron 的托盘宿主窗口 `Electron_NotifyIconHostWindow` 常年 `rect=0,0,0x0` 且 `IsWindowVisible=False`，**健康应用也一样**，所以它的存在与可见性都不是判据。
3. `Shell_NotifyIconGetRect` 返回的**坐标**也不是判据（溢出状态下所有健康图标都报同一个溢出按钮位置）。只有 `hr` 是不是 0 才是判据。

## Step 1 — 只读盘点（先跑这个，不改任何东西）

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<技能目录>/scripts/tray-inventory.ps1" -Process "<进程名片段>"
```

输出六个小节，逐条读：

| 小节 | 要看什么 | 判据形状 |
|---|---|---|
| 0 probe shape guard | `NII cbSize` | 必须是 40（x64）。不是 40 说明结构体漂了，后面所有 `hr` 都无意义，脚本自己退 5 |
| 1 integrity | explorer 的 IL 与应用主进程 IL；`EnableLUA` | 每个匹配进程的 IL 只作上下文列出；**是否判红在第 3 节按"持有托盘宿主窗口的那个进程"裁定**（Chromium 的 Low `S-1-16-4096` / Untrusted `S-1-16-0` 沙箱辅助进程天然低于浏览器主进程，把它们当缺陷就是造缺陷） |
| 2 tray host windows | 目标进程有没有 `Electron_NotifyIconHostWindow` | 没有 ⇒ 这个实例根本没走到建托盘的代码（早退、单实例转交、托盘建在已退出的进程里），Windows 无责 |
| 3 GetRect sweep | `registered=` / `withRect=` / `noRect=` 计数 | `withRect=0 noRect=0` ⇒ 注册从未到达 shell；`noRect>0` ⇒ shell 认了但没画（溢出面板/默认隐藏）；`withRect>0` **只证明注册成功，不证明在任务栏上看得见**（见 Step 3 的截图反证） |
| 4 registry | `HKCU\Control Panel\NotifyIconSettings` 的 `uid` / `tipLen` / `IconSnapshot` 尺寸 / `lastWrite`，以及 `UIOrderList` 成员 | 见 Step 5 的读法 |
| 5 UIA | 可见托盘里的具名按钮节点；溢出面板先在 UIA 里找 `TopLevelWindowForOverflowXamlIsland` | 溢出面板没展开时该岛不可见，脚本会打 `NO-RUN`；要枚举溢出项先点任务栏 chevron（`^`）展开，再重跑。可见区与溢出区要分两批取，别把“未展开时看不到”判成图标缺失 |

退出码：`0` 未见缺陷形状 / `1` 判红（IL 不匹配、NOT-REGISTERED、NO-HOST-WINDOW）/ `2` NO-RUN（参数或环境不足）/ `5` 结构体漂移。

## Step 2 — 正向对照注册（这一步决定后面所有负读数能不能信）

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<技能目录>/scripts/control-icon.ps1" -Png "<应用自己那张图标>" -HoldSeconds 20
```

它在本进程注册一个一次性托盘图标，再用 `Shell_NotifyIconGetRect` 问 shell 要位置，并同时打印：本进程 IL、`whoami /groups` 的强制标签（校准探针读数是否可信）、以及一个**未注册过的 uID=99999** 作负对照。

- `>> PASS` 且负对照 `FAIL|0x80004005` ⇒ 拿到了本次排查唯一的有效前提：**shell 收得到、探针测得出**。此时应用仍无图标 ⇒ 问题在它这个实例，不在系统。
- `>> PASS` 但同一张 PNG 应用用不出来 ⇒ 排除资源；对照 `IconSnapshot` 的像素尺寸确认不是 DPI 空图。
- `>> FAIL`（NIM_ADD 成功但 shell 不给位置）⇒ shell 侧，用 `-Png` 从**与 explorer 同 IL 的会话**再跑一次；变成 PASS 就说明变量是完整性级别，而不是应用。
- `>> FAIL: NIM_ADD returned FALSE` ⇒ 先看 `uFlags`，别怪系统：`NIF_GUID(0x20)` 配零 GUID、或 `NIF_MESSAGE(0x1)` 配没注册的窗口消息，都会让 `NIM_ADD` 直接失败（本机实测踩过）。

## Step 3 — 决定性判据，逐 uID 问 shell

`tray-inventory.ps1` 第 3 节做的那件事，手工版：对目标的宿主句柄遍历 `uID 0..8` 调 `Shell_NotifyIconGetRect`。

```
健康样本（本机 2026-10-07 实测）：u3:2282,1392,32x48  => registered=1 withRect=1
故障样本（本机 2026-10-04 实测 DSH Desktop 稳定版）：uID 0..4 全部 FAIL|0x80004005  => NIM_ADD 根本没进 shell
```

**截图反证（别把 `withRect` 读成"看得见"）**：本机 2026-10-07 用一个肉眼在任务栏上找不到的对照图标实测——它报 `withRect=1`，坐标与健康应用（Qoder CN / Weixin / Beta）**完全相同**（都是 `2282,1392,32x48`）。截下来的托盘条里只有 `^`、输入法、一个绿色图标、网络/音量、时钟、通知——那个对照图标并不在其中。⇒ 该坐标是**溢出锚点**，不是它自己的槽位。`hr` 是不是 0 才是"到没到 shell"的判据；**"看没看见"只能靠目视或截图**。

- `0x80004005`（E_FAIL）= 这个 (hwnd, uID) 在 shell 里不存在。
- `0x80070057`（E_INVALIDARG）= **你自己传错结构体**（把 `NOTIFYICONDATA` 当 `NOTIFYICONIDENTIFIER` 传、或 cbSize 不是 40），不是应用的问题。这一条会把整轮排查带到假红上，务必先看第 0 节。
- Electron 的 `uID` 常见为 3（不是 0），所以 0 号失败不代表没注册，必须遍历。
- `hr=0` 且矩形 `0x0` = 已注册但当前不显示（藏在溢出面板），**与 `hr!=0` 是两回事**，脚本分开计数。

## Step 4 — 归因，完整性级别与 UIPI

判据是**硬**的，但方向也是硬的一半：UIPI 只拦**由下向上**的窗口消息，所以规则是「托盘宿主窗口的**归属进程** IL 不得低于 explorer」，同级与更高级都算正常。
比对对象只有这一个进程——`tray-inventory.ps1` 第 1 节把每个匹配进程的 IL 都列出来仅作上下文，判红动作在第 3 节按宿主窗口归属者做；Chromium 的 Low（`S-1-16-4096`）渲染器沙箱与 Untrusted（`S-1-16-0`）辅助进程永远不会持有托盘窗口，把它们算进判据会把正常安装读成缺陷（本机 2026-10-07 就是这么错过一次假红，已修）。

夹具：`-AssumeExplorerIl S-1-16-12288` 可把 explorer 的 IL 假装成 High，用来在一台当前没坏机器的机器上验证这条判据**确实能变红**（本机实测：同一份 Beta 实例默认退 0 无 IL-MISMATCH，加该开关退 1 并报 `IL-MISMATCH`）。

本机成因链（2026-10-04，同类问题）：

```
EnableLUA=0（UAC 整体关闭）
  ⇒ 管理员账户的进程默认全部 High，explorer 也是 High（S-1-16-12288）
  ⇒ 应用主进程却被人主动降到 Medium（S-1-16-8192）
  ⇒ Medium → High 的 Shell_NotifyIcon 消息被 UIPI 静默丢弃
  ⇒ 托盘图标永远不出现，且应用侧看不到任何错误
```

相关性验证（当时逐个量了可见托盘的归属进程）：**11 个能显示图标的应用全部是 High 或 System，唯一不显示的那个是 Medium**。Beta 渠道包正常显示，只因为它从提权会话启动、继承成了 High——同代码、同 Electron 版本、同 SHA1 的图标。

降权来源要逐项排除，别猜：exe 清单（`asInvoker` 也可能被上层降权）、AppCompat SDB、IFEO、`__COMPAT_LAYER` 环境变量、**安装目录的完整性标签**（低完整性标签目录会让 Electron 初始化异常）、以及父进程链（`High 父 → CreateProcess → 子 Medium` 说明是显式降权而非继承）。判据是「谁创建它」——`tray-inventory.ps1` 会打印每个进程的 IL 与启动时间。

**反向对照要自证**：用计划任务或 `runas /trustlevel` 造一个 Medium 的对照实例时，必须回读它**实际**的 IL。本机那次计划任务对照组跑成了 High，于是一整轮「Medium 也不该显示」的结论其实是没做过的实验。

## Step 5 — 注册表与 UIOrderList 只是旁证

`HKCU\Control Panel\NotifyIconSettings\<每 exe 一个哈希键>`：

- `ExecutablePath` 定位是哪台安装；`UID` 是它在 shell 里的 uID（对照 Step 3 的命中号）。
- **键随进程注册而生、随注销而死**。所以「键不见了」= 实例没注册，不是「被隐藏」，也不是「注册表污染」。这一条否证了「持久隐藏状态」和「污染」两个假设。
- `IconSnapshot` 是 shell 缓存的位图，PNG 头可解出宽高（脚本已解）。宽高正常 + 对照注册 PASS ⇒ 资源侧无责。
- `UIOrderList` 是 8 字节一项的 u64 序列（`entries = bytes/8`），只说明 explorer 记不记得这个 id，**不能**区分「记得但没显示」。
- 键的最后写入时间用来做「谁最后写过托盘状态」的时间线对齐，注意 FILETIME 本身就是 100ns 刻度，再除 10 会把日期算到 1643 年。

## Step 6 — 分支，TaskbarCreated 之后只剩空格子

广播 `TaskbarCreated` / 重启 explorer 后，应用会重新注册托盘，此时 Electron 会**丢 tooltip**（上游已修，PR electron/electron#54624）。症状是溢出面板里出现**无名称的空白格子**。

- 它解释「图标在但没名字 / 渲染成空白」，**不解释「完全没有条目」**。用 Step 3 的 `hr` 一刀分开。
- 因此 `setImage()` / `setToolTip()` 保活补丁对根因无效（本机实测：补丁在实例里生效了，图标依然没有，且 GetRect 仍全失败）。

## 已否证的假设（别再重复验证一遍）

| 假设 | 否证证据 |
|---|---|
| 托盘有 16 个图标上限 | 溢出面板实测远超 16；同一 PNG 手工连注 3 个全部出现 |
| explorer 重启把图标丢了 | explorer 启动时间早于应用实例 5 小时，且新实例照样不出现 |
| 空 tooltip = 幽灵条目导致 | `tipLen=0` 在健康应用上同样出现，与是否显示无关 |
| 注册表被污染 / 持久隐藏 | 键随进程生死，两个实例的键同时消失；`UIOrderList` 两边都在 |
| 图标文件坏 / DPI 空图 | 与正常工作的 Beta 安装 SHA1 相同，`IconSnapshot` 16x16 非空 |
| Electron / Chrome 版本差异 | 两个安装同为 Electron 44.0.0，托盘代码逐行一致 |
| `tray.getBounds()` 返 `0x0` 就是没注册 | `0x0` 只表示「当前没画在屏幕上」，与「藏在溢出面板」同形，必须靠 GetRect 区分 |
| 宿主窗口存在 = 已注册 | 健康与故障应用的 `Electron_NotifyIconHostWindow` 都是 `0,0,0x0`、都不可见 |

## 修复方案（属于系统级改动，先弹窗拿确认再动）

硬判据只有一条——**让 explorer 与应用处于同一完整性级别**。三个可落地选项：

| 方案 | 做法 | 收益 | 代价 / 回滚 |
|---|---|---|---|
| A 恢复 UAC（推荐） | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System` 置 `EnableLUA=1`（配套 `ConsentPromptBehaviorAdmin=5`、`PromptOnSecureDesktop=1`），重启 | 一次改对，explorer 回 Medium，与所有常规应用同级；同时恢复系统安全基线 | 之后需要管理员权限的操作会弹确认框；回滚＝`.reg` 写回旧值 + 重启。**改前必须导出原值留回滚文件** |
| B 应用不再自我降权 | 找到应用/插件里主动降完整性或写低完整性标签的分支（本机是 `~/.dsh/cordis.patch.yml` 的 `sandbox-policy`），改它的工作目录策略 | 不动系统基线 | 属第三方应用加固逻辑，改错会让该应用其他功能失效；且需要重装级验证 |
| C 让应用以 explorer 同级启动 | 从与 explorer 同 IL 的会话启动，或改快捷方式 | 立即可验 | 每次都得这么启动，把环境问题固化成使用习惯，只当临时验证手段 |

推荐 A：B 动的是别人的加固，C 是把缺陷当特性。

## 复验（做完必须能失败）

1. 重跑 Step 1，要求 `== 3` 对目标宿主窗口出现 `registered>=1`（`withRect` 或 `noRect` 都算注册成功，`withRect=0 noRect=0` 才算没到 shell）。这条在改前是红的、改后变绿，才算判据成立。
2. 前台类改动要**目视或截图**确认图标真的在（托盘属前台；拿不到截图就显式写「未做视觉验证 + 原因」）。
3. 若仍不显示，按任务管理器「详细信息」加「完整性级别」列，核 `explorer.exe` 是否已降到与应用同级——不同级就还没生效（通常欠一次重启）。
4. 记下本技能编写时未闭环的部分：**恢复 UAC 后图标是否出现，未做视觉复验**（来源会话止于等待重启；后续仅核实 `EnableLUA=1` 与 explorer 已回 Medium）。

## 本技能脚本自身的坑（只留托盘注册专属的；PS/UIA/编码类通用坑的真源是 `/windows-ui-forensics-powershell`）

- `Shell_NotifyIconGetRect` 收的是 **`NOTIFYICONIDENTIFIER`**（x64 长 40 字节：cbSize/hWnd/uID/guidItem），不是 `NOTIFYICONDATA`（976 字节）。混用会对**每个** uID 返回 `0x80070057`，看起来像「应用没注册」——纯假红。脚本用第 0 节的 cbSize 守卫钉住它。
- `NIM_ADD` 的 `uFlags`：`NIF_GUID(0x20)` 配零 GUID、或 `NIF_MESSAGE(0x1)` 配未注册的窗口消息，都会让 `NIM_ADD` **直接返回 FALSE**（本机实测），别把它读成「shell 拒收图标」。
- 托盘状态的键只在进程注册期间存在；用 `RegistryKey.Handle`（.NET 4.x 是 `SafeRegistryHandle`，不是 `IntPtr`）取 `RegQueryInfoKeyW` 的写入时间，比手拼 64 位 `HKCU` 常量安全——手拼漏了符号扩展会得到 `ERROR_FILE_NOT_FOUND(2)`，长得像「这个 exe 没有托盘状态」。FILETIME 本身就是 100ns 刻度，再除 10 会把日期算到 1643 年。
- 跨完整性级别读别的进程：`PROCESS_QUERY_INFORMATION(0x400)` 会被拒，`PROCESS_QUERY_LIMITED_INFORMATION(0x1000)` 通常可以——两个都试，否则 explorer 读成 `no-handle` 就像「shell 不见了」。
- `GetTokenInformation(TokenIntegrityLevel)` 返回的 `TOKEN_MANDATORY_LABEL` 里 **SID 指针偏移随构建变化**（本机该构建在偏移 0）；不要写死，先用自己的 token 校准一次再读目标进程，否则会把 IL 读成乱值。
- PS 里取正则捕获组**别写 `[int]$Matches[1]`**：实测会把整个 SID 串当整数转换，报「无法将值 S-1-16-8192 转换为 System.Int32」并在进程表中途崩掉；改成 `-replace` 去前缀 + `[int]::TryParse`。
- **与 `/windows-ui-forensics-powershell` 的一处实测分歧（未裁定）**：该手册 §2 记「`Shell_TrayWnd` 下 23 个 Button 的 `Current.Name` 全为空」；本技能 2026-10-07 同机同小时实测同一棵子树**同样是 23 个 Button，但 20 个有名字**（显示桌面 / 通知 / 时间 / 网络 / 输入法…，名字为中文）。差异最可能出在控制台码页——名字先被判成空、多半是输出编码伪装的假阴性（本技能脚本因此强制 `[Console]::OutputEncoding=UTF8`）。按对方的夹具跑之前先核这一条；两边都别拿"名字为空"直接当"图标不存在"的判据。

通用纪律（中文匹配、UIA 按 AutomationId/ClassName、`$pid` 只读、hex 常量、必红夹具）不在本文件重复，直接看 `/windows-ui-forensics-powershell`；从 Git Bash 起 PS 与原生 CLI 的替换规则看 `/windows-powershell-from-gitbash`、`/windows-gitbash-command-safety`。

本技能三个脚本**故意全 ASCII**（含 `>> PASS` / `>> FAIL` / `>> NO-RUN` 标记）：PS 5.1 读无 BOM 的 UTF-8 `.ps1` 会把中文字面量按 ANSI 解码打成乱码，而乱码正好落在要给 agent 读的判据行上。中文说明只放本文件。

## Resources

- `scripts/tray-inventory.ps1` — 六节只读盘点（IL / 宿主窗口 / GetRect / 注册表 / UIA / 归因），不改任何状态。
- `scripts/control-icon.ps1` — 正向对照注册，带负对照与 IL 校准；唯一能证明「探针测得出」的一步。
- `scripts/win32-tray.ps1` — 上面两个共用的 Win32 助手（`Add-Type` 编译 C#，含 `NOTIFYICONIDENTIFIER`、token IL、UIOrderList、`TaskbarCreated` 广播）。不要单独运行。
- 相关：`/diagnose-windows-webview2-blank-window`（套壳白屏）、`/edge-net-check`（网页打不开）。同族 UIPI 现象另见 Windows 拖放失效一例——症状不同、机制同源。
- 若打算改安装目录里的应用 JS 来做"重设图标/保活"（本机试过且对根因无效），先走 `/shipped-app-js-patch-hygiene`：改前用 SHA1 + marker 命中数证明在改的是原版，备份命名可回滚。
