# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

### Changed
- Add `pkg-diff review`: per-file text/wording diffs with `KEEP-LOCAL` / `TAKE-INBOUND` / `BOTH-CHANGED` / `NO-BASELINE` / `WHITESPACE` verdicts and a mandatory `MERGE_DECISIONS` list. Merge, release-sync and install-update workflows now require per-file merge choices (keep local / take inbound / manual merge / skip) instead of a single deploy question.
- Add a stop-gate check that blocks share-package updates or merges performed without a merge review and a per-file decision.
- Match inbound `skills/<name>` against the client's `skills-library/<name>` tier during review, so library-tier skills reach a per-file decision instead of being reported as new.
- Make the context-governor hook snapshot incremental: cache the transcript offset, sentinel and last usage in hook state, scan only appended bytes, and fall back to a full scan when the file shrinks or is rewritten. Enable pre-compaction usage hints with `{"inject":true}` in `<data-dir>/config.json` (env wins). Steady-state scans of a 22 MB transcript drop from ~2.0 s to ~0.13 s.

### Fixed
- Replace the compaction recovery pointer's nonexistent fold-handle instruction with the continuity archive and raw transcript routes, and state explicitly that no fold handle exists.

### 中文摘要
- 新增 `pkg-diff review`：逐文件文本/文案 diff、三路判定与 `MERGE_DECISIONS` 清单；合并、发布后同步现役与安装更新流程改为逐条询问（保留本地 / 采纳包内 / 手工合并 / 跳过），不再只问“是否部署”。
- stop-gate 新增门禁：未做合并审阅与逐条决策就更新/合并分享包会被拦截。
- 审阅时把包内 `skills/<name>` 自动映射到本机 `skills-library/<name>`，按需层技能不再被误报为新增。
- context-governor hook 快照改为增量（缓存偏移 / 哨兵 / 上次 usage，截断或重写回退全量），压缩前使用率提示用 `<data-dir>/config.json` 的 `{"inject":true}` 开启（env 优先）；22MB 会话稳态扫描由约 2.0 秒降至约 0.13 秒。
- 压缩恢复指针不再指向不存在的 fold 句柄，改为 continuity 档案与原始 transcript，并明说没有 fold 句柄。

## [0.1.0] - 2026-11-08

### Changed
- Ask once before creating a goal: the per-turn reminder and the session-budget handoff now offer a single opening confirmation for medium/large tasks (recommended), create a goal only on consent, and never re-prompt an existing goal or nag after a decline. Small tasks do not pop up.
- Route the `/skill-load` and `/pkg-find` command entry points through thin shells to the `skills-router` skill and its `references/route-commands.md`, so retrieval, asking and install/update criteria live in one place instead of being duplicated in each command.
- Sync the shareable rules document with the 5.7.0 live configuration (rule sedimentation, the hard-fact register, and the long-task and delivery workflow blocks) while preserving the curated release wording; the document generator no longer hardcodes a stale version header.

### Fixed
- Compare hook wiring by script identity in the weekly rule audit (command + args, base64 `run-package-hook` payload, and `powershell -File` forms), track `PostToolUse` among the five hook events, and report flag-only differences as INFO instead of false wiring drift.
- Ignore two-level sibling references in `skills-doctor` cross-reference lookups so a `../../<skill>/...` path is not mistaken for a dangling same-level reference.

### 中文摘要
- 目标模式改为开局问一次（推荐建、同意才建、已有目标不重复问、拒绝或取消不催问，小任务不弹窗）；`/skill-load` 与 `/pkg-find` 收口为薄壳，检索、询问与安装更新判据统一到 skills-router。
- 周检按脚本身份比对 hook 接线（含 PostToolUse 与 `powershell -File` 形态），仅 flag 差异降为 INFO；doctor 忽略两级同级引用，消除悬空误报；分享版规则同步 5.7.0 并保留人工策展措辞，生成器不再写死过期版本头。

## [0.0.30] - 2026-11-06

### Added
- Add the experimental `context-governor` CLI for measured usage reports, logical fold receipts with UTF-8 range hashes and protected ranges, scoped retrieval, handoff packs, pins, verification, pruning and on-demand load manifests. It never rewrites model requests and reports `physicalSavings=0` until an independent executor receipt exists.
- Add a fail-open hook adapter that defaults to zero injection, emits a bounded restore pointer after compaction, and remains unwired until explicitly approved.
- Generate an on-demand human-readable `SKILLS.md` navigation catalog alongside the machine index. Include the reviewed skill descriptions and Python visualization references.

### Fixed
- Generate self-contained context test fixtures in isolated temporary directories so installed tests, metadata generation and release builds succeed.
- Preserve complete UTF-8 characters during paged source retrieval, validate byte cursors, retain existing ledger references in fold previews, and honor `--record false` without writing a manifest.
- Publish skill navigation and the machine index together during fresh installation, upgrades, direct skill installation and tier changes; restore both views on failure and preserve concurrent edits.
- Preview existing WAL ledgers through a verified temporary copy, including committed WAL-only references, so SQLite never creates source-side WAL/SHM files; reject a changing source instead of claiming a valid preview.

### 中文摘要
- 上下文工具提供逻辑折叠、引用追回与交接证据；不改写模型请求，未取得独立物理执行回执时仍报告 `physicalSavings=0`。hook 默认未接线。
- 修复发布数据目录归属、中文与 emoji 分页恢复、只读预览及布尔开关；技能人读目录随安装事务保持一致。

## [0.0.29] - 2026-11-06

### Changed
- Route installed commands and core skills by description trigger cues, recognize both "触发词：" and "触发：", and rank installed commands as usable candidates.
- Restore 25 on-demand domain skills to the shipped library tier and give them object-level trigger cues plus "not for" routing, so MongoDB, Redis, Python, Spring, PostgreSQL, frontend/backend and game tasks reach the right entry point without per-turn injection.
- Add trigger markers to the `python-programmer`, `redis-core` and `office-docs` umbrella descriptions so absorbed sub-domain capabilities remain discoverable.
- Audit ambiguous requests before implementation and enforce the review gate when the answer changes scope, acceptance or authorization.
- Apply the reviewed local workflow improvements, including session-budget continuity and expanded design-system references.

### Fixed
- Treat an installed command as current during a package re-installation instead of asking to use it, so the complete profile can refresh without a false "no safe update baseline" error.
- Avoid secret-scan false positives in the inbound package diff selftest by constructing example private addresses at runtime and using bracket access for the local-root property.
- Isolate migration PowerShell modules in CI and retain bounded stage traces for failed stages.
- Refresh catalog, manifest, bilingual README highlights, skill inventory and download links for 0.0.29.

## [0.0.28] - 2026-11-06

### Changed
- Map the current Codex personal engineering methods to existing Qoder capabilities, installed entry points and explicit host prerequisites; keep runtime, account and private-state portability separate.
- Carry task-scoped tool discovery, error classification, one retry budget and read-back before retrying unknown writes into the installed workflow and prompt reminder. Preserve the existing authentication/attempt guards.
- Extend the existing verification workflow with behavior-to-delivery evidence, clean installation, incremental upgrades and independent installation checks. Add observable motion/theme methods to the existing browser skill.
- Correct CI diagnosis and cost guidance: zero steps, short jobs and missing logs are clues, not billing conclusions; use returned check-run identities, current evidence and current billing documentation.

### Fixed
- Replace nonexistent Windows runner promises with an installed, read-only argv comparison probe. Include it when selecting either Shell boundary skill; avoid universal quoting, path-conversion and encoding claims.
- Audit Unicode and nested local references, arbitrary resource extensions and recursive Markdown with cycle termination. Separate missing references from unreadable, changing or out-of-scope input, and keep executable examples and external links outside automatic scanning.

### 中文摘要
- 将 Codex 已验证的方法合入现有技能和安装工作流，并提供清晰能力承接图；不搬运宿主或私人状态。
- 两个 Windows 技能带入真实 argv 探针，引用审计覆盖中文、嵌套与递归；交付、CI判断及有界恢复同步纠偏。

## [0.0.27] - 2026-11-05

### Fixed
- Include required shared runtimes when installing first-party parallel, edit-attribution, self-evolution and routing skills. Keep optional maintenance and external services separate.
- Support explicitly binding an existing migrated skills library without relocating user data. Check the client, tier link, physical target and binding file identity across discovery, comparison, loading, installation and recovery; keep unbound and nested links unreadable.
- Read skill entries through verified file descriptors and reject root or content changes before returning results. Quarantine ambiguous bound-tier names before reading descriptions while keeping unrelated capabilities available.
- Keep external library backups on their own filesystem, bind transaction directory identities, restore owned partial binding writes, and detect revoked grants before staging or publishing. Preserve concurrent changes and all recovery material.
- Require an approved matching index-builder graph for direct catalog installation into bound libraries. Keep unsupported cross-volume tier moves explicitly blocked.
- Keep MCP values and private hook arguments out of carrier preflight output; expose an explicit client-root argument. Include the new resolver in the generic memory archive and exclude machine-specific binding receipts from distribution.

### 中文摘要
- 修复“技能装了但必要脚本没装”，明确选装并行后可执行真实 worktree 写入工具；核心补齐备份/载体预检。
- 原有 D 盘按需库可显式绑定，保留布局和定制；撤销、换目录、同名、跨卷失败与写盘故障均有明确拒绝或恢复路径，不将跳过整库当成缺失。

## [0.0.26] - 2026-11-05

### Added
- Ship a complete portable workflow profile: twelve public core skills, three managed rule sections, checkpoint/fact commands, dependency closure and sixteen exec hooks across five native events.
- Default fresh clients to complete; preserve existing routing choices, explicit workflow modes, local skill tiers and unrelated settings. Offer explicit complete upgrades and read-only installation health checks.
- Keep personal text outside managed rule sections; review locally changed managed sections and hook conflicts before publishing. Use existing transactional backups and rollback for all profile metadata.

### Fixed
- Bind every managed hook to its selected client with a bounded whitelist launcher and structured exec arguments. Preserve async stdin consumers, child exit-2 blocking and UTF-8 payloads.
- Check every declared hook including task routing, managed rule receipts, disabled hooks and required installed files. Keep portable startup checks independent of private memory and another client.
- Limit session transcript fallback to the selected client; never consume another CN client's same-session transcript.
- Retain an observed higher stable Latest when release listing pages lag.

### 中文摘要
- 分享包从“有文件/单路由”补齐为可独立安装的通用工作流；旧安装可显式增量升级，私人 BYOK、凭据和记忆不分发。
- 本地定制、旧来源不明和冲突仍先审阅；文件健康、原生引擎事件、fixture 模型和真实业务验收分别记录，不把安装成功等同模型自动采用。

## [0.0.25] - 2026-11-05

### Changed
- New installs now select `--workflow-mode model` for `rules-reminder.js`; existing route/model selections are preserved on upgrade. The installer accepts an explicit `--workflow-mode route|model` to switch an existing selection, so upgrades can ask before changing it. The route fallback recognizes common colloquial execution verbs (such as 修一下, 重写, 调成, 生成, 导出) while keeping read-only, trivial and continuation turns quiet.

### Fixed
- Honor polite, spaced and quantified read-only or workflow refusals. Preserve already supplied mandatory verification checks before question, continuation and low-evidence returns; structured advice never grants execution authority.
- Emit the real Node executable and argument array for workflow decisions, plus correctly quoted PowerShell/POSIX commands; handle client paths with spaces, quotes and dollar signs.
- Reinstall through an alias of the same physical client without treating it as a foreign hook scope; retain rejection of different scripts and clients.
- Bind effective Git configuration origins and per-worktree config identity before and after dirty checks. Reject redirected working directories and configuration drift without discarding files.
- Register new worktrees without checkout, validate their actual identity/configuration, then disable conditional executable drivers before materialization. Existing receipts missing configuration bindings fail explicitly and retain recovery material.

### Release integrity
- Resolve the event or requested tag to one immutable commit for Windows, Linux and build; refuse tag drift before building.
- Serialize publication across versions with a bounded pending queue. Publish without automatically taking Latest, then reconcile the highest published stable numeric version with a finite readback budget; retain verified assets if external drift does not settle.
- Refresh the catalog dependency closure for model workflow assessment.

### 中文摘要
- 新装默认使用 model 模式，已有 route/model 选择保留；安装器新增 `--workflow-mode route|model` 显式切换，升级后可先询问再改；route 回退补齐口语执行动词，只读、琐碎与续接轮仍不触发。

- 只读/拒绝边界及早返回验证清单已补齐；裁定命令提供真实 Node argv 和正确的本机 shell 引用。
- 同物理客户端别名重装保持幂等，其他客户端与错误脚本继续拒绝。
- Git 校验绑定每工作树及条件配置，阻止重定向隐藏脏文件和首次检出执行条件过滤器；旧无绑定回执明确拒绝并保留现场。
- Windows、Linux 和构建统一固定提交，跨版本发布排队并按最高稳定版本核对 Latest，避免晚完成的旧版降级指针。

## [0.0.24] - 2026-11-04

### Fixed
- Preserve explicit current skill selections even when previous advice is disabled or excluded, prioritize named local skills before truncating candidates, and respect time-prefixed refusals. Ignore linked local skill entries and derive usage tier suggestions from current unambiguous directories.
- Treat resident-choice metadata as part of the catalog install transaction: malformed state, failed publication and concurrent changes return failure with rollback. Reject linked tier parents before installation, migration and rollback; skip linked or non-regular entries before reading skill descriptions.
- Canonicalize Windows checkout aliases consistently for approved checker inputs and parallel worktree identities. Keep Linux ownership checks case-sensitive and reject backslash filenames that cannot be safely represented by a plan path.
- Redact complete quoted credential values containing whitespace or escaped quotes before publishing parallel context.
- Traverse complete skill reference chains, terminate cycles, and reject empty/missing roots, malformed CLI options and references resolved outside the distributed package.

### Verification and delivery
- Run Windows CI fixtures in the runner's non-system temporary directory; keep backup fixtures independent of desktop recycle-bin services while preserving production recycle behavior.
- Retain the existing v0.0.23 tag and its failed CI evidence; publish these fixes under a new version after Windows/Linux regression and independent installed-package verification.

### 中文摘要
- 显式能力选择优先于旧关闭/排除偏好；本次、这次、暂时等拒绝生效，使用统计按当前实际层级给建议。
- 常驻清单纳入安装事务，失败不再假成功；拒绝 linked 层级目录越界写入，读取技能说明前检查链接边界。
- 修复 Windows 短路径身份误判、Linux 大小写/反斜杠路径越权，以及含空格或转义引号的凭据漏脱敏。
- 引用校验完整遍历并拒绝空包、错误参数及包外依赖；Windows CI 临时目录与备份夹具适配实际 runner。

## [0.0.23] - 2026-11-04

### Package integrity
- Add `skill-reference-integrity.cjs`: scan every `SKILL.md` and transitively referenced Markdown for `references/` and `scripts/` paths, ignore code fences and HTML comments, and fail with exit 2 on unresolved references. Two documented cross-skill refs are allowlisted with reasons.
- Restore 194 referenced skill files from the live skill sources, including minigame references/scripts, Spring and frontend references, and senior-devops assets; repair malformed relative paths and add the three missing miniprogram protocol documents.
- Add a CI reference-integrity gate and validate the package on every pull request.

### Installer and hooks
- Enforce Node.js 24.16+ in `install-package.cjs` before any write, with a clear upgrade message; unify the documented requirement and keep the MCP installer's Node 18+ exception explicit.
- Document every template hook script with its catalog install ID and command, and make `global-config-guard` report hook wiring that points at a script missing from the client.

### Release gates
- Let `share-package-verify` run as a CI gate and keep `check-release.js` from treating the repository root as a release asset directory.
- Add a Windows CI job running the full isolated test suite, add `pull_request` triggers, set a 45-minute timeout, and cache npm.

### Skills
- Remove the exact duplicate trigger phrase shared by six Spring skills so routing can distinguish architecture, AOP, Resilience4j, test patterns, events, and verification.

### Windows compatibility
- Canonicalize project roots and run/output paths in the trusted checker and parallel-write so Windows short (8.3) temp paths resolve to the same location as Git's long paths; include the extracted catalog helper in test sandboxes.
- Skip the recycle-bin hop in CI and point the Windows job at the runner's non-system temp drive, so backup and CUA installation tests exercise real behavior instead of failing on runner layout.

### Maintainability and docs
- Extract `stripQuoted` into `stop-gate-text.js`, redaction into `parallel-context-redact.cjs`, and catalog scoring into `pkg-catalog-score.cjs`, each with unit tests; parent behavior is unchanged.
- Harden the CUA cursor guard to pass driver arguments as argv instead of a shell string, with test-only stubs gated by `CUA_GUARD_TEST_STUBS`.
- Make `pack-share-docs.cjs` accept `--home` and cover it with positive and negative tests.
- Add a heading table of contents to the rules document; correct the platform badge to Windows 10/11 (primary); state the shipped status counts in `INDEX.md`; emit a machine-readable `statusLegend` in `catalog.json`.

### 中文摘要
- 新增技能引用完整性校验器并补齐 194 个断链文件与 3 篇缺失协议文档，CI 与 PR 均执行校验。
- 安装器在写盘前强制 Node.js 24.16+；hooks 增加脚本安装对照表与接线缺失检查。
- 发布门禁接入包校验，`check-release` 拒绝把仓库根当资产目录；新增 Windows 全量测试任务。
- 六个 Spring 技能的重复触发词已去重；三个大脚本拆出公共模块并补单测；CUA 守卫改用 argv 传参。
- 规则文档增加目录，平台徽章、索引状态计数与 catalog 状态说明已校准。

## [0.0.22] - 2026-11-04

### Capability installation
- Ask during interactive skill installation whether the selected skill should be resident; the default remains on-demand, and non-interactive installs must pass `--tier core|library`. The final resident count is a per-user usage decision rather than a fixed package constant.
- Add `tier-skills --promote/--demote` for adjusting resident status after real usage; both preview by default, persist explicit choices in `<client>/skills-resident.json`, and rebuild the index only with `--apply`. `--keep` and `--restore-all` remain one-off operations, so package upgrades do not reset the user's resident set.
- Record skills installed directly into the resident tier (`pkg-catalog install --tier core` and `install-package --resident`) in `<client>/skills-resident.json`, so a later default tiering pass does not silently demote them.
- Add `skill-usage.cjs` for local usage records and tier suggestions: `/skill-load --record` logs a search demand, explicit `log` records actual use, and `suggest` recommends promotion after repeated use or demotion after 90 idle days for user-promoted skills. Package CORE defaults are never suggested for demotion, and no tier changes are applied without user confirmation. Only skill names, timestamps and sources are stored.
- Discover relevant on-demand skills from live skill tiers even when no package is registered; local and package candidates merge, while explicit use, refusal and exclusion still win. Read-only AUTO_LOAD directives require a real entry read and are not permanently deduped by delivered markers.
- Install `build-skills-index.cjs` together with `capability-advisor.cjs`, because live skill discovery requires the local index builder.

### Parallel planning and recall
- Require a plan document before parallel dispatch and a decision before run initialization.
- Add a real recall command that discovers memory through the client root instead of a protocol-only description.
- Surface installed on-demand skills as ASK_USE candidates while registered package capabilities keep their existing behavior.
- Install the parallel plan and context scripts with the base package, and exclude `.bak` process files from packages and the repository.
- Add package regression tests and a working-tree consumer probe.

### Fixed
- Stage unchanged sibling modules for staged script updates, so an upgrade that changes both a skill and the index builder rebuilds the staged index instead of rolling back.
- Treat `别用 X` and `不要用 X` as explicit refusals during capability routing instead of auto-loading the named skill.
- Redact full-width credential separators and non-HTTP URL userinfo in recall context, and report them as sensitive content.

### 中文摘要
- 常驻技能改为按使用习惯确认并持久化，新增使用记录与晋升/降级建议；按需技能不依赖注册包也能从本地技能库自动发现并以只读方式加载。
- 并行派发前必须先有计划文档，运行前必须有明确决定；新增真实召回命令，基础包随装并行计划与上下文脚本。
- 随包能力声明本地技能索引依赖，确保安装后自动发现链路完整。

## [0.0.21] - 2026-11-03

### Capability installation and task use
- Add a package installation entry that inspects existing/missing capabilities, updates only copies proven unchanged against the previously registered package, and preserves local modifications for review.
- Suggest missing general or explicitly preferred capabilities for user selection; skip unrelated specialized entries. Optional capabilities are never all accepted by a generic `--yes`.
- Install the routing dependency closure and merge its UserPromptSubmit wiring so relevant installed capabilities actively prompt for task use. Explicit current requests route directly without repeated questions; per-session reminders are bounded and do not imply approval or native-host acceptance.
- Include required dependencies in explicit capability selections even when advice is disabled. Bind custom clients in the hook command itself; legacy two-argument wiring upgrades without depending on inherited QODER_HOME.
- Keep SQLite continuity opt-in independent from capability activation. Explicit preference sources, transactional installation, recovery and unchanged legacy-client behavior remain part of acceptance.

### Added
- Auto-bind continuity sessions on supported machines: when the installer is accepted and the host provides Node.js 24.16+ with `node:sqlite` and FTS5, it writes `<store>/auto-bind.json` (`{"schema":1,"enabled":true}`) so each new session binds on its first hook with task `AUTO-<date>-<dir>`. An explicit per-session `disable` is never reopened; `--no-auto-bind` keeps the original manual `enable` flow, and unsupported hosts fall back to the same manual flow after offering a Node.js install.
- Add a portable continuity store default: `CONTINUITY_STORE` wins, then `D:/qoder-data/context-continuity` on Windows when a `D:` drive exists, otherwise `~/.qoder/context-continuity`.

### Parallel write execution
- Add `parallel-write.cjs prepare/verify`: create locked per-unit Git worktrees from a clean, recorded baseline; check real registration, branches, every linear commit, both rename endpoints, dirty state and shared Git drift, then preview integration with Git merge-tree. No automatic branch merge or project-code execution.
- Check same-wave read/write ownership conflicts; dependent write waves must start from the newly integrated baseline. Isolate Git environment and executable hooks/filters/drivers while inspecting and preparing worktrees.
- Add all-or-nothing `merge-batch` for same-version worker results, canonical writer locks, snapshot checks and recoverable publication. Reject pack outputs that alias canonical files or locks. Context inputs and conflicted worktrees are retained.

### Fixed
- Preserve first-use session disables and serialize continuity scope changes; reject ambiguous CLI paths. Publish continuity scripts, settings and auto-bind policy without overwriting concurrent edits, retaining recovery copies when ownership changes.
- Reject absolute/overlapping parallel ownership paths and duplicate dependencies. Bind worker deltas to both context version and plan digest; check canonical scope, mirrors and packs against the plan, and reject sensitive results before writing.
- Distinguish explicit goal/verification requests from quotations, advice and refusals. Keep carrier reminders active for small or Git-tracked files; require qualified task/session evidence for evolution candidates, and treat failed release commands as failures.
- Validate catalog arguments before writes, compare every installed skill tier, and report unavailable package comparisons as `DRIFT_UNVERIFIED` rather than equality.
- Do not attribute aggregate build/test/deploy results to an arbitrary target. Combined database output cannot clear failures; authentication errors are attributed only when their reported identity selects one target unambiguously.
- Correct the offline Cua license checksum to match its distributed LF bytes, and verify every offline payload/license checksum in the release gate. Independent actual-ZIP acceptance caught the earlier CRLF-based checksum before publication; historical releases remain unchanged.

### Compatibility and recovery
- Worker deltas now require `planDigest`; older deltas must be regenerated from the current context pack. Catalog `drift` exits 2 when installed content cannot be compared with its package source.
- Historical release assets, live client configuration, real user data and external services are unchanged. Native Qoder/UI behavior and the separate B05 pilot remain outside this isolated CLI/package acceptance.

### 中文摘要
- 同步最新代码中的可选自动绑定模式，修复首次关闭被重新开启及安装并发覆盖；保护用户选择与恢复资料。
- 收紧并行路径所有权、计划摘要、上下文范围和敏感结果校验，防止跨计划合并或互斥失效。
- 修复规则误触发、证据不足的候选晋升、发布失败误判，以及目录比对假一致和复合命令串账。

### Verification
- Continuity/installer focused regression: 45 pass / 0 fail. Parallel coordination focused regression: 55 pass / 0 fail. Actual Git worktree regressions cover independent commits, out-of-scope changes, branch/base drift and executable Git driver suppression; full cross-platform gates and fixed-commit package acceptance are required before publication.

## [0.0.20] - 2026-11-03

### Added
- Add deterministic parallel-plan validation (`scripts/parallel-plan.cjs`) with dependency waves, hard gates, write isolation, path ownership and machine-readable verdicts.
- Add shared context and recall tooling (`scripts/parallel-context.cjs`): coordinator-owned canonical context, bounded/redacted memory packs, versioned worker deltas and stale-pack checks.
- Add the `parallel-orchestration` skill and four-layer vibecoding docs. Parallelizable plans must be shown to the user for approval before dispatch; write parallelism needs a separate explicit opt-in plus worktree isolation and disjoint `ownedPaths`.
- Sync the parallel orchestration rule to global and share-rule docs, and ignore `.qoder/parallel-runs/` runtime records.

### Verification
- `parallel-plan` and `parallel-context` suites: 26 pass / 0 fail; fixtures cover parallel-read, same-file rejection and production/database hard gates.
- Full regression: 380 pass / 0 fail; documentation, sensitive scan and package metadata checks pass; package catalog has 267 entries.
- Installed skill and scripts verified locally: `skill-load` resolves the skill and the installed copies pass the same 26 tests.

## [0.0.19] - 2026-11-03

### Added
- Integrate the B05 auto-trigger into `rules-reminder.js` (backed by `verification-trigger-core.js`): actionable tasks automatically receive the four-step policy/selection instruction, with a kill switch and a decision ledger. It is advisory-only while the host lacks `resolveAuthority`; it never calls the authority-bound session functions or claims the T-07 native pilot passed.
- Restore the missing `goal-candidate-core.js` and merge the live goal-candidate reminder into `rules-reminder.js`, keeping package and live behavior aligned without adding a seventh UserPromptSubmit hook.
- Refine the B05 trigger so request-style questions ("是否可以…/能否帮我…") count as tasks while advice and status questions ("是否应该…/是否已经部署…") stay silent.
- Add `stop-gate` rules R10/R11: install/update `NEXT_ACTION` output must be followed by an explicit user choice, and a successful release command must be followed by an explicit deploy question.
- Extend `edit-guard` to remind about `carrier-preflight` when creating or overwriting skills, rules, memory, hooks, agents, commands, or hook-named scripts.

### Verification
- B05 trigger tests 14/14 (5 core + 9 in `rules-reminder`); `rules-reminder` 45/45; `stop-gate` 336/336; `edit-guard` 19/19; live hook positive/negative probes exit 0.

## [0.0.18] - 2026-11-03

### Fixed
- Audit all increments in the five published releases 0.0.13–0.0.17 against opt-in installation, authorization, recovery and evidence boundaries.
- Validate complete continuity hook commands, matchers, types and timeouts before writing; preserve conflicting wiring for review. Prepare backups before publication and roll back only an unchanged installer-owned script if settings publication fails. Include `continuity.cjs` in the catalog installer's dependency closure.
- Respect Bash `dir_path` in retry scopes and inspect every recognized target before compound commands, without changing budgets or clearing locked targets. Aggregate tool results still do not establish individual command outcomes.
- Prevent explicit tool errors and nonzero exits from using row-shaped output to reset authentication failures; preserve query-row false-positive controls.
- Group evolution records by topic and scope, count qualified independent tasks and sessions instead of raw record totals, and exclude external or unverified local evidence from global promotion. Explicit user preferences retain their original scope; reports remain candidates, not authorization.
- Restore full, hash-verified data before converting a junction back to a real directory. Remove host-worker patching from panel forensics, require manual live-process maintenance, limit wrong-key controls to safe test credentials, and route temporary debugging facts away from lasting memory.
- Apply per-test timeouts to serialized release contracts instead of truncating aggregated suites at nine minutes. Timeouts, crashes and failed checks still fail the release gate.

### Compatibility and recovery
- Historical releases and assets remain immutable. No live client configuration, production credentials or user data migration is changed by this release.
- Coverage is local isolated CLI/runtime testing, static guidance contracts and fixed-commit package acceptance; it does not establish native host/UI behavior, production service acceptance or the separately incomplete B05 pilot.

### 中文摘要
- 复核 0.0.13–0.0.17 全部增量，修复接续安装的接线误判、失败回滚与目录依赖缺失。
- 修复 Bash 目录作用域与复合调用后续目标漏检、显式错误借 rows 输出清零认证失败、候选记录重复/外部来源/范围混合导致的错误晋升。
- 修复反向迁移空目录丢入口、修改宿主取证、现役停机、真实账号负控及临时事实入长期记忆五处规则冲突。
- 完整测试按单项限时，不以整套九分钟上限截断后续文件；失败仍阻止发布。旧版资产与现役配置保持不变。

## [0.0.17] - 2026-11-03

### Added
- Add an optional install-time continuity setup. `install.cmd` detects Node.js, asks whether to enable the SQLite/FTS5 continuity memory and recovery mode, and wires the five hooks into the selected client. When Node.js is missing, it offers a winget install or portable download guidance.
- Ship `scripts/continuity.cjs`, a per-session SQLite + FTS5 archive with automatic migration from the earlier JSON record format; CLI and hook behavior remain compatible.
- Add isolated installer tests for dry-run, idempotent hook merging, malformed settings, and non-interactive skip.

### Changed
- Ask before installing or updating on-demand package entries. `pkg-catalog.cjs search/list/drift` now compares package and local content and emits `NEXT_ACTION`; `skill-load` checks installed skills against the registered package. `/pkg-find`, `/skill-load`, and `skills-router` require an explicit `AskUserQuestion` choice before any write, and release/deployment asks include the drift list.

### Fixed
- Serialize the contract test suite with `--test-concurrency=1` so wall-clock guard checks are not starved by parallel test files.

### Compatibility and recovery
- The installer preserves existing hooks, skips duplicate continuity wiring, backs up before changing files, and writes nothing in `--dry-run`. Collection still requires an explicit per-session `enable`.

### 中文摘要
- 新增安装时可选的接续模式：`install.cmd` 检测 Node.js，询问是否启用 SQLite/FTS5 记忆与追回，并把 5 个 hooks 接入所选客户端；未检测到 Node.js 时提供 winget 安装或便携版指引。
- 随包提供 `scripts/continuity.cjs`：每会话 SQLite + FTS5 档案，旧 JSON 记录首次读取时自动迁移；CLI 与 hook 行为保持兼容。
- 安装器保留既有 hooks、不重复接线、改前备份；`--dry-run` 不写盘；采集仍需按会话显式 `enable`。
- 按需条目安装/更新前必须询问：检索输出 `NEXT_ACTION`，`skill-load` 也比对已安装技能；发布/部署询问包含 drift 清单。
- 契约测试改为串行执行，避免并行测试压垮 wall-clock 守卫断言。

## [0.0.16] - 2026-11-02

### Added
- Add a per-turn self-evolution capture reminder plus a targeted note for long-term preferences, explicit persistence requests, and repeated corrections. Single-task constraints, ordinary requests, meta questions, and rule quotations do not trigger it.
- Add `evolution-candidates.cjs`, a read-only scan over memory feedback, stop-gate violations, and evolution records. It classifies candidates as `promote-global`, `promote-local`, `observe`, or `covered` and writes Markdown + JSON reports. Reports are candidates only and never change rules, skills, hooks, permissions, or approval boundaries.

### Compatibility and recovery
- The new reminder adds one static line to every prompt injection; non-triggering turns keep the rest of the output byte-identical to the previous release. The scan is read-only by default and writes only under `evolution/candidates/` with `--write`.
- Tests run with an isolated client root; no live client configuration or user data is modified.

### 中文摘要
- 新增每轮自进化采集提醒，并对长期偏好、明确沉淀和重复纠正追加针对性提示；单次约束、普通请求、教学式提及和引用规则原文不触发。
- 新增 `evolution-candidates.cjs`：只读汇总记忆 feedback、门禁违规台账与进化记录，输出四类候选报告；报告不自动修改规则、技能、hook、权限或审批边界。

### Contributors / 贡献者
- @liushikuan63

## [0.0.15] - 2026-11-01

### Fixed
- Classify retry budgets by the executed program and its operation, without treating command-like argument text as test/build evidence. Exclude Node help/version queries, including equals-sign forms, and keep remote invocations with different destinations in separate budgets.
- Reject missing or flag-shaped handoff/import target arguments before selecting a default or writing files.
- Decode BOM-marked UTF-16LE/BE during credential scanning and report truncated encodings. Limit environment-expression exemptions to unquoted values; nearby comments and markup cannot exempt literal credentials.
- Stage memory imports and track file identity plus confirmed writes during rollback. Preserve concurrent edits/replacements and complete staged input with a recovery receipt instead of deleting another writer's data.
- Build skill indexes in staging and publish with identity/content checks and exclusive creation. Failed installation no longer overwrites or removes a concurrently changed index.
- Validate MCP hook structure and complete Cua guard commands before installation or configuration writes. Preserve conflicting wiring for review instead of declaring it correctly connected.
- Repair fail-streak installer self-tests to load the complete dependency closure, isolate the client root and require real subprocess success with no crash log.
- Make memory synchronization report copy failures and verify copied bytes; return nonzero when data migration or its read-back probe fails. Before copying, reject destination links (including existing ancestors and nested links) and conflicting destination data; reuse a nonempty destination only when its full file proof already matches. Verify relative paths and streaming SHA256 before cutover; bind rollback to its receipt, backup, actual junction destination and an unchanged destination tree while the client is stopped.
- Make memory-sync self-tests select their actual repository/installed companions, use disposable clients on both Windows and Linux, and reject a nonzero guard exit even when stdout is empty.
- Reject links and output paths inside the input tree in the generic ZIP packer, and clamp implicit filesystem timestamps to ZIP's supported date range. Explicit invalid reproducibility timestamps still fail.
- Serialize manual completion and tag-triggered publication of the same release under one concurrency group.

### Compatibility and recovery
- Build/test directory scopes remain compatible with 0.0.14. Remote invocation keys now include their full arguments except known verbosity flags; older remote keys are retained without migration because their destination provenance was incomplete.
- A rollback conflict intentionally leaves the changed target and recovery material in place and reports failure. Resolve the recorded conflict before retrying; a failure is not reported as a clean rollback.
- Legacy migrations without a receipt require manual recovery review. If destination data has changed since migration, automatic Undo keeps the junction and asks for reconciliation instead of activating a stale backup. No user data migration is executed as part of release acceptance.
- Tests and package acceptance use isolated clients. Native Qoder routing/UI, real external accounts/services, Cua installation/autostart and the separately incomplete B05 acceptance remain unverified.

### 中文摘要
- 修复命令参数污染连败类别、帮助/版本查询误计数和远端目标串账；拒绝交接/导入命令的缺值参数。
- 敏感扫描支持明确 BOM 的 UTF-16 文本，并收窄环境表达式豁免，防止邻近注释或标记掩盖明文。
- 记忆导入和技能索引采用暂存与归属核对；失败回滚保留并发变更及恢复资料，不覆盖其他写入者。
- 修复 MCP hook 结构/完整接线误判、fail-streak 自检依赖缺失，以及同步/迁移失败仍返回成功的问题。
- 修复通用 ZIP 打包器的链接、输出目录与时间范围边界；同一标签的手动与推送发布统一串行。

### Contributors / 贡献者
- @liushikuan63

## [0.0.14] - 2026-11-01

### Fixed
- Scope build, test and deployment retry budgets by working directory and explicit workspace selectors. Equivalent tool cwd, `cd` and package-manager directory options share a budget; separate projects do not. Quoted build commands in `echo` or `rg` no longer consume retries.
- Validate fail-streak installer arguments before inspecting targets. Reject missing values, unknown flags and invalid timeouts instead of falling back to a default client directory. Existing hook wiring is considered equivalent only when the hook type, complete Node/guard command, matcher and timeout match.
- Resolve relative handoff entry paths against the queue file's directory, including when `--file` itself is relative; check Unix absolute paths as well.
- Use each credential assignment's own offset and captured value during distribution scanning, preserving `=` characters. Scan legitimate directory names containing `backups`, `node_modules` or a `.git` suffix; exclude only the exact reserved directory names.

### Compatibility and limits
- Legacy retry keys lack project provenance and remain in state without matching new scoped calls. Mixed historical counts cannot be assigned safely to a project, so they are not migrated.
- Retry command parsing covers direct commands, quoting, separators, directory changes and explicit target options; variable expansion, shell functions and complete shell control flow are outside its coverage.
- No live client configuration is changed. Isolated installation and regression evidence does not establish native Qoder routing, external-account/service behavior or the separately incomplete B05 acceptance.

### 中文摘要
- 修复跨项目与 workspace 连败计数串账；同一目标的等价目录写法仍累计，`echo` / `rg` 引用构建命令不再消耗失败预算。
- 修复安装器漏参数时回落默认目录的问题；严格核对 hook 类型、完整 Node/守卫命令、matcher 与 timeout，拒绝把错误解释器或 `--clear ALL` 误判为正确接线。
- 交接队列相对入口改按队列所在目录检查，并补查 Unix 绝对路径。
- 修复敏感扫描重复文本上下文串用、含 `=` 值漏检及合法目录名被误跳过的问题。
- 旧版无项目归属的计数不迁移；本轮不改现役配置，也不将隔离测试等同于原生宿主、真实服务或 B05 完整验收。

### Contributors / 贡献者
- @liushikuan63

## [0.0.13] - 2026-11-01

### Added
- Add seven on-demand skills for recurring delivery and triage work: share-package release and live sync, local reverse-proxy change verification, OAuth/SSO login triage, proxy rule surgery, SVG/CSS scene animation, AI-client network triage, and counterexample-driven plan review.
- Extend existing skills with release evidence binding, streaming/chunked UTF-8 acceptance, dual-client rollout and parity, BYOK provider/credential/cap checks, desktop update ACL diagnosis, junction-to-directory replacement, minified-bundle probes, prompt-triggered hook rollout, description route-cue branches, and memory-divergence handling.
- Restore companion scripts and references for Electron tray/asar forensics, CUA guardrails, and BYOK CN onboarding/dual-client config sync.

### Fixed
- Remove dangling skill references and point process ownership/stop-start guidance at `local-reverse-proxy-triage`.
- Correct share-package release script paths to `.github/build-release.js`, `.github/verify-delivery.js`, and `.github/run-tests.js`.
- Keep the packaged rule-document reference valid where the source `rules/` directory is not shipped, and preserve the repository's newer recheck and memory-update authorization guidance during the merge.

### Validation
- Isolated Linux suite (Node 24.16): all four checks exit 0, 214/214 contracts. Windows-only MCP/Cua fixtures that place the Cua install directory on the system drive fail identically on clean HEAD and are not caused by this change.
- Windows local: all non-MCP/Cua suites pass; skills-doctor CLEAN, trigger overlap 0 among changed carriers, and all seven new skills route first on generic and product-specific queries.
- The tag workflow regenerates and verifies the committed package, scans the actual distribution, and compares remote assets byte-for-byte before publishing.

### 中文摘要
- 新增 7 个按需技能：分享包发布与现役同步、本机反代改动验证、OAuth/SSO 登录排查、分流规则手术、SVG/CSS 场景动画、客户端网络排查、反例驱动方案审查。
- 扩展 15 个既有技能：发布证据绑定、流式分块 UTF-8 验收、双客户端上线 parity、BYOK provider/凭据/上限检查、桌面更新 ACL、junction 反向替换、混淆 bundle 探针、提示词触发 hook、描述路由线索分支、记忆真分叉处理。
- 修复悬空技能引用、发布脚本路径与分享包内不存在的 `rules/` 路径；保留仓库较新的 recheck 与记忆更新授权口径。
- 验证：Linux 隔离套件 4 项检查全退出 0、214/214 契约通过；Windows 本地除 3 个既有 MCP/Cua 夹具外全绿，`skills-doctor` CLEAN、触发重叠 0、新技能路由第一命中。

### Contributors / 贡献者
- @liushikuan63

## [0.0.12] - 2026-11-01

### Added
- Restore 108 verified companion references and scripts for 19 shipped skills, with per-file source, license and sensitive-content receipts.
- Add boundary regressions for MCP installation, authentication locking, fail-streak wiring, archive purge, release dispatch and catalog source integrity.

### Fixed
- Harden MCP installation: preserve malformed configuration, scope skip/preview, verify dbhub tgz integrity, call npm without a shell, require a non-system-drive empty Cua directory, verify archive entry/version, and fail without writing settings. Cua offline/online preview now reports platform limits on non-Windows hosts while actual installation still requires Windows x64.
- Harden authentication locking: merge aliases and counts across MCP/shell, keep blocked entries until manual clear, ignore quoted or documented commands, avoid mistaking query rows for authentication errors, avoid storing password text, and require an explicit clear target.
- Isolate crash-guard self-tests and fail-streak installer verification; validate hook entries, quote command paths, require verified backups, clean temporary files, and stop on first failure.
- Protect archive purge from copied manifests and failed restores; fix `cua-wait` read-only `$PID`, migration undo drive coverage and the phantom `-Cleanup` hint.
- Tighten skill guidance on UAC denial, service restarts, memory writes, TLS downloads, runner process stops, RabbitMQ retries, forensic pristine claims, mtime-based ownership, Office copying and suggestion deduplication.
- Make release dispatch test the selected tag, enumerate contract tests, and verify shipped catalog sources and dependency IDs.

### Validation
- Full isolated suite: 38/38 suites, 214/214 contracts, 487 source files unchanged; syntax checks cover 171 JS/JSON/Shell and 10 PowerShell + 7 Python/TOML files; metadata regenerated with zero drift; release package CLEAN and secret scan 0 hits.

### 中文摘要
- 补齐 19 个技能中 108 个已核实来源与许可的配套文件，并逐文件记录来源、许可和敏感内容检查回执。
- 修复 MCP 安装、认证锁库、fail-streak 安装器、崩溃守卫自测、归档清理、迁移脚本和发布门禁的边界问题；非 Windows 主机上的 Cua 预览只提示平台限制，实际安装仍要求 Windows x64。
- 收紧提权/UAC、服务重启、记忆写入、TLS 下载、Runner 进程停止、RabbitMQ 重试、Electron 取证、mtime 归属、Office 复制和建议去重等技能指引。
- 全量隔离回归 38/38 套件、214/214 契约、487 文件指纹一致；语法、元数据、发布包结构和敏感扫描均通过。

### Contributors / 贡献者
- @liushikuan63

## [0.0.10] - 2026-10-31

### Added
- Add a RECHECK protocol for renewed evidence gathering, independent methods, explicit verification gaps and coverage-based convergence.
- Append bounded recheck guidance to supported repeated-check or review requests and challenges to a previous success report, while leaving ordinary reminder output unchanged.

### Fixed
- Distinguish real recheck requests from negations, definitions, examples, quoted text and code blocks; preserve questions about the outcome being checked and require a current failure before treating an ordinary contrast as a dispute.
- Decode UTF-8 input across stream chunks so Chinese requests and their echoed text survive byte splits in both `prompt` and `user_prompt`.
- Preserve existing same-scope authorization instead of requesting duplicate approval during an authorized repair loop.

### Scope
- Request detection and hook output are testable mechanics, not proof that a model performed the requested review or that all natural-language forms are recognized.
- No live client configuration or permissions are changed. B05 remains independently incomplete and still requires real native interactions and screenshots.

### 中文摘要
- 新增 RECHECK 复核协议：重新取证、不同盲区的方法交叉核对、明确未验证项，并按覆盖范围收敛。
- 对支持的再次检查、循环审查及旧成功结论质疑追加协议摘要；普通轮保持原有提醒输出。
- 区分真实复核请求与否定、定义、例句、引文、代码块，保留对待验结果的疑问，并要求实际失败才能把普通转折判为质疑。
- 修复标准输入按字节分块时中文被破坏的问题，覆盖 `prompt` 和 `user_prompt`，同时保持请求摘要完整。
- 已有同范围修复授权继续有效，不重复索取批准；识别和注入通过不代表模型已实际完成复核，也不承诺无限自然语言覆盖。
- 不改现役客户端配置与权限；B05 的真实原生交互和截图仍需独立验收。

### Contributors / 贡献者
- @liushikuan63

## [0.0.9] - 2026-10-31

### Fixed
- Fix a 0.0.8 regression that let double-negative or rhetorical success wording pass without verification evidence; failed outcomes are now excluded only when the negation applies directly to the outcome.
- Treat common failure wording such as "not all passed", "not fully passed" and "could not pass" as failed outcomes instead of unverified success claims.
- Keep headless or non-blocking modifiers, causal antecedents and separately reported failures out of double-negation detection.
- Complete the 0.0.8 Chinese summary with its missing short-reply and failed-outcome entry.

### Scope
- Ship the verification-wording fix and its regression coverage without changing client permissions or enabling optional workflows.
- B05 remains independently incomplete: real native choices, host authorization, content-change and recovery flows, and screenshots still need separate evidence.

### 中文摘要
- 修复 0.0.8 引入的回归：双重否定或反问形式的成功说法（如“没有不通过”“不是通过了吗”）不再无证据放行；只有否定直接作用于结果时才视为失败结果。
- 把“不是全部通过”“没有完全通过”“无法通过”等常见失败说法识别为失败结果，不再误当成缺少证据的成功主张。
- 不把“无头”“非阻塞”等修饰词、因果前件或分别报告的失败结果误当成双重否定。
- 补齐 0.0.8 中文摘要中缺失的短回复与失败结果条目。
- 本版仅交付验证措辞识别修复与回归覆盖；B05 真实宿主问答和截图仍未完成，不改变现役权限或默认启用状态。

### Contributors / 贡献者
- @liushikuan63

## [0.0.8] - 2026-10-31

### Fixed
- Preserve i18next namespace identity across aliases and block-scoped initializers instead of accepting overwritten methods as translation evidence.
- Isolate static-block variable scopes and evaluate initializers, assignment operands and destructuring bindings in their JavaScript order.
- Check captured translator bindings at supported local calls, retain coverage of uncalled function sources and report recursive call scopes as unverified.
- Preserve the namespace object evaluated on a member assignment's left side even when its right side rebinds the variable.
- Recognize supported test and build commands at command boundaries, rejecting quoted text, comments, skipped branches, concatenated control words and masked failures while preserving runner-specific verbosity arguments.
- Reject Node help and version queries with equals-sign values instead of recording them as successful test runs.
- Keep dependency installation and standalone cleaning out of test/build evidence.
- Deduplicate visible-literal issues by source node so repeated local calls do not inflate approved baseline debt.
- Check complete short replies instead of treating them as missing text, while keeping failed outcomes distinct from successful verification claims.

### Scope
- Ship reviewed source-level fixes and regression coverage without changing client permissions or enabling optional workflows.
- B05 remains independently incomplete: real native choices, host authorization, content-change and recovery flows, and screenshots still need separate evidence.

### 中文摘要
- 修复命名空间别名和块内初始化后的翻译绑定识别，不再把改写过的方法当作已翻译证据。
- 隔离类 static 块的变量作用域，并按 JavaScript 求值顺序处理初始化、赋值与逐项解构。
- 按受支持的本地调用检查捕获的翻译绑定，保留未调用函数的源码覆盖，并将递归调用作用域明确标为未验证。
- 成员赋值右侧重绑变量时，保留左侧已经求值的原命名空间对象。
- 统一测试与构建命令的边界识别，排除字符串、注释、未执行分支、拼接控制词和吞错，同时保留各运行器合法的详细输出参数。
- 不把带等号值的 Node 帮助、版本查询当作成功测试，也不把依赖安装或单独清理当作测试、构建证据。
- 按源码节点去重可见字面量问题，避免重复本地调用虚增已批准基线中的旧债。
- 按完整短回复检查证据，不再当作缺失文本跳过；同时把失败结果与成功验证主张区分开。
- 本版仅交付复审后的源码修复与回归覆盖；B05 真实宿主问答和截图仍未完成，不改变现役权限或默认启用状态。

### Contributors / 贡献者
- @liushikuan63

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

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.0.8...HEAD
[0.0.8]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.8
[0.0.7]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.7
[0.0.6]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.6
[0.0.5]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5
[0.0.4]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4
[0.0.3]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3
[0.0.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
