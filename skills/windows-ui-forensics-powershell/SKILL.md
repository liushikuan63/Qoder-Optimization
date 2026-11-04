---
name: windows-ui-forensics-powershell
description: "从 Git Bash 驱动的 Windows 桌面取证手册——截图、UIA 枚举、托盘与飞窗检查、P-Invoke 常量，以及会让探针说谎的编码陷阱。用于 PowerShell 探针报 0 项或无匹配却要分清空窗口与缺句柄、UIA Name 为空要靠 AutomationId 或 ClassName、Add-Type 前找不到类型、0x80000000 变负 Int32 破坏 uint 参数、无 BOM 的中文被当 cp936 而静默不匹配，以及点击-截图-枚举易失界面之前。订正见 windows-powershell-from-gitbash《订正与增量》。"
when_to_use: Windows 桌面取证写 PowerShell 探针（截图 / UIA 枚举 / 托盘瞬态面板 / P-Invoke 常量）；探针报 0 项或匹配不到、要分清"窗口是空的"与"句柄没拿到"时
---

# Windows 桌面取证（PowerShell 探针）避坑手册

## Overview

本手册只管一件事 - **取证的失败大多是探针自己没拿到东西，而不是目标真的没有**。下面每条都带 2026-10-07 本机实测的报错原文或对照读数，按"必红夹具 → 正确写法"的顺序排。基础三条硬替换（不内联 `-Command`、脚本体 ASCII、不用 `*>`）与 node 运行器见技能 `windows-powershell-from-gitbash`，本文不重复。

数值标注说明 - `cp936`、`23 个 Button`、Win11 的类名都是**本机示例**，判据本身与机器无关，换机器先重探。

## 0. 三条前置纪律

1. **锁屏时一切 GUI 驱动必失败** - 先 `Get-Process -Name LogonUI`，在跑就打印 `NO-RUN: locked` 并退出，别把它记成"没找到窗口"（前台被 LockApp 持有时窗口激活一律被拒）。
2. **码页先探不猜** - `chcp` 实测本机 936，PS 自身中文错误文本的字节是 GBK；读回日志按"能 UTF-8 解码就直用，否则 iconv GBK→UTF-8"分支，别硬写码页。
3. **取证卫生** - 临时产物落 `%TEMP%/qoder-work/<任务>/`；截图**用完立即删**（画面里是用户邮件标题、令牌、别人开的窗口），原图不进记忆也不进汇报。

## 1. 中文匹配 - 默认形状是静默假阴性，不是报错

含中文的 `.ps1` 存成 **UTF-8 无 BOM** 交给 `powershell.exe -File`，实测（首三字节 `24 45 72`）：

```powershell
$literal = '托盘'                                   # e6 89 98 e7 9b 98 被按 cp936 读成 3 个字
$expect  = [string][char]0x6258 + [string][char]0x76D8   # 正确的两个字
$literal.Length        # 实测 3
$literal -ceq $expect  # 实测 False
$text -match $literal  # 实测 False
```

**退码 0、零异常、脚本末尾标记照常打印** - 比报错更危险，因为取证时会读成"这个窗口/进程里没有这个名字"。把同一文件首三字节改成 `ef bb bf`（带 BOM）后 `Length=2`、`-ceq True`、`-match True`。

- 会不会报 `字符串缺少终止符` **取决于具体字节**（第二字节撞上 `"` 或 `'` 才吞引号），所以**禁止拿"有没有报错"当编码判据**。
- 根修＝存 UTF-8 **带 BOM**（或改 `pwsh`）；不动文件编码的等价修法＝用 `[char]0x…` 码点拼串（实测两支都对）。
- 自检写法（ASCII 输出、不受码页污染），凡中文匹配先跑一遍：

```powershell
function Cp([string]$s) { if (-not $s) { return '<empty>' }; (($s.ToCharArray() | %{ '{0:X4}' -f [int]$_ }) -join ' ') }
Write-Output ('literal-cp=' + (Cp $literal) + ' expect-cp=' + (Cp $expect))
```

## 2. UIA 定位 - Name 常是空串，按 AutomationId / ClassName

本机 Win11 实测：`Shell_TrayWnd` 下 `ControlType=Button` 共 **23 个，`Current.Name` 全为空**，只有 `AutomationId`（`StartButton`、`SystemTrayIcon`、`Appid: MSEdge`）和 `ClassName`（`SystemTray.NormalButton`、`Taskbar.TaskListButtonAutomationPeer`、`SystemTray.OmniButton`）可用。

⇒ `Name -match '显示隐藏的图标'` 这类文案匹配**必假阴性**，还叠加 §1 的编码坑（两重）。先用"列清单"探针把可用标识打出来，再决定按哪个属性找：

```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tray = [WinProbe]::FindWindow('Shell_TrayWnd', $null)          # FindWindow via Add-Type, see 4
$root = [System.Windows.Automation.AutomationElement]::FromHandle($tray)   # guard first, see 3
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
for ($i = 0; $i -lt $btns.Count; $i++) {
  $c = $btns[$i].Current; $r = $c.BoundingRectangle
  Write-Output ($i.ToString() + '|class=' + $c.ClassName + '|auto=' + $c.AutomationId +
    '|rect=' + [int]$r.X + ',' + [int]$r.Y + '|namecp=' + (Cp $c.Name))
}
```

按条件定位用 `PropertyCondition([AutomationElement]::AutomationIdProperty, 'SystemTrayIcon')`。打开瞬态面板优先用 `InvokePattern.Invoke()`，不要用 `SendInput` 挪用户鼠标；收尾发一次 `keybd_event` ESC 并复验面板已关。

## 3. 枚举报 0 项 - 判定顺序是"句柄 → 窗口 → 内容"

1. **句柄先核**。`AutomationElement.FromHandle([IntPtr]::Zero)` 抛 `ArgumentException: hwnd 不能为 IntPtr.Zero`，随后 `FindAll` 变 `InvokeMethodOnNull` - 这一条会把"窗口根本没打开"伪装成"面板里 0 项"。守卫 `if ($h -eq [IntPtr]::Zero) { 'NO-WINDOW'; return }`（实测 `-eq 0` 与 `-eq [IntPtr]::Zero` 都判真）。
2. **窗口存在性**。`FindWindow` 逐个试类名（本机 Win11 溢出面板是 `TopLevelWindowForOverflowXamlIsland` / `..._WASDK`，Win10 是 `NotifyIconOverflowWindow`）。取不到句柄时 `Marshal.GetLastWin32Error()` 实测返 **1407**（ERROR_CLASS_DOES_NOT_EXIST），直接指认"类名不存在"，不用猜。
3. **内容才轮到计数**。瞬态 UI（托盘溢出面板、右键菜单、tooltip）在**另起进程**取证会因焦点被抢而自动关闭 - 会话记录里的形状是分开跑取不到、同进程一次跑完 `FindWindow → UIA → 截图 → 关闭` 拿到 `count=17`。
   **这条本轮未在 Win11 复现 A/B**（本机溢出按钮不作为 `Shell_TrayWnd` 的 Button 子元素暴露，`InvokePattern` 路径没打通），只有会话证据 - 拿它当前提前先自己跑一次同进程版本，别直接引用计数。

## 4. System.Drawing - 类型必须先加载

实测四形（`Add-Type -AssemblyName System.Drawing` **之前**），报错外壳不同、消息同一个：

| 写法 | 实测报错 |
| --- | --- |
| `[GraphicsUnit]::Pixel` | `RuntimeException :: 找不到类型 [GraphicsUnit]。` |
| `[System.Drawing.GraphicsUnit]::Pixel` | `RuntimeException :: 找不到类型 [System.Drawing.GraphicsUnit]。` |
| `New-Object System.Drawing.Bitmap 10,10` | `PSArgumentException :: 找不到类型 [System.Drawing.Bitmap]: 请确认加载了包含该类型的程序集。` |
| `GraphicsUnit::Pixel`（C# 双冒号原样抄进 PS） | `CommandNotFoundException`（PS 只认 `[类型]::成员`） |

可用的裁剪骨架（实测落地 PNG）：

```powershell
Add-Type -AssemblyName System.Drawing
$src = New-Object System.Drawing.Bitmap 40,40
$dst = New-Object System.Drawing.Bitmap 12,12
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,12,12),
                  (New-Object System.Drawing.Rectangle 4,4,12,12),
                  [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$dst.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
```

- 全屏取帧 `[System.Drawing.Graphics]::CopyFromScreen($x,$y,0,0,$bmp.Size)`，坐标取 UIA `BoundingRectangle`；先 `SetProcessDPIAware` 否则尺寸缩错，最小化窗口的 rect 报 `-32000,-32000`（要先 `ShowWindow($hwnd,9)`）。
- 重载写错时报的是**参数转换**错并点名参数 - `MethodException :: 无法将"DrawImage"的参数"destRect"(其值为"0")转换为类型"System.Drawing.Rectangle"`。**读它点名的参数名**，别归因成"GDI+ 坏了/缺权限"。

## 5. P/Invoke 常量 - hex 先变负 Int32，`[uint32]` 也救不回来

实测五形态对照（`WS_POPUP` 正是 `0x80000000`，是最容易撞上的高位标志）：

| 写法 | 实测结果 |
| --- | --- |
| `0x80000000` | Int32 **`-2147483648`**；`0xFFFFFFFF` → Int32 **`-1`** |
| `[uint32]0x80000000` | **FAIL** `无法将值"-2147483648"转换为类型"System.UInt32"。错误:"值对于 UInt32 太大或太小。"` |
| `0x80000000 -as [uint32]` | **静默返回空**（`$null`），比报错更坏 |
| `[uint32]::Parse('80000000',[System.Globalization.NumberStyles]::AllowHexSpecifier)` | **2147483648** - 实测唯一可用 |
| 裸 `0x80000000` 传给 `CreateWindowExW` 的 `uint exStyle` | `MethodException :: 无法将"CreateWindowExW"的参数"exStyle"(其值为"-2147483648")转换为类型"System.UInt32"` |

⇒ 高位标志一律写**十进制**（`[uint32]2147483648`）或用上面的 `Parse(..., AllowHexSpecifier)`；**`[uint32]0x8000…` 是把同一个负数再转一次，照样红**（网上/自动推荐里常见的这个修法已被实测否证）。

`IntPtr` 形参实测可直接收裸 `0`（成功建窗、返回非零句柄），不强制 `[IntPtr]::Zero`；但判失败统一用 `-eq [IntPtr]::Zero`（§3）。

建窗探针要放到 `-32000,-32000` 并随后 `DestroyWindow`，别在用户桌面上闪出真窗口。

## 6. `$pid` 是只读自动变量 - 定义过、调用炸、行号在调用处

三形实测全红，异常同一个 `SessionStateUnauthorizedAccessException :: 无法覆盖变量 PID，因为该变量为只读变量或常量`（`FullyQualifiedErrorId: VariableNotWritable`）：

```powershell
$pid = 4242                              # 立刻红
foreach ($pid in 1,2) { }                # 红
function Get-IlLevel([int]$pid) { $pid }  # 定义这一步不报错
Get-IlLevel 0                             # 一调用就红，报错行指向调用处
```

最坑的是中间那形 - `[PSParser]::Tokenize` 语法门对它 `PARSE-OK`，只有运行时才炸且行号不在 `param()` 上。⇒ 探针里的进程号一律命名 `$procId` / `$targetPid`。`$PID`（当前进程）实测始终可读、不会被覆盖。

## 7. 完整性级别 SID - 能构造，不能 Translate

`New-Object System.Security.Principal.SecurityIdentifier 'S-1-16-12288'` **构造成功**并回显 `.Value`，但 `.Translate([System.Security.Principal.NTAccount])` 抛 `IdentityNotMappedException :: 未能转换部分或所有标识引用`（native `ConvertSidToStringSid` 那侧同族报 `sidConvErr 122`）。

⇒ 判完整性级别一律比**原始串** `S-1-16-8192`(Medium) / `-12288`(High) / `-16384`(System)，不要 `Translate`。托盘图标"应用有句柄但 shell 就是不显示"的一类根因就是高低 IL 不匹配（UIPI 静默丢弃 `Shell_NotifyIcon`），取证阶梯见技能 `electron-tray-icon-diagnosis`。

## 8. 每条都要有必红夹具

上手册任一条面前先自证它能红（本手册的条目都按这个方式验过）：

| 条目 | 必红夹具 | 必绿对照 |
| --- | --- | --- |
| §1 | 无 BOM 存中文 ⇒ `-ceq False` | 加 BOM ⇒ `True` |
| §2 | `Name -match '中文'` ⇒ 无命中 | 按 `AutomationId` ⇒ 命中 |
| §3 | `FromHandle([IntPtr]::Zero)` ⇒ `ArgumentException` | 先核句柄 ⇒ 明确报 `NO-WINDOW` |
| §4 | 不 `Add-Type` ⇒ `找不到类型` | `Add-Type` ⇒ 出 PNG |
| §5 | `[uint32]0x80000000` ⇒ `值对于 UInt32 太大或太小` | `Parse(...,AllowHexSpecifier)` ⇒ 2147483648 |
| §6 | `$pid = 1` ⇒ `VariableNotWritable` | `$procId = 1` ⇒ 退 0 |
| §7 | `Translate([NTAccount])` ⇒ `IdentityNotMappedException` | 比原始 `S-1-16-*` 串 |

顺带否证一条常见误记 - `'a,b'.Split()` 在 PS 5.1 **实测正常返回**，不要拿它当 `MethodCountCouldNotFindBest` 的例子（该报错 id 只在会话记录里出现过，原始调用形状未定位）。

## 边界（不重复同域技能）

- 原生 CLI 的斜杠开关被 MSYS 转盘符路径（`reg` / `whoami` / `sc` / `tasklist`）⇒ **`windows-gitbash-command-safety`**（含封装脚本，已实测）。
- 语法门必须 `-File`、嵌套双引号、四种写盘的 BOM 差异、退 0 与异常共存、代理与码页自探 ⇒ **`windows-powershell-from-gitbash`《订正与增量》**。
- 基础三条硬替换 + `<本机辅助脚本>/psdiag.cjs` 运行器 ⇒ **`windows-powershell-from-gitbash`**。
- 托盘图标为何不显示（`Shell_NotifyIconGetRect` 逐 uID、对照注册）⇒ **`electron-tray-icon-diagnosis`**。
- 需要管理员权限的改动（HKLM 写、服务 ImagePath、计划任务）⇒ **`windows-elevated-changes-from-git-bash`**，并按本机红线先给方案与回滚。
- 显示栈 / EDID / HDR ⇒ **`powershell-windows-display-interop`**。
- 往用户窗口注入按键 ⇒ **`windows-desktop-keyboard-automation`**（本手册只发 ESC 收尾自己的面板）。

## 验证状态

- **本机实测、有报错原文或对照读数**（2026-10-07）- §1 无 BOM/带 BOM 两支、§2 23 个 Button 的 `Name` 全空、§3 的 `IntPtr.Zero` 判定与 `GetLastWin32Error=1407`、§4 四形 TypeNotFound 与裁剪落地、§5 五形态对照（含 `[uint32]` 直转被否证）、§6 三形、§7 `Translate` 异常、§8 的 `'a,b'.Split()` 否证。
- **未本机复现** - §3 的"跨进程焦点抢占关掉瞬态面板"只有会话证据（Win11 上溢出按钮不作为 `Shell_TrayWnd` 的 Button 暴露，`InvokePattern` 未打通）。引用它之前自己跑一遍同进程版本。
- **不做视觉验证的部分** - 本手册的截图步骤产出的一次性 PNG 已按卫生规则删除，未留图；判据是字节数与"截图后已删"的复验，不是画面比对。

## 9. 提权窗口：不可驱动、不可关、也不可截（2026-10-07 实测）

`services.msc` / `gpedit.msc` / `secpol.msc` / `taskschd.msc` 都带**自动提权**标志。从非提权会话 `Start-Process` 它们会弹 UAC，产出的是 HIGH IL 窗口，于是：

- **关不掉**：`Stop-Process -Force` 回"拒绝访问"；`PostMessage(WM_CLOSE)` 被 UIPI **静默丢弃**（不报错，窗口照旧）⇒ 你为取证开的窗口会留在用户桌面上。
- **提不到前台**：`SetForegroundWindow` 跨完整性级别被拒。而 `capture-window.ps1` 走的是 `CopyFromScreen`（抓屏幕矩形，不是 PrintWindow），于是截到的是**当时真正在前台的窗口**——本轮截到的是用户正在玩的游戏画面。这既是无效证据也是隐私事故：**截到用户私人内容立刻删除**，并在汇报里点名。
- **正解**：需要这类窗口的像素证据时，**整条链路都要提权**（把 capture 调用放进提权 payload 里跑）；做不到就放弃像素证据，改用可失败的注册表 / 计数判据，并显式写"未做视觉验证 + 原因"。
- **前置纪律补一条**：不要为了拿"前台证据"去开**会抢焦点**的窗口，尤其用户正在用机器时（本轮两次 UAC 被跳过即因此，任务被拖长）。要动 GUI 先说一句，再在同轮内复验它是否真被执行。
