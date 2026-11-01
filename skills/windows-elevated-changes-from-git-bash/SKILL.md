---
name: windows-elevated-changes-from-git-bash
description: "从未提权的 Git Bash 或 MSYS 会话执行需要管理员权限的 Windows 改动——HKLM 注册表写、服务 ImagePath 与配置、计划任务、ACL 受限路径、服务重启。固定双文件模式：纯 ASCII 的提权 payload .ps1 把带时间戳结果追加进日志，启动器用 Start-Process -Verb RunAs -PassThru -File 再回读日志，因为提权子进程写不到调用方 stdout。用于需要 UAC、reg.exe add /d 吞引号造成无引号服务路径、HKLM 写了但值没变、exitcode=0 不可信。"
when_to_use: "需要管理员权限写 Windows（HKLM 注册表值 / 服务 ImagePath 与配置 / 计划任务 / 受保护目录）且当前 shell 非提权时"
---

# 从非提权 Git Bash 会话安全执行 Windows 管理员改动

## Overview

提权改动只有两处会静默出错：**执行通道**（`-Verb RunAs` 起的是分离进程，stdout 回不来）与**写入语义**（`reg.exe` 吞嵌入引号、注册表 32/64 位视图、退出码假绿）。固定成"载荷 + 启动器"两个 `.ps1`，结果一律走日志文件回读，再独立复验一次。

## 与兄弟技能的边界

- `windows-powershell-from-gitbash` 管基础三条硬替换（不内联 `-Command`、脚本体 ASCII、不用 `*>`）与 node 运行器。
- `windows-powershell-scripting-safety` 管解析错第二根因（嵌套裸双引号）、语法门必须 `-File`、真实码页是 GBK 936。
- `windows-gitbash-command-safety` 管**从 bash 直接调原生工具**时 `/v`、`/s`、`/f`、`/y` 被 MSYS 改成盘符路径。本技能的 `reg.exe` 都在 `.ps1` 里调，不经 MSYS，不受这条影响；一旦图省事把 `reg query ... /v ...` 写进 bash 命令行就会撞，按那份技能的 `MSYS_NO_PATHCONV=1` 口径走。
- **本技能只管需要 UAC 的写操作**，不重复上面三份。载荷同样要保持 ASCII-only——日志由 `Add-Content` 落盘、回读时按活动码页解码，中文文案必然乱码。

## 四条硬替换

| 别写 | 会怎样 | 改写成 |
| --- | --- | --- |
| `powershell -Command "... $p ... $_ ..."` 内联提权命令 | bash 先展开 `$p`/`$_`，PowerShell 收到残串（报 `\.WaitForExit`、`\extglob`），退 1，**且 UAC 根本不弹**——容易被误判成"用户拒绝了" | 落 `.ps1` 用 `-File` 执行；bash 侧命令行里不出现 `$` |
| `reg.exe add <key> /v ImagePath /t REG_EXPAND_SZ /d $v`，`$v` 里带引号 | reg.exe 把嵌入引号剥掉，`"D:\...\x.exe"` 存成无引号 ⇒ **未加引号服务路径**，是已知可提权隐患；而 `Get-ItemProperty` 读回来看不出"少了一层引号"，容易当成成功 | `[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(<sub>, $true).SetValue($name, $v, [Microsoft.Win32.RegistryValueKind]::ExpandString)`，然后**重新 OpenSubKey 读回**并断言引号还在 |
| `Get-ChildItem HKLM:\... -Recurse` 找残留引用 | 注册表枚举慢，超工具时限被后台化，本轮拿不到结论 | `reg.exe query <根键> /f "<关键字>" /s [/k]`，秒级返回；只用**匹配行与退出码**判定，别解析它的中文提示（GBK 936，`/s` 的命中数在文案里） |
| 拿 `exitcode=0` 当成功 | **cmdlet 的非终止错误照样打到脚本末尾并退 0**（实测 `Get-Item` 报 `PathNotFound` 后 `BEGIN`/`END` 齐全、退 0）；只有裸 `throw` 才退 1 | 判据 = 日志里的**显式结论行**（`AFTER ... = <读回值>`）+ 事后独立复验；`exitcode=` 只当"有没有跑到末尾"的辅助信号 |

## 标准流程（8 步，顺序不可换）

0. 核身份并**预告 UAC**：`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')` 为 False 才需要提权；先告诉用户"会弹一个 UAC，请点是"。
1. 只读取现状：把每个将改的键/值原样读出来记进日志——这是回滚依据，不是可选步骤。
2. 写载荷 `elev-payload.ps1`：备份 → 读原值 → 改 → 读回，每步 `Say` 到日志文件。
3. 写启动器 `elev-launch.ps1`：`Start-Process -Verb RunAs -PassThru -File` + `WaitForExit` + 回读日志。
4. 从 bash 只调启动器。
5. 看日志判成败，**不看** bash 侧 stdout（提权进程的输出到不了这里）。
6. 独立复验：另开一条只读命令重读值 / `Get-Service` / `sc.exe qc <服务>` / 进程表。脚本自述的"已改成 X"不算证据。
7. 服务类改动必须重启才生效，但**先拿到用户对服务启停的明确确认**；优先用 `Stop-Service`（不要默认 `-Force`，它会连带停止依赖服务）→ 短暂等待 → `Start-Service` → 读回 `Status`；只改值不重启等于没改。

## 为什么必须走日志文件

`Start-Process -Verb RunAs` 启动的是**分离的提权进程**，它的 stdout 无法重定向回非提权调用方。日志文件是唯一可靠通道，于是四个必守点：

- 启动器**先删旧日志**（`Remove-Item`），否则会读到上一轮的结论；
- 载荷里 `Say` 用带时间戳的 `Add-Content`，中途异常也能留下部分记录；
- 载荷自己印结论行，别让读的人从表格里数行数；
- 启动器必须有 `else { 'no elevated log produced' }` 分支——这句区分"UAC 被拒/超时"与"脚本自己报错"，缺它就只能猜。

## 模板（路径与键名换成当次目标）

载荷 `elev-payload.ps1`：

```powershell
$ErrorActionPreference = 'Continue'
$work = 'C:\Users\<user>\AppData\Local\Temp\qoder-work\<task>-<stamp>'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$log = Join-Path $work 'fix.log'
function Say($m) { $line = ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m); Add-Content -Path $log -Value $line }

Say 'BEGIN <change>'

# 1. rollback source first - one .reg per key, and prove each file landed
$backupKeys = [ordered]@{
  'service' = 'HKLM\SYSTEM\CurrentControlSet\Services\<Service Name>'
  'app'     = 'HKLM\SOFTWARE\<Vendor>\<App>'
}
foreach ($name in $backupKeys.Keys) {
  $out = Join-Path $work ("backup-$name.reg")
  & reg.exe export $backupKeys[$name] $out /y 2>&1 | Out-Null
  Say ("backup {0} -> {1} ({2})" -f $backupKeys[$name], (Split-Path $out -Leaf), (Test-Path $out))
}
if (-not (Get-ChildItem $work -Filter 'backup-*.reg').Count) { Say 'ABORT no backup landed'; exit 1 }

# 2. read the original values (rollback reference)
$svc = 'SYSTEM\CurrentControlSet\Services\<Service Name>'
$ro = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($svc)
Say ('BEFORE ImagePath = ' + $ro.GetValue('ImagePath'))
$ro.Close()

# 3. sanity-check the target exists before pointing anything at it
Say ('target exists = ' + (Test-Path -LiteralPath 'D:\path\to\thing.exe'))

# 4. values that must keep embedded quotes go through the .NET API, never reg.exe
$quoted = '"' + 'D:\path\to\thing.exe' + '"'
$rw = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($svc, $true)
$rw.SetValue('ImagePath', $quoted, [Microsoft.Win32.RegistryValueKind]::ExpandString)
$rw.Close()
$check = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($svc).GetValue('ImagePath')
Say ('AFTER ImagePath = ' + $check)
# pattern must be the single-quoted form; a backtick inside single quotes is a literal
Say ('quotes preserved = ' + ($check -like '"*"'))

# 5. a value change only takes effect after the service restarts
# Stop-Service 不加 -Force：-Force 会连带停止依赖服务。执行前须已取得用户对服务启停的明确确认。
Stop-Service -Name '<Service Name>' -ErrorAction Stop
Start-Sleep -Seconds 2
Start-Service -Name '<Service Name>'
Start-Sleep -Seconds 4
Say ('state after restart = ' + (Get-Service -Name '<Service Name>').Status)
Say 'END'
```

启动器 `elev-launch.ps1`（从 bash 调它，不在 bash 里内联命令）：

```powershell
$ErrorActionPreference = 'Continue'
$dir = 'C:\Users\<user>\AppData\Local\Temp\qoder-work\<task>'
$log = Join-Path $dir 'fix.log'
Remove-Item $log -ErrorAction SilentlyContinue
try {
  $p = Start-Process powershell -Verb RunAs -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dir 'elev-payload.ps1')
  $p.WaitForExit(90000) | Out-Null
  'exitcode=' + $p.ExitCode
} catch {
  'LAUNCH-FAILED: ' + $_.Exception.Message
}
if (Test-Path $log) { '--- elevated log ---'; Get-Content $log } else { 'no elevated log produced' }
```

调用形式：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\...\elev-launch.ps1"`（`-ArgumentList` 必须是**数组**、每项自带引号；路径含空格时不要再额外包一层引号）。

## 上真实写操作之前先跑只读冒烟

载荷换成只做两件事：打印 `IsInRole=` + `reg.exe query` 一个必然存在的 HKLM 值（如 `SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 `ProductName`）。跑通"启动器 → 日志 → 回读"链路，再上写操作。

判据能失败（2026-10-07 本机实测）：同一条载荷经 `-Verb RunAs` 得 `IsInRole=True`，直接 `-File` 非提权跑得 `IsInRole=False`；日志还应有 `regexe_exit=0`。两个分支只会出现一个，出现 `no elevated log produced` 说明授权没通过。

## 失败分诊

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| `no elevated log produced` | UAC 被点"否"或授权窗口超时 | **停止本次操作并如实报告**；不得自动再弹 UAC。只有用户明确要求重试时才可再弹，并说明只为哪一处；**不要**记成"脚本失败" |
| `LAUNCH-FAILED: ...` | 启动阶段抛异常（`-File` 路径不存在、`-ArgumentList` 不是数组） | 先 `Test-Path` 载荷路径 |
| `exitcode=0` 但日志缺结论行 | cmdlet 非终止错误不会把退出码变成 1 | 按未成功处理；结论行缺失就是没做成 |
| 日志有 `BEGIN` 无 `END` | 载荷中途遇终止错误 | 把出错行 `Say` 出来再定位；bash 侧拿不到提权进程的 stderr |
| 提权成功但值没变 | 只改了一个视图，或服务没重启 | 32 位程序看 `SOFTWARE\WOW6432Node\<Vendor>\<App>`；卸载项在 `CurrentVersion\Uninstall` 与 `WOW6432Node` 两处都要查 |
| 需要第二次授权 | 第一次授权没覆盖新发现的目标（例：先改路径、后补引号） | 如实说明第二次只为哪一处，别静默再弹 |

## 红线

- 核心 / 生产服务的启停与配置：先给方案与回滚步骤，拿到用户确认再动；不要用 `-Force` 停服务。
- UAC 被拒绝或超时：停止本次操作并报告，不得自动重新弹窗。
- 只写目标值，**不删键**；`.reg` 备份与日志留在带时间戳工作目录，交回人工删。
- 备份没落盘（`Test-Path` False）就中止，不带病继续。
- 凭据、内网地址不写进日志——日志会被整份回读进上下文。

## 自检

- [ ] 载荷与启动器都经 `-File` 执行，bash 命令行里没有 `$`
- [ ] 每个被改的键都有 `.reg` 备份，且 `Test-Path=True` 记在日志里
- [ ] 改后值是**重新读回**的，不是脚本自述
- [ ] 含引号的值用 .NET API 写，断言用 `'"*"'` 形式读回仍为 True
- [ ] 服务类改动跑完 `Stop-Service` / `Start-Service` 并读到 `Status`
- [ ] 没有把 `exitcode=0` 单独当成功判据
