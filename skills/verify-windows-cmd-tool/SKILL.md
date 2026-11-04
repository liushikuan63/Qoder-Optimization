---
name: verify-windows-cmd-tool
description: "改/验/发 Windows 纯批处理（.cmd/.bat）控制台工具的闭环：① GBK+CRLF 编辑链（UTF-8 副本 → CRLF → GBK → 装全部副本 → md5 比对）；② 真实控制台验收（start 启动；禁用 MCP launch_app，会剥 APPDATA 造成假故障；capture-window.ps1 截图；SendInput 每键 250–350ms）；③ 无键盘验收；④ cmd 陷阱（chcp 吞 stdin、rmdir 加 nul 断链、NT 路径前缀、选择器 1 基序号）；⑤ 打包后解压逐字节比对。触发：编辑/验收/打包 .cmd 工具。"
---

# Windows 纯批处理（.cmd/.bat）工具：编辑 · 验收 · 发行

## 适用范围与边界

处理对象：**独立 Windows 控制台程序**——单个 `.cmd` / `.bat`（可配 PowerShell 选择器），双击即用、只用系统自带命令，不依赖 Git / Python / Node。

- 网页 / 小程序 / 游戏 / App / 桌面 GUI 的前台验收 → 用 `verify-ui-in-browser`。
- 「断言必须能失败、拿不到证据要标注未验证」的总纪律 → 用 `verify-before-claim`；本技能只补它没覆盖的 `.cmd` 实现与交付细节。
- 交付物必须是纯批处理（同事机器多半没装 Git for Windows）：凡是「给用户双击 / 给同事分享 / 放桌面」的一律 `.cmd`；`.sh` 只留给自己或 Agent 自动化。

## 0. 开工先读

1. 目标工具自己的 `README.md`「设计要点」段——里面记着该工具已踩过的坑，优先于任何通用清单。
2. 相关记忆：`memory/reference-windows-bat-encoding.md`（陷阱全量版）、`memory/reference-console-app-ui-verification.md`（验收实测记录）。

## 1. 编辑链（GBK + CRLF 是硬要求）

安装版是 **GBK + CRLF**，**不能拿 UTF-8 / LF 直接改**：cmd 按当前代码页逐行解析文件，UTF-8 中文会被按错误字节边界切开、引号与括号被拆坏，报一堆 `'R' 不是内部或外部命令` 之类的碎片错误（`chcp 65001` 也救不了）。

```bash
# ① 从安装版还原出 UTF-8 工作副本（放临时根，别就地改）
iconv -f GBK -t UTF-8 "<安装版>.cmd" > "$TEMP/qoder-work/tool-utf8.cmd"
# ② 用 Edit 工具改工作副本（此时是 UTF-8，Edit 才能正常处理中文）
# ③ 转 CRLF —— 必须在 iconv 之前（to-crlf.js 读的是 utf8，对 GBK 文件用它会把中文读坏）
node ~/.qoder/scripts/to-crlf.js "$TEMP/qoder-work/tool-utf8.cmd"
#    判据：输出 JSON 里 replacementChar=0 且 bareLFAfter=0
# ④ 转 GBK 并安装到全部副本
iconv -f UTF-8 -t GBK "$TEMP/qoder-work/tool-utf8.cmd" > "<副本路径>"
```

`to-crlf.js <file>`：读 utf8 → LF 归一 → 全 CRLF → 写 utf8，输出 `{lines, bareLFBefore, crlfBefore, crlfAfter, bareLFAfter, replacementChar}`。**只对 UTF-8 文件用。**

**安装到全部副本**：副本清单**运行期实测**（本机实例是 `~/.qoder/scripts/` 安装版 + 桌面分享包下的同名文件），别写死文件列表——它会变（桌面包目录名与文件集都改过）。

**改已安装产物前先备份**：留 `<文件名>.bak-<原因>-<时间戳>`（例 `.bak-pre-xjfix-095440`），保证可回滚。

**回读比对（可失败判据）**：

```bash
md5sum "<副本1>" "<副本2>" "<副本3>"        # 所有行的哈希必须完全相同
iconv -f GBK -t UTF-8 "<副本1>" | head -20   # 中文正常、无乱码与替换字符
```

## 2. 真实控制台验收

**启动（关键）**：

```bash
MSYS_NO_PATHCONV=1 cmd /c start "" "C:\...\工具.cmd"
```

- **禁用 MCP `launch_app` 启动 `.cmd`**：它经 ShellExecute 起的子进程拿到的是**被剥离的环境块**——实测 `APPDATA`、`LOCALAPPDATA`、`COMPUTERNAME` 全空（`USERPROFILE` / `TEMP` 有）。凡依赖 `%APPDATA%` 的逻辑会静默失效，**极易被误判成脚本 bug**。用 `start` 开的新窗口环境与双击一致。
- `MSYS_NO_PATHCONV=1` 必带，否则裸 `/` 路径会被 MSYS 改写。
- 找不到窗口时按标题枚举：`powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, MainWindowTitle"`

**截图**：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.qoder/scripts/capture-window.ps1 -Hwnd <id> -Out "C:\...\shot.png"
```

`-Out` 传 **Windows 路径**（Git Bash 的 `/c/...` 会被它当字面路径）。脚本自己会 SW_RESTORE + 置前 + 等 600ms + DPI-aware 取窗口矩形后抓图。

- 报 `GetWindowRect failed for hwnd ...` = 窗口已消失或退出太快 → 让窗口活久一点（加 `pause`、或改用第 3 节无键盘法），**不是截图脚本坏了**。
- **控制台光标闪烁会让连续截图哈希不同**——别据此判「画面没变」，要看截图内容。
- **程序里有 `cls`（长列表清屏）或跑完即退时，屏幕内容留不住**（截图与回看都抓不到）→ 改用第 3 节的输出重定向捕获全文。
- **控制台输出是 GBK**：Git Bash 直连显示乱码属正常现象，解读用 `… | iconv -f GBK -t UTF-8`。

## 3. 无键盘验收法（首选：不干扰用户，也不依赖 computer-use）

工具的交互输入走 `set /p` 时，把要输入的内容写进文件，让真窗口自己跑完：

```
start "" cmd /c "工具.cmd < in.txt"
```

- 落地建议：**把这条 `start` 命令写成一个 `.cmd` 启动脚本再执行**——cmd 与 bash 之间的引号链反复把命令搞挂（实测多次）。`start` 的空标题 `""` 不能省。
- 判据：跑完查窗口列表 → **窗口消失**（残留窗口列表为空）。例：喂菜单最后一行的序号，验证「0. 退出」确实能关窗。
- `--apply` 类分支自带 **TTY 守卫**（`timeout /t 0` 探非交互）→ stdin 一重定向就被 `[拒绝执行]`。**这是正确行为，不是故障**；这类分支只能用真窗口 + 键盘验。
- 输入文件用 ASCII 数字最稳；要喂中文得注意编码（Write 工具写的是 UTF-8，而工具可能按 GBK 读）。

**补丁副本法**（核对界面渲染内容，完全不需要交互）：另存一份「只跑目标 UI 分支并把结果 `type` 出来」的副本再执行。例：给回退清单加 `--dumprev`，直接输出 `Qoder [AppData\Roaming]` / `[AppData\Local]` 两行来核对标签是否正确。

- 打补丁用**落盘的 .js / .cmd 脚本**，别用 `node -e`——引号会被 shell 吃掉（实测多次）。
- 补丁副本放临时根，绝不改安装版。
- **输出重定向法**：`工具.cmd --scan > out.txt 2>&1` 捕获完整文本再读文件定位（有 `cls` 或秒退时尤其有用）。
- **沙箱法**：验证会改数据的分支时，在 `%TEMP%/qoder-work/sb-*/` 下造假结构 + `mklink /J` 假联接，用**覆盖环境变量**（USERPROFILE / APPDATA / LOCALAPPDATA）的窗口跑真工具，绝不碰真实数据。

## 4. 驱动真实按键（兜底）

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.qoder/scripts/sendkeys-to-window.ps1 -TitleLike "工具名" -Keys "DOWN,DOWN,ENTER" -GapMs 350
```

`-Keys` 逗号分隔，支持 `DOWN/UP/LEFT/RIGHT/ENTER/ESC/TAB/SPACE`（其余 token 原样交给 SendKeys）；`-NoActivate` 可跳过置前。脚本按标题找可见顶层窗口 → 置前 → 逐键发送。

- **键间隔 250–350ms**：80ms 连发会丢键。
- **先发 `Escape` + `Shift_L` 清输入法组字**，再发方向键——组字态下 ↑/↓ 会被候选翻页吞掉（注意 Esc 本身可能被选择器当成「取消」，必要时重进）。
- MCP `press_key` 报 `foregroundStatus: matched` 也可能整体没生效——**以截图内容为准**。
- computer-use 的 MCP 连接可能中途掉线（工具列表里消失），上面这个脚本就是备用方案。
- **用户正在用电脑时不要盲发按键**：注入键打到当前前台窗口，会把方向键与回车打进用户的浏览器或聊天窗口。此时改用第 3 节的无键盘法，或等用户空闲。
- 留档：`<本机辅助脚本>/send-console-keys.ps1`（AttachConsole + `CreateFile("CONIN$")` + `WriteConsoleInput`，不依赖焦点，理论最稳）本机实测报 `ERROR_ACCESS_DENIED(5)`（疑企业安全套件拦截）——换机器可再试。

## 5. cmd 高频陷阱清单

新增坑时**同批更新本节与 `memory/reference-windows-bat-encoding.md`**，避免两份漂移成假绿。

**解析与语法**

- 块内**裸括号**（如 `echo (none)`）会让 cmd 报「此时不应有 )」——去掉括号或改写。
- `for /f` 的命令串**不能以「带引号的 exe 路径」开头**（`cmd /c` 会剥错引号 → 命令静默返回空）；把 exe 所在目录并进 `PATH`，命令串用裸命令名就正常。
- 带括号的参数（如 `--format=%(refname:short)`）别经 `!VAR!` 延迟展开喂给 `for /f`（括号会破坏命令串解析）。
- `if "!N!" GTR 0` 带引号会走字符串比较、判成假 → 用 `if not "!N!"=="0"` 或不加引号。
- 嵌套 `for /d` 探目录**别写死层级**（层级不符会一帧都不命中且毫无报错）；对每层 `call` 一个子程序才稳。

**交互与输入**

- `chcp 936` 会吞掉 stdin 第一行 → 必须写 `chcp 936 <nul >nul`（显式给它 NUL 输入）。
- `set /p` 在输入耗尽（EOF）时返回 errorlevel 1，不判会**无限空转刷屏**；`pause` 被重定向时会一直等，别指望它自动返回。
- **cmd 调 PowerShell 交互组件（上下键菜单）绝不能重定向其输出**：`[Console]::CursorTop` / `SetCursorPosition` / `ReadKey` 都要求进程连着真实控制台，一旦接到文件或管道就抛错退出，表现为「选择器静默失效、退回数字输入」；`ReadKey` 在 stdin 被重定向时同样抛错 → 必须准备「无控制台即回退数字输入」的分支；要留错误信息就让 PS 自己 `Out-File` 写日志。
- **上下键选择器返回的是 1 基序号**：菜单最后一项「0. 退出」的序号是 N 而不是 0 → 用「序号 == 菜单行数」判定，否则选中退出会落进「无效输入」循环、窗口永远关不掉。
- **全局变量用完必须还原**：某个菜单项临时改过 `ITEMS` 之类的全局清单却不还原，后续菜单项会跟着错（实测：点过菜单 9 之后，再来盘点就看不到默认条目）。
- **守卫要 fail-closed，且放在扫描 / 打印之后、真正动手之前**：枚举不到进程列表就直接中止（不能当成「没有进程」）；进程检查挡在扫描前，用户只看到一句「[停止]」→ 会被当成「功能坏了」。

**文件与进程**

- 判 junction：`fsutil reparsepoint query "<路径>"`（退出码 0 = 重解析点，不需要管理员）。
- 取联接目标后要**剥掉 `\??\`（和 `\\?\`）前缀**：PowerShell `New-Item -ItemType Junction` 建的链接，`dir /AL` 会把目标显示成 NT 命名空间形式 `\??\E:\...`，而 Win32 的 `if exist` / `robocopy` / `move` 都不认这个前缀——不剥就会把可用联接误报成「联接目标不存在」。
- 安全断链：`rmdir "<联接>" <nul`（`<nul` 防交互提示挂住），**绝不能用 `rmdir /s`**（会删光目标盘内容）。
- 外部命令一律写 **`%SystemRoot%\System32\` 全路径**：PATH 里 Git/MSYS 的同名 `find` 会抢占，把 `find /c /v ""` 变成扫描整个 C 盘。
- 别用 findstr 管道解析 tasklist（findstr 出错时输出为空，会被读成「没有进程」→ 假绿）；改用 `for /f "usebackq tokens=1 delims=," %%A in ("<csv文件>")` 直接读 CSV。
- 通配符会把备份目录一起命中（`*qoder*` 连 `xxx.bak-migrating` 也列出）——按后缀排除，注意 `.bak-migrating` 是 **14** 个字符（写成 `~-13` 会取成 `bak-migrating`、判等失败）。
- robocopy 复验要带 **`/XJ`**（不带就会把联接里的文件算成「还缺」→ 源里只要有一个联接子目录就报假警报）；`/L /NJH /NJS /NDL /NP /FP` 计划模式**输出为空即通过**；还要排除 `*多余文件` 行（行首是 TAB，判前缀前先 `for /f "tokens=*"` 去空白）。
- 判「提交是否已合并」别用 `git branch --contains`（分离 HEAD 的工作树会多打一行 `* (HEAD detached at …)` → 误判可删）；用 `git for-each-ref --contains <sha> refs/heads refs/remotes`。
- 校验 junction 可读性用 `ls` / `cat`（会穿透联接），**别用 MSYS 的 `find`**（不穿透 → 假阴性）。

**工具链**

- MSYS 程序（bash / iconv）输出到 Windows 控制台时会按控制台代码页自动转码——中文直接就对，**别手工再 `iconv` 成 GBK**（二次转码会变方框）；而重定向到文件那一路不转码，极易被误判成「转换正常」。
- MSYS 的 `timeout` 杀不干净 Windows 进程（超时后 cmd 仍活着、管道不结束）→ 自动化测试改用「去掉 `pause` 的副本」，输入结束后靠 EOF 守卫自然退出。
- 用 sed 改批处理：文件已是 CRLF 时 `$` 锚点匹配不到行尾（pattern 用 `.*$` 兜底）；MSYS 的 sed 会把替换文本里的 `nul` 改写成 `/dev/null`——涉及 `nul` 的替换改用 Edit 或 node。
- **bash → cmd 互操作雷区**（Agent 在 Git Bash 里操作时）：① `mklink` 这类复合命令经 bash→cmd 传参会崩（`\"` 被原样交给 cmd、链式命令全挂）→ **把命令落盘成 .cmd 再执行**；② `node` 读不了 `/tmp/x`（会解析成 `C:\tmp\x`）→ 脚本间传路径一律用 `%TEMP%` 等 Windows 形式；③ `iconv` 别直接吃 MSYS 管道输出（易报 `cannot convert`）→ 先落文件再转换。

## 6. 打包发行

```bash
node ~/.qoder/scripts/pack-folder.js "<工具文件夹>" [输出.zip]   # 默认输出同级 <文件夹名>.zip
```

生成 **Unix 来源 + UTF-8 标志位**的 zip——中文文件名在资源管理器 / PowerShell / unzip 下都能正确解出。`Compress-Archive` 生成的是 DOS 来源 zip，MSYS `unzip` 下中文会乱码。

打包后必须**解压到临时目录与源逐字节比对**（md5），并把改动同步到全部副本（见第 1 节）。

## 7. 交互与交付约定（用户明确要求，改任何带菜单的 .cmd 都照此办）

1. **所有「从清单里选」的输入点都用 ↑/↓ 选择器**——主菜单**和**二级选择（目标盘、回退对象…）都要；回车确认、Esc 取消；**只有破坏性确认保留手工输入 `yes`**（防误触）。
2. **不得为了新交互丢掉原有提示**：做法是「顶部清屏 → 打完整标题 / 说明 / 前提提示 → 选择器画在提示下方」。把提示直接取消掉是错的。
3. 列表高于窗口时**自动滚动**，底部显示「当前 / 总数」。
4. 可重复的操作要有**「退出 / 返回」项**，且**支持连续操作**（做完一项回到刷新后的列表，不弹回主菜单）；有副作用的项要标明（如「回退会拆掉同源」）。
5. 同名项要加**区分标签**（如 `[AppData\Roaming]` / `[AppData\Local]`），别让两行看起来一样导致选错。
6. 危险动作（改运行时数据、删除）**只接受交互窗口里人工确认**；脚本 / 管道代跑一律拒绝。

## 8. 收尾清单

- 编辑 → 转 CRLF → 转 GBK → 装全部副本 → md5 一致
- 真机验收：给出可失败判据（窗口消失 / 清单文本 / 截图内容）；交互路径要覆盖正反用例——正常路径 + `Esc` 取消路径各走一遍；拿不到就显式标注「未验证 + 原因」
- 打包 → 解压逐字节比对
- 同批更新目标工具的 `README.md`「设计要点」与相关记忆
- 临时产物（截图 / 调试副本 / 输入文件）统一放 `%TEMP%/qoder-work/`，用后即删，收尾检查误落目录
- 需宿主程序退出的**停机类操作由用户手动执行**，不代做
- 按归属提交：只提交明确路径，别 `git add -A`

## 相关

`memory/reference-windows-bat-encoding.md`（陷阱全量版）· `memory/reference-console-app-ui-verification.md`（验收实测记录）· `memory/prefer-native-batcmd-over-gitbash.md`（纯批处理交付口径）· 技能 `verify-ui-in-browser`（网页 / 小程序 / App）· 技能 `verify-before-claim`（证据纪律）

## 维护

Windows `.cmd/.bat` 工具的**构建 / 验收 / 交付只维护本技能一份**。2026-09-29 因多个并行演进会话各自新建，同域一度出现 4 份技能（`windows-console-ui-verification` / `verify-console-ui-in-windows` / `windows-native-cmd-tools`，三份已移入 `~/.qoder/skills-disabled/` 留档）。**不要再新建同域泛化技能**——要补充内容就改本文件；新增 cmd 坑同批更新第 5 节与 `memory/reference-windows-bat-encoding.md`。
