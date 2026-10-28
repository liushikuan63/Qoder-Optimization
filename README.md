# Qoder-Optimization

**An opt-in toolkit for making Qoder workflows more repeatable and verifiable.** It adds rules, on-demand skills, hooks, commands, scripts, and MCP templates through Qoder's extension points; it does not modify Qoder itself.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](VERSION)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#requirements-and-limits)

[English](#english) | [简体中文](#简体中文) · [Install guide](README-安装说明.md) · [Skill catalog](SKILLS-清单.md) · [Machine-readable index](catalog.json)

---

## English

### Download

No clone required — pick a version and download it. Every release carries a ready-to-install zip (versioned top-level folder) and a `.sha256` checksum; GitHub also attaches a source snapshot automatically.

- **Latest:** https://github.com/liushikuan63/Qoder-Optimization/releases/latest
- **All versions:** https://github.com/liushikuan63/Qoder-Optimization/releases

| Version | Released | Highlights | Download |
|---|---|---|---|
| 0.0.1 | 2026-10-27 | First open-source release | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization-0.0.1.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

Published assets are immutable: a released zip is never replaced, fixes ship as a new patch version. Full history in [CHANGELOG.md](CHANGELOG.md).


### What it does

AI coding assistants can lose track of process: a check may be claimed without evidence, a failed action may be repeated, or useful findings may disappear with the conversation. Qoder-Optimization provides opt-in mechanisms for those workflows, including checks that can fail when their conditions are not met.

| Included | Count | Examples |
|---|---:|---|
| Skills | 123 | Verification, code review, delivery, databases, documents, desktop automation |
| Scripts | 87 | Guardrails, self-tests, packaging, validation, tool helpers |
| Commands | 10 | Clarification, checkpoints, skill search, cleanup |
| Sub-agents | 2 | Runtime-truth and post-deployment verification |
| Catalog entries | 222 | Skills, scripts, commands, and agents |

### How it fits together

```text
Rules      Set cross-project and task-specific expectations
Skills     Load reusable guidance when a task needs it
Hooks      Run checks at configured points in the workflow
Tools      Fill gaps such as bounded waits and region screenshots
Delivery   Assemble, sanitize, scan, and verify shareable packages
```

Each part is opt-in. In particular, hook scripts remain inactive until you wire them into the selected client's `settings.json`.

### Get started

For a guided setup, give the repository to Qoder and ask it to inspect your current configuration before proposing changes:

> Read `README-安装说明.md`, `INDEX.md`, `catalog.json`, `hooks/README-hooks.md`, and `mcp/README-mcp.md`. Inspect my existing `~/.qoder` or `~/.qoder-cn` setup, then propose an install plan covering skills, conflicts, and configuration changes. Show the plan and wait for confirmation before editing; back up each file before changing it.

For a manual setup, follow the [installation guide](README-安装说明.md). Install only the skills you need; do not copy `skills/` wholesale.

After setup, run the checks from the client directory you configured:

```bash
node ~/.qoder/scripts/skills-doctor.cjs
node ~/.qoder/scripts/skill-collisions.cjs
node ~/.qoder/scripts/build-skills-index.cjs
```

The first two checks should report a clean skill set and no trigger collisions. Restart Qoder after changing its configuration.

### Documentation

| Need | Start here |
|---|---|
| Detailed installation and skill tiers | [README-安装说明.md](README-安装说明.md) |
| Browse skills | [SKILLS-清单.md](SKILLS-清单.md) or [INDEX.md](INDEX.md) |
| Search package entries | [catalog.json](catalog.json) |
| Shared coding rules | [Qoder-AI编码通用规则.md](Qoder-AI编码通用规则.md) |
| Hook setup | [hooks/README-hooks.md](hooks/README-hooks.md) |
| MCP setup | [mcp/README-mcp.md](mcp/README-mcp.md) |
| Plugin recommendations | [plugins/README-plugins.md](plugins/README-plugins.md) |

### Design principles

- **Checks need meaningful outcomes.** Guard tests include cases that must be blocked and cases that must pass.
- **Unknown is not a pass.** A check that cannot decide should report that uncertainty.
- **Use mechanisms for critical steps.** Put execution-time checks in hooks instead of relying only on longer prompts.
- **Install the smallest useful set.** Skills are selected from the catalog instead of copied in bulk.
- **Keep boundaries explicit.** Guards are fail-open and are not a security boundary; platform permissions remain authoritative.
- **Sanitize package copies.** Packaging checks operate on the package and leave local originals untouched.

### Catalog snapshot

In the catalog generated on 2026-10-27, 28 core skill descriptions total 6,817 characters; all 123 skill descriptions total 25,421 characters. The core descriptions are 26.8% of the full catalog description text. This compares description text only, not total prompt tokens.

### Requirements and limits

- Qoder desktop client: international (`~/.qoder`) or CN (`~/.qoder-cn`). Scripts detect a single-client setup and do not create the other directory.
- Node.js 20 or newer for scripts and tooling.
- Developed and tested on Windows 10/11. Most scripts use Node.js; desktop automation and some cleanup tools are Windows-specific.
- No service, telemetry, or account is required. MCP configuration contains placeholders and must be configured by you.
- Hooks only run after you wire them into Qoder. Guards fail open if they crash, so they do not replace operating-system or platform permissions.

### FAQ

**Does this replace Qoder's built-in rules?** No. Add only the rules, skills, and guards you choose.

**Should I install all 123 skills?** Usually not. Registered skill descriptions are injected into each turn; keep frequent, cross-domain skills resident and load specialized skills when needed.

**Can I use only part of the package?** Yes. Catalog entries are independent, and rules, skills, hooks, and scripts can be adopted separately.

### Contributing

Issues and pull requests are welcome. New guards should include a case that must be blocked and a case that must pass. Keep unrelated behavior changes in separate contributions.

### License

MIT; see [LICENSE](LICENSE). This is an unofficial community project and is not affiliated with or endorsed by Qoder. Third-party files under `mcp/offline/` retain their respective licenses; see [mcp/offline/LICENSE-cua-driver.txt](mcp/offline/LICENSE-cua-driver.txt) where applicable.

---

## 简体中文

### 下载

不用克隆仓库，按版本下载即可。每个 Release 都附一个可直接安装的 zip（顶层目录带版本号）和 `.sha256` 校验文件，GitHub 另自动生成源码包。

- **最新版**：https://github.com/liushikuan63/Qoder-Optimization/releases/latest
- **全部版本**：https://github.com/liushikuan63/Qoder-Optimization/releases

| 版本 | 发布日期 | 主要内容 | 下载 |
|---|---|---|---|
| 0.0.1 | 2026-10-27 | 首个开源版 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization-0.0.1.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

已发布的资产不再替换：发现缺陷就发新的补丁版本，历史记录见 [CHANGELOG.md](CHANGELOG.md)。


### 项目简介

Qoder-Optimization 是一套可选安装的 Qoder 增强工具，让工作流程更稳定、验证结果更可检查。它通过 Qoder 自身的扩展点提供规则、按需技能、hooks、命令、脚本和 MCP 模板，不修改 Qoder 本体。

AI 编码助手常见的问题包括：没有证据就声称验证通过、失败后反复重试、对话结束后经验无法复用。本项目把其中适合自动化的部分做成可运行的机制；条件不满足时，检查可以明确失败。

| 内容 | 数量 | 示例 |
|---|---:|---|
| 技能 | 123 | 验证、代码评审、交付、数据库、文档、桌面自动化 |
| 脚本 | 87 | 守卫、自测、打包、校验与工具补强 |
| 命令 | 10 | 需求澄清、接续检查、技能检索、清理 |
| 子智能体 | 2 | 运行期真值核验、部署后验收 |
| 目录条目 | 222 | 技能、脚本、命令与子智能体 |

### 工作方式

```text
规则       明确跨项目与任务要求
技能       在任务需要时加载可复用的方法
Hooks      在配置的流程节点运行检查
工具       补足有界等待、区域截图等能力
交付       组装、脱敏、扫描并校验分享包
```

各部分都由你选择启用。特别是 hooks：只有在对应客户端的 `settings.json` 中完成接线后，脚本才会运行。

### 快速开始

推荐先让 Qoder 检查当前配置并给出安装计划，再决定实际改哪些文件，把目录或仓库地址丢给 Qoder，附上这句话，：

> 先阅读 `README-安装说明.md`、`INDEX.md`、`catalog.json`、`hooks/README-hooks.md` 和 `mcp/README-mcp.md`。检查我当前的 `~/.qoder` 或 `~/.qoder-cn` 配置，提出技能选择、冲突和配置修改计划。先展示计划并等待确认；修改前逐个备份文件。

手动安装请按[安装说明](README-安装说明.md)操作。只安装需要的技能，不要整目录复制 `skills/`。

安装后，在所使用客户端的目录中运行：

```bash
node ~/.qoder/scripts/skills-doctor.cjs
node ~/.qoder/scripts/skill-collisions.cjs
node ~/.qoder/scripts/build-skills-index.cjs
```

前两项应分别报告技能状态正常、触发词无冲突。修改配置后需要重启 Qoder。

### 文档导航

| 需求 | 文档 |
|---|---|
| 完整安装步骤与技能分层 | [README-安装说明.md](README-安装说明.md) |
| 浏览技能 | [SKILLS-清单.md](SKILLS-清单.md) 或 [INDEX.md](INDEX.md) |
| 检索包内条目 | [catalog.json](catalog.json) |
| 通用编码规则 | [Qoder-AI编码通用规则.md](Qoder-AI编码通用规则.md) |
| Hooks 接线 | [hooks/README-hooks.md](hooks/README-hooks.md) |
| MCP 配置 | [mcp/README-mcp.md](mcp/README-mcp.md) |
| 插件建议 | [plugins/README-plugins.md](plugins/README-plugins.md) |

### 设计原则

- **检查必须有明确结果**：守卫自测同时包含必须拦截和必须放行的用例。
- **未知不等于通过**：无法判定时应报告未知，不得当作成功。
- **关键步骤靠机制保障**：执行时的检查放进 hook，不只依赖更长的提示词。
- **按需安装**：从目录中挑选需要的技能，不整包复制。
- **明确安全边界**：守卫崩溃时 fail-open，不构成安全边界；权限仍由平台控制。
- **只脱敏打包副本**：打包校验处理包内副本，不改本机原文件。

### 目录快照

截至 2026-10-27 生成的目录，28 个常驻技能的描述共 6,817 字符；123 个技能的描述共 25,421 字符。常驻描述占全部技能描述文本的 26.8%。这里比较的是描述文本，不是完整提示词 token 数。

### 环境与限制

- 适用于 Qoder 桌面客户端：国际版（`~/.qoder`）或中文版（`~/.qoder-cn`）。脚本可识别单客户端环境，不会创建另一侧目录。
- 脚本与工具要求 Node.js 20 或更新版本。
- 在 Windows 10/11 上开发和验证。多数脚本使用 Node.js；桌面自动化和部分清理工具仅适用于 Windows。
- 无需服务端、遥测或账号。MCP 配置仅含占位符，需要自行配置。
- Hooks 接线后才会运行。守卫崩溃时会 fail-open，因此不能替代操作系统或平台权限。

### 常见问题

**会替换 Qoder 自带规则吗？** 不会。你可以逐项选择要启用的规则、技能和守卫。

**应该安装全部 123 个技能吗？** 通常不需要。已注册技能的描述会进入每轮上下文；建议常驻高频、跨领域技能，其余按需加载。

**可以只使用其中一部分吗？** 可以。目录条目相互独立，规则、技能、hooks 和脚本都可以分开采用。

### 参与贡献

欢迎提交 Issue 和 PR。新增守卫应同时提供必须拦截和必须放行的用例；无关行为变更请拆分提交。

### 许可证

项目采用 MIT 许可证，见 [LICENSE](LICENSE)。这是非官方社区项目，与 Qoder 官方无隶属或背书关系。`mcp/offline/` 下的第三方文件遵循各自许可证；相关说明见 [mcp/offline/LICENSE-cua-driver.txt](mcp/offline/LICENSE-cua-driver.txt)。
