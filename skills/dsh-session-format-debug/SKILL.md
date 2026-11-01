---
name: dsh-session-format-debug
description: "取证 dsh（DeepSeek Harness，~/.dsh）会话轮次反复失败的固定流程，报错特征为 format v4 message requires a producer-owned source kind。六步——从 ~/.dsh/logs 锁定失败 session id；按 zstd 帧魔数 28 B5 2F FD 逐帧解 session.v4.jsonl.zstd；按事件类型统计 source.kind 并用两遍独立扫描对账覆盖度；从 app.asar 现抽校验器跑消息形状矩阵"
---

# DSH 会话格式失败取证

## Overview

把「dsh 某会话轮次一直失败」定位到具体消息形状，并证明修复真的生效。核心认知——**这类失败绝大多数不在 dsh 本体，而在用户自己写的 host 插件**：插件手工构造 followup 消息时用了已退役的 v3 包装，而 `Agent.followup()` 不做任何归一化，直接撞上 v4 准入校验器。**会话数据本身往往是干净的，不要去改它。**

## 何时用 / 不用

- 用：日志里出现 `format v4 message requires a producer-owned source kind`；或 `queued continuation → failure recorded → scheduled` 严格节拍死循环；或要读 `session.v4.jsonl.zstd`；或改了 `~/.dsh/plugins/**` 却看不出效果。
- 不用：非 dsh 的 zstd 文件（本技能脚本按 dsh 事件形状写）；纯 UI / 渲染问题。

## 前置：先探测，别照抄本机值

```bash
ls -d "$HOME/.dsh" && ls "$HOME/.dsh/logs" | head
node -p "typeof require('zlib').zstdDecompressSync"   # 需 function，否则 Node 太旧
```

本机参考值（**只作示例，会变**）：

| 用途 | 路径 |
| --- | --- |
| 插件 / hook 日志 | `~/.dsh/logs/<plugin>[-native].log`（时间戳是 **UTC**，用户说的是本地 UTC+8，对时前先换算） |
| 会话转录 | `~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`（slug 形如 `--D-Java-GitHub-tieshi--`） |
| 运行时配置 / 插件注册 | `~/.dsh/cordis.patch.yml` |
| 会话元数据 | `~/.dsh/storages/session_projcache/sessions/<session-id>.json` |
| 主程序 | `app.asar`（本机在 `%LOCALAPPDATA%/Programs/DeepSeek Harness/resources/`） |

## 步骤 1 — 日志定性，锁定 session id

```bash
grep -h "failure recorded" ~/.dsh/logs/*.log | tail -5
```

节拍三件套（实测形状）：

```
... agent=session-<id> queued continuation 1/8
... agent=session-<id> failure recorded ("format v4 message requires a producer-owned source kind"), awaiting idle
... agent=session-<id> continuation scheduled in 30000ms
```

出现 `human input: counter reset` 说明这条链会被真人消息打断——它是**判据**，解释了步骤 5 里 `kind` 为什么不能等于 `user`。据此拿到 `session-<id>` 再找转录文件。

## 步骤 2 — 逐帧解码会话（假阴性重灾区）

**关键陷阱**：`session.v4.jsonl.zstd` 不是单一 zstd 流，**每个追加事件各占一个 zstd 帧**。对整文件 `zlib.zstdDecompressSync` 只会静默返回首帧（本机实测 4.2MB → 解出 **204 字节 1 行**），于是统计出来是空直方图 + `offenders: 0`——**这是假绿，不是干净**。

```bash
node scripts/scan-session.cjs "<转录路径>"    # 本机实测：7337 帧 → 13239 事件 → 4984 条消息
```

输出顺序——帧数 / 事件数 → 事件类型直方图 → `source.kind` 直方图 → **覆盖度自证** → offender 明细。脚本跑了两遍**相互独立**的扫描（显式映射 + 结构递归 sweep）并比较总数；两遍不一致就印 `PARTIAL` 并点名未映射的事件类型，此时不得拿 offender 数下结论；遇到只有首帧的残缺文件印 `INCONCLUSIVE` 并退 1。

对照实验（证明脚本真走通了多帧）：同一文件用整文件解压只得到 204 字节。

## 步骤 3 — 判据，offender 在持久数据里还是活体注入

消息在事件里的位置**按类型分岔**（本机 13239 事件会话实测）：

| 事件类型 | 消息位置 | 实测 kind |
| --- | --- | --- |
| `user/message` | **`data` 本身**（`role`/`content`/`source` 平铺在 data 上） | `user` |
| `assistant/message` | `data.message` | `model`（2112） |
| `tool/result` | `data.message` | `tool`（1966） |
| `agent/inbox/spliced` | **`data.inserted[]`** | `user` / `plugin:<name>` |
| `system/message`、`developer/message` | `data.message` | `system-prompt` |

**注意分母**：`agent/inbox/spliced` 567 个事件里 276 个的 `inserted` 是空数组（合法零消息），所以不能拿事件数当消息数比——这就是脚本改用「两遍扫描对账」而不是「计数相除」的原因。

只扫 `data.message` / `data.messages[]` / `data.added[]` 的朴素写法会漏掉 `user/message` 与 `agent/inbox/spliced`：2026-10-04 那次直方图只统计到 1289 条，而同一会话实际有 4984 条消息。**而插件 followup 恰好落在 `data.inserted`**——漏了它，"0 offender"完全可能是漏扫。

分叉判据：

- **持久数据 0 offender（且覆盖度 COVERAGE OK）** ⇒ 非法消息是**活体产生**的，不要去改会话文件；直接查插件里手工构造 `source` 的地方。
- **持久数据有 offender** ⇒ 才涉及数据修复；会话文件是用户数据，动手前备份并单独取得用户确认。
- **正向判据（端到端已生效的数据层证据）**：持久数据里出现 `kind` 为 `plugin:<name>` 且 offender 为 0 ⇒ followup 真被接受并落盘了（本机 2026-10-07 复跑：`plugin:auto-continue-native` 18 条、`plugin:session-heartbeat-native` 2 条）。

```bash
grep -rn "kind: 'plugin'" ~/.dsh/plugins --include=index.js | grep -v '\.bak'
```

## 步骤 4 — 从 app.asar 现抽真实校验器，跑形状矩阵

不要凭报错文字猜规则，把**当次安装里真实那份**校验器抽出来实跑（版本会漂移，结论不能硬编码）：

```bash
node scripts/verify-source-validator.cjs [asar 路径]   # 缺省自动探测
```

它提取 `source()` 与 `producerKind()` 跑 10 项带期望的检查，**任一项不符即退 1**——6 个必拒（带 `plugin` 字段的旧包装、裸 `kind` 为 `plugin`、空串 `kind`、缺 `kind`、非字符串 `kind`、`source` 非对象）+ 2 必接受（`plugin:<name>`、`user`）+ `producerKind()` 输出逐字等于修复后的形状 + 拒给报错文本与插件日志逐字一致。asar 里没有这些符号、或切片边界漂移导致编译不过，也会明确退 1 并提示人工重定位——**不得把假绿当验证**。

从代码读到的语义（v3→v4 转换器，`session-format-v3-to-v4`）：

- `rewriteV3MessageSource()` 遇到 `kind` 为 `plugin` 会调 `rewritePluginSource()` → 用 `producerKind(plugin, role)` 自动 lift 成新 kind；
- **但 `Agent.followup()` 不走这个转换器**，`source` 原样进 inbox，撞上原生 `source()` 校验器——这就是「同一种写法在别处能用、在 followup 必死」的原因。

## 步骤 5 — 修

正确形状取自 `producerKind()` 的官方映射，不是随手起的名字：

```js
// 弃用 source 为 kind 等于 plugin 外加 plugin 字段的旧包装
source: { kind: `plugin:${name}` }
```

硬性纪律：

1. **改前先备份**：沿用既有命名 `index.js.bak-<主题>-<日期>`；汇报里给出备份文件名。
2. **`kind` 不能等于 `'user'`**：auto-continue 靠 `kind === 'user'` 判定「人说话了」并清零重投计数，写成 `user` 会静默改变接续行为（形状合法但语义错，步骤 4 的矩阵测不出来）。
3. **同批改测试断言**：插件自测可能正在锁死这个 bug（实测两处断言就是旧形状），不改则「全绿」是假的。
4. **排除历史副本**，别把旧运行时当活代码：`*.bak*` 与 `~/.dsh/backups/profile-runtime-upgrade-*/**`（升级前的旧版本树，正是它退役了这个包装）。
5. **镜像安装要同步**（本机曾出现 `~/.dsh-beta` 与 stable 逐字节相同）：先用步骤 6 确认哪个是 live，再决定是否一起改。
6. **别照抄 app.asar 里的插件 API 文档示例**——它至今仍写着被拒的那个旧包装。

```bash
node --test ~/.dsh/plugins/<plugin>/index.test.mjs   # 本轮退出码是判据的一部分
```

## 步骤 6 — 证明修复被运行中的进程加载

**插件只在应用启动时加载一次，不热重载。** 落盘 ≠ 生效。三者对齐才算数：

```bash
grep -h "loaded:" ~/.dsh/logs/<plugin>-native.log | tail -3      # ① 进程加载代码的时刻（UTC）
ls -l --time-style=+%Y-%m-%dT%H:%M ~/.dsh/plugins/*/index.js     # ② 文件 mtime 必须早于 ①
powershell -NoProfile -Command "Get-Process | Where-Object Path -like '*DeepSeek*' | Select-Object Id,StartTime"
```

判据——`loaded` 行时间戳**晚于** mtime，且应用进程 StartTime 晚于编辑时间，且此后日志不再出现 `failure recorded`。

**重启是对外可见动作**：会影响用户正在运行的应用，必须交用户拍板（实测用户选择自己重启），不得自行重启 dsh。用户重启后按上面的三对齐复验。

## 验证阶梯（逐层说清到哪一层）

1. 形状层——步骤 4 的 10 项矩阵全 PASS（含必红对照组）。
2. 数据层——步骤 3 的正向判据，持久数据里出现 `plugin:<name>` 且 0 offender。
3. 行为层（最强，可选）——亲眼观察一轮由插件 followup 起轮且无 `failure recorded`。补验法：`touch ~/.dsh/hooks/continuation-queue.md`（改 mtime ⇒ 心跳在 idle 时投一条），或在那个会话里直接发一条消息后看日志。

做不到哪一层就显式写「未验证 + 原因」，不得宣称端到端已修好。

## 常见误用速查（本机实测，都会浪费时间）

| 误用 | 现象 | 正确做法 |
| --- | --- | --- |
| `grep --no-ignore` | `grep: unknown option -- no-ignore`——那是 ripgrep 的参数，GNU grep 没有 | 用 `grep -rn`，或 `rg -uu`（ripgrep 默认跳 node_modules / .gitignore） |
| `zlib.zstdDecompress(buf)` 不带回调 | `TypeError [ERR_INVALID_ARG_TYPE]` 的 callback 参数必须是函数 | 用 `zlib.zstdDecompressSync(buf)` |
| 整文件 `zstdDecompressSync` | 静默只返回首帧 204 字节 ⇒ 空直方图 + `offenders` 为 0 的假绿 | 按魔数 `28 B5 2F FD` 逐帧 `indexOf` 后 `subarray` 解 |
| `node -e` 内联跑从 asar 抽出的代码 | `SyntaxError: Identifier 'RENAMED_PRODUCERS' has already been declared`（同名 const 在归档里出现多次，切片重叠） | 落成 `.cjs` 文件再跑；用 `new Function(...)` 包作用域 |
| 只查「坏形状不存在」 | 必假绿（漏映射时也是 0） | 两遍独立扫描对账 + 正向断言（旧形状必须真被拒） |
| 管道后取退出码判红 | `node x.cjs \| tail -4; echo $?` 拿到的是 `tail` 的状态（实测把 exit 为 1 看成 0） | 先重定向到文件再取 `$?`，或用 `PIPESTATUS[0]` |

## Resources

- `scripts/scan-session.cjs`——逐帧解 `session.v4.jsonl.zstd`，输出事件类型 / `source.kind` 直方图 + 两遍扫描覆盖度对账 + offender 明细。参数 `<转录路径> [--top N] [--offenders N]`。只读，不写任何文件；残缺文件退 1。
- `scripts/verify-source-validator.cjs`——从 `app.asar` 现抽 `source()` / `producerKind()`，跑 10 项带期望的形状矩阵。参数 `[asar 路径]`，缺省自动探测；只读，不写任何文件；符号缺失退 1。

两脚本已在 2026-10-07 对现存 `~/.dsh` 实跑——扫描 7337 帧 / 13239 事件 / 4984 消息且两遍对账一致、0 offender；矩阵 10/10 PASS；三条必红路径（无 asar、无符号、单帧残缺）均如期退 1。
