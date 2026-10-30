# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

## [0.0.7] - 2026-10-30

### Fixed
- Invalidate translator bindings after `var` initializers, implicit loop assignments and destructured namespace-member writes.
- Fingerprint convention sources and declared check inputs from their raw bytes, including UTF-8 BOMs and staged Git blobs.
- Recognize absolute Node executables and the release test entry point without accepting skipped branches, swallowed failures or here-document text as successful test evidence.
- Count directory-based script modules as single catalog entries instead of incorrectly reporting missing package files.

### Scope
- Ship the source-level fixes and updated usage contracts without enabling optional client workflows or changing permissions.
- The live end-to-end pilot (B05) remains incomplete: real native choices, independent authorization binding, content-change and recovery flows, and screenshots still require separate evidence. Passing regression tests does not complete that pilot.

### 中文摘要
- 修复 `var` 初始化、循环隐式赋值及解构成员写入后仍沿用旧翻译绑定的问题。
- 按原始字节计算约定来源与检查输入的摘要，避免 UTF-8 BOM 或 Git 暂存区内容变化被文本解码掩盖。
- 正确识别 Node 绝对路径和测试入口，不把短路未执行、吞掉失败或 here-document 文本当作测试成功。
- 修正目录型脚本模块的包计数，同时保留目录缺失和目录漏计的反例检查。
- 本版仅交付源码修复与说明；B05 真实问答、独立授权绑定、内容变化/恢复及截图验收仍未完成，不默认启用相关流程。

### Contributors / 贡献者
- @liushikuan63

## [0.0.6] - 2026-10-30

### Fixed
- Require native verification answers to follow the complete displayed proposal and record the proposal source message.
- Resolve i18next bindings by lexical scope in loops and switches, including `var` hoisting, without treating static-unknown text as translated.
- Invalidate convention receipts when a selected local check executable or its declared inputs change, while keeping receipt audits read-only.

### Changed
- Report verification benchmark results per development and holdout split and require the light holdout plan to meet the speed threshold independently.

### 中文摘要
- 将原生验证答复绑定到完整展示的提案，并保留提案来源消息。
- 改进循环与 switch 中的 i18next 作用域识别，以及检查命令和输入变化后的回执失效判断。
- 分开统计开发集与保留集，要求轻量档保留集独立满足提速门槛。
- 真实客户端端到端试点（B05）仍需另行验收，源码与单测通过不代表已默认启用。

### Contributors / 贡献者
- @liushikuan63

## [0.0.5] - 2026-10-30

### Added
- Opt-in project convention checks for internationalization, coding style, tools, dependencies and version constraints, with scoped source records and explicit task decisions.
- Adaptive verification choices, manual verification handling and paired benchmark validation; source distribution does not enable live client workflows.

### Fixed
- Reject internationalization plans that omit files covered by a required convention instead of accepting incomplete coverage.
- Preserve locked directory-based script dependencies during catalog installation, exclude installed modules and backups, and report separate third-party setup requirements.
- Create and confirm draft releases by their REST release IDs rather than assuming drafts are visible through tag lookups.

### Changed
- Keep local `docs/` out of Git and release archives; distribute public usage contracts with the skills and installation guide.
- Prepare the convention runtime from its lockfile in CI and extend the release and installation regression checks.

### 中文摘要
- 新增按需采用的项目约定检查，覆盖国际化、编码风格、工具、依赖和版本，并绑定规则来源及任务选择。
- 增加验证选档、人工待验清单和配对评估，修复覆盖遗漏、目录依赖安装及草稿发布问题。
- 公开调用约定随技能和安装说明分发，本地 `docs/` 不入包；源码发布不会自动启用现役客户端流程。

### Contributors / 贡献者
- @liushikuan63

## [0.0.4] - 2026-10-29

### Fixed
- Scan JSON credential keys after decoding, inspect nested archives with bounded expansion, and reject inconsistent ZIP directories.
- Preflight installation dependencies and cross-tier duplicates; roll back files and indexes after installation failure.
- Load package validation exemptions from the distributed source instead of the recipient's HOME.
- Preserve deletion intent in memory merges, support both memory archive layouts, and refuse conflicting imports before writing.
- Make read-only audits suppress history and child-check heartbeats; propagate verification failures as nonzero process exits.

### Changed
- Generate versioned documentation, full skill descriptions, dependency metadata and memory import tools from public package sources.
- Distribute MCP offline components as an optional ZIP with its own checksum; verify the disjoint union against the same committed source.
- Combine resumable download and full delivery verification in one maintainer entry point; authentication failures are not retried.

### 中文摘要
- 修复 JSON 与压缩包敏感信息扫描、安装回滚、记忆合并和审计退出码等问题。
- 同步版本文档、技能描述和依赖元数据，将 MCP 离线组件拆为可选附件并提供独立校验文件。
- 统一可恢复下载和发行内容校验入口；认证失败不重试。

### Contributors / 贡献者
- @liushikuan63

## [0.0.3] - 2026-10-28

### Added
- `injected-context-slimming`：每轮注入文件（AGENTS.md / MEMORY.md）的无损瘦身流水线——量化 → 备份 → 只压叙述不删判据 → 覆盖断言 → 双侧同写验收。
- `memory-bank-divergence-repair`：双侧记忆分叉修复流水线——先测行集包含关系再分档（纯滞后覆盖 / 真双向逐段合并 / 单边补齐）。

### Changed
- AGENTS.md 规则瘦身至 160 行：只压叙述与重复条款，阈值、命令与硬禁止词逐条保留。
- 新增「超过红线时按层级优先级把低优先级内容转成索引形式」条款：技能流程与记忆 → `rules/` 领域细则 → 本文件主题细则只压叙述。
- `rules-weekly-audit.js`：篇幅越线提示改为指向上述优先级处置，并新增 `MEMORY.md` 超 200 行检查（超限时客户端只加载部分索引且无提示）。

### 中文摘要
- 压缩 AGENTS.md 的叙述和重复条款至 160 行，并明确超出篇幅时按优先级转为索引的处理顺序。
- 周检增加 MEMORY.md 超过 200 行的告警，提示索引可能被截断。
- 新增注入上下文瘦身和双侧记忆分叉修复两个按需技能；本版共 125 个技能（12 常驻、113 按需）和 224 条目录条目。

### Contributors / 贡献者
- @liushikuan63

## [0.0.2] - 2026-10-28

### Fixed
- Make cleanup safety fixtures independent of copy timestamps and expose bounded failure diagnostics in CI without weakening cleanup protections.
- Reduce the recommended resident set to 12 entries without deleting skills; repair core/library resource lookup, zero-write previews, explicit migration scopes and index-failure reporting.
- Generate installable catalog source/install entries from the public package, not from private HOME configuration; validate schema before replacing registration.
- Validate tag, VERSION, catalog, manifest, counts and consumer behavior; build only approved committed files and independently verify ZIP contents.
- Compare existing remote assets by downloaded content instead of names, and retain drafts until both assets pass verification.
- Back up exact pending suggestion rows and verify updates before COMMIT; leave evolving, expired and unselected rows untouched.
- Preserve model/tool/author attribution and uncertainty in rewritten guidance; numeric or word-list checks do not establish semantic equivalence.
- Correct secret-scan false positives for versions, relative paths and Markdown names, while rejecting missing or empty scan inputs.

### Added
- Release workflow: pushing a `v*` tag runs a release gate, builds `Qoder-Optimization-<version>.zip` with a versioned top-level folder, writes a `.sha256` checksum, and attaches both to the GitHub Release.
- `CHANGELOG.md`, plus a download section and version table in `README.md`, so users can pick a version without cloning.

### Changed
- README rewritten for a flatter, claim-checkable tone (PR #1 from @YuneTech); the download section and version table are kept.
- Release assets are immutable: a published zip is never replaced, fixes ship as a new patch release.
- Package and asset names contain no spaces (`Qoder-Optimization-0.0.1.zip`, top-level folder `Qoder-Optimization-0.0.1/`), so GitHub does not rewrite the asset name.

### 中文摘要
- 完善 tag 触发门禁、版本化 ZIP、SHA-256 校验和远端按下载内容比对的发布链路，已发布附件不覆盖。
- 从公开树生成并校验 catalog，常驻技能降到 12 个但不删除技能，修复资源查找、预演、迁移范围和索引错误上报。
- 改进建议处理、敏感信息扫描和失败诊断，并保留 README 下载入口及版本表。
- 本版共 123 个技能（12 常驻、111 按需）和 222 条目录条目。

### Contributors / 贡献者
- @liushikuan63
- @YuneTech — README pull request / README 改写 PR 提交者。
- @Owsmyf — commit author (`Maverick`) / Git 提交作者。

## [0.0.1] - 2026-10-27

### Added
- First open-source release.
- 123 skills, split into a resident layer (always injected) and an on-demand library.
- 87 scripts: guardrails with self-tests, packaging and validation tooling, desktop-automation helpers.
- 10 slash commands, 2 sub-agents, 20 domain/process rule files.
- Hook wiring templates for 5 events and placeholder-only MCP configuration.
- De-identified memory export (`qoder-memory-export-generic.tar.gz`) and offline MCP assets.
- MIT license.

### 中文摘要
- 首次开源发布，采用 MIT 许可证，提供规则、按需技能、hooks、命令、脚本与 MCP 配置模板。
- 包含 123 个技能、87 个脚本、10 个指令、2 个子智能体和 20 份规则文件；技能分为常驻层与按需库。
- 随包提供脱敏记忆导出和离线 MCP 资产；安装从 README.md 和 README-安装说明.md 开始。

### Contributors / 贡献者
- @liushikuan63

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.0.7...HEAD
[0.0.7]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.7
[0.0.6]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.6
[0.0.5]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5
[0.0.4]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4
[0.0.3]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3
[0.0.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
