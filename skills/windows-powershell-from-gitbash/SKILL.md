---
name: windows-powershell-from-gitbash
description: "从 Git Bash 或 MSYS 驱动 PowerShell 5.1 写一次性 .ps1 诊断脚本的替换规则。用于内联 powershell.exe -Command 炸出 extglob、CommandNotFoundException 或无法识别的 cmdlet；含中文字面量或正则的 .ps1 报 TerminatorExpectedAtEndOfString；输出文件回读每个字符间带空格（UTF-16）；以及任何用 Get-CimInstance、Add-Type P-Invoke、reg export、截屏的脚本之前。随包脚本骨架与纯 UTF-8 捕获的 runner。"
when_to_use: Git Bash 里调 powershell.exe 报错、.ps1 中文炸引号、输出文件字符间夹空格、写 Windows 诊断探针时；PS 5.1 订正（嵌套双引号、-File 语法门、BOM 写盘、退码 0 假绿、GBK 码页）
---

# 从 Git Bash 驱动 PowerShell 做 Windows 诊断

## Overview

把三件事按固定替换写死——不内联 `-Command`、脚本体不用中文、不用 `*>` 重定向——一次性诊断脚本就能稳定跑通并读回来。本机 2026-10-05 一轮排查连续踩中这三条，替换后同一套探针连跑六份无失手。

## 三条硬替换

| 症状（可对照报错原文） | 根因 | 替换 |
| --- | --- | --- |
| 刷屏 `extglob.*` / `无法将“…ProcessName”项识别为 cmdlet` | bash 在**双引号**里先展开了 `$_`、`$()`，PowerShell 拿到的是残串（`$_` 会变成上一条命令的最后一个参数） | 写 `.ps1` 用 `-File` 执行；`$_` 只出现在脚本里 |
| `TerminatorExpectedAtEndOfString` / `字符串缺少终止符`，且报错行指向别处 | PS 5.1 按 ANSI 码页（本机 936）读**无 BOM** 的 `.ps1`，多字节序列吞掉相邻引号 | 脚本体 **ASCII-only**（注释、输出、正则全英文）；确需中文则存 UTF-8 **带 BOM**，或改 `pwsh` |
| 读回来的文件每个字符间夹空格（` = = = = =   V o l u m e s `） | PS 5.1 的重定向运算符 `>` / `*>` 默认写 **UTF-16 LE**（文件头 `FF FE`） | 脚本内写文件用 `\| Out-File -Encoding utf8`；或由调用方捕获后按 UTF-8 落盘（见运行器） |

## 标准流程

1. 一次性产物落 `%TEMP%/qoder-work/<任务>/`，脚本与输出同目录。
2. 建脚本：Write 工具，或 `cat > x.ps1 <<'EOF'`（**EOF 必须加引号**，否则 bash 又展开一遍）。
3. 套下面的骨架，脚本体保持 ASCII。
4. 运行：`node <本技能目录>/<本机辅助脚本>/psdiag.cjs x.ps1 --lines 40`。
5. 读结果：stdout 只有摘要 + `EXIT=`，全文在同名 `.out.txt`（UTF-8 无 BOM，grep / Read 可直接用）。
6. 收尾删临时目录（本机口径：按推荐直接清，不逐个问）。

## 脚本骨架（复制即用）

```powershell
$ErrorActionPreference = 'SilentlyContinue'   # use 'Continue' when errors must be visible
function Sec($t) { Write-Output ''; Write-Output "===== $t =====" }

Sec 'Volumes'
Get-Volume | Format-Table DriveLetter, HealthStatus, Size

Sec 'Processes matching betop'
$pat = 'betop'                                # ASCII-only pattern
Get-Process | Where-Object { $_.ProcessName -match $pat } | ForEach-Object { Write-Output $_.ProcessName }
```

- 助手函数**不要用单字母名**：`H` 会命中别名 `Get-History`（`r`/`cp`/`ls`/`cat`/`irm` 同理），在 `SilentlyContinue` 下整节静默消失。
- 每节都打 `Sec` 分节头，方便事后 `grep -a '====='` 定位。
- 结论行自己印出来（`Write-Output "matched=$n"`），别让读的人从表格数行数。

## 运行器 <本机辅助脚本>/psdiag.cjs

`node <本机辅助脚本>/psdiag.cjs <x.ps1> [--out <file>] [--lines N]`（相对本技能目录；CN 侧绝对路径 `~/.qoder-cn/skills/windows-powershell-from-gitbash/<本机辅助脚本>/psdiag.cjs`）

- 走 `spawnSync(..., '-File')` **不经过 shell** ⇒ `$_` 类坑天然免疫，脚本里想怎么写就怎么写。
- 显式解码：`FF FE` 走 utf-16le；严格 UTF-8 失败再走 gbk；落盘为 UTF-8 无 BOM。
- 只把摘要打到 stdout（`EXIT=` / `OUT=` / `DECODED=` / 前 N 行），避免几十万字节的诊断输出灌进上下文。
- `EXIT=` 忠实：解析失败退 1、脚本 `exit 3` 退 3、空输出且退 0 会额外印 `WARN: exit 0 with no output`。

**不要用 `-Command "& 'x.ps1'; exit $LASTEXITCODE"` 包装**：脚本压根没解析成功时它报 `EXIT=0`（本机实测），把"没跑"洗成全绿。

## 没有 node 时的兜底

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File x.ps1 > x.out.txt 2>&1
file -b x.out.txt        # 别假设，复验一次
```

本机实测：只跑 ASCII 探针时重定向 stdout 是有效 UTF-8，但 PS 自身的中文错误 / 警告文本实测是 GBK(936)——必须**先探后转**，别把"ASCII 能过"当成"重定向已是 UTF-8"（详见下文《订正与增量》§3）。脚本内部自己 `*>` 写出的文件仍是 UTF-16，所以规则不变——脚本内写文件优先用 `[IO.File]::WriteAllBytes` + `UTF8Encoding($false)` 的无 BOM 写法（§4），`Out-File -Encoding utf8` 会带 BOM。

## 同族调用点的其余坑（简表）

- `param()` 必须是文件的**第一条语句**，前面只允许注释。
- 双引号里 `"$x:yyy"` 被当驱动器限定变量 ⇒ 写 `"${x}: yyy"`。
- 数组字面量里**逗号优先于 `+`**，拼参数会被静默拆坏。
- PS 5.1 的 `-Encoding UTF8` 写出**带 BOM**；给 node 解析的 JSON 用 `[IO.File]::WriteAllBytes` + `UTF8Encoding($false)`。
- Git Bash 会把 `/y`、`/IM` 这类斜杠参数转成盘符路径 ⇒ 写成 `//y`（`reg export` 静默不产出就是它）。
- 全量清单与实测报错原文见记忆 `reference-powershell-script-encoding`、`reference-windows-powershell-diagnostics`。

## 边界

- 以上 `*>` 产 UTF-16、无 BOM 脚本按 ANSI 码页读取，都是 **Windows PowerShell 5.1**（`powershell.exe`）的行为；PowerShell 7（`pwsh`）默认按 UTF-8 读脚本、重定向也是 UTF-8，不必 ASCII-only。别把 5.1 的规则套到 `pwsh` 上。
- gbk 解码分支是防御性的：本机重定向流实测已是 UTF-8，该分支仅由单元断言覆盖，未被真实运行触发。
- 要提权的诊断（读受保护进程路径、HKLM 写操作）不在本技能范围——走技能 `windows-elevated-changes-from-git-bash`（载荷 + 启动器两个 `.ps1`、结果经日志文件回读），并先按本机红线给方案与回滚，经确认再动。



## 订正与增量（合并自 windows-powershell-scripting-safety，2026-10-12）

# PowerShell 5.1 写法安全：已验证的增量与纠正

## Overview

本技能只装 **2026-10-07 逐条实测、且能拿出报错原文或字节证据**的增量，并指名纠正两份已有材料（同子域技能与长期记忆）里会把人引错的三处。基础三条硬替换（不内联 `-Command`、脚本体 ASCII、不用 `*>`）见本文《三条硬替换》，不重复。

## 1. 嵌套双引号：`字符串缺少终止符` 的第二根因

两份旧材料都把这条报错归因于“中文 + 无 BOM 被 ANSI 码页吞引号”。**纯 ASCII 脚本也能出同一报错**，所以先排除本因再去改编码：

```powershell
$t = " -> $($_.Name)>"      # 实测：字符串缺少终止符: “。 position 指向行尾之后
```

根因：同一个双引号串里又出现裸 `"`，PS 5.1 把第一个内层 `"` 当串结束，后半串进入表达式解析器。→ 内层用单引号（`'->'`），或用 `-f` / 拼接。

**订正一条流传的假规则**：旧记录说 `$( … -join ' | ' … )` 里的 `' | '` 会触发解析错误。本轮实测 `Write-Host "joined ==> $($items -join ' | ')"` 正常输出 `a | b` 且语法门报 `PARSE-OK`。该断言作废；它当年的真凶就是本节的嵌套双引号（报错文本与行号完全同形状）。

## 2. 语法门必须 `-File`，否则门自己会假绿

```powershell
# $W/psgate.ps1
$ErrorActionPreference = 'Stop'
$f = $args[0]
if (-not $f) { Write-Output 'GATE-ERR: no file argument'; exit 2 }
$err = $null
[void][System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath $f), [ref] $err)
if ($err.Count) { $err | ForEach-Object { "PARSE-ERR: " + $_.Message }; exit 1 }
"PARSE-OK"
```

- ✅ `-File "$W/psgate.ps1" "$W/x.ps1"` 实测三态：好脚本 `PARSE-OK / 0`、坏脚本 `PARSE-ERR` + `字符串缺少终止符` 退 1、**漏传参数 `GATE-ERR` 退 2**。
- ❌ `powershell -Command '<gate body>' "$W/x.ps1"`：`-Command` 绑的是 `ValueFromRemainingArguments`，尾随参数**不落到 `$args`** 而是被并进命令串。实测 `$f` 为空、`Get-Content` 抛异常，门照样打印 `PARSE-OK` 并退 0，顺带把那个路径当脚本执行了。**这就是“拿不能失败的门判绿”。**
- **能力边界**：别名遮蔽（`function H` 被 `Get-History` 抢走）在门里是 `PARSE-OK`——门只查语法，绑定/运行时错必须靠真跑。
- 任何新量具上岗前先喂一个**已知会红**的输入（§1 那个嵌套双引号脚本就是现成夹具），确认报 1 再拿来判 0。

## 3. 控制台真实码页是 GBK(936)，不要猜、要探

实测（`chcp` = 936）：PS 自身的中文错误文本不管是重定向到文件还是进管道，字节都是 `d5 d2 b2 bb b5 bd`（GBK 的“找不到”），node 严格 UTF-8 解码直接 `NOT-UTF8`，`file -b` 判 ISO-8859。

⇒ **两条观察不矛盾，但都不当前提**：PS 自身的中文错误与警告文本是 GBK(936)（上面字节实测），而纯 ASCII 输出对两种码页都算“有效 UTF-8”——只跑 ASCII 探针就会误读成“重定向已是 UTF-8”（同子域技能就是这么来的）。2026-10-07 复跑同一份 junction + 注册表探针（全 ASCII）：`iconv -f UTF-8` 直接通过、detected=UTF8；换成带中文错误文本的脚本就落进 GBK 分支。**写“先探后转”，不硬写码页：**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "$W/diag.ps1" >"$W/diag.log" 2>&1; rc=$?
if iconv -f UTF-8 -t UTF-8 "$W/diag.log" >/dev/null 2>&1; then cp "$W/diag.log" "$W/diag.utf"
else iconv -f GBK -t UTF-8 "$W/diag.log" >"$W/diag.utf"; fi
head -40 "$W/diag.utf"
echo "exit=$rc errors=$(grep -c -E 'Exception|Error|CategoryInfo' "$W/diag.utf")"
```

## 4. 无 BOM 写盘：四种写法的实测区别

| 写法 | 实测首三字节 | 结论 |
| --- | --- | --- |
| `Set-Content -Encoding UTF8` | `ef bb bf` | 带 BOM，node `JSON.parse` 直接炸 |
| `… \| Out-File -Encoding utf8` | `ef bb bf` | **同样带 BOM**（旧材料把它当通用安全写法，不够） |
| `[IO.File]::WriteAllBytes($p,(New-Object Text.UTF8Encoding($false)).GetBytes($txt))` | `7b 22 6b` | 干净无 BOM（首选） |
| `[IO.File]::WriteAllText($p,$txt)` | `7b 22 6b` | 同样无 BOM，更短；.NET 默认 UTF-8 不带 BOM |

写完**回读首字节校验**，不要只看写命令没报错。

## 5. 退码 0 不等于没报错

实测：脚本里 `function H` 被 `Get-History` 抢绑、日志里躺着 `ParameterBindingException`，同时 `DONE` 照常打印、`-File` 退码 **仍是 0**。旧材料只警告了 `-Command "& 'x.ps1'; exit $LASTEXITCODE"` 包装的假绿，没盖住裸 `-File`。

⇒ 判绿固定两条一起报：`exit=$rc` **加** `errors=$(grep -c …)`；任一非 0 即红。要真失败就 `$ErrorActionPreference='Stop'` + `try/catch { exit 1 }`（注意 Stop 下原生命令的 stderr 会抛 `NativeCommandError` 中断整脚本，外部命令单独包 `Continue`）。

## 6. 强制直连 vs 走代理

- `Invoke-WebRequest -Proxy $null` **不等于**绕开系统代理（未显式指定时 .NET 回落 WinINET）。此条本轮 **未验证**：当前 `ProxyEnable=0`，直连与回落都返 200、分不开。要证它得临时开系统代理（机器级改动），先过用户确认。
- 显式关代理——`Add-Type` 那行不能省（实测漏了就报“找不到类型 `[Net.Http.HttpClientHandler]`”，PS5.1 默认不加载该程序集）：

```powershell
Add-Type -AssemblyName System.Net.Http
$h = New-Object System.Net.Http.HttpClientHandler; $h.UseProxy = $false
$c = New-Object System.Net.Http.HttpClient($h); $c.Timeout = (New-TimeSpan -Seconds 8)
[int]$c.GetAsync($u).Result.StatusCode
# 备选：$req = [System.Net.HttpWebRequest]::Create($u); $req.Proxy = $null
```

- **对照组不可省**：同一脚本里再走一次“默认代理”。只有**一直一红**才证明例外/代理差异真实存在；两边都绿说明代理根本没开，本量无意义。

## 7. cmdlet 位置参数里的 `+`

`Join-Path $bkDir 'x-' + (Get-Date -Format 'yyyyMMdd')` 实测报 `找不到接受实际参数“+”的位置形式参数`。同族：数组字面量里逗号优先于 `+`（旧材料已记）。→ 拼接整体加括号。另：**助手函数 ≥3 字母**（别名优先级高于函数）。

## 8. 截图卫生

- 最小化窗口 rect 报 `-32000,-32000` ⇒ 先 `ShowWindow($hwnd, 9)` 再取帧；先 `SetProcessDPIAware` 否则尺寸缩错。
- **截图用完立即删**（在任何收尾之前）：画面里是用户邮件标题、令牌、别人开的窗口；原图不进记忆也不进汇报。

## 验证状态

- 本轮实测拿到报错原文或字节：§1 嵌套双引号、§1 的 `-join ' | '` 否证、§2 门三态与 `-Command` 假绿、§3 GBK 字节与 `chcp 936`、§4 四种写法的 BOM、§5 退 0 与异常共存、§6 直连片段返 200、§7 `Join-Path`。
- **未验证**：`-Proxy $null` 回落系统代理（需开机器级代理）。

## Resources

- `<本机辅助脚本>/psdiag.cjs` — 执行 `.ps1` + 显式解码 + UTF-8 落盘 + 摘要打印；可 `require()` 复用其 `decode()`。
