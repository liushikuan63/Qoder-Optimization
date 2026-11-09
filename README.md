# Qoder-Optimization

**An opt-in toolkit for making Qoder workflows more repeatable and verifiable.** It adds rules, on-demand skills, hooks, commands, scripts, and MCP templates through Qoder's extension points; it does not modify Qoder itself.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](VERSION)
[![Node](https://img.shields.io/badge/node-24-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20(primary)-lightgrey.svg)](#requirements-and-limits)

[English](#english) | [简体中文](#简体中文) · [Install guide](README-安装说明.md) · [Skill catalog](SKILLS-清单.md) · [Machine-readable index](catalog.json)

[Codex capability map / Codex 能力承接图](skills/skills-router/references/codex-capabilities.md) records reusable methods, installed execution paths and host-specific prerequisites. 本包复用已有技能承接工程方法，不复制宿主、账户或私人状态。

---

## English

### Download

No clone required — pick a version and download it. Every release carries a ready-to-install zip (versioned top-level folder) and a `.sha256` checksum; GitHub also attaches a source snapshot automatically.

- **Latest:** https://github.com/liushikuan63/Qoder-Optimization/releases/latest
- **All versions:** https://github.com/liushikuan63/Qoder-Optimization/releases

| Version | Released | Highlights | Download |
|---|---|---|---|
| 0.1.0 | 2026-11-08 | Script-identity hook audit; doctor two-level reference fix; ask-once goal mode; router command shells; rules 5.7.0 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.1.0/Qoder-Optimization-0.1.0.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.0) |
| 0.0.30 | 2026-11-06 | Logical context receipts; transactional skill navigation; UTF-8 recovery fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.30/Qoder-Optimization-0.0.30.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.30) |
| 0.0.29 | 2026-11-06 | On-demand skill routing cues; restored library entries | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.29/Qoder-Optimization-0.0.29.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.29) |
| 0.0.28 | 2026-11-06 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.28/Qoder-Optimization-0.0.28.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.28) |
| 0.0.27 | 2026-11-05 | Complete workflow runtimes and explicitly bound migrated libraries | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.27/Qoder-Optimization-0.0.27.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.27) |
| 0.0.26 | 2026-11-05 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.26/Qoder-Optimization-0.0.26.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.26) |
| 0.0.25 | 2026-11-05 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.25/Qoder-Optimization-0.0.25.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.25) |
| 0.0.24 | 2026-11-04 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.24/Qoder-Optimization-0.0.24.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.24) |
| 0.0.23 | 2026-11-04 | Skill reference integrity, Windows CI, release gates and maintainability extraction | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.23/Qoder-Optimization-0.0.23.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.23) |
| 0.0.22 | 2026-11-04 | Usage-driven resident skills, automatic on-demand discovery and parallel plan/recall fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.22/Qoder-Optimization-0.0.22.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.22) |
| 0.0.21 | 2026-11-03 | Active capability lifecycle, isolated parallel writes and delivery integrity | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.21/Qoder-Optimization-0.0.21.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.21) |
| 0.0.20 | 2026-11-03 | Parallel orchestration with plan approval and explicit opt-in | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.20/Qoder-Optimization-0.0.20.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.20) |
| 0.0.19 | 2026-11-03 | B05 auto-trigger; install/update and deploy ask gates | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.19/Qoder-Optimization-0.0.19.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.19) |
| 0.0.18 | 2026-11-03 | Five-release audit: continuity recovery, scoped evidence and rule consistency | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.18/Qoder-Optimization-0.0.18.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.18) |
| 0.0.17 | 2026-11-03 | Continuity install and explicit package update prompts | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.17/Qoder-Optimization-0.0.17.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.17) |
| 0.0.16 | 2026-11-02 | Self-evolution capture trigger and evidence promotion | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.16/Qoder-Optimization-0.0.16.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.16) |
| 0.0.15 | 2026-11-01 | Transaction recovery, encoding, installer and packaging fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.15/Qoder-Optimization-0.0.15.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.15) |
| 0.0.14 | 2026-11-01 | Project-scoped retries, installer validation and scan fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.14/Qoder-Optimization-0.0.14.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.14) |
| 0.0.13 | 2026-11-01 | Seven new on-demand skills; delivery and triage hardening | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.13/Qoder-Optimization-0.0.13.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.13) |
| 0.0.12 | 2026-11-01 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.12/Qoder-Optimization-0.0.12.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.12) |
| 0.0.10 | 2026-10-31 | Recheck protocol and request detection; UTF-8 input fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.10/Qoder-Optimization-0.0.10.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.10) |
| 0.0.9 | 2026-10-31 | Verification wording regression fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.9/Qoder-Optimization-0.0.9.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.9) |
| 0.0.8 | 2026-10-31 | Translation binding and command-evidence fixes | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.8/Qoder-Optimization-0.0.8.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.8) |
| 0.0.7 | 2026-10-30 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.7/Qoder-Optimization-0.0.7.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.7) |
| 0.0.6 | 2026-10-30 | Native answer binding, lexical i18n scopes and stronger receipt checks | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.6/Qoder-Optimization-0.0.6.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.6) |
| 0.0.5 | 2026-10-30 | Opt-in convention checks and adaptive verification | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.5/Qoder-Optimization-0.0.5.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5) |
| 0.0.4 | 2026-10-29 | Integrity fixes; optional offline bundle | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.4/Qoder-Optimization-0.0.4.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4) |
| 0.0.3 | 2026-10-28 | Slimmer rules (160 lines) with an over-budget index rule, plus two maintenance skills | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.3/Qoder-Optimization-0.0.3.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3) |
| 0.0.2 | 2026-10-28 | Installable catalog and verified release pipeline | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.2/Qoder-Optimization-0.0.2.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2) |
| 0.0.1 | 2026-10-27 | First open-source release | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization-0.0.1.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

Published assets are immutable: a released zip is never replaced, fixes ship as a new patch version. Full history in [CHANGELOG.md](CHANGELOG.md).


### What it does

AI coding assistants can lose track of process: a check may be claimed without evidence, a failed action may be repeated, or useful findings may disappear with the conversation. Qoder-Optimization provides opt-in mechanisms for those workflows, including checks that can fail when their conditions are not met.

| Included | Count | Examples |
|---|---:|---|
| Skills | 133 | Verification, code review, delivery, databases, documents, desktop automation |
| Scripts | 150 | Guardrails, self-tests, packaging, validation, tool helpers |
| Commands | 11 | Clarification, checkpoints, skill search, cleanup |
| Sub-agents | 2 | Runtime-truth and post-deployment verification |
| Catalog entries | 296 | Skills, scripts, commands, and agents |

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

Start with `install.cmd` on Windows, or `node scripts/install-package.cjs` elsewhere. A fresh installation defaults to the complete portable workflow: 12 public core skills, managed rules, required helpers and 16 exec hooks across five events. Existing routing installations retain their choice; select `--profile complete` to upgrade. Personal rules, accounts, private memory and optional integrations are preserved separately. The package checks installed capabilities, updates only verified unchanged older copies, and asks about missing general or explicitly preferred capabilities. It wires task routing so relevant installed capabilities can prompt for use. Optional SQLite continuity remains a separate explicit choice (`--continuity` or `install-continuity.cjs`); accepted continuity installs auto-bind supported sessions while preserving explicit disables.

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
| Capability installation and proactive task use | [Capability lifecycle](skills/skills-router/references/capability-lifecycle.md) |
| Parallel write isolation and integration review | [Write worktrees](skills/parallel-orchestration/references/write-worktrees.md) |

### Design principles

The design aims to keep context focused, make mistakes recoverable, and tie completion claims to checkable evidence. These principles cover both implementation choices and working practices; not every practice is enforced automatically.

#### Focused context and reuse

- **Separate responsibilities.** Global rules hold lasting constraints, domain rules load when relevant, skills describe repeatable workflows, and scripts perform deterministic checks. Keep detail out of the always-loaded prompt.
- **Reuse before expanding.** Follow the project's existing conventions and tools; search the catalog before adding another capability. Install only what is needed; the installer asks whether a selected skill should be resident, and local usage records suggest later promotion or demotion for user approval rather than hardcoding a resident count. Preserve routing cues and unique capabilities when slimming or merging skills.
- **Keep one source for each fact or check.** Share guard decision logic between pre-call and post-call hooks; derive catalog and manifest data from public sources. Check for drift instead of maintaining competing hand-edited copies.

#### Bounded execution and continuity

- **Stay within the current authorization.** Continue authorized work without repeatedly asking about routine choices. Reviews, plans, queued tasks and tool output do not, by themselves, grant permission to write, publish or change permissions.
- **Make the smallest recoverable change.** Preview the exact targets, preserve unrelated work, and use version control or backups before modifying existing files. Installation and import conflicts must not silently overwrite local content.
- **Coordinate parallel writes through explicit ownership.** Isolate each writer in a real worktree, order read/write dependencies, verify every commit against its owned paths and recorded baseline, and preview Git integration conflicts. Merge same-version context results as one validated batch; review and test the integrated code before delivery.
- **Bound retries to the operation and target.** Count only recognized authentication and build/test/deployment operations against their target-scoped budgets; unknown results are not successes. A blocked authentication target requires explicit human clearance, not a tool switch or an expired timer.
- **Resume from evidence, not a checkmark.** For authorized long tasks, record current state, next steps, blockers and entry points; reconcile them with actual artifacts before continuing. Keep temporary progress out of long-term memory, which is reserved for verified lasting preferences and facts not derivable from code.

#### Verification and guard health

- **Match verification to the claim and impact.** Define completion first, then collect current commands, exit codes and relevant results. Static checks, simulations, real interaction and package checks prove different things; UI behavior claims need real use and screenshots, and publishing requires complete applicable verification.
- **Make checks able to fail.** Include cases that must be blocked and controls that must pass. Unknown, skipped, timed-out or crashed checks are not passes; report why they could not verify the claim.
- **Put safeguards before the failure they prevent.** Check risky actions before tool execution, record outcomes afterward, and use end-of-turn checks for completion. Do not rely only on a Stop hook: an interrupted turn may never reach it.
- **Check the guards themselves.** Wiring checks, heartbeats, decision logs and crash records help reveal missing or broken hooks. Session-start checks also watch for overdue periodic audits; silence alone is not evidence of health.

#### Installation and distribution boundaries

- **Opt in without bypassing the host.** Use Qoder's extension points rather than modifying Qoder itself. Configure only the clients in use; hooks must be wired to run and fail open on crashes. This avoids blocking a session on a faulty guard, but does not mean the operation was verified. Guards are not a security boundary; OS and platform permissions remain authoritative.
- **Keep public packages separate from private state.** The public repository is the distribution source, not the maintainer's HOME. Private configuration is not exported by default; separately authorized exports are allowlisted and sanitized in copies, leaving originals untouched. Credentials and internal addresses do not belong in source, logs or shared documentation; MCP templates use placeholders.
- **Isolate destructive and failure tests.** Use disposable HOME, client-state and temporary directories rather than live configuration or credentials. Tests must not erase real logs or let inherited environment overrides point them back to live data.
- **Verify what recipients actually get.** Build approved public files from a fixed commit, keep version and catalog metadata aligned, and independently unpack and compare the output. Check downloaded ZIPs and checksums, then validate the receiving environment; an upload or a producer-side pass alone is not proof of delivery.

Details: [installation and tiers](README-安装说明.md), [working rules](Qoder-AI编码通用规则.md), [verification evidence](skills/verify-before-claim/SKILL.md), [hook setup](hooks/README-hooks.md), and [guard mechanisms](scripts/README-rule-enforcement.md).

### Catalog snapshot

In the catalog generated on 2026-11-08, 12 core skill descriptions total 2,643 characters; all 133 skill descriptions total 27,123 characters. The core descriptions are 9.7% of the full catalog description text. These figures sum each catalog description's JavaScript string length; they do not measure total prompt tokens.

### Requirements and limits

- Qoder desktop client: international (`~/.qoder`) or CN (`~/.qoder-cn`). Scripts detect a single-client setup and do not create the other directory.
- Node.js 24.16+ is required by the installer and continuity tools; this release uses 24.16.0 for its test pipeline. The suggestion utility needs the built-in `node:sqlite` module. The standalone MCP installer only requires Node 18+.
- Developed and tested on Windows 10/11. Most scripts use Node.js; desktop automation and some cleanup tools are Windows-specific.
- No service, telemetry, or account is required. MCP configuration contains placeholders and must be configured by you.
- Hooks only run after you wire them into Qoder. Guards fail open if they crash, so they do not replace operating-system or platform permissions.

### FAQ

**Does this replace Qoder's built-in rules?** No. Add only the rules, skills, and guards you choose.

**Should I install all skills?** Usually not. Registered skill descriptions are injected into each turn; keep frequent, cross-domain skills resident and load specialized skills when needed.

**Can I use only part of the package?** Yes. Catalog entries are independent, and rules, skills, hooks, and scripts can be adopted separately.

### Contributing

Issues and pull requests are welcome. New guards should include a case that must be blocked and a case that must pass. Keep unrelated behavior changes in separate contributions.

### Release maintenance

Maintain releases from a Git checkout, not from a downloaded zip. Fetch and merge the latest remote changes while preserving local work. The public repository is the distribution source; the metadata generator does not read your HOME or export private configuration. Preview metadata changes, back up existing files, then use `--apply` when the scope is correct. Keep VERSION, catalog, manifest, both language sections, counts and download links aligned.

Prepare locked test dependencies with `npm ci --prefix skills/office-docs --ignore-scripts` and `npm ci --prefix scripts/convention-runtime --ignore-scripts`, then run `node .github/run-tests.js` for isolated self-tests and release contracts. On Windows, set `RELEASE_TEST_HOME_PARENT` to a disposable parent outside paths classified as temporary, and keep TEMP/TMP in a separate test directory.

The tag workflow validates and packages only approved committed files, then independently unpacks and compares their contents. Existing release assets are downloaded and compared before being retained; differing assets are not replaced. Finally, verify the actual CI run and download both published assets. A successful upload alone is not delivery verification.

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
| 0.1.0 | 2026-11-08 | 脚本身份核 hook 接线；doctor 两级引用修复；目标模式开局问一次；命令薄壳归口路由；规则同步 5.7.0 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.1.0/Qoder-Optimization-0.1.0.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.0) |
| 0.0.30 | 2026-11-06 | 逻辑上下文回执、事务技能目录、UTF-8追回修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.30/Qoder-Optimization-0.0.30.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.30) |
| 0.0.29 | 2026-11-06 | 按需技能路由线索；恢复库条目 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.29/Qoder-Optimization-0.0.29.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.29) |
| 0.0.28 | 2026-11-06 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.28/Qoder-Optimization-0.0.28.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.28) |
| 0.0.27 | 2026-11-05 | 工作流运行依赖与已迁移按需库的受控绑定 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.27/Qoder-Optimization-0.0.27.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.27) |
| 0.0.26 | 2026-11-05 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.26/Qoder-Optimization-0.0.26.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.26) |
| 0.0.25 | 2026-11-05 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.25/Qoder-Optimization-0.0.25.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.25) |
| 0.0.24 | 2026-11-04 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.24/Qoder-Optimization-0.0.24.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.24) |
| 0.0.23 | 2026-11-04 | 技能引用完整性、Windows CI、发布门禁与大脚本拆分 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.23/Qoder-Optimization-0.0.23.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.23) |
| 0.0.22 | 2026-11-04 | 常驻技能按使用习惯确认、按需技能自动发现、并行计划与召回修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.22/Qoder-Optimization-0.0.22.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.22) |
| 0.0.21 | 2026-11-03 | 能力主动核对与使用、并行写隔离、交付完整性 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.21/Qoder-Optimization-0.0.21.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.21) |
| 0.0.20 | 2026-11-03 | 并行编排：计划审批与显式 opt-in | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.20/Qoder-Optimization-0.0.20.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.20) |
| 0.0.19 | 2026-11-03 | B05 自动触发；安装/更新与部署询问门禁 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.19/Qoder-Optimization-0.0.19.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.19) |
| 0.0.18 | 2026-11-03 | 五版复核：接续恢复、证据作用域与规则一致性修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.18/Qoder-Optimization-0.0.18.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.18) |
| 0.0.17 | 2026-11-03 | 接续安装与按需安装/更新询问 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.17/Qoder-Optimization-0.0.17.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.17) |
| 0.0.16 | 2026-11-02 | 自进化采集触发与证据晋升 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.16/Qoder-Optimization-0.0.16.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.16) |
| 0.0.15 | 2026-11-01 | 事务恢复、编码扫描、安装器与打包边界修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.15/Qoder-Optimization-0.0.15.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.15) |
| 0.0.14 | 2026-11-01 | 项目连败隔离、安装器校验与敏感扫描修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.14/Qoder-Optimization-0.0.14.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.14) |
| 0.0.13 | 2026-11-01 | 新增 7 个按需技能；交付与排查加固 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.13/Qoder-Optimization-0.0.13.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.13) |
| 0.0.12 | 2026-11-01 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.12/Qoder-Optimization-0.0.12.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.12) |
| 0.0.10 | 2026-10-31 | 复核协议与请求识别；中文分块输入修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.10/Qoder-Optimization-0.0.10.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.10) |
| 0.0.9 | 2026-10-31 | 验证措辞识别回归修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.9/Qoder-Optimization-0.0.9.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.9) |
| 0.0.8 | 2026-10-31 | 翻译绑定与命令证据识别修复 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.8/Qoder-Optimization-0.0.8.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.8) |
| 0.0.7 | 2026-10-30 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.7/Qoder-Optimization-0.0.7.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.7) |
| 0.0.6 | 2026-10-30 | 原生答复绑定、词法作用域与回执校验加固 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.6/Qoder-Optimization-0.0.6.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.6) |
| 0.0.5 | 2026-10-30 | 按需采用项目约定检查与验证选档 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.5/Qoder-Optimization-0.0.5.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5) |
| 0.0.4 | 2026-10-29 | 完整性修复；离线附件按需下载 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.4/Qoder-Optimization-0.0.4.zip) · [notes](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4) |
| 0.0.3 | 2026-10-28 | 规则瘦身至 160 行 + 超红线转索引条款 + 两个维护技能 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.3/Qoder-Optimization-0.0.3.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3) |
| 0.0.2 | 2026-10-28 | 修复索引安装，补齐发布验证 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.2/Qoder-Optimization-0.0.2.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2) |
| 0.0.1 | 2026-10-27 | 首个开源版 | [zip](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.0.1/Qoder-Optimization-0.0.1.zip) · [说明](https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1) |

已发布的资产不再替换：发现缺陷就发新的补丁版本，历史记录见 [CHANGELOG.md](CHANGELOG.md)。


### 项目简介

Qoder-Optimization 是一套可选安装的 Qoder 增强工具，让工作流程更稳定、验证结果更可检查。它通过 Qoder 自身的扩展点提供规则、按需技能、hooks、命令、脚本和 MCP 模板，不修改 Qoder 本体。

AI 编码助手常见的问题包括：没有证据就声称验证通过、失败后反复重试、对话结束后经验无法复用。本项目把其中适合自动化的部分做成可运行的机制；条件不满足时，检查可以明确失败。

| 内容 | 数量 | 示例 |
|---|---:|---|
| 技能 | 133 | 验证、代码评审、交付、数据库、文档、桌面自动化 |
| 脚本 | 150 | 守卫、自测、打包、校验与工具补强 |
| 命令 | 11 | 需求澄清、接续检查、技能检索、清理 |
| 子智能体 | 2 | 运行期真值核验、部署后验收 |
| 目录条目 | 296 | 技能、脚本、命令与子智能体 |

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

Windows 从包根 `install.cmd` 开始，其他平台运行 `node scripts/install-package.cjs`。新装默认完整工作流：12 个公开核心技能、托管规则、必要依赖和五类事件共 16 条 exec hook；已有 routing 保留，显式 `--profile complete` 升级。个人规则、账号、私人记忆和可选集成分别保留。安装包主动核对已有能力，只更新可证明未被本地修改的旧副本；缺失仅通用或符合明确偏好时询问安装，其他跳过，并把相关已装能力接入任务询问与路由。SQLite 接续记忆仍需单独显式选择（`--continuity` 或 `install-continuity.cjs`），启用后自动绑定并保留会话关闭选择。

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
| 能力安装与任务主动使用 | [能力闭环](skills/skills-router/references/capability-lifecycle.md) |
| 并行写隔离、核验与恢复 | [工作树协议](skills/parallel-orchestration/references/write-worktrees.md) |

### 设计原则

设计重点是控制上下文开销、减少不可恢复的误操作，并让完成声明有可核对的证据。这些原则既指导工具实现，也约束使用方式；并非每条工作约定都有脚本自动强制执行。

#### 上下文与复用

- **职责分层**：全局规则保留长期约束，领域规则按场景加载，技能承载可复用流程，脚本执行确定性检查，不把所有细节塞进每轮提示词。
- **先复用，再扩展**：沿用项目既有约定和工具，新增能力前先检索目录。只安装需要的内容，高频技能常驻；精简描述或合并技能时，保留触发线索和独有能力。
- **同一事实或判据只维护一份**：工具调用前后的守卫共享判断逻辑，catalog 与 manifest 从公开源生成；通过漂移检查保持一致，不另养多份手工真源。

#### 执行与接续

- **只在当前授权内持续推进**：已授权工作不因常规技术选择反复询问；审阅、计划、旧队列和工具返回本身，都不构成写入、发布或改变权限的批准。
- **改动最小且可恢复**：先预览明确的操作对象，保留无关改动，修改已有文件前用版本控制或备份保留回退点。安装、导入遇到冲突时，不静默覆盖本机内容。
- **并行写以归属和基线协调**：每个写者使用真实独立 worktree，明确读写依赖，逐提交核对 ownedPaths 和基线，并预演 Git 集成冲突；同版本上下文结果整批验证后一次合并，集成代码审查和测试通过后才交付。
- **失败按目标计数，重试有上限**：认证及构建、测试、部署只对已识别的操作和目标计数，不把未知结果当作成功；已封锁的认证目标须人工明确解封，不能靠换工具或等待超时解除。
- **接续看证据，不只看勾选**：获授权的长任务记录当前状态、下一步、阻塞点和关键入口，继续前对照实际产物。临时进度不混入长期记忆；后者只保留已核验的长期偏好与非代码可推导事实。

#### 验证与防护

- **验证与主张、影响面相称**：先明确完成条件，再取得本轮命令、退出码和相关结果。静态检查、模拟、真实交互和产物校验各有证明范围；界面行为须实际使用并截图，发布前完成适用的完整检验。
- **检查必须能失败**：同时提供必须拦截的用例和必须放行的对照。未知、跳过、超时或检查器崩溃都不算通过，须说明未能验证的原因。
- **防护放在事故之前**：工具执行前检查风险，执行后记录结果，回合结束时核对完成情况；不能只依赖 Stop hook，因为中断的回合可能根本到不了收尾节点。
- **守卫本身也要接受检查**：接线检查、心跳、判定台账和崩溃记录用于发现缺失或失效的 hook；会话启动时还检查定期审计是否逾期，不能把“没有报错”当作健康证据。

#### 安装与分发边界

- **可选启用，不绕过宿主**：通过 Qoder 扩展点提供能力，不修改 Qoder 本体；只配置实际使用的客户端，hooks 接线后才运行。守卫崩溃时 fail-open，避免守卫故障卡住会话，但放行不等于验证通过。守卫不构成安全边界，权限仍由操作系统与平台控制。
- **公开包与私有状态分开**：公开仓库是交付源，不是维护者的 HOME。默认不导出私有配置；单独获准的导出按白名单处理，只脱敏副本、不改原件。凭据和内网地址不进入源码、日志或共享文档，MCP 模板只保留占位符。
- **失败与破坏性测试必须隔离**：使用可丢弃的 HOME、客户端状态和临时目录，不使用现役配置或凭据；测试不能删除真实日志，也不能因继承环境变量而误指向真实数据。
- **交付验证面向接收者**：从固定提交构建获准的公开文件，同步版本和目录元数据，独立解包并比对内容；核对实际下载的 ZIP 与校验文件，再验证接收环境。上传成功或制作端通过，都不能单独证明交付成功。

详细说明见[安装与分层](README-安装说明.md)、[工作约定](Qoder-AI编码通用规则.md)、[验证证据](skills/verify-before-claim/SKILL.md)、[守卫接线](hooks/README-hooks.md)和[机制说明](scripts/README-rule-enforcement.md)。

### 目录快照

截至 2026-11-08 生成的目录，12 个常驻技能的描述共 2,643 字符；133 个技能的描述共 27,123 字符。常驻描述占全部技能描述文本的 9.7%。数据按 catalog 中 description 的 JavaScript 字符串长度求和，不是完整提示词 token 数。

### 环境与限制

- 适用于 Qoder 桌面客户端：国际版（`~/.qoder`）或中文版（`~/.qoder-cn`）。脚本可识别单客户端环境，不会创建另一侧目录。
- 安装器与接续工具要求 Node.js 24.16+，本版测试流水线使用 24.16.0；建议状态工具需要内置的 `node:sqlite` 模块。独立 MCP 安装器只需 Node 18+。
- 在 Windows 10/11 上开发和验证。多数脚本使用 Node.js；桌面自动化和部分清理工具仅适用于 Windows。
- 无需服务端、遥测或账号。MCP 配置仅含占位符，需要自行配置。
- Hooks 接线后才会运行。守卫崩溃时会 fail-open，因此不能替代操作系统或平台权限。

### 常见问题

**会替换 Qoder 自带规则吗？** 不会。你可以逐项选择要启用的规则、技能和守卫。

**应该安装全部技能吗？** 通常不需要。已注册技能的描述会进入每轮上下文；建议常驻高频、跨领域技能，其余按需加载。

**可以只使用其中一部分吗？** 可以。目录条目相互独立，规则、技能、hooks 和脚本都可以分开采用。

### 参与贡献

欢迎提交 Issue 和 PR。新增守卫应同时提供必须拦截和必须放行的用例；无关行为变更请拆分提交。

### 版本维护

维护版本要使用 Git 源码仓库，不从下载的 ZIP 直接改出新版。先拉取并保留本地工作合并最新远端；公开仓库是交付源，元数据生成器不读取 HOME，也不导出私有配置。先预演和备份，确认范围后再加 `--apply`，同步 VERSION、catalog、manifest、双语文档、计数和下载链接。

分别用 `npm ci --prefix skills/office-docs --ignore-scripts` 和 `npm ci --prefix scripts/convention-runtime --ignore-scripts` 准备锁定的测试依赖，再运行 `node .github/run-tests.js`。Windows 上把 `RELEASE_TEST_HOME_PARENT` 指向不会被识别为临时路径的独立沙箱父目录，TEMP/TMP 使用另一测试目录。

标签工作流只校验和打包获准的已提交文件，并独立解包比对内容。已有同名资产下载比对后才保留，内容不一致时停止、不覆盖。最后核对真实 CI，并下载 ZIP 和校验文件复验；上传成功不能单独证明交付成功。

### 许可证

项目采用 MIT 许可证，见 [LICENSE](LICENSE)。这是非官方社区项目，与 Qoder 官方无隶属或背书关系。`mcp/offline/` 下的第三方文件遵循各自许可证；相关说明见 [mcp/offline/LICENSE-cua-driver.txt](mcp/offline/LICENSE-cua-driver.txt)。

<!-- offline-bundle:start -->
### Optional offline bundle / 可选离线附件

The core ZIP excludes MCP offline binaries. Download the [offline bundle](https://github.com/liushikuan63/Qoder-Optimization/releases/download/v0.1.0/Qoder-Optimization-0.1.0-offline.zip) only when needed; verify its separate .sha256 and extract both ZIPs into the same directory. Links become available when that version is published.

核心包不含 MCP 离线二进制；需要时单独下载离线附件，核对各自的 .sha256 后解压到同一目录。无需离线组件时只取核心包；链接仅在对应版本发布后可用。
<!-- offline-bundle:end -->
