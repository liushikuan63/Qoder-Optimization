# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

## [0.0.6] - 2026-10-30

### Fixed
- Require native verification answers to follow the complete displayed proposal and record the proposal source message.
- Resolve i18next bindings by lexical scope in loops and switches, including `var` hoisting, without treating static-unknown text as translated.
- Invalidate convention receipts when a selected local check executable or its declared inputs change, while keeping receipt audits read-only.

### Changed
- Report verification benchmark results per development and holdout split and require the light holdout plan to meet the speed threshold independently.

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

## [0.0.3] - 2026-10-28

### Added
- `injected-context-slimming`：每轮注入文件（AGENTS.md / MEMORY.md）的无损瘦身流水线——量化 → 备份 → 只压叙述不删判据 → 覆盖断言 → 双侧同写验收。
- `memory-bank-divergence-repair`：双侧记忆分叉修复流水线——先测行集包含关系再分档（纯滞后覆盖 / 真双向逐段合并 / 单边补齐）。

### Changed
- AGENTS.md 规则瘦身至 160 行：只压叙述与重复条款，阈值、命令与硬禁止词逐条保留。
- 新增「超过红线时按层级优先级把低优先级内容转成索引形式」条款：技能流程与记忆 → `rules/` 领域细则 → 本文件主题细则只压叙述。
- `rules-weekly-audit.js`：篇幅越线提示改为指向上述优先级处置，并新增 `MEMORY.md` 超 200 行检查（超限时客户端只加载部分索引且无提示）。

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

## [0.0.1] - 2026-10-27

### Added
- First open-source release.
- 123 skills, split into a resident layer (always injected) and an on-demand library.
- 87 scripts: guardrails with self-tests, packaging and validation tooling, desktop-automation helpers.
- 10 slash commands, 2 sub-agents, 20 domain/process rule files.
- Hook wiring templates for 5 events and placeholder-only MCP configuration.
- De-identified memory export (`qoder-memory-export-generic.tar.gz`) and offline MCP assets.
- MIT license.

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.0.5...HEAD
[0.0.5]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5
[0.0.4]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4
[0.0.3]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3
[0.0.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
