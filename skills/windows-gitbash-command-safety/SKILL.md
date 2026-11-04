---
name: windows-gitbash-command-safety
description: "从 Git Bash 或 MSYS 直调 Windows 原生 exe（reg.exe、whoami.exe、tasklist.exe、sc.exe、wmic、cmd）的替换表。用于命令死于 无效语法 或 extra operand；/v /s /f /im /y /groups 被静默改写成盘符路径；交给 Windows 程序的 /tmp 变成 C:\\tmp\\...；原生工具的中文在管道或重定向文件里是 GBK 乱码；grep 对注册表输出报 Binary file matches。随包一个包装器一次修好开关改写与 cp936 解码。"
---

# 从 Git Bash 直调 Windows 原生命令的安全写法

## Overview

MSYS 会在 exec 前改写命令行参数，Windows 原生 exe 又按控制台码页输出中文——四条互相独立的失效方式混在同一轮排查里，表现成「命令明明能跑却报无效语法」。本技能给每条固定替换，并让每节都带一条**必红的对照组**，防止判据变成假绿。

范围切分：**PowerShell 侧**（`-Command` 吞 `$_`、无 BOM `.ps1` 按 ANSI 读、`*>` 产 UTF-16）走 `windows-powershell-from-gitbash`；PS 码页与 BOM 的否证细节走 `windows-powershell-scripting-safety`。本技能只管**直调 `*.exe`**。

## 1. 四条硬替换

| 症状（可对照原文） | 根因 | 替换 |
| --- | --- | --- |
| `reg query ... /v Path` → `错误: 无效语法。` | MSYS 把以 `/` 开头且「像路径」的参数改写成 `<Git安装盘>:/Program Files/Git/v` 之类 | `MSYS_NO_PATHCONV=1 reg query ... /v Path`；或写双斜杠 `//v`；或整条塞进 `cmd //c "..."` |
| `whoami /groups` → `whoami: extra operand ‘/groups’`（**`whoami.exe /groups` 同样报**） | Git Bash 的 `whoami` / `whoami.exe` 都命中 `/usr/bin/whoami.exe`（coreutils 版），压根不是 System32 那个 | `MSYS_NO_PATHCONV=1 "$WINDIR/System32/whoami.exe" /groups` —— 两个条件**缺一不可** |
| Windows 程序报 `workspace path is missing: C:\tmp\trayrepro` | `/tmp` 在 MSYS 里是 `%LOCALAPPDATA%\Temp`，但 Windows 侧按进程 cwd 解析成 `C:\tmp` | 交给原生 exe / 别的应用的路径一律先 `cygpath -w` |
| 中文在管道里成 `ӳ  PID` / `??Ϣ`，工具返回甚至被打成 `[Binary output: N bytes]` | 原生 exe 的中文文本按码页 936 输出，**重定向到文件也是 GBK** | `iconv -f GBK -t UTF-8`（先探码页，见 §5）；或直接用 `<本机辅助脚本>/winrun.cjs` |

## 2. 开关参数：三种正确写法与取舍

| 写法 | 例子 | 何时用 |
| --- | --- | --- |
| **`MSYS_NO_PATHCONV=1`（推荐）** | `MSYS_NO_PATHCONV=1 reg query "HKCU\Environment" /v Path` | 一条命令多个斜杠开关；也最贴近原始意图，读得懂 |
| **双斜杠** | `reg query "HKCU\Environment" //v Path` | 只有一两个开关、不想动 env 时；`//` 会被折成单 `/` |
| **整条交给 cmd** | `cmd //c "reg query HKCU\Environment /v Path"` | 需要 cmd 内建行为（`for /f`、`%ERRORLEVEL%`），或开关里含空格 |

- 只有**以 `/` 开头且形似路径**的参数会被转（`/v /s /f /y /im /groups`）；`-` 前缀不转 ⇒ 工具两种都接受时优先 `-`。
- 转换目标随机器变（本机 Git 装在 `D:/software/Git`，故报 `D:/software/Git/groups`），**别把前缀当判据**。
- **`cmd` 的 `EXIT=0` 不是成功证据**：递给它认不出的开关（`//c` 折不了、`/x`）时，cmd 会打版本横幅然后**退 0**（实测 `EXIT=0 REAL=cmd`，回读文件头是 `Microsoft Windows [10.0.26300...]`）。过 cmd 的判据必须比内容，不能只看退出码。

## 3. 先核真身，再加开关

`MSYS_NO_PATHCONV` 只解决改写，不解决**命令被遮蔽**。同名的 coreutils/MinGW 版本会抢在 System32 之前，且加 `.exe` 后缀也照样命中：

```bash
command -v whoami whoami.exe   # 落在 /usr/bin/ 即被遮蔽
```

被遮蔽时先按报错形状分辨：`extra operand` / GNU 风格长错误 ＝ 你调用的是 coreutils 版，不是 Windows 版——这时加多少 env 都不会好。

## 4. 路径方向

- `cygpath -w /tmp` → `C:\Users\<user>\AppData\Local\Temp`（实测）。`/tmp` **不是** `C:\tmp`。
- 反向（Windows → bash）别把 `\` 直接贴进双引号串，会被当转义；单引号包住，或 `cygpath -u`。
- 一次性产物落 `%TEMP%/qoder-work/<任务>/`，脚本与输出同目录；跨调用与后台任务**一律绝对路径**（见 §7）。
- 注册表键含反斜杠时用双引号整体包住：`"HKCU\Environment"`。

## 5. 码页：别猜，探

实测判据（`reg query` 一个不存在的键，输出重定向到文件）：

```bash
od -An -tx1 -N8 cn.txt      # b4 ed ce f3 = GBK 的「错误」
iconv -f UTF-8 -t UTF-8 cn.txt >/dev/null 2>&1 && echo utf8 || echo not-utf8
iconv -f GBK -t UTF-8 cn.txt | head -1
```

- 本机结论：`file -b` 报 `ISO-8859 text`、严格 UTF-8 解码**失败**、走 GBK 还原成「错误: 无效语法。」——**管道与重定向文件都是 GBK**，不要假设经过 bash 就变 UTF-8。
- 判据用 ASCII 兜底：`tr -dc '[:print:]'`、`grep -a`、或只把英文 token 当锚点，别把中文塞进判据（GBK 字节会撞引号与 `[]` 字符类，还会误报 `Invalid multibyte sequence`）。
- 码页非 936 的机器上 GBK 分支会解错，先 `chcp` 确认。

## 6. `grep` 把输出判成二进制

含 NUL 或非 UTF-8 高字节时，`grep` 只印 `Binary file x matches`——**匹配内容静默丢失**，读回来像「有匹配」，实际什么都没拿到。

- 修法：`grep -a`（实测同一文件：不带 `-a` 只回 `Binary file ... matches`，带 `-a` 出 `line1Path`）；需要纯文本再 `tr -d '\000'`。
- 常见触发面：`reg query` 的 `REG_BINARY` / `REG_MULTI_SZ` 值、UIA / 控件树 dump、压缩日志。REG_BINARY 那支源自历史会话，本轮由 NUL 注入复现判据。

## 7. 后台任务与 cwd

- Bash 工具**每次调用重置 cwd**（同一轮实测两次 `Shell cwd was reset to ...`）：`cd /tmp` 在下一条命令里不生效，后台任务与产物路径必须写绝对路径。
- `&` 起的进程 **stdout 不回读**，但**落盘文件下一回合读得到**（实测 `BG_ALIVE`）——「后台无法取证」是错的，正确口径是「后台必须自己写文件」。
- 要跨回合判定完成：`{ cmd > out.txt 2>&1; echo "EXIT=$?" >> out.txt; touch out.done } &`，判据看 `out.done` + `EXIT=`，别看进程在不在。
- 要起 Windows GUI 进程再取证：`cmd //c start "" <win路径>` 或 `powershell.exe Start-Process`；裸 `&` 会让子进程丢 cwd 且拿不到句柄。

## 8. 包装器 `<本机辅助脚本>/winrun.cjs`

`MSYS_NO_PATHCONV=1 node <本技能目录>/<本机辅助脚本>/winrun.cjs <exe> [args...] [--out <file>] [--lines N] [--no-resolve] [--gbk|--utf8] [--winpath]`

- **前缀不能省**：转换发生在 bash→node 这一跳，包装器收到时参数已经是 `D:/software/Git/groups`。实测不加前缀跑 `whoami /groups`：`REAL=` 已正确指向 System32，但仍 `EXIT=1`——坏在参数上，脚本修不了它。
- 不经 shell（`spawnSync` 数组参数 + `windowsVerbatimArguments`）⇒ 引号类坑免疫；脚本内再设 `MSYS_NO_PATHCONV` / `MSYS2_ARG_CONV_EXCL` 只作二道保险。
- 脚本会把开关形的 `//x` 折成 `/x`（bash 会做这一步、node 不会），修掉“`cmd //c` 退 0 却只返横幅”那类假绿； UNC 路径（`//server/share`）不在折叠范围内。
- 命中遮蔽名单（`whoami find sort expr path echo`）时自动换成 `$WINDIR\System32\<exe>`，打印 `REAL=` 让你看见用的是哪一个。
- 三条实跑判据（本机 2026-10-07）：`reg query "HKCU\Environment" //v Path` → `EXIT=0 DECODED=utf8`；不加前缀的 `whoami /groups` → `EXIT=1`（**必红对照组**）；`MSYS_NO_PATHCONV=1` + `whoami /groups` → `EXIT=0 DECODED=gbk`，20 行落 `OUT=`。
- 解码：严格 UTF-8 → 失败退 GBK；全文按 UTF-8 无 BOM 落盘，stdout 只印 `EXIT=` / `OUT=` / `DECODED=` / `REAL=` + 前 N 行。
- `--winpath` 把参数里的 `/tmp/...`、相对路径转成 Windows 路径再传入。
- 只做**只读**默认：不替 `taskkill` / `sc stop` 之类兜底，副作用命令仍按本机红线先给方案。

## 边界与未验证

- `taskkill` / `sc` / `net stop` / `wmic` 的写法由 §1–§2 的改写规则同族推出，**未实测**（有副作用，不该为验证而执行）。
- 本机值只作示例：码页 936、Git 在 `D:/software/Git`、`/usr/bin/whoami.exe` 存在、`/tmp` 落 `%LOCALAPPDATA%\Temp`。换机先跑 §3 的 `command -v` 与 §5 的码页三行。
- 提权类诊断（读受保护进程、写 HKLM）不在本技能范围——先给方案与回滚，经确认再动。

## Resources

- `<本机辅助脚本>/winrun.cjs` — 执行原生 exe + 解遮蔽 + GBK 解码 + UTF-8 落盘 + 摘要限量；可 `require()` 复用其 `decode()`。

## 9. 注册表判据的三条新坑（2026-10-07 实测，都会造成"假阴性＝东西被删了"）

1. **`find /c "X"` 不是 Windows 的 find**：Git Bash 里它解析成 GNU `find`，`/c` 被当成**路径** ⇒ 直接去搜整个 C 盘（实测吐出 `$RECYCLE.BIN\...` 清单加一串 `Permission denied`），既不出行数又灌爆上下文。数行数用 `grep -c`，非要 Windows `find /c` 就 `cmd //c "find /c \"X\""`。
2. **`reg.exe query HKLM\SOFTWARE\...` 从 Git Bash 直调会被 MSYS 改写路径** ⇒ 返回"搜索结束: 找到 0 匹配"。本轮差点据此判"注册表里没有该注册"。正解：注册表判据**不要走 reg.exe**，用 `powershell -File` 里的 `Get-ChildItem HKLM:\...` / `(Get-Item $k).GetValue()`；实在要用 reg.exe 就 `cmd //c` 包一层并带 `/reg:64`。
3. **反斜杠层数在 grep 里不可信**：判 `\Extensions\` 这类路径子串，`grep -i '\extensions\\'` 会因转义层数被折叠而匹配到不该匹配的行（本轮同一命令一次报 57 次、一次报 0）。正解：交给 PowerShell 的 `-like '*\Extensions\*'` 或 `.Contains('\Extensions\')`。

**收敛成一条纪律**：凡是**注册表 / 带反斜杠路径 / 中文**三类判据，一律写成 `.ps1` 用 `powershell -NoProfile -ExecutionPolicy Bypass -File` 跑（脚本用 Write 工具落盘，见下条），Git Bash 只做编排与 tail。

## 10. Bash 工具会折叠双反斜杠（落盘脚本必查）

命令文本里写两个反斜杠，落到磁盘的文件里只剩一个 ⇒ 正则 `^\SystemRoot` 退化成 `^\SystemRoot`（`\S` 变字符类，静默不匹配）、Windows 路径拼接错位。**含反斜杠或正则的脚本一律用 Write 工具落盘**，跑之前 `grep -n` 抽查那几行转义是否还是你要的形状；判"文件缺失"必须逐条到真实目录 glob 否证。
