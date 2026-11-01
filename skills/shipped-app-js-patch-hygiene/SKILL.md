---
name: shipped-app-js-patch-hygiene
description: "热修已安装桌面或 Electron 应用打包 JS 的可验证流程——改前用 SHA1 加补丁标记数证明 live 文件是否原版（.bak 未必干净、.patched 不是还原点），意图命名备份、最小改动、node --check 语法门、与已验原版逐行 diff、真重启后从应用自己的日志数标记、修不动就还原并复验 SHA1。用于热修 JS、残留 .bak 或 .patched、node --check 通过但应用照坏、删 scratch user-data-dir 报 Device or resource busy。不用于 git 仓库源码与重新打包。"
argument-hint: "<live-js-path> [patch-marker]"
---

# 已发布应用 JS 补丁卫生

## Overview

给已安装应用的随包 JS 打热补丁时的固定卫生动作：先证明现场，再落可验证的还原点，最小改动，语法门与运行时门都做实地，无效即从已验证 pristine 还原并复算哈希，最后清掉自己造的临时实例。核心是每一步都留下能失败的判据，不把看着改好了当完成。

## 何时用

- 要直接改安装目录里的随包产物：`resources/app/**.js`、打包后的 `lib/<name>-<hash>.js`、`app.asar` 解包件。
- 目标目录同时存在 `*.bak-*` / `*.patched-*` / `*.orig` 等历史件，分不清哪个能当还原点。
- `node --check` 报 OK 但应用照坏，或明知坏的样本也报 OK。
- 诊断结论已表明补丁对根因无效，要把应用回到改动前，并清掉自建的第二实例与临时 `--user-data-dir`。
- 不用于：git 仓库内源码、构建期重新打包、插件市场包。

## 前置（动手前逐条确认）

1. 改第三方已发布产物会破坏代码签名，且自动更新可能静默覆盖补丁 ⇒ 先向用户说明并取得同意。
2. 任何写入之前必须已有已验证的还原点（第 2 步），不是改坏了再想。
3. 运行时验证需要重启用户正在使用的应用 ⇒ 单独请示，不静默结束他人进程。
4. 别的会话遗留的 `.bak-*` / `.patched-*` 默认只报告不删；要删必须用户逐件点名。
5. 写 `Program Files` 可能需要提权；先确认目录可写与完整性标签正常。

## 步骤

助手脚本 `scripts/patch-hygiene.cjs`（Node 18+；输出纯 ASCII；退出码 **0 通过 / 1 判红 / 2 前置或参数失败**）。先把路径存成变量（Git Bash）：

```bash
S="node <绝对技能目录>/scripts/patch-hygiene.cjs"
LIVE="/d/Program Files/<App>/resources/app/lib/<name>-<hash>.js"
```

### 1. 盘点现场：按内容而不是按文件名认还原点

```bash
$S survey "$LIVE" --marker <patchMarker>
```

读三样：live 的 SHA1/字节数/mtime；同目录每个历史件的 SHA1 与 `IDENTICAL-TO-LIVE|DIFFERS`；每件的 marker 命中数。

判据与已知形状：

- `.bak-*` **不等于原版**：它可能是上一个会话改完之后的备份，也可能是上一段改动的产物。
- `*.patched-*` 几乎一定是**改过的副本**，只能当补丁参考，不能当还原点。
- `.map` 是源地图不是备份（`survey` 已排除，别手工把它当 pristine）。
- pristine 的认定：**marker 命中 0 且哈希与官方安装包/发布哈希一致**；只有最早日期件时，最多称"未发现补丁痕迹"，不能单凭它认定原版。记下独立来源的 SHA1 当基线，后面全部靠它。拿不出这样一份就不得贸然回滚，只报告现状。

### 2. 落备份（命名带意图与日期）

```bash
$S backup "$LIVE" --intent <意图短词>
```

产出 `<name>-<hash>.js.bak-<intent>-<YYYYMMDD>` 并印出备份自身 SHA1。目标存在则拒绝覆盖（需 `--force`）。备份后脚本自己逐字节比过一次哈希，不一致就判红。

### 3. 最小改动 + 插入可检索 marker

用 Edit 改 live 文件本身，不重写整文件。补丁里留一个唯一标识符（如 `trayKeepAlive`、`<name>Diag`）：第 1、5、7 步都要靠这个 marker 定量，而不是靠肉眼读 diff。

### 4. 语法门（本技能最关键的一条：假绿形状已实测）

```bash
$S check "$LIVE"
```

脚本会自动选形状并**印出用了哪一种**（`mode=in-place` / `mode=mjs-copy` / `mode=copy-goal.mjs`，目标与依据看 `SHAPE ... reason=` 行）。手工做也一样，实测对照：

| 检查形状 | 对坏 ESM 的实测结果 | 可用性 |
|---|---|---|
| `.js` 副本，目录里没有 `package.json` type 上下文 | `node --check` **exit 0**（静默放过） | 禁用（假绿） |
| 同内容改名 `.mjs` | exit 1 | 可用 |
| 原地检 live，应用自带 `package.json` 为 `"type":"module"`（含父目录） | exit 1 | 可用 |
| 备份件（名字结尾是 `.bak-*` 而不是 `.js`）原地检 | 合法 ESM 被误判成语法错 | 禁用（假红） |
| 同一备份件改名 `.mjs`（应用是 ESM）/ `.cjs`（应用是 CJS）再检 | exit 1 | 可用 |

结论：**要么原地检（先核 type=module），要么副本必须落 `.mjs`**；拷到临时目录当 `.js` 检是禁止形状。

首行与三、四行是同一族的两面：`node --check` 靠扩展名与 `package.json` 定模块目标——**无目标时放过坏代码（假绿），目标错时报冤好代码（假红）**。假红这一面特别阴：`restore` 要先给还原点过语法门，拿 `.bak-*` 直接检会被当成语法错而被误拒 ⇒ 看起来是守卫在拦你，其实是守卫自己算错了目标。`check` 会自动按目标改名成 `.mjs`/`.cjs` 并印 `mode=copy-goal.mjs`。

门是活的就要自证（必跑一次，不然你不知道它会不会报错）：

```bash
$S selftest
```

要求 `SELFTEST PASS` 且退 0；它会同时报告当前 Node 版本下假绿形状是否仍复现（假绿是版本相关行为，不复现不等于判据错）。

### 5. 逐条 diff

```bash
$S diff "$PRISTINE" "$LIVE"
```

交付时逐条贴 hunk 原文（不写加了几行保活逻辑这种无法核对的话）。系统 `diff` 不可用时脚本回退到前后缀修剪的单块输出，此时多 hunk 会合并 ⇒ 输出里会打 `FALLBACK`，要注明未按 hunk 拆分。

### 6. 运行时生效证明（区分语法对与真的执行了）

1. 补丁里加一行走应用自身 logger 的日志，前缀固定（如 `[tray-diag]`）。
2. 征得同意后完全退出并重启应用（主进程 JS 不会热生效；不重启就下补丁无效的结论是假的）。
3. 到应用日志目录 grep 这个前缀（常见形状：`%APPDATA%\<ProductName>\logs\` 下的日志文件）。
4. 三种结果分别处置：有日志行且行为变化 ⇒ 生效；有日志行但行为不变 ⇒ **补丁被执行但对根因无效**（这是最有价值的定性，别误读成没打上）；无日志行 ⇒ 根本没执行（改错文件 / 另有加载副本 / asar 优先 / 没重启）。

### 7. 无效即还原 + 复验

```bash
$S restore "$LIVE" "$PRISTINE" --marker <patchMarker>
```

只在还原源 marker 命中 0 且自身过语法门时才动手，否则退 2 拒绝；还原后必须同时满足：live 与 pristine 的 SHA1 相等 **且** live 的 marker 命中 0。**只做到 SHA1 相等不算完成**，两项都要印出来。最后提醒：主进程 JS 需重启应用才回到无补丁态。

### 8. 清理自建临时物

为了做对照而用 `--user-data-dir=<scratch>` 起的第二实例会锁住整个 scratch 目录；**先杀进程树再删**，否则 `rm -rf` 会刷出几十行 `Device or resource busy`：

```bash
$S instances "<scratch-user-data-dir>"            # 只读：列 pid / 根 pid / 建议命令
$S instances "<scratch-user-data-dir>" --kill     # 经用户同意后才带 --kill
```

`--kill` 只对匹配到的**根 pid** 做 `taskkill /T /F`。匹配规则（已实测）：只认命令行里出现完整的 `--user-data-dir=<该路径>` 且路径后紧跟分隔符（空白 / `"` / `;` / 行尾）的进程——纯前缀匹配会把 `App` 打到 `App Beta` 这种旁系 profile 上，属误杀风险；助手自身的进程行会被剔除（见 `EXCLUDED self-helper rows=`）；根 pid 优先上溯**同名父进程**——Electron 主进程的命令行常不带 `--user-data-dir`，只杀 helper 会留下主进程继续撑锁。所以先看 `PARENTS outside-match` 与 `ROOTS` 两行再决定要不要 `--kill`，杀完核 `REMAINING 0` 才删目录；最后用 `ls` 确认目录已空。记忆与源码的 `.bak` 回滚点保留，不归入本轮垃圾。

## 坑清单（均为实测，不是推测）

- **提权启动污染对照**：从提权终端启动对照组，它会继承 High 完整性而用户自启动的实例是 Medium ⇒ 对照组正常是假对照。做 A/B 前先测两边进程完整性级别，并保证启动方式与用户一致。
- **中文输出不可当判据**：`taskkill` / `reg` 等在 CP936 下输出乱码 ⇒ 只取退出码，要读内容就重定向到文件再 grep。
- **管道吞退出码**：`node x.cjs | head -2; echo $?` 拿到的是 `head` 的码 ⇒ 真码用 `${PIPESTATUS[0]}`，或先落盘再 `echo $?`。
- **PowerShell 陷阱**：从 Git Bash 驱动 `.ps1` 按技能 `windows-powershell-from-gitbash` 与 `windows-powershell-scripting-safety` 改写；`$pid` 是只读自动变量，自己声明会报 VariableNotWritable。
- **安装目录标签被动过**：若目录被 ACL 沙箱打上低完整性标签，Electron 会在启动几十毫秒内静默死掉且无日志行——那是另一族问题（参技能 `electron-tray-icon-diagnosis`），先排除再谈补丁。
- **自动更新会把补丁抹掉**：交付时显式写明补丁存在被更新覆盖的风险，与重装后的复现命令。

## 验收（自称完成之前逐条对）

1. 现场：能指出哪一份件是已验证 pristine（SHA1 + marker=0）。
2. 语法：`check` 输出里 `mode=` 属于可用形状，且 `selftest` 退 0。
3. 执行：日志里有 marker 行（或明确写下未做运行时验证及原因）。
4. 结论：生效 / 执行但无效 / 未执行 三态里选定一个，并给出支撑读数。
5. 现场复原：还原后 SHA1 一致 + marker=0；自己造的临时实例与目录已清。

## Resources

- `scripts/patch-hygiene.cjs` — 子命令 `survey` / `backup` / `check` / `selftest` / `diff` / `restore` / `instances`。除 `backup`、`restore` 与显式 `--kill` 外全部只读；无隐式副作用；所有判据以退出码返回。
