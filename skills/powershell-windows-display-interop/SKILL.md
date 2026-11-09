---
name: powershell-windows-display-interop
description: "用 PowerShell Add-Type P-Invoke 读或改 Windows 显示栈——EDID 块、HDR 与自动色彩管理、HDR 状态取证、当前分辨率、刷新率、像素时钟、位深、显示器友好名。用于 DisplayConfigGetDeviceInfo 或 EnumDisplaySettings 返回 TRUE 或 hr=0 却字段全空、设备信息调用对每种类型都回 hr=0x1F 或 0x7A、EDID 扩展块解析成乱码、Add-Type 编不过内联 C#（CS0266、ToString 字符字面量、缺 Desktop 程序集）、模式或路径结构体读回全 0。"
---

# Windows 显示栈 PowerShell interop

## Overview

用 `Add-Type` 内联 C# + P-Invoke 读写 Windows 显示栈（QueryDisplayConfig / DisplayConfig*DeviceInfo / EnumDisplayDevices / 注册表 EDID）的可靠套路。目标是把「接口看着坏了」这类假阴性在半小时内定性掉，而不是反复改结构体参数。驱动方式与编码规约（`.ps1` + `-File`、脚本体 ASCII-only、斜杠参数被转成盘符路径、`>` 写 UTF-16）见姊妹技能 `windows-powershell-from-gitbash`，本技能只写显示栈相关的增量。

## 0. 先定性：通路坏 ≠ 参数错 ≠ 没权限

改任何东西之前按顺序做三个实验：

1. **对照组**：先跑一个同族、非提权就该成功的调用（`QueryDisplayConfig(0x2, ...)` 用裸 `byte[]`）。它出数而目标 API 失败 ⇒ 编组和进程环境没问题，问题在具体调用或通路本身。
2. **提权只做一次**：用 `-Verb RunAs` 自重启跑同一份脚本，把提权前后的 hr 码都写进日志。**提权前后 hr 一模一样 ⇒ 与权限无关**，此后不要再拿提权当变量重试。
   - 本机实证：Windows 11 26H2 build 26300 + RTX 5080，`DisplayConfigGetDeviceInfo` 对**每一个** device-info type 恒 `0x0000001F`，`DisplayConfigSetDeviceInfo` 恒 `0x0000007A`，提权后不变；佐证是 `HKLM:\...\GraphicsDrivers\Configuration` 整键缺失。这类机器上 HDR 只能走注册表持久面 + 面板目视，脚本重试是纯消耗。
3. **换通路，不换参数**：通路判坏后改读持久化真相（`MonitorDataStore` / `DisplayFeatureSetUsage` / `DirectXUserGlobalSettings`）与 `EnumDisplaySettings` / WMI，别继续在 device-info 上试结构体变体。

## 1. 编组（marshalling）铁律

- **写入型结构体必须 `ref` / `out` / `[In, Out]`**。按值传的后果是 API 返回 TRUE、字段全空——长得跟「这台机器没有设备」或「接口坏了」一模一样。实测 `EnumDisplayDevices(string, int, DISPLAY_DEVICE buf, int)`（少了 `ref`）连 8 次返回 TRUE + 空串，补 `ref` 立刻出名字。**同一段 DllImport 里所有出参逐个检查**，不要只修刚撞见那一个。
- **更稳：传裸 `byte[]` 自己按小端偏移解**。一次躲开 ANSI/Unicode 选择、`Pack` 对齐、字段顺序、数组 stride 四类坑；缓冲区多给一点就不会 `ERROR_MORE_DATA`。
- **不要猜 stride**。先用绝对偏移把整块缓冲按 4 字节一组打印出来，认出已知量（分辨率、刷新率、像素时钟、LUID），再定每条记录步长。实测把 mode 条目按 stride 256 取，第二条读出全零，而全零会被误判成「该模式不存在」——**这是假读数，不是结论**。
- **`DISPLAYCONFIG_DEVICE_INFO_HEADER` 手填四段**：`+0` size（必须是目标结构体的**原生**大小，不是缓冲区长度）、`+4` type（文档枚举号）、`+8` adapterLuid、`+16` id（target 或 source）。
- **取位对不对要有能失败的判据**：把解出的 luid/id 填进 header，正常机器应返回 `0x00000000`；恒 `0x57`/`0x1F` 时先怀疑 id 过期或偏移错（**每次调用前重新 `QueryDisplayConfig` 取 id**，拔插/改分辨率后 id 会变），而不是继续换别的参数。
- `DllImport` + `CharSet.Unicode` 会自动探测 `W` 后缀，EntryPoint 写不带后缀的名字通常能跑；写错报的是「找不到入口点」，**别误读成「返回空」**。

## 2. C# here-string 里 Add-Type 的四个固定坑

- **数值→byte 必须显式 cast**：`d[0] = (byte)(v & 0xFF); d[1] = (byte)(v >> 8);`，写 `d[0] = 840` 直接 CS0266。
- **C# 没有单引号字符串**：`hz.ToString('0.000')` 编译不过（`'0.000'` 是字符字面量），一律 `ToString("0.000")`；`"X8"` 同理全用双引号。
- **用 WinForms / Drawing / 部分 `Process` 重载要带引用程序集**：`Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Windows.Forms.dll','System.Drawing.dll'`，否则报「… 缺少对 'Desktop' 的定义」。
- **`@"..."@` 会展开 `$` 和反引号**：C# 里出现插值 `$` 会被 PowerShell 吃掉 ⇒ 默认用 `@'...'@` 单引号 here-string，需要的变量在 PowerShell 侧先拼好。`using` 全部写进 `$src`，Add-Type 不继承会话状态。**最易漏的一条**：写了 `[In, Out]` / `DllImport` 短写法就必须 `using System.Runtime.InteropServices;`，否则报「未能找到类型或命名空间名称“In」」——这条错看起来像 P-Invoke 本身坏了，实测就是这样把一个本来正确的骨架卡住的。

## 3. 显示栈特有的 Git Bash 坑

- `whoami /groups` / `/priv` 上是**两个独立的坑叠加**（查完整性级别 / AppContainer 时首当其冲）：① Git Bash 的 `whoami` 是 coreutils 版本，报 `extra operand '/groups'`；而 **PowerShell 继承了同一份 MSYS PATH**，所以 `powershell.exe -Command "whoami /groups"` 一样失败——只换宿主不解决问题。② 直接把 `/groups` 传给原生 exe 会被 MSYS 转成 `D:/software/Git/groups`，报「无效参数/选项」。能用的写法只有两条：`powershell.exe -NoProfile -Command "C:\Windows\System32\whoami.exe /groups"`（全路径写在 `-Command` 串**内**），或 `MSYS2_ARG_CONV_EXCL='*' /c/Windows/System32/whoami.exe /groups`。
- `cmd /c "..."` 的 `/c` 被转成 `C:/Program Files/Git/c`，症状是弹一个空白 cmd 并只打版本横幅（看着像「命令没执行」）。能走 PowerShell 原生 cmdlet 就别绕 cmd。
- 其余（inline `-Command` 吞 `$_`、`/y` 类斜杠参数、无 BOM 脚本按 ANSI 读）归姊妹技能。

## 4. 取证只读 log，不读 stdout

- 控制台 GBK 乱码**不代表执行失败**（Add-Type 的中文错误就是这样）。用骨架里的 `Say` 同写控制台与 `log.txt`，**判定只读 log 文件**。
- 脚本内写文件用 `Out-File -Encoding utf8` 或 `Add-Content`（避开 PS 5.1 `*>` 的 UTF-16）；中文结论写成 UTF-8 文件再用 Read 工具读回。
- `字符串缺少终止符 / TerminatorExpectedAtEndOfString` **先排嵌套双引号再怀疑编码**（纯 ASCII 脚本也会出同一报错）；驱动与码页细则见技能 `windows-powershell-from-gitbash` 与 `windows-powershell-scripting-safety`。

## 5. 交付顺序（probe → DryRun → 备份 → 执行 → 复验）

1. `probe1.ps1`、`probe2.ps1`…：**只读**，dump 现场（live mode + 持久值 + EDID 解析 + 各 API 的 hr 码）。只读探针就能把「通路坏」定掉，必须先于任何写操作。
2. 交付脚本**必须带 `[switch]$DryRun`**，每个写点都 `if ($DryRun) { Say "  DRYRUN would ..."; return }`。
3. **先 `-DryRun` 全流程实跑一遍**（含提权自重启后的路径），确认每个分支都被打印、没有抛错，才去掉开关真写。
4. 写 HKLM 前 `reg export` 相关键到与 `log.txt` 同目录的带时间戳输出目录；回滚＝双击导入这些 `.reg`，要写进脚本头部注释。
5. 提权走自重启（`-Verb RunAs`），**逐个开关都要拼进重启参数**，否则提权后跑的是「无开关」默认路径。
6. **复验用非提权进程重读一遍**，确认值没被系统/驱动回写；`AutoColorManagementEnabled` 这类要显示通路重新初始化（注销 / 重启 / 拔插 DP）才生效，「改完立刻读不到变化」不等于没写进去，要显式标注。

## 6. 清理安全（最容易造成不可逆损失的一步）

- **scratch 命名不得与交付文件同前缀**。实测 `rm -rf hdr-apply-*` 把交付的 `hdr-apply-admin.ps1` 一起删了——而此前 `ls -1d hdr-apply-*` 已经把它列出来了：**glob 一旦命中就不再区分临时物和交付物**。
- 规约：临时产物用不同前缀（`probe1.ps1` / `test-dryrun.ps1`）或放 `D:/tmp/`；删除**只逐个点名**，删前看一眼 `ls -1d` 清单；`rm -rf` 之后立刻 `wc -l <交付文件>` 作为「交付物还在」的可失败判据。
- 交付脚本要写第二版之前，先 `cp` 一份再改。

## 7. 可复制骨架

```powershell
param([switch]$DryRun, [switch]$TryApiSet)          # param() 必须是第一条语句
$ErrorActionPreference = 'Stop'

# elevation: relaunch preserving switches
$id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $rl = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($DryRun) { $rl += ' -DryRun' }
  if ($TryApiSet) { $rl += ' -TryApiSet' }
  Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -ArgumentList $rl
  exit
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $PSScriptRoot "report-$ts"      # deliverable prefix must NOT match scratch prefix
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $outDir 'log.txt'
function Say($m) { Write-Host $m; Add-Content -Path $log -Value $m }   # console is GBK-mangled; log is truth

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;   // [In, Out] will not compile without this
public static class Dx {
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern int QueryDisplayConfig(int flags, ref uint pc,
      [In, Out] byte[] paths, ref uint mc, [In, Out] byte[] modes, IntPtr cur);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern int DisplayConfigGetDeviceInfo([In, Out] byte[] info);
  static uint U(byte[] b, int o) { return (uint)(b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)); }
  static string S16(byte[] b, int off, int max) {
    int n = 0; while (n < max && (b[off + n*2] | (b[off + n*2 + 1] << 8)) != 0) n++;
    return Encoding.Unicode.GetString(b, off, n * 2);
  }
  static void Hd(byte[] b, int size, int type, uint luid, uint id) {
    Array.Clear(b, 0, b.Length);
    b[0] = (byte)size; b[1] = (byte)(size >> 8); b[4] = (byte)type;          // CS0266 if uncast
    b[8] = (byte)luid; b[9] = (byte)(luid >> 8); b[10] = (byte)(luid >> 16); b[11] = (byte)(luid >> 24);
    b[16] = (byte)id;  b[17] = (byte)(id >> 8);  b[18] = (byte)(id >> 16);  b[19] = (byte)(id >> 24);
  }
  public static string Report() {
    StringBuilder sb = new StringBuilder();
    uint pc = 8, mc = 24;
    byte[] paths = new byte[8 * 128], mdes = new byte[24 * 128];
    int hr = QueryDisplayConfig(0x2, ref pc, paths, ref mc, mdes, IntPtr.Zero);
    if (hr != 0) return "QueryDisplayConfig hr=0x" + hr.ToString("X8");       // double quotes, never 'X8'
    uint luid = U(paths, 20), tid = U(paths, 28) & 0x3FFFFF;
    for (int i = 0; i < mc && i * 64 + 56 < mdes.Length; i++) {               // stride: VERIFY by dumping, do not guess
      int o = i * 64;
      if (U(mdes, o) != 2) continue;
      double hz = U(mdes, o + 32) / (double)U(mdes, o + 36);
      sb.AppendLine("mode: " + U(mdes, o + 40) + "x" + U(mdes, o + 44) + " @ " + hz.ToString("0.000") +
                    " Hz, pclk " + (U(mdes, o + 16) / 1000000.0).ToString("0.0") + " MHz");
    }
    byte[] ac = new byte[64]; Hd(ac, 28, 9, luid, tid);                        // 9 = GET_ADVANCED_COLOR_INFO
    int h9 = DisplayConfigGetDeviceInfo(ac);
    sb.Append("GET_ADVANCED_COLOR_INFO hr=0x" + h9.ToString("X8"));
    if (h9 == 0) {
      uint v = U(ac, 20), v2 = U(ac, 24);
      sb.Append(" HDRactive=" + ((v >> 1) & 1) + " supportsHDR=" + (v & 1) +
                " bitsPrimary=" + (v2 & 0xFFF) + " bitsSecondary=" + ((v2 >> 12) & 0xFFF));
    }
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
Say '[live]'
Say ([Dx]::Report())

# registry-backed truth: read always, write only past DryRun
$md = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\MonitorDataStore'
foreach ($k in Get-ChildItem $md) {
  $p = Join-Path $k.PSPath 'Volume'
  if (-not (Test-Path $p)) { continue }
  $v = Get-ItemProperty $p
  Say ((Split-Path $k.PSPath -Leaf) + ' HDREnabled=' + $v.HDREnabled + ' AutoColorMgmt=' + $v.AutoColorManagementEnabled)
  if ($DryRun) { Say '  DRYRUN - nothing written'; continue }
  # Set-ItemProperty ... only after reg export backup of this key
}
```

EDID 分块（`+=` 不带前置逗号会把 128 字节摊平进外层数组，块数看起来永远是 1）：

```powershell
function Get-EdidBlocks($bytes) {
  $blocks = @()
  for ($i = 0; $i + 128 -le $bytes.Count; $i += 128) { $blocks += ,$bytes[$i..($i+127)] }
  return ,$blocks           # 两个逗号都不能省：内层防 128 字节摊平进 $blocks，外层防函数返回值被管道拆一层
}
# [0] base block, [1..] extensions; extension tag = $blocks[$n][0]
# **实测陷阱**：写成 `return $blocks` 时，只有 1 块（无扩展块）的显示器会把内层 128 字节直接吐出来，$b.Count=128，
# 而 $b[1][0] 仍读出一个看着合理的 0xFF（其实是基块第 2 个字节）——假数据不报错。多块时又正常，所以必须带单块对照组。
# CTA-861 里找 DBS tag 0x03 (HF-EOTF-DB)：+1 -band 0x80 才有效；+2 EOTF bits 1=HDR10 2=HDR10+ 4=DolbyVision 8=HLG 16=Traditional
# 峰值亮度 = $blk[$j+3] / 50.0 cd/m2；面板型号取 EDID 的 name descriptor，别信 PnP 设备名
```

## 8. 读法速查与 hr 码

| 想要的量 | 通路 | 状态 |
|---|---|---|
| 分辨率 / 刷新率 / 像素时钟 | `QueryDisplayConfig(0x2, ...)` 裸缓冲，mode stride 64：`+32/+36` 分子分母、`+40/+44` 宽高、`+48/+52` total、`+16` pclk | 本机实跑通，数值与 EDID 范围限制一致 |
| adapterLuid / targetId | 同上 paths 缓冲 `+20`、`+28 & 0x3FFFFF` | 本机 device-info 恒坏 ⇒ **靠 header 调用返回 0 自证这一步未验证** |
| HDR 支持 / 活跃 / 位深 | device-info type 9（size 28），`+20` bit1=active，`+24` `&0xFFF` / `>>12` | 按原生结构体取位成立；本机**未拿到成功返回** |
| 显示器友好名 / 输出技术 | device-info type 2（size 420），UTF-16 名在 header 之后 | 同上，**未验证** |
| HDR 开关（临时，可被驱动覆盖） | type 10 `SET_ADVANCED_COLOR_STATE`，`+20` 置 1 | 需提权；本机恒 `0x7A` |
| HDR / 色彩管理持久真相 | `MonitorDataStore`（`HDREnabled`、`AutoColorManagementSupported/Enabled`）、`DisplayFeatureSetUsage` | **最可靠读写面**，非提权可读 |
| Auto HDR 全局与每游戏 | `HKCU:\...\DirectXUserGlobalSettings` 的 `AutoHDREnable=`；每游戏子键同名串 | 拼接串，改写要整串回写 |
| NVIDIA TrueHDR 旁证 | NVIDIA 类键里的 `_User_Global_*_TrueHDR` | 只作旁证，必须与 `MonitorDataStore` / `AutoHDREnable` 交叉核对，不单独定性 |
| Auto HDR 是否真的生效 | 事件查看器的 Display 事件 **4125** | 有 4125 才说明 Auto HDR 实际启用；只看到 `AutoHDREnable=1` 不等于生效 |
| EDID | `HKLM:\SYSTEM\CurrentControlSet\Enum\DISPLAY\<mon>\<inst>\Device Parameters\EDID` | 分块见上 |

| hr | 名 | 判读 |
|---|---|---|
| `0x00000000` | S_OK | |
| `0x0000001F` | ERROR_GEN_FAILURE (31) | 每个 type 都 31 ⇒ 通路坏，换持久面，不要再重试 |
| `0x0000007A` | ERROR_MORE_DATA (122) | header size ≠ 结构体原生大小；恒 122 也是通路坏的表现 |
| `0x00000057` | ERROR_INVALID_PARAMETER (87) | 先查 luid/id 是否过期、header 取位是否错 |
| `0x00000032` | ERROR_NOT_FOUND (50) | id 对不上当前拓扑，重新 `QueryDisplayConfig` |
| TRUE + 字段全空 | — | **按值传参的编组 bug**，不是「没有设备」 |

## Checklist

1. 对照组跑了吗（同族、非提权应成功的调用）？
2. 提权只跑一次并留下前后 hr 对比？
3. 所有写入型结构体逐个确认 `ref` / `[In, Out]`？
4. stride 与取位靠打印核对，不靠猜？全零当假读数不当结论？
5. here-string：byte 显式 cast、字符串双引号、`-ReferencedAssemblies`、`$` 展开？
6. 判定读 `log.txt`（UTF-8）而非 stdout？EDID 分块有前置逗号？
7. `-DryRun` 全流程实跑过；`reg export` 备份落在交付目录里？
8. 非提权复验过没被回写？未生效部分标成「未验证 + 原因」？
9. 删除只点名，scratch 与交付不同前缀，交付物 `wc -l` 仍在？
