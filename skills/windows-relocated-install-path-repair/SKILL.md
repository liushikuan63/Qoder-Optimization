---
name: windows-relocated-install-path-repair
description: "诊断并修复 Windows 应用被手工从 C 盘搬到 D 盘之后出现的能启动但核心功能失效。形态——输入法能切中文却不出候选只吐英文字母；软件能开但后台服务、渲染进程、更新或卸载失效；日志出现 Service Control Manager 7000 系统找不到指定的文件；注册表 InstallPath 或服务 ImagePath 仍指向已删除的旧 C 盘目录。 触发词：7000、ImagePath、InstallLocation。"
when_to_use: "软件曾从 C 盘手工搬到 D 盘（或删了旧目录）后出现功能残缺、服务起不来、事件 7000，或注册表里还写着已不存在的 C 盘路径"
---

# 修复 C→D 搬迁导致的 Windows 安装路径失效

## Overview

机制一句话：**目录搬走了，注册表和服务里记的还是旧路径**。搬的时候在 C 盘留了 junction（目录联接）的软件照常工作；硬搬、把 C 盘原件删掉的软件就坏。本机实测 `C:\Program Files\{Docker, Git, Eclipse Adoptium, nodejs}` 都留着指向 D 的联接 ⇒ 从没出问题；微信输入法（WeType）是硬搬 ⇒ 服务起不来。

症状形态也要对上：**壳/挂在系统目录里的部分仍完好**（TIP dll 在 `System32`，所以能切到「中」），**依赖旧路径拉起来的子进程全灭**（服务、引擎、候选窗）。所以是「能启动但核心功能失效」，不是「打不开」。

固定顺序不可换：**① 只读诊断 → ② 选路线 → ③ 备份 → ④ 重指 → ⑤ 三级验证**。没校验过的备份等于没备份，第 ③ 步不许跳。

## 与兄弟技能的边界（本技能不重复它们）

| 需要的事 | 用哪个 |
|---|---|
| Git Bash 里跑 `.ps1`（不内联 `-Command`、脚本体 ASCII、node 运行器） | `windows-powershell-from-gitbash` |
| `.ps1` 报「字符串缺少终止符」但正文是 ASCII；语法门必须 `-File` | `windows-powershell-scripting-safety` |
| `reg.exe` / `sc.exe` 直调时 `/v` `/s` `/f` `/y` 被 MSYS 改成盘符路径 | `windows-gitbash-command-safety` |
| 需要 UAC 的写操作（两文件模式、日志回读、退出码假绿） | `windows-elevated-changes-from-git-bash` |
| 注入按键做端到端验收、前台归属断言、误动用户内容后的处置 | `windows-desktop-keyboard-automation` |
| 建/删 junction 的完整要点（`robocopy /XJ`、删链只能 `rmdir`） | 记忆 `reference-windows-junction-migration` |

## 第 1 步：只读诊断（本机的实测耗时 6 秒）

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "<本技能目录>/<本机辅助脚本>/relocated-install-diag.ps1" \
  -AppName wetype -Vendor Tencent -OldPath "C:\Program Files\Tencent\WeType" -NewPath "D:\Program Files\Tencent\WeType"
```

`-AppName` 是进程/服务名片段，`-Vendor` 是注册表厂商键名（WeType 在 `HKLM\SOFTWARE\Tencent` 下，所以两个都要给），`-OldPath` 是要追的失效路径。**三个都不给时脚本印 `SKIPPED-NO-NEEDLE`** 而不是数字——防止空模式把所有值都匹配上（见假证据清单）。

看五个读数：

| 读数 | 含义 | 判定 |
|---|---|---|
| `BROKEN_SERVICE_IMAGEPATH` | 全系统有多少服务的 ImagePath 文件已不存在 | 本机基线 **2**（OneDrive 两服务指向已删的旧版本号目录），与目标应用无关就忽略 |
| `SCM_EVENTS_MATCHING_APP` | 事件里该应用的服务启动失败条数 | **>0 即坐实**；本机 WeType 为 2（18:49、19:36 各一次） |
| `REG_VALUES_NAMING_STALE_PATH` | 还有哪些键值写着旧路径 | 就是**改动清单**，逐条定性 |
| `PROC_MATCHES` | 相关进程数与**所在会话号** | 服务在 sess=0，引擎/候选窗必须在 **sess=1**（用户交互会话），在 0 就是起错地方 |
| `MISSING_UNINSTALL_PATHS` | 卸载项里失效的路径 | **百位以上说明解析器坏了**，不是机器坏了 |

脚本不可用时的等价手跑（在 PowerShell 里跑，不要在 Git Bash 直调 `reg.exe`）：

```powershell
Get-CimInstance Win32_Service | Where-Object { $_.DisplayName -like '*WeType*' } | Select Name,State,PathName
Get-WinEvent -FilterHashtable @{LogName='System'; Id=7000,7023} -MaxEvents 40 | Where-Object { $_.Message -like '*WeType*' }
reg.exe query 'HKLM\SYSTEM\CurrentControlSet\Services' /f "C:\Program Files\Tencent\WeType" /s /d   # 千万别加 /t
reg query "HKLM\SOFTWARE\Tencent\WeType" ; reg query "HKLM\SOFTWARE\WOW6432Node\Tencent\WeType"
```

## 第 2 步：按引用面选路线

`REG_VALUES_NAMING_STALE_PATH` 的条数决定路线（**默认推荐 A**，用户 2026-10-07 定的口径）：

| 路线 | 什么时候选 | 收益 | 代价 |
|---|---|---|---|
| **A. 重指注册表**（默认） | 引用面收敛在服务 ImagePath + 厂商键 + 卸载项（本机 WeType 是 5 处） | 根治，C 盘不留幽灵目录，升级不会再指错 | 要 UAC；HKLM 与 WOW6432Node **两份都要改**；服务路径的引号容易丢 |
| B. 在旧位置建 junction 指新位置 | 引用面查不清、有第三方组件硬编码旧路径、或不敢动注册表 | 一条命令、零注册表写入、`rmdir` 即回滚 | C 盘留目录壳；软件自更新到新版本号后联接指错版本；不是根治 |
| C. 卸载重装到 D 盘 | 键值已被改乱，或版本目录已换 | 最干净 | 丢用户配置与词库，耗时最长 |

走 B 时用 PowerShell 建链，**不要**在 Git Bash 里 `cmd //c mklink /J`（实测报路径语法错）：

```powershell
New-Item -ItemType Junction -Path 'C:\Program Files\Tencent\WeType' -Target 'D:\Program Files\Tencent\WeType'
(Get-Item 'C:\Program Files\Tencent\WeType').Delete()   # 删联接只能这样或 rmdir；rm -rf 会穿透删掉 D 盘真源
```

## 第 3 步：备份（不可跳，且必须校验）

每个要改的键先 `reg export` 一份到 `D:\tmp\<app>-repoint-<时间戳>\`，然后**逐个校验 .reg 是真文件、字节数 ≥20**。回滚就是把对应 `.reg` 导入。下面这段是实测跑通的形态（4 个键 → 4 个文件，1462/444/468/1020 字节）：

```powershell
$keys = @('HKLM\SYSTEM\CurrentControlSet\Services\WeType Management Service',
          'HKLM\SOFTWARE\Tencent\WeType',
          'HKLM\SOFTWARE\WOW6432Node\Tencent\WeType',
          'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WeType')
$bk = Join-Path 'D:\tmp' ('wetype-repoint-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $bk -Force | Out-Null
$i = 0
foreach ($k in $keys) {
  $i++
  # 序号前缀不能省：HKLM\SOFTWARE\Tencent\WeType、WOW6432Node\...\WeType、Uninstall\WeType 的叶名都是 WeType，
  # 只用叶名做文件名会让后一份直接盖掉前一份（实测三键同名）。
  $leaf = ('{0:d2}-' -f $i) + ((Split-Path $k -Leaf) -replace '[^0-9A-Za-z]', '') + '.reg'
  $f = Join-Path $bk $leaf
  $out = & reg.exe export $k $f /y 2>&1        # 别接 | Out-Null：目标不合法时 reg.exe 会提问，提问被吞掉就成了静默挂起
  $it = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
  if ($it -and -not $it.PSIsContainer -and $it.Length -ge 20) { Write-Output ('OK ' + $leaf + ' bytes=' + $it.Length) }
  else { Write-Output ('BACKUP-FAILED rc=' + $LASTEXITCODE + ' ' + ($out -join ' ')) }
}
Write-Output ('FILE_COUNT=' + @(Get-ChildItem $bk -Filter *.reg).Count)   # 必须等于键的个数
```

任何一条 `BACKUP-FAILED`、或 `FILE_COUNT` 少于键数，都不允许进入第 4 步。

从 Git Bash 直调 `reg export` 时路径**不能用 POSIX 风格**：实测 `reg export HKLM\... /d/tmp/t1.reg /y` 报「无效语法」，`cmd //c "reg export HKLM\... D:\\tmp\\t2.reg /y"` 才产出 444 字节的 .reg（同 `windows-gitbash-command-safety`）。

## 第 4 步：重指（提权写入，本类特有的两条硬约束）

执行通道按 `windows-elevated-changes-from-git-bash` 的两文件模式（载荷 + 启动器，结论从日志文件读，不看 bash 侧 stdout）。下面两条是搬迁类独有的：

1. **服务 ImagePath 必须带引号**。`reg.exe add ... /d "\"D:\...\x.exe\""` 会被 reg.exe 剥掉嵌入引号，存成无引号路径 ⇒ 已知的本地提权隐患（本机因此多弹了一次 UAC 返工）。用 `Set-ItemProperty` 保留原样字符串，并在读回时断言：

```powershell
$v = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\WeType Management Service').ImagePath
if ($v -notmatch '^"') { throw 'UNQUOTED service ImagePath - fix it before declaring success' }
```

2. **32/64 位两份视图 + 卸载项都要改**。本机 WeType 的 5 处：服务 `ImagePath`；`HKLM\SOFTWARE\Tencent\WeType` 的 `InstallDir`/`InstallPath`；`HKLM\SOFTWARE\WOW6432Node\Tencent\WeType` 同名两项；`WOW6432Node\...\Uninstall\WeType` 的 `InstallLocation`/`UninstallString`/`DisplayIcon`。**只改 64 位那份是这类修复最常见的半成品**。

改完**必须重启服务**才生效（只改值不重启等于没改）：`Stop-Service -Force` → 等几秒 → `Start-Service` → 读回 `Status`。

## 第 5 步：三级验证，每级都要能失败

| 级别 | 判据 | 本机实测 |
|---|---|---|
| L1 服务态 | `Get-Service` 为 Running **且** ImagePath 文件真实存在且带引号 | `"D:\Program Files\Tencent\WeType\2.1.4.6\wetype_service.exe"` |
| L2 进程栈 | 引擎/候选进程存在**且在 sess=1** | `wetype_server` + `wetype_renderer` 回到用户会话 |
| L3 端到端 | 真按键、真读回上屏结果 | 注入 `nihao` → 候选窗属主是 `wetype_renderer` → 空格上屏，码点 `U+4F60 U+597D` = 你好 |

L3 的注入、前台归属断言、回读、以及误动用户内容后的处置全部按 `windows-desktop-keyboard-automation` 走；本技能只钉住两条搬迁类必踩的：

- **判定用码点，不用 CJK 正则**。`一-龥` 这类范围在 GBK 码页的脚本里会因编码给出**假 FAIL**（本机实测：判定行是红的，实际已经转成功了）。`($clip.ToCharArray() | ForEach-Object { 'U+{0:X4}' -f [int]$_ }) -join ' '`。
- **Win11 记事本会把用户上次未保存的会话恢复进新窗口**，看着像自己的临时草稿——别把它当草稿，本类验收不要选记事本/App 这类会恢复会话的目标。

改完再跑一次第 1 步，`REG_VALUES_NAMING_STALE_PATH` 应从改动清单规模降到残余几条。**残余要逐条定性并写进结论**，不得当全绿：本机留了 1 条防火墙规则里的 `wetype_update.exe` 旧路径（只影响更新程序的入站规则，不影响输入），显式记为「已知未改 + 理由」。

## 假证据清单（逐条都是本机实测，能直接坑掉一次「已修复」）

| 别写 | 会怎样 | 改写成 |
|---|---|---|
| `$v -split ' '` 取卸载项里的 exe | `"D:\Program Files\Qoder\Uninstall Qoder.exe" /allusers` 被切成 `D:\Program` ⇒ 本机 **167 行全假阳性** | 先取成对引号内的部分，否则用 `^(.*?\.exe)` 正则；只查目录就单看 `InstallLocation`（改完后本机为 0） |
| `reg.exe query <根> /f <路径> /s /d /t REG_SZ` | **`/t` 会让 `/f` 失效并整树 dump**（同一根键、两个不同 needle 都返回 1894 行且 0 行真含 needle）⇒ 数出来的 530217 全是假数 | `/f <needle> /s /d` 不加 `/t`（实测精确返回 2 行且都含 needle），或用 PS 原生 `Get-ChildItem -Recurse` + `-like` |
| 空 needle 也跑 `-like "*$needle*"` | `"**"` 匹配一切 ⇒ 无参数时虚报 508 个进程、37300 个键值 | 先 `[bool]$needle` 守卫，为空就印 `SKIPPED-NO-NEEDLE`，不印数字 |
| `Get-WinEvent` 只加 `ProviderName='Service Control Manager'` | 显示名不符时整节零命中（假阴性） | 同一 ID 跑「带 provider」与「不带 provider」两个计数并对比，不等就报 `WARN`（本机 42 vs 139） |
| 后台扫描脚本没产出就当「没引用了」 | stderr 被吞，看着像查干净了 | 换 `reg.exe` / PS 原生精确查，并要脚本自己印计数行 |
| 拿 bash 侧 stdout 当提权结果 | `Start-Process -Verb RunAs` 是分离进程，stdout 根本不回来 | 只看日志文件里的显式结论行（同 `windows-elevated-changes-from-git-bash`） |
| `reg.exe export` 的结果管道接进 `Out-Null` | 目标路径不合法（例如文件名算成空串、指到目录本身）时 reg.exe 会**提问**，提问被管道吞掉 ⇒ 整条命令**静默挂起**（本机实测三次挂到工具超时、目录建了但 .reg 一个没产出），看起来像"机器很慢" | 把输出收到变量里（`$out = & reg.exe ... 2>&1`），并用 `$LASTEXITCODE` 加文件字节数一起判 |
| 备份文件名只用键的叶名 | `HKLM\SOFTWARE\Tencent\WeType`、`WOW6432Node\...\WeType`、`Uninstall\WeType` 叶名相同 ⇒ 后一份**直接盖掉**前一份，四个键只剩三个文件却照样"备份成功" | 加零填充序号前缀，末尾断言 `FILE_COUNT` 等于键数 |
| 在 Git Bash 用 heredoc 写 `($k -split '\\')` | 落盘成 `-split '\'`，PS 报「`\ 是模式末尾非法」，`$leaf` 变空串却不中断（`SilentlyContinue`），下一步就往目录本身导出 | 取路径末段用 `Split-Path -Leaf`；或在脚本里印出解析结果自证 |

## Resources

- `<本机辅助脚本>/relocated-install-diag.ps1`：第 1 步的只读诊断（七节 + VERDICT 汇总，纯 ASCII，只读——不写注册表、不启停服务）。已在本机三态实测：给 WeType 参数能复现来源会话结论（残余 1 条防火墙规则、sess=1 引擎进程 8 个、SCM 命中 2）；给 OneDrive 作阳性对照（真查出 4 条指向已删版本号目录的键值）；无参数时印 `SKIPPED` 而不是假数。
