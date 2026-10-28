# Qoder-Optimization

**Make an AI coding agent behave like an engineering executor — with rules it must follow, skills loaded on demand, and guardrails that can actually fail a build.**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](VERSION)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#requirements--compatibility)

English | [简体中文](#简体中文)

---

## English

### Download

No clone required — pick a version and download it. Every release carries a ready-to-install zip (versioned top-level folder) and a `.sha256` checksum; GitHub also attaches a source snapshot automatically.

- **Latest:** https://github.com/liushikuan63/Qoder-Optimization/releases/latest
- **All versions:** https://github.com/liushikuan63/Qoder-Optimization/releases

| Version | Released | Highlights | Download |
|---|---|---|---|
| 0.0.1 | 2026-10-27 | First open-source release | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization%20-%200.0.1.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

Published assets are immutable: a released zip is never replaced, fixes ship as a new patch version. Full history in [CHANGELOG.md](CHANGELOG.md).

### The problem

AI coding assistants are capable, but their **behavior drifts**. The same prompt on two days can produce two different working styles, and "done" often means "the model said so" rather than "something provable happened". Five recurring failure modes:

1. **Verification that cannot fail** — a command was run once, a build passed, therefore "verified". Hooks pointing at nonexistent scripts still return success.
2. **Missing process** — no fixed pre-flight (which machine, which database, which UI language, which step needs approval) and no fixed wrap-up (was the evidence produced *this* run?).
3. **Undisciplined failure handling** — retrying the same failing action with new explanations, sometimes until an account is locked out.
4. **Tooling gaps** — whole-window screenshots, one-round-trip-per-wait, unbounded tool output that truncates long sessions.
5. **Knowledge that does not accumulate** — a good debugging session evaporates when the conversation ends.

Qoder-Optimization is a **drop-in enhancement layer** that converts these soft problems into executable, verifiable mechanisms. It does not modify Qoder itself; it uses Qoder's own extension points: rules, skills, hooks, MCP configuration, commands and sub-agents.

### What's inside

| Component | Count | Purpose |
|---|---:|---|
| Skills | 123 | On-demand playbooks: verification discipline, code review, delivery, document authoring, database work, office documents, desktop automation, deployment checks |
| Scripts | 87 | Guardrails, self-tests, packaging and validation tooling, desktop automation helpers |
| Commands | 10 | Slash-command entry points (clarify, checkpoint, clean-disk, clean-temp, fact ledger, skill load, …) |
| Sub-agents | 2 | Runtime-truth verifier, post-deploy verifier |
| Rules | 20 domain/process files | Cross-domain discipline stays in `AGENTS.md`; details live in `rules/` |
| Hook wirings | 15 entries across 5 events | Pre/Post tool guards, session-start checks, prompt reminders, stop gate |
| MCP templates | Placeholder config + offline assets | No credentials; wired by you, smoke-tested before use |

### Architecture: five layers

```
Layer 5  Delivery   whitelist assembly -> sanitize -> sensitive scan -> structure check -> hash verify
Layer 4  Tools      region screenshots, bounded waiting, payload limits
Layer 3  Guards     hooks that can block + self-tests that must turn red on bad fixtures
Layer 2  Skills     resident core (always injected) + on-demand library (not injected)
Layer 1  Rules      AGENTS.md discipline + 20 domain rule files
```

Each layer answers one question: *what should be done* (rules), *what to use* (skills), *what cannot be skipped* (hooks), *what is missing from the toolchain* (scripts), *how to ship it safely* (delivery chain).

### Quick start

**Option A — let your agent install it.** Drop the folder (or a clone of this repo) into the chat and say:

> This is the Qoder-Optimization 0.0.1 package at `<path>`. Read `README-安装说明.md`, `INDEX.md`, `catalog.json`, `hooks/README-hooks.md` and `mcp/README-mcp.md` first. Then inspect my current `~/.qoder` setup and give me an install plan: which skills go resident, which go on-demand, what conflicts with my existing config, and which lines of `settings.json` need changing. Show the plan first and wait for my confirmation. Back up every file you are about to modify with `scripts/backup-file.js`.

The agent will usually: read the package, read your current configuration, choose skills for your stack, propose a plan, install, rebuild the index, and report exit codes.

**Option B — manual, in the right order.**

```bash
# 1. Register the package (do NOT copy skills/ wholesale)
node ~/.qoder/scripts/pkg-catalog.cjs register <package-dir>
node ~/.qoder/scripts/pkg-catalog.cjs search "verify"
node ~/.qoder/scripts/pkg-catalog.cjs install <id>          # dry run
node ~/.qoder/scripts/pkg-catalog.cjs install <id> --apply  # really install

# 2. Scripts (pick the client directory that actually exists)
cp scripts/* ~/.qoder/scripts/          # international client
cp scripts/* ~/.qoder-cn/scripts/       # CN client — one side only if you run one client

# 3. Sub-agents
cp agents/*.md ~/.qoder/agents/

# 4. Rules: merge the parts that fit your environment into ~/.qoder/AGENTS.md
# 5. Hooks: merge hooks/hooks.example.json into settings.json (see hooks/README-hooks.md)
# 6. MCP: merge mcp/mcpServers.example.json (placeholders only), then smoke-test
# 7. Memory: unpack qoder-memory-export-generic.tar.gz and pick what you want
```

> **Hooks do nothing until wired.** The guard scripts on disk are inert; they only run when referenced from `settings.json`. This is intentional: nothing is silently injected into your agent.

**Verify the install (these commands can actually fail):**

```bash
node ~/.qoder/scripts/skills-doctor.cjs        # expect VERDICT=CLEAN
node ~/.qoder/scripts/skill-collisions.cjs     # expect zero trigger collisions
node ~/.qoder/scripts/build-skills-index.cjs   # rebuild the skill index
```

Restart the client afterwards — configuration is read at startup.

### Repository layout

```
.
├── VERSION                       # 0.0.1
├── CHANGELOG.md                  # version history
├── .github/                      # release gate + tag-triggered release workflow
├── README-安装说明.md             # detailed install guide (Chinese)
├── Qoder-AI编码通用规则.md        # shareable rule set (sanitized)
├── Qoder-个人规则生成提示词.md     # prompt that generates rules for YOUR environment
├── SKILLS-清单.md                # human-readable skill catalog
├── INDEX.md / catalog.json       # machine-readable catalog (222 entries)
├── skills-manifest.json          # tier information
├── skills/                       # 123 skill sources (install on demand)
├── scripts/                      # 87 scripts (guards, self-tests, tooling)
├── commands/                     # 10 slash commands
├── agents/                       # 2 sub-agents
├── hooks/                        # wiring template + event-by-script table
├── mcp/                          # placeholder MCP config + offline binaries
├── plugins/                      # recommended plugins and why
└── qoder-memory-export-generic.tar.gz  # de-identified memory examples
```

### Design principles

- **Every claim must be falsifiable.** A gate ships with a dirty fixture that must be blocked and a clean fixture that must pass. Break the judgement and the test must turn red.
- **Unknown is not success.** When a driver cannot decide, it returns `unknown`; that is never treated as a pass.
- **Mechanism over reminders.** A discipline that matters at execution time becomes a hook, not a longer prompt. Prompts get diluted by long contexts; hooks do not.
- **Least privilege by default.** Skills are installed on demand rather than copied in bulk, because a fully registered set injects every `description` into every turn.
- **Fail open, never pretend.** Guards permit the action when they crash; they are not a security boundary. Permissions remain with the platform.
- **De-identified by construction.** The packaging chain rewrites only the copies inside the package; your local originals are untouched.

### Measured effects (author's machine, one run)

| Topic | Measurement |
|---|---|
| Prompt cost of skills | 28 resident descriptions = 6,931 chars vs 123 registered = 25,924 chars (26.7%) |
| Screenshot payload | 272 KB full window → 52 KB region → 18 KB at 0.4 scale → 2.3 KB at 0.1 scale |
| Landed screenshots | image written to disk, ~424 bytes returned to context |
| Bounded waiting | 2 s window appeared at attempt 6 / ~2,249 ms; nonexistent predicate timed out with exit 1 |
| Self-tests | 31 suites, dirty fixtures red, clean fixtures green |
| Package verification | 333 files byte-identical after unzip; 0 sensitive hits; 0 dangling references |

These are local numbers, not team-level productivity claims.

### Requirements & compatibility

- **Qoder** desktop client, international (`~/.qoder`) or CN (`~/.qoder-cn`). Single-client setups are detected automatically; the scripts never create the other client's directory.
- **Node.js 18+** for scripts and tooling.
- Developed and tested on Windows 10/11. Most scripts are plain Node and portable; desktop-automation helpers (`cua-*`) and some cleanup tooling are Windows-specific.
- No network service, no telemetry, no account required.

### FAQ

**Does this replace Qoder's built-in rules?** No. It is a curated set of rules, skills and guards you opt into, file by file.

**Why not just install all 123 skills?** Every registered skill injects its description into every turn. The two-tier layout keeps the injected set small and loads the rest on demand.

**Are there credentials in this repository?** No. MCP configuration is placeholder-only; the memory export is de-identified. Scan it yourself: `grep -rn "password\|token\|PRIVATE KEY" .`

**Can I use only parts of it?** Yes. The catalog is independent per entry; rules, skills, hooks and scripts are separable.

### Contributing

Issues and pull requests are welcome. Two ground rules:

1. **A new guard needs two fixtures** — one that must be blocked, one that must pass — and the assertion must fail when you break the judgement.
2. **Do not widen scope silently.** If a change also alters unrelated behaviour, split it.

### License & third-party notices

MIT — see [LICENSE](LICENSE). This is an unofficial community project and is not affiliated with or endorsed by Qoder.

Binaries under `mcp/offline/` are third-party artifacts distributed with their own licenses (for example `mcp/offline/LICENSE-cua-driver.txt`); they are included for offline setup convenience only.

---

## 简体中文

### 下载

不用克隆仓库，按版本下载即可。每个 Release 都附一个可直接安装的 zip（顶层目录带版本号）和 `.sha256` 校验文件，GitHub 另自动生成源码包。

- **最新版**：https://github.com/liushikuan63/Qoder-Optimization/releases/latest
- **全部版本**：https://github.com/liushikuan63/Qoder-Optimization/releases

| 版本 | 发布日期 | 主要内容 | 下载 |
|---|---|---|---|
| 0.0.1 | 2026-10-27 | 首个开源版 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization%20-%200.0.1.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

已发布的资产不再替换：发现缺陷就发新的补丁版本，历史记录见 [CHANGELOG.md](CHANGELOG.md)。

### 这是什么

Qoder-Optimization 是一套给 AI 编码助手用的**增强层**：把"模型应该按规矩做"变成"不做就过不去"。

它不修改 Qoder 本体，只用它自己的扩展点（规则、技能、hooks、MCP、命令、子智能体），补上五类最常见的问题：**验证不可失败**、**流程缺失导致行为漂移**、**失败处理不规范**、**工具能力不足**、**经验无法沉淀**。

### 包里有什么

| 组成 | 数量 | 作用 |
|---|---:|---|
| 技能 | 123 | 按需加载：验证证据纪律、代码评审、交付、文档体系、数据库、办公文档、桌面自动化、部署后验收等 |
| 脚本 | 87 | 门禁、自测、打包与校验工具链、桌面自动化补强 |
| 命令 | 10 | 斜杠入口：澄清、落盘接续、磁盘清理、临时文件清理、硬事实登记、技能检索等 |
| 子智能体 | 2 | 运行期真值核验、部署后真实验收 |
| 规则 | 20 篇领域/流程 | 跨领域纪律进 `AGENTS.md`，细则下沉 `rules/` |
| hooks 接线 | 5 类事件、15 条 | 工具前后拦截、开会话体检、每轮提醒、收尾门禁 |
| MCP 模板 | 占位符配置 + 离线件 | 不含凭据，由你接线并先做协议冒烟 |

### 五层架构

```
第 5 层 交付   白名单组装 -> 包内脱敏 -> 敏感扫描 -> 结构校验 -> 解压哈希比对
第 4 层 工具   区域截图、有界等待、返回体积上限
第 3 层 门禁   能拦截的 hook + 必须能判红的自测
第 2 层 能力   常驻技能（每轮注入）+ 按需技能库（不注入）
第 1 层 规则   AGENTS.md 纪律 + 20 篇领域规则
```

每一层回答一个问题：该怎么做（规则）、用什么做（技能）、不这样做会被拦（门禁）、能力不够怎么补（脚本）、怎么安全地给别人（交付链）。

### 快速开始

**方式一：让 AI 自己装。** 把目录或仓库地址丢给 Qoder，附上这句话：

> 这是 Qoder-Optimization 0.0.1 增强包（在 `<路径>`）。先只读检查 `README-安装说明.md`、`INDEX.md`、`catalog.json`、`hooks/README-hooks.md`、`mcp/README-mcp.md`，再结合我当前 `~/.qoder` 的实际情况给安装计划：哪些技能进常驻、哪些进按需库、与我现有配置冲突在哪、要改 `settings.json` 的哪几行。先出计划，等我确认再动手；动手前用 `scripts/backup-file.js` 逐个备份。

**方式二：手动，按顺序来。**

```bash
# 1. 先登记包，再按需安装（不要整目录 cp skills/*）
node ~/.qoder/scripts/pkg-catalog.cjs register <包目录>
node ~/.qoder/scripts/pkg-catalog.cjs search "验证"
node ~/.qoder/scripts/pkg-catalog.cjs install <id>          # 预演
node ~/.qoder/scripts/pkg-catalog.cjs install <id> --apply  # 真装

# 2. 脚本（只往实际存在的那一侧客户端目录放）
cp scripts/* ~/.qoder/scripts/
cp scripts/* ~/.qoder-cn/scripts/

# 3. 子智能体
cp agents/*.md ~/.qoder/agents/

# 4. 规则：把与你环境相符的部分并入 ~/.qoder/AGENTS.md
# 5. hooks：把 hooks/hooks.example.json 改好占位符后并入 settings.json
# 6. MCP：合并 mcp/mcpServers.example.json（纯占位符），并做协议冒烟
# 7. 记忆：解包 qoder-memory-export-generic.tar.gz，按需筛选并入
```

> **hooks 不接线就不会跑**：脚本躺在磁盘上不会自己执行，必须在 `settings.json` 的 `hooks` 里引用。这是刻意设计——不悄悄往你的助手环境里注入行为。

**装完自己验一遍（这些命令是能失败的）：**

```bash
node ~/.qoder/scripts/skills-doctor.cjs        # 期望 VERDICT=CLEAN
node ~/.qoder/scripts/skill-collisions.cjs     # 期望触发重叠对 = 0
node ~/.qoder/scripts/build-skills-index.cjs   # 重建技能索引
```

改完配置需要重启客户端才生效。

### 目录结构

```
.
├── VERSION                       # 0.0.1
├── CHANGELOG.md                  # 版本历史
├── .github/                      # 发布门禁 + tag 触发的发布工作流
├── README-安装说明.md             # 详细安装说明
├── Qoder-AI编码通用规则.md        # 可分享版规则（已脱敏）
├── Qoder-个人规则生成提示词.md     # 按你的环境生成个人规则的提示词
├── SKILLS-清单.md                # 人类可读技能清单
├── INDEX.md / catalog.json       # 机器可读目录（222 条）
├── skills-manifest.json          # 常驻 / 按需分层信息
├── skills/                       # 123 个技能源码（按需安装）
├── scripts/                      # 87 个脚本（门禁 / 自测 / 工具）
├── commands/                     # 10 个命令
├── agents/                       # 2 个子智能体
├── hooks/                        # 接线模板 + 事件×脚本对照
├── mcp/                          # MCP 占位符配置 + 离线二进制
├── plugins/                      # 推荐插件与理由
└── qoder-memory-export-generic.tar.gz  # 脱敏记忆示例
```

### 设计原则

- **每条断言都要能失败**：门禁自带"脏夹具必须被拦 + 干净夹具必须放行"，判据改坏后用例必须变红。
- **未知不算通过**：驱动无法判定时返回 `unknown`，绝不当作 pass。
- **机制优先于提醒**：真正影响执行的纪律做成 hook，而不是把提示词写得更长。
- **默认最小安装**：技能按需装，不整目录复制——全量注册会把 123 条描述每轮都注入。
- **fail-open 不当安全边界**：门禁崩溃时放行，硬权限仍交给平台。
- **脱敏只改包内副本**：本机原文件保持原值。

### 实测效果（作者本机单次测量）

| 项目 | 数据 |
|---|---|
| 技能注入成本 | 常驻 28 条 6,931 字符 vs 全量 123 条 25,924 字符（26.7%） |
| 截图体积 | 整窗 272 KB → 区域 52 KB → 0.4 缩放 18 KB → 0.1 缩放 2.3 KB |
| 落盘模式 | 图片写文件，回给上下文约 424 字节 |
| 有界等待 | 约 2 秒出现的窗口在 attempt 6 / 约 2,249 ms 命中；不存在的谓词超时退 1 |
| 自测 | 31 套，脏夹具判红、干净夹具放行 |
| 成品复验 | 解压 333 个文件逐字节一致；敏感词 0 命中；悬空引用 0 |

以上均为本机测试数据，不代表团队或业务侧收益。

### 环境要求

- **Qoder** 客户端（国际版 `~/.qoder` 或 CN 版 `~/.qoder-cn`）；只装一个客户端时脚本自动识别，不会凭空创建另一侧目录。
- **Node.js 18+**。
- 开发与验证环境为 Windows 10/11；多数脚本是纯 Node、可跨平台，桌面自动化与部分清理工具为 Windows 专用。
- 无服务端、无遥测、无需账号。

### 常见问题

**会覆盖 Qoder 自带规则吗？** 不会。这是你逐文件选择启用的规则、技能与门禁集合。

**为什么不能一次装完 123 个技能？** 每个已注册技能都会把描述注入每一轮对话。两层结构把注入量控制在小集合，其余用时再读。

**仓库里有没有凭据？** 没有。MCP 配置是纯占位符，记忆包已脱敏。你可以自己扫：`grep -rn "password\|token\|PRIVATE KEY" .`

**能只用一部分吗？** 能。catalog 里每条独立，规则、技能、hooks、脚本可分开取用。

### 贡献

欢迎 Issue 与 PR，两条底线：

1. **新增门禁必须带两条夹具**（一条必须被拦、一条必须放行），且把判据改坏时用例要变红。
2. **不夹带无关改动**：顺带改了不相干行为就拆开提交。

### 许可与第三方声明

本项目采用 MIT 许可证，见 [LICENSE](LICENSE)。这是非官方社区项目，与 Qoder 官方无隶属或背书关系。

`mcp/offline/` 下的文件是第三方产物，遵循各自许可证（例如 `mcp/offline/LICENSE-cua-driver.txt`），随包提供仅为离线安装方便。
