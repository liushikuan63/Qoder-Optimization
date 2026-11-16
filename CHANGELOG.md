# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

## [0.2.1] - 2026-11-16

### 中文摘要
- 新增 `production-readiness-audit` 技能（按需）：把用户给的 147 条「vibe-coded 产品生产就绪清单」变成可复用资产——原文逐条保留，补上域、稳定 ID、适用条件、可失败的取证方式与默认严重度/风险类别。流程先判适用性（内部工具不必 SAML，无 PHI 不必 HIPAA），**禁止为凑清单加无用功能**；每项要么给证据，要么明说不适用/无法确认；前十按「严重度 → 风险类别（泄露/资金/中断）」的确定规则排序，不靠感觉。附机器可读的报告契约、13 条「仍然需要人」的责任归属表，以及「只读审阅、整改另批」的边界。
- 新增 `scripts/readiness-report-check.cjs`：校验审查报告本身，而不是采信它。五条判据——清单 ID 全覆盖（漏项＝假装检查过）、finding/pass 必须给真实存在且落在被审查仓库内的证据（行号可选、存在性硬性）、不适用与无法确认必须写理由、没查的项不许带严重度、前十必须等于确定排序的前缀。清单解析不出 ID 或有重号一律 exit 2，不静默通过，覆盖判据不会空转。附 36 条测试，含变异对照（绿报告改一个证据路径即判红）、驱动真实 147 条清单的端到端用例，以及安装分层用例（library/core 沙箱＋两层皆无的负对照）。
- 把生产就绪审查接进 vibecoding 交付门：`vibecoding-doc` §8.1 与 `vibe-coding-workflow` 新增的「交付前：最终检测审计（③④ 完成后必跑）」都要求调用 `production-readiness-audit`——typecheck / lint / 单测 / 契约 / e2e 全绿只证明本轮改动按判据工作，不证明整个产品能上生产。两份 spec 示例夹具的 §6 验收各加审计条目（高配那份同时跑报告校验器），审计技能侧补上反向入口。选择该技能时安装图会带上 `readiness-report-check.cjs`，只装技能也能跑到 playbook 要求的校验器。
- 新增 `scripts/carrier-conflict-resolve.cjs`：生成/更新 skill、rule、command、agent、hook 时**增量检测并自主消解冲突**，不再每次编辑都付全仓扫描的代价。载体索引按 mtime+size 失效（实测 149 个载体：冷 155ms、warm 100ms 且 **0 次重解析**；同一改动跑全量契约门要 1274ms）。消解只做确定性、可逆、只改候选文件的事：重复触发词删掉但保留独有线素；超上限先删已被既有载体覆盖的路由词再压填充词，**绝不截断独有线素**。同名冲突、触发词全重复（给并入目标）、压不下或会丢线素三种停下问用户，既有载体一律不写。触发词抽取复用 `skill-trigger-uniqueness.cjs`、上限复用 `share-package-verify.cjs`，不造第二份真源。`skill-authoring-closure` 改为先跑它，全量门只在提交/出包前跑一次。附 14 条内嵌自测＋12 条独立沙箱测试，后者证明「增量」这条判据本身能失败。
- 把 grill-me 式序列追问并入现有澄清体系，而不是新增同域技能：`/clarify` 增 grill 模式，`/grill-me` 只做薄别名指向同一真源；长任务规则把 C 档关键歧义升级为 1–3 轮（每轮 ≤4 问、每题 2–4 个真实备选，按覆盖收敛即停）；`vibecoding-doc` §3.6 把面试答案直接映射到 spec §1/§2/§3/§4/§6，并留 ≤10 行决策记录。开工卡「≤1 次、≤4 问」预算不变——grill 轮次单独计算、封顶 3 轮；含混初筛的高/中置信提示同步给出该升级选项，配正负测试与变异对照（对改前模块跑同一断言必红）。
- `scripts/readiness-report-check.cjs` 的默认清单路径只认 `skills/`，而它自己的 catalog 条目声明 `tier=library`：安装后清单在 `skills-library/`，默认调用直接 `ENOENT`／exit 2；仓库内自测却恒绿（仓库布局就是 `skills/`），判据没覆盖真实安装形态。现改为先探 `skills-library/` 再回退 `skills/`，两层皆无时返回首选路径让调用方明确报 `ENOENT`，不静默拿空清单当通过。新增 4 条测试覆盖解析顺序与 library/core 两种安装沙箱，并配「两层皆无」负对照；只把默认路径计算拧回原样，恰好两条分层敏感测试判红（34/36），单变量证明判据有效。
- 打 tag 必须用 `git tag -a --cleanup=verbatim`：git 默认 `cleanup=strip` 会把 `#` 开头的行当注释删掉，v0.2.0 首次打 tag 时 `### 中文摘要` 标题被静默吃掉、12 条条目还在，被新判据拦下后删 tag 重推才修好。发布器错误信息现在直接点名这个根因与改法，发布命令第 6 步强制该参数，并加一条负对照锁住「条目齐全但标题消失」的真实形态。判据随仓库推送，其他电脑打包时同样受约束。
- 最终审计补齐交付面：报告路径与校验器退出码写入验收矩阵 / 收口清单，未执行必须标「未执行 + 原因」而不是写成已通过；B0x 任务包明确纳入；漏项或无证据的报告必须判红（exit 1）。发送前清单加第 8 问，审计未跑且未标注的包不能宣布交付。
- 发布门修复：包内设计 token（形如 `--ly-h1-mega` 的 CSS 自定义属性名）曾被密钥扫描误判为凭据键值、阻断发布扫描；现明确 CSS 自定义属性名一律不按凭据处理，并在自测中加入 JSON 真密钥正/负对照，确保真密钥仍判红。

- 跨平台验证补齐：修复 4 组只在 POSIX 失败的自测与判据——证据登记支持 POSIX 绝对路径、edit-guard 夹具移到任何 git 仓之外、包校验的来源存在性先归一化分隔符、盘符守卫变异对照改用真实盘符形态；Linux 容器与 Windows 全量回归均全绿。
- 视觉成品最终检测项补强：`verify-ui-in-browser` 新增五项最终清单（真实运行、关键部位 1:1/2–4× 放大、审美 rubric、运行期行为矩阵、证据落盘），`verify-before-claim` 加交叉引用；把 `image-detail-inspect` 与 `impeccable` 从可选工具变成可失败验收判据。


### English Summary
- Add `production-readiness-audit` skill (on-demand): a checklist-driven, read-only production-readiness review for any product. It turns a 147-item "vibe-coded app" checklist into a reusable asset — every item keeps its original wording and gains a domain, a stable ID, an applicability condition, a falsifiable way to gather evidence, and a default severity/risk class. The playbook gates applicability first (an internal tool needs no SAML; a product with no PHI needs no HIPAA), forbids adding features just to satisfy the list, requires evidence or an explicit `not-applicable` / `unverified` verdict for every single item, and ranks the top ten findings by severity then risk class (data leak, money loss, outage) so the ordering is deterministic rather than a matter of taste. Ships a machine-readable report contract, a human-ownership table for the thirteen "you still need people" roles, and a boundary that keeps the review read-only until the user approves fixes.
- Add `scripts/readiness-report-check.cjs`: validate the review report instead of trusting it. Five criteria — full checklist-ID coverage (a skipped item means "pretended to have checked"), every `finding` / `pass` carries evidence whose path really exists inside the audited repository (line numbers optional, existence mandatory), `not-applicable` / `unverified` must state a reason, unverified items may not carry a severity, and `top` must equal the deterministic severity → risk → ID prefix. An unparseable or duplicated-ID checklist exits 2 rather than silently passing, so the coverage criterion cannot idle. Ships 36 tests including a mutation control (a green report turns red when one evidence path is renamed), an integration case that drives the real 147-item checklist end to end, and install-tier cases (library/core sandboxes plus a both-missing negative control).
- Wire the readiness audit into the vibecoding delivery gate: `vibecoding-doc` §8.1 and the new "before delivery" section of `vibe-coding-workflow` both require calling `production-readiness-audit` once module generation and debugging are done, because typecheck / lint / unit / contract / e2e green only proves this batch meets its criteria — not that the whole product can go to production. Both spec fixtures gain acceptance items for the audit (the high-config one also runs the report checker), and the audit skill names its upstream entry points. Selecting the skill now pulls `readiness-report-check.cjs` through the install graph, so a skill-only install still has the checker its playbook tells you to run.
- Add `scripts/carrier-conflict-resolve.cjs`: incremental conflict detection and autonomous resolution when authoring or updating a skill, rule, command, agent or hook, so a full-repository scan is no longer the price of every edit. The carrier index is invalidated by mtime+size (measured on 149 carriers: 155 ms cold, 100 ms warm with **zero re-parses**, versus 1274 ms for the full contract gate on the same change). Resolution is deterministic, reversible and touches only the candidate file: duplicate trigger phrases are dropped while unique routing words are kept, and an over-cap description first sheds routing words already covered by an existing carrier, then filler — never truncating a unique routing word. Name collisions, fully-duplicate triggers (with a merge target) and unresolvable over-cap descriptions stop for a user decision; the existing carrier is never written. Trigger extraction reuses `skill-trigger-uniqueness.cjs` and the cap reuses `share-package-verify.cjs`, so there is no second source of truth. `skill-authoring-closure` now runs this before the full gate, which is reserved for commit/package time. Ships a 14-case embedded self-test plus an independent 12-case sandbox test that proves the incrementality criterion can fail.
- Integrate grill-style requirement interviews into the existing clarification flow instead of adding a separate skill: `commands/clarify.md` gains a grill mode, a thin `commands/grill-me.md` alias points at the same source, `rules/long-task.md` upgrades C-level ambiguity to 1–3 rounds (≤4 questions each, 2–4 real options, stop on coverage), and `vibecoding-doc` §3.6 maps interview answers to spec §1/§2/§3/§4/§6 plus a ≤10-line decision log. The kickoff budget (≤1 card, ≤4 questions) is explicitly untouched — grill rounds are counted separately and capped at three. The high/medium ambiguity note now proposes the same upgrade, with a positive/negative test pair and a mutation control proving the new assertion fails against the pre-edit module.
- `scripts/readiness-report-check.cjs` resolved its default checklist only under `skills/`, so a library-tier install — the tier its own catalog entry declares — failed with `ENOENT` / exit 2 while the in-repo self-tests stayed green, because the repo layout is `skills/`. The default now probes `skills-library/` then `skills/`, and returns the first candidate when neither exists so the caller still reports `ENOENT` instead of silently auditing against an empty checklist. Four new tests cover the resolver order and both install tiers in sandboxes, with a both-missing negative control; reverting only the default-path computation turns exactly the two tier-sensitive tests red (34/36).
- Tag annotations must be created with `git tag -a --cleanup=verbatim`. Git's default `cleanup=strip` silently deletes lines starting with `#`, so the `### 中文摘要` heading vanished from the first v0.2.0 tag while all twelve bullets survived — the new annotation check rejected it, and the tag was deleted and re-pushed with `verbatim`. The publisher's error now names this root cause and the fix, `update-share-package.md` step 6 requires the flag, and a negative control locks the exact stripped shape (bullets present, heading gone). These criteria ship in the repo so packaging on any other machine is held to the same rule.
- The final-audit gate now states where its evidence lands and how to fail safely: the report path and checker exit code go into the acceptance matrix or closure ledger, `not run` must be labeled with a reason instead of reading as a pass, B0x task packages are covered explicitly, and the clause is required to turn red on a report with a skipped item or an evidence-free finding. The pre-send checklist gains an eighth question, so a package cannot be declared delivered while the audit is unrun and unlabeled.
- Distribution gate fix: design tokens (`--ly-h1-mega`-style CSS custom property names) were misread as credential key-values and blocked the release scan; CSS custom property names are now excluded explicitly, with JSON fixtures proving a real-looking token still turns the scan red.

- Cross-platform verification: four checks that only failed on POSIX are fixed — evidence registration now recognizes POSIX absolute paths, edit-guard fixtures live outside any git repository, package source existence checks normalize separators first, and the drive-letter guard mutation uses a real drive form; the full suite is green on both a Linux container and Windows.
- Strengthen the visual delivery gate: `verify-ui-in-browser` now carries a five-item final checklist (real run, 1:1/2–4x detail crops, aesthetic rubric, runtime behavior matrix, evidence capture), and `verify-before-claim` cross-references it; `image-detail-inspect` and `impeccable` become fail-able acceptance criteria rather than optional tools.


### Contributors / 贡献者
- @liushikuan63

## [0.2.0] - 2026-11-15

### 中文摘要
- 新增 `long-task-merge-takeover` 技能：当多个长任务的放行判据互相依赖形成死锁时，把它们合并为单会话串行接管，并一路推进到发布与部署；配套可失败的证据纪律、踩坑对策表与量化提速经验，随包两份已脱敏的实战参考。
- 新增仓库侧秒级契约门 `carrier-contract-gate.cjs`：新增或修改技能、规则、命令、代理、hook、脚本后，在提交与出包之前先跑；九项判据覆盖触发词唯一性、引用完整性、元数据计数漂移、描述上限、机器专属标识等，硬违约阻断、存量债仅提示。
- 新增 `carrier-preflight.cjs --package`：载体要进公开包时，描述上限改用包侧同一真源并硬拦，消除「生成时合法、合并时违约」；不带该参数时行为不变。
- tag 附注强制中文摘要：发布前读取远端 tag 对象，附注缺少非空中文摘要即在上传任何资产之前判红；新增 `--print-tag-message` 从 CHANGELOG 生成附注，单一真源不手抄；已发布 tag 不重写。
- `tier-skills` 支持绑定库的跨卷晋升/降级：junction 解析到真实目标，跨卷时改用逐字节校验的复制兜底；CN 本地定制（Codex 能力承接图）上游化进包源。
- 修复手写技能清单与 catalog 不一致（补 2 个漏列技能、去掉 7 个错误的常驻标记），并纳入契约门检测；编写规范回写既有载体，明确「契约门先绿、再进全量套件」；包元数据重建至 135 个随包技能。

### English Summary
- Added the `long-task-merge-takeover` skill: when several long-running tasks deadlock on each other's release criteria, merge them into one serial session and carry the takeover through to release and deployment, with falsifiable evidence discipline, a pitfall/countermeasure table, quantified speedup lessons, and two sanitized worked references.
- Added `carrier-contract-gate.cjs`, a seconds-level repo-side contract gate to run before committing or packaging any new or changed carrier; nine checks cover trigger uniqueness, reference integrity, metadata count drift, description caps and machine-specific identifiers, with hard violations blocking and pre-existing debt reported as advisory.
- Added `carrier-preflight.cjs --package`: carriers destined for the public package now enforce the description cap from the package-side single source as a blocker, closing the "legal at authoring, illegal at merge" gap; behaviour without the flag is unchanged.
- Git tag annotations must now carry a non-empty Chinese summary: the publisher reads the remote tag object and fails before uploading any asset when it is missing; `--print-tag-message` composes the annotation from the CHANGELOG as the single source; already-published tags are not rewritten.
- `tier-skills` now supports cross-volume promote/demote for bound libraries by resolving the junction to its real target and falling back to a byte-verified copy; CN local customizations (the Codex capability map) were upstreamed into the package source.
- Fixed the hand-written skill inventory against the catalog (two missing skills added, seven incorrect resident marks removed) and brought it under gate coverage; authoring norms were written back into existing carriers with "gate green before the full suite"; package metadata rebuilt to 135 shipped skills.

## [0.1.7] - 2026-11-14

### 中文摘要
- 新增 `image-detail-inspect` 技能：通过裁剪、放大、分块让图片细节躲过视觉管线降采样，提供纹理/色彩/对比/光影量化与同区域同倍率 A/B 对比，附可失败自测；可选 RapidOCR 离线交叉核对，内网零网络可用。
- 新增读图后主动提醒精确识图的 PostToolUse hook 与配套规则，并真正接进安装器 hook 表（此前只随包复制、装了不触发）；可选 OCR 离线包作为独立 Release 资产交付，不混进核心包。
- 视觉验收升级：`verify-before-claim` / `verify-ui-in-browser` 要求局部采样放大对比，不得只凭全局缩略图下结论；新增两组可失败的前台断言——文字/控件按 WCAG 对比度阈值核验，模式/状态切换对每个应显示/隐藏区块下断言并带切回负向用例。

### English Summary
- Added the `image-detail-inspect` skill: crop, zoom and tile images so fine detail survives vision downscaling, with texture/color/contrast/lighting metrics, same-region same-scale A/B comparison and a falsifiable self-test; optional RapidOCR cross-check works fully offline for intranet use.
- Added a PostToolUse hook and companion rule that proactively prompt precise image recognition after reading an image, now actually wired into the installer hook table (previously copied but never fired); the optional offline OCR bundle ships as a separate release asset instead of mixing into the core package.
- Visual verification upgraded: `verify-before-claim` / `verify-ui-in-browser` now require local-sample zoom comparison instead of judging from a global thumbnail, plus two falsifiable front-end assertion groups — text/control legibility against WCAG contrast thresholds, and mode/state-switch completeness with a switch-back negative case.

## [0.1.6] - 2026-11-13

### 中文摘要
- 新增接续档案自动清理（默认关闭，显式开启才生效）：默认干跑，确认后才把超期、孤儿或空的会话档案移入隔离区并写逐文件校验清单；保留期、孤儿宽限、手工档案保护、当前会话排除均有明确规则，支持中断恢复、隔离区查询、审计日志与检查缓存。
- 新增自进化确定性采集：每轮结束时把长期偏好、明确沉淀要求、重复纠正、能力缺口等候选脱敏后登记入册，判据收敛到唯一真源；采集永不拦截、绝不擅自修改规则/技能/记忆等载体，附只读报告与零写入演练。
- 新增收尾建议弹窗与两道门禁：载体改不改由用户拍板，未弹建议卡不得收尾；声称「已沉淀为规则/技能」必须有本轮成功写入证据，否则拦下。
- 清理时选择的「保留」落盘为证据标记，后续清扫能区分受保护证据与可丢产物。
- 包校验器、大输出守卫、清理守卫、hook 守卫全面加固：未知参数与绕法一律失败关闭，堵掉多处实测绕过与「空集恒真」漏洞。
- 光标守卫在高负载下更可靠：读写预算可配并重试，自带总时限与起进程余量，时间用尽给出诚实的「未验证」判定而非被静默杀掉；备份判龄改用备份自身时间，新建回滚点不再被误裁。
- 安装器把随包 hook 超时当作下限而非唯一合法值，更大的本地余量原样保留；负载脆弱的自测不再把「机器忙」误判成「产品坏」；文档声明的条数与实现真值用常驻测试钉死，再漂移即红。

### English Summary
- Added opt-in automatic pruning of the continuity archive (off by default): dry run first, then quarantine expired, orphaned or empty session archives with a per-file checksum manifest; clear retention, grace and protection rules, plus interrupted-batch recovery, quarantine listing, audit log and inspection cache.
- Added deterministic self-evolution capture: at each turn's end, redacted candidates (long-term preferences, explicit sedimentation requests, repeat corrections, capability gaps) are recorded with a single shared judgement core; capture never blocks and never modifies rules, skills or memory on its own, with read-only reporting and a zero-write dry run.
- Added a wrap-up suggestion popup and two stop gates: every carrier change is decided by the user, and wrap-up is blocked until suggestions are asked; claims of "already sedimented into a rule/skill" require a successful write this turn.
- Cleanup "keep" answers now persist as evidence markers so later sweeps can distinguish protected evidence from disposable output.
- Hardened the package verifier, output guard, cleanup guards and hook guards: unknown arguments and bypasses fail closed, closing several measured evasions and vacuous-green holes.
- The cursor guard is more reliable under load: configurable read/write budgets with retries, a self-imposed deadline with spawn reserve, and an honest UNVERIFIED verdict instead of being silently killed; backup age is judged by the backup's own timestamp so fresh rollback points are never pruned by mistake.
- The installer treats the shipped hook timeout as a floor, preserving larger local headroom; load-fragile self-tests no longer mistake a busy machine for a broken product; documented tallies are pinned to implementation truth by a permanent test so they cannot drift again.

## [0.1.5] - 2026-11-10

### 中文摘要
- 读取分享包时按 catalog 安装全部随包技能，不再只装固定子集。
- 新增「开工确认」必要闭环：除简单纯问答外，同一轮结束前必须复述目标/范围/验收、列出可验证步骤并弹窗确认后才执行；配套门禁拦截「未确认就写入」与「未出卡就收尾」，纯问答与已确认任务的继续执行豁免。
- 安装分享包时问一次是否常驻开工提示卡，选「否」后相关注入与门禁停用，其余提醒不变。
- 技能分层支持显式、可审计的核心降层名单（路由技能仍受保护）；索引发布拒绝用空扫描覆盖已有索引。

### English Summary
- Reading a shared package now installs every shipped skill declared by its catalog instead of a fixed subset.
- Added a mandatory kickoff confirmation loop: except for simple Q&A, each turn must restate goal/scope/acceptance, list verifiable steps and obtain explicit confirmation before any write; gates block unconfirmed writes and uncarded wrap-ups, with exemptions for pure questions and confirmed continuations.
- Package installation asks once whether the kickoff card stays resident; choosing "no" disables its injection and gates while leaving other reminders unchanged.
- Skill tiering supports an explicit, audited core-demote list (the router skill stays protected); index publication refuses to overwrite a populated index with an empty scan.

## [0.1.4] - 2026-11-10

### 中文摘要
- 能力推荐更稳更安静：泛化触发词不再单独拉技能进建议，补充口语化路由，权衡型提问保持静默；使用类建议优先于维护类，本地有差异的技能给使用建议而非更新审查。
- 推荐去重从「整个会话」改为「同一请求」：新请求可再次推荐同一能力，同一请求重试才静默。
- 新增常驻「开工自检」：含混时先给真实备选反问，能力建议只作召回线索、命中须核对适用边界。

### English Summary
- Capability routing is quieter and more stable: generic trigger words no longer pull skills into suggestions on their own, spoken-language routes were added, weighing questions stay silent, and use suggestions outrank maintenance ones.
- Recommendation dedupe is now per request instead of per session: a new request may suggest the same capability again; only retries of the same request stay quiet.
- Added a resident kickoff self-check: ask with real alternatives when ambiguity would cause rework, and treat capability suggestions as recall clues whose applicability must be verified.

## [0.1.3] - 2026-11-10

### 中文摘要
- 回填 6 个按需技能的最新内容：恢复完整描述、补入新的防护与配置项、采用整理后的数据库流程并补齐参考文件。
- 所有发布包描述以完整改写控制在 300 字符以内，不做机械截断。
- 设计原则更新：能力分层与宿主边界并入中英文设计原则，补充近期机制（一次性澄清、描述预算、并行/目标/文档按需启用等），澄清规则补「作用对象不明」案例。

### English Summary
- Backfilled six on-demand skills with newer content: complete descriptions restored, newer guards and configuration knobs added, and the curated database workflow adopted with its reference files.
- Every package description now fits the 300-character contract through complete rewrites instead of mechanical truncation.
- Design principles refreshed: capability layering and host boundaries merged into both language sections, recent mechanisms documented, and the "unclear target object" case added to the clarification rules.

## [0.1.2] - 2026-11-09

### 中文摘要
- 恢复「指令/需求不清 → 推荐提示词纠正」：给出保留原意的纠正稿选项，纠正稿只作建议、不构成执行授权；澄清命令接入能力路由。
- `vibe-coding-workflow` 采用新版内容（使用边界、并行/目标化衔接、按需库路径），上游说明文件随技能一并安装。
- 理解确认改为常驻：绝大多数任务可在开工前确认一次理解，确认只对齐理解、不构成授权，且至多一次。

### English Summary
- Restored the prompt-correction recommendation for ambiguous requests: a corrected prompt preserving the original intent is offered as advice only, never as authorization; the clarify command is now routable.
- `vibe-coding-workflow` adopts the newer content (use/avoid boundaries, parallel and goal handoffs, library-tier paths), with upstream docs installed alongside the skill.
- Understanding checks are now resident: most tasks may confirm understanding once before starting; the check aligns understanding only, never authorizes, and is asked at most once.

## [0.1.1] - 2026-11-09

### 中文摘要
- 新增 `pkg-diff review` 逐文件合并审阅：文本/文案差异配三路判定与决策清单；合并、发布同步与安装更新改为逐条询问（保留本地/采纳包内/手工合并/跳过），未审阅就合并会被门禁拦截；按需层技能不再被误报为新增。
- 上下文治理 hook 改为增量快照：大会话稳态扫描由约 2 秒降至约 0.13 秒；只上报使用率的模型不再显示为「真实 0 token」；压缩恢复指针改指真实存在的档案路径。
- 恢复模型工作流下的验证选档、目标候选与能力询问；并行/文档提示按任务规模阈值询问。
- 离线包 cua-driver 资产升级到 0.44.0（校验与签名同步）；开启自动清理时按本轮清理临时产物，分享包产物仍逐轮询问，证据与回滚点不参与清理。

### English Summary
- Added `pkg-diff review` for per-file merge decisions: text/wording diffs with three-way verdicts and a mandatory decision list; merge, release-sync and install-update now ask per file instead of one deploy question, and unreviewed merges are blocked; library-tier skills are no longer misreported as new.
- The context-governor hook now snapshots incrementally: steady-state scans of large transcripts drop from ~2 s to ~0.13 s; ratio-only models no longer look like a real 0-token measurement; the compaction recovery pointer now references archives that actually exist.
- Restored verification-tier, goal-candidate and capability asks in the model workflow; parallel/documentation prompts follow task-size thresholds.
- The offline bundle's cua-driver asset was upgraded to 0.44.0 with refreshed checksums and signatures; optional auto-clean removes this round's temp artifacts while share-package artifacts still require an explicit ask, and evidence/rollback points are never cleaned.

## [0.1.0] - 2026-11-08

### 中文摘要
- 目标模式改为开局问一次：中大型任务推荐建、同意才建，已有目标不重复问、拒绝不催问，小任务不弹窗。
- `/skill-load` 与 `/pkg-find` 收口为薄壳，检索、询问与安装更新判据统一到路由技能，不再各命令重复维护。
- 周检按脚本身份比对 hook 接线，仅参数差异不再误报漂移；技能体检消除跨级引用的悬空误报；分享版规则文档同步最新配置并保留人工策展措辞。

### English Summary
- Goal mode now asks once at kickoff: recommended for medium/large tasks, created only on consent, never re-prompted for an existing goal or after a decline, and silent for small tasks.
- `/skill-load` and `/pkg-find` became thin shells over the router skill so retrieval, asking and install/update criteria live in one place.
- The weekly audit compares hook wiring by script identity so flag-only differences no longer report false drift; the skill doctor no longer flags cross-level references as dangling; the shareable rules document syncs the latest configuration while preserving curated wording.

## [0.0.30] - 2026-11-06

### 中文摘要
- 新增实验性上下文治理工具：用量实测报告、逻辑折叠与引用追回、交接包、固定与修剪；不改写模型请求，未取得独立执行回执前如实报告零物理节省；配套 hook 默认不接线、需显式批准。
- 新增人读版技能导航目录，与机器索引在安装、升级、分层变更时同批发布，失败一起回滚。
- 修复中文与 emoji 分页恢复、只读预览不污染源数据库、测试夹具自包含等问题。

### English Summary
- Added the experimental context-governor tooling: measured usage reports, logical folds with scoped retrieval, handoff packs, pins and pruning; it never rewrites model requests and honestly reports zero physical savings until an independent executor receipt exists; the companion hook stays unwired until explicitly approved.
- Added a human-readable skill navigation catalog published together with the machine index across install, upgrade and tier changes, with joint rollback on failure.
- Fixed CJK/emoji paged retrieval, read-only previews that never touch the source database, and self-contained test fixtures.

## [0.0.29] - 2026-11-06

### 中文摘要
- 已安装命令与核心技能按描述触发词路由，命令成为可用候选；25 个领域技能恢复到随包按需库并补对象级触发词与「不适用」边界，数据库/前后端/游戏等任务无需每轮注入即可找到正确入口。
- 含混请求先审计再实施，答案改变范围/验收/授权时强制走审阅门。
- 修复重装时把已装命令误当新候选、入包差异自测的敏感扫描误报等问题；目录、清单与双语 README 同步刷新。

### English Summary
- Installed commands and core skills are now routed by description trigger cues, with commands ranked as usable candidates; 25 domain skills return to the shipped library tier with object-level triggers and "not for" boundaries, so database/frontend/backend/game tasks reach the right entry point without per-turn injection.
- Ambiguous requests are audited before implementation, with a mandatory review gate when the answer changes scope, acceptance or authorization.
- Fixed re-installation treating installed commands as new candidates and secret-scan false positives in the package diff selftest; catalog, inventory and bilingual READMEs refreshed.

## [0.0.28] - 2026-11-06

### 中文摘要
- 将已验证的个人工程方法合入现有技能与安装工作流：任务级工具发现、错误分类、唯一重试预算、未知写入先读回；不搬运宿主或私人状态。
- 验证流程扩展到交付证据、干净安装、增量升级与独立实装检查；浏览器技能补动效/主题观测方法。
- 两个 Windows 技能带入真实 argv 只读探针，不做 universal 引号/编码断言；引用审计覆盖中文、嵌套与递归 Markdown；CI 诊断纠偏：零步骤/缺日志是线索不是计费结论。

### English Summary
- Merged proven personal engineering methods into existing skills and the installed workflow: task-scoped tool discovery, error classification, a single retry budget and read-back before retrying unknown writes; no host or private state is carried over.
- The verification workflow now covers behavior-to-delivery evidence, clean installation, incremental upgrades and independent installation checks; the browser skill gained motion/theme observation methods.
- Both Windows skills ship a real read-only argv probe instead of universal quoting/encoding claims; reference auditing covers Unicode, nested and recursive Markdown; CI diagnosis corrected: zero steps and missing logs are clues, not billing conclusions.

## [0.0.27] - 2026-11-05

### 中文摘要
- 修复「技能装了但必要脚本没装」：并行、编辑归属、自进化与路由技能安装时补齐共享运行时，可选维护与外部服务保持分离。
- 支持显式绑定已迁移的按需技能库，保留用户布局与定制；客户端/链接/物理目标/绑定文件四重身份校验贯穿发现、比较、加载、安装与恢复，撤销授权、同名冲突、跨卷与写盘故障都有明确拒绝或恢复路径。
- 载体预检输出不再携带 MCP 值与私有 hook 参数；机器专属绑定回执不进分发包。

### English Summary
- Fixed "skill installed but required scripts missing": shared runtimes now ship with the parallel, edit-attribution, self-evolution and routing skills, while optional maintenance and external services stay separate.
- Existing migrated skill libraries can be explicitly bound without relocating user data; client/link/target/binding identity is verified across discovery, comparison, loading, installation and recovery, with clear refusal or recovery paths for revoked grants, name collisions, cross-volume moves and write failures.
- Carrier preflight output no longer carries MCP values or private hook arguments; machine-specific binding receipts are excluded from distribution.

## [0.0.26] - 2026-11-05

### 中文摘要
- 分享包补齐为可独立安装的完整工作流：12 个公共核心技能、托管规则区、检查点/事实命令、依赖闭包与五类事件 16 条 exec hook；新客户端默认完整档，旧安装保留既有选择并可显式增量升级。
- 托管规则区外的个人文字不受影响；本地改动的托管区与 hook 冲突先审阅再发布，全部走事务备份与回滚。
- 每条托管 hook 绑定所选客户端并经白名单启动器执行；会话转录回退只限所选客户端，不消费另一客户端的同名会话；私人 BYOK、凭据与记忆不分发。

### English Summary
- The shared package became a complete, independently installable workflow: twelve public core skills, managed rule sections, checkpoint/fact commands, dependency closure and sixteen exec hooks across five native events; fresh clients default to complete while existing choices are preserved with an explicit upgrade path.
- Personal text outside managed sections is untouched; locally changed managed sections and hook conflicts are reviewed before publishing, all through transactional backup and rollback.
- Every managed hook binds to its selected client through a bounded whitelist launcher; transcript fallback never consumes another client's same-session transcript; private BYOK, credentials and memory are not distributed.

## [0.0.25] - 2026-11-05

### 中文摘要
- 新装默认 model 工作流模式，已有选择保留；安装器支持显式切换，升级可先询问再改；route 回退补齐口语执行动词，只读与续接轮保持安静。
- 只读/拒绝边界更早返回且保留必需验证清单；裁定命令输出真实 Node 参数与正确引用的本机 shell 命令，含空格/引号/美元符号路径也正确。
- Git 校验绑定每工作树配置身份，阻止重定向隐藏脏文件；同物理客户端别名重装幂等，异客户端继续拒绝。
- 发布完整性：三平台统一固定到同一不可变提交，跨版本发布排队，按最高稳定版本核对 Latest，避免旧版晚完成降级指针。

### English Summary
- New installs default to the model workflow mode with existing selections preserved; the installer supports explicit switching so upgrades can ask first; the route fallback recognizes colloquial execution verbs while read-only and continuation turns stay quiet.
- Read-only/refusal boundaries return earlier while keeping mandatory verification checklists; workflow decisions emit the real Node argument array and correctly quoted shell commands, including paths with spaces, quotes and dollar signs.
- Git checks bind per-worktree configuration identity and block redirected dirty-file hiding; re-installation through an alias of the same physical client is idempotent while foreign clients stay rejected.
- Release integrity: all three platforms pin one immutable commit, publication is serialized across versions, and Latest is reconciled to the highest published stable version so a late-finishing older release cannot downgrade the pointer.

## [0.0.24] - 2026-11-04

### 中文摘要
- 显式能力选择优先于旧的关闭/排除偏好，「本次/暂时」等时间限定拒绝生效；使用建议按当前实际层级给出。
- 常驻选择纳入安装事务：状态损坏、发布失败或并发变更一律回滚，不再假成功；链接目录越界写入被拒绝。
- 修复 Windows 短路径身份误判、Linux 大小写与反斜杠路径越权，以及含空格/转义引号的凭据漏脱敏。
- 引用校验完整遍历引用链并终止循环，拒绝空包、错误参数与包外依赖；Windows CI 夹具适配真实 runner 环境。

### English Summary
- Explicit capability selections now outrank older disable/exclude preferences, time-qualified refusals are honored, and usage suggestions reflect the current actual tier.
- Resident choices join the install transaction: malformed state, failed publication or concurrent changes roll back instead of faking success; linked-directory escapes are rejected.
- Fixed Windows short-path identity misjudgement, Linux case/backslash path escapes, and credential redaction gaps for values with spaces or escaped quotes.
- Reference validation traverses complete chains with cycle termination and rejects empty packages, malformed options and out-of-package dependencies; Windows CI fixtures adapt to the real runner environment.

## [0.0.23] - 2026-11-04

### 中文摘要
- 新增技能引用完整性校验器：扫描全部技能文档及其引用链，断链即判红；从现役补齐 194 个被引用文件与 3 篇缺失协议文档，CI 与每个 PR 都执行校验。
- 安装器在任何写盘前强制 Node.js 24.16+；hook 脚本补安装对照表，接线指向缺失脚本会被点名。
- 发布门禁接入包校验器；新增 Windows 全量隔离测试任务与 PR 触发。
- 六个 Spring 技能的重复触发词去重，路由可区分各自专长；三个大脚本拆出公共模块并补单测；CUA 守卫改用参数数组传参。
- 规则文档增加目录，平台徽章、索引状态计数与 catalog 状态说明校准。

### English Summary
- Added a skill reference-integrity checker that scans every skill document and its transitive references, failing on dangling links; 194 referenced files and 3 missing protocol documents were restored, with the check enforced in CI and on every pull request.
- The installer enforces Node.js 24.16+ before any write; hook scripts gained an install-ID对照 table and wiring that points at missing scripts is reported.
- Release gates now run the package verifier; a full isolated Windows test job and pull-request triggers were added.
- Duplicate trigger phrases across six Spring skills were removed so routing can distinguish them; three large scripts were split into tested shared modules; the CUA guard passes arguments as an argv array.
- The rules document gained a table of contents; platform badge, index status counts and catalog status legend were corrected.

## [0.0.22] - 2026-11-04

### 中文摘要
- 常驻技能改为按使用习惯决定并持久化：安装时询问是否常驻，默认按需；新增晋升/降级命令（默认预览）与本地使用记录、升降建议，包升级不再重置用户的常驻集合。
- 按需技能不依赖注册包也能从本地技能库自动发现；「别用 X」被识别为明确拒绝而非自动加载。
- 并行派发前必须先有计划文档与明确决定；新增真实记忆召回命令；基础包随装并行计划与上下文脚本。
- 修复技能与索引构建器同批升级时的回滚误判；召回上下文补全角分隔符与非 HTTP URL 凭据脱敏。

### English Summary
- Resident skills are now a persisted per-user decision: installation asks whether to stay resident (default on-demand), promote/demote commands preview by default, and local usage records drive suggestions; package upgrades no longer reset the user's resident set.
- On-demand skills are discovered from live local tiers without a registered package; "don't use X" is treated as an explicit refusal instead of auto-loading.
- Parallel dispatch requires a plan document and an explicit decision first; a real memory recall command was added; the base package ships the parallel planning and context scripts.
- Fixed rollback misjudgement when a skill and the index builder upgrade together; recall context redaction covers full-width separators and non-HTTP URL credentials.

## [0.0.21] - 2026-11-03

### 中文摘要
- 新增分享包安装入口：盘点已有/缺失能力，只更新经证明未改动的副本，本地修改保留待审；缺失的通用能力供用户挑选，可选能力不被通用「yes」一锅端。
- 接续会话支持自动绑定（宿主满足 Node 24.16+ 与 SQLite 条件时），显式关闭永不重开；存储位置可移植配置。
- 新增并行写入准备/核验：从干净基线建带锁工作树，逐提交检查真实注册、分支、改名端点与共享漂移，合并前用 merge-tree 预演；同波次所有权冲突检查，依赖波次必须从新集成基线出发；全有或全无的批次合并与可恢复发布。
- 修复首次关闭被重开、安装并发覆盖、目录比对假一致、复合命令结果串账、发布失败误判等问题；离线资产校验和按真实字节复核。

### English Summary
- Added a package installation entry that inspects existing/missing capabilities, updates only copies proven unchanged, and preserves local modifications for review; missing general capabilities are offered for selection and optional ones are never bulk-accepted by a generic "yes".
- Continuity sessions can auto-bind on supported hosts (Node 24.16+ with SQLite); an explicit disable is never reopened; the store location is portably configurable.
- Added parallel-write prepare/verify: locked worktrees from a clean recorded baseline, per-commit checks of registration, branches, rename endpoints and shared drift, merge-tree preview before integration, same-wave ownership conflict checks, and all-or-nothing recoverable batch merging.
- Fixed first-use disables being reopened, concurrent install overwrites, false-equal catalog comparisons, aggregate results attributed to the wrong target, and failed releases judged as success; offline asset checksums verified against actual bytes.

## [0.0.20] - 2026-11-03

### 中文摘要
- 新增确定性并行计划校验：依赖波次、硬门禁、写隔离、路径归属与机器可读裁决；配套共享上下文工具（协调者持有的规范上下文、有界脱敏记忆包、版本化工作增量与过期包检查）。
- 新增并行编排技能与四层 vibecoding 文档；可并行计划必须先给用户确认再派发，写并行需单独明确同意并配工作树隔离与互不重叠的文件归属。

### English Summary
- Added deterministic parallel-plan validation with dependency waves, hard gates, write isolation, path ownership and machine-readable verdicts, plus shared context tooling (coordinator-owned canonical context, bounded redacted memory packs, versioned worker deltas and stale-pack checks).
- Added the parallel-orchestration skill and four-layer vibecoding docs; parallelizable plans must be approved by the user before dispatch, and write parallelism requires separate explicit opt-in with worktree isolation and disjoint file ownership.

## [0.0.19] - 2026-11-03

### 中文摘要
- 验证选档自动触发接入每轮提醒：可执行任务自动收到选档指引，带关闭开关与决策台账；宿主未提供授权解析时保持咨询模式，不冒称原生链路通过。
- 触发口径细化：请求式提问（「能否帮我…」）算任务，建议式与状态式提问（「是否应该…/是否已部署…」）保持安静；目标候选提醒合并进同一入口，不新增 hook。
- 收尾门禁新增两条：安装/更新给出下一步后必须取得用户明确选择；发布成功后必须明确询问是否部署。创建或覆盖技能/规则/记忆等载体时提醒先做载体预检。

### English Summary
- The verification-tier auto-trigger now joins the per-turn reminder: actionable tasks receive the tier-selection instruction with a kill switch and decision ledger; without host authority resolution it stays advisory and never claims the native pilot passed.
- Trigger wording refined: request-style questions count as tasks while advice and status questions stay silent; the goal-candidate reminder merges into the same entry without adding a hook.
- Two new wrap-up gates: install/update next-step output must be followed by an explicit user choice, and a successful release must be followed by an explicit deploy question; creating or overwriting carriers now prompts a carrier preflight.

## [0.0.18] - 2026-11-03

### 中文摘要
- 复核 0.0.13–0.0.17 全部增量，修复接续安装的接线误判、失败回滚与目录依赖缺失；冲突接线保留待审而非假称已接好。
- 修复重试作用域漏检 Bash 工作目录与复合命令后续目标、显式错误借表格输出清零认证失败计数、进化候选按条数而非合格任务数晋升等问题。
- junction 转回实体目录前必须完整哈希校验数据；发布契约测试改为单项限时，不再以整套九分钟上限截断后续文件；历史资产与现役配置保持不变。

### English Summary
- Audited every increment in releases 0.0.13–0.0.17, fixing continuity-install wiring misjudgement, failure rollback and missing directory dependencies; conflicting wiring is preserved for review instead of declared connected.
- Fixed retry scopes missing the Bash working directory and later targets of compound commands, explicit errors resetting authentication counters through row-shaped output, and evolution promotion counting raw records instead of qualified tasks.
- Junction-to-directory conversion now requires full hash-verified data first; release contract tests get per-test timeouts instead of a nine-minute suite cap; historical assets and live configuration remain unchanged.

## [0.0.17] - 2026-11-03

### 中文摘要
- 新增安装时可选的接续模式：安装器检测 Node.js、询问是否启用 SQLite/FTS5 记忆与追回，并把五个 hook 接入所选客户端；缺 Node 时给安装或便携版指引。
- 随包提供每会话 SQLite+FTS5 档案脚本，旧 JSON 记录首次读取自动迁移；保留既有 hook、不重复接线、改前备份，预览模式不写盘，采集仍需按会话显式启用。
- 按需条目安装/更新前必须询问：检索与技能加载都会比对包与本地内容并给出下一步，发布/部署询问附带差异清单。

### English Summary
- Added optional install-time continuity: the installer detects Node.js, asks whether to enable SQLite/FTS5 memory and recovery, and wires five hooks into the selected client; missing Node gets install or portable guidance.
- Ships a per-session SQLite+FTS5 archive script with automatic migration from the older JSON format; existing hooks are preserved, wiring is idempotent, changes are backed up, dry-run writes nothing, and collection still requires explicit per-session enablement.
- On-demand entries must be confirmed before install/update: search and skill loading compare package vs local content and emit next actions, and release/deploy asks include the drift list.

## [0.0.16] - 2026-11-02

### 中文摘要
- 新增每轮自进化采集提醒：长期偏好、明确沉淀请求与重复纠正会收到针对性提示；单次约束、普通请求与引用规则原文不触发。
- 新增只读候选扫描：汇总记忆反馈、门禁违规与进化记录，按「升全局/升本地/观察/已覆盖」四类出报告；报告只是候选，不自动改规则、技能、hook 或权限。

### English Summary
- Added a per-turn self-evolution capture reminder with targeted notes for long-term preferences, explicit persistence requests and repeated corrections; single-task constraints, ordinary requests and rule quotations do not trigger it.
- Added a read-only candidate scan over memory feedback, gate violations and evolution records, classifying candidates as promote-global/promote-local/observe/covered; reports are candidates only and never change rules, skills, hooks or permissions.

### Contributors / 贡献者
- @liushikuan63

## [0.0.15] - 2026-11-01

### 中文摘要
- 重试预算按真实执行程序与操作分类：命令样参数不再冒充测试证据，帮助/版本查询不计数，不同远端目标各自独立预算；交接/导入的缺值参数在写盘前拒绝。
- 敏感扫描支持带 BOM 的 UTF-16 文本并收窄环境表达式豁免；记忆导入与技能索引改为暂存+归属核对后发布，失败回滚保留并发变更与恢复资料。
- 修复记忆同步/迁移失败仍报成功：复制逐字节校验、拒绝链接目标、切换前流式哈希核对；通用 ZIP 打包器拒绝链接与输入树内输出路径并钳制时间戳范围；同一标签的手动与自动发布统一串行。

### English Summary
- Retry budgets are classified by the executed program and operation: command-like argument text no longer masquerades as test evidence, help/version queries are excluded, and different remote destinations keep separate budgets; missing handoff/import arguments are rejected before any write.
- Credential scanning decodes BOM-marked UTF-16 and narrows environment-expression exemptions; memory imports and skill indexes publish from staging with identity checks, and rollback preserves concurrent edits and recovery material.
- Fixed memory sync/migration reporting success on failure: copied bytes are verified, link destinations rejected and streaming hashes checked before cutover; the generic ZIP packer rejects links and in-tree outputs and clamps timestamps; manual and tag-triggered publication of one release are serialized.

### Contributors / 贡献者
- @liushikuan63

## [0.0.14] - 2026-11-01

### 中文摘要
- 重试预算按工作目录与显式工作区选择器划分：同一项目的等价目录写法共享预算，跨项目不再串账；`echo`/`rg` 里引用的构建命令不再消耗重试。
- 安装器参数先校验再检查目标：缺值、未知开关、非法超时一律拒绝，不再回落默认客户端目录；hook 接线只有类型、完整命令、matcher 与超时全同才算等价。
- 交接队列相对入口改按队列所在目录解析并补查 Unix 绝对路径；敏感扫描修复含 `=` 值漏检、上下文串用与合法目录名误跳过。

### English Summary
- Retry budgets are scoped by working directory and explicit workspace selectors: equivalent directory spellings of one project share a budget while separate projects no longer cross-count; build commands quoted inside `echo`/`rg` no longer consume retries.
- Installer arguments are validated before target inspection: missing values, unknown flags and invalid timeouts are rejected instead of falling back to a default client directory; hook wiring counts as equivalent only when type, full command, matcher and timeout all match.
- Relative handoff entries resolve against the queue file's directory with Unix absolute paths checked; credential scanning fixes values containing `=`, context bleed and legitimate directory names being skipped.

### Contributors / 贡献者
- @liushikuan63

## [0.0.13] - 2026-11-01

### 中文摘要
- 新增 7 个按需技能：分享包发布与现役同步、本机反代改动验证、OAuth/SSO 登录排查、分流规则手术、SVG/CSS 场景动画、AI 客户端网络排查、反例驱动方案审查。
- 扩展既有技能：发布证据绑定、流式分块 UTF-8 验收、双客户端上线一致性、BYOK 凭据与上限检查、桌面更新 ACL 诊断、junction 反向替换、混淆 bundle 探针等；补齐 Electron 取证与 CUA 守卫的配套脚本。
- 修复悬空技能引用与发布脚本路径；分享包内不存在的规则目录引用改为有效指向，合并时保留仓库较新的复核与记忆更新授权口径。

### English Summary
- Added seven on-demand skills: share-package release and live sync, local reverse-proxy change verification, OAuth/SSO login triage, proxy rule surgery, SVG/CSS scene animation, AI-client network triage and counterexample-driven plan review.
- Extended existing skills with release evidence binding, streaming/chunked UTF-8 acceptance, dual-client rollout parity, BYOK credential/cap checks, desktop update ACL diagnosis, junction-to-directory replacement and minified-bundle probes; companion scripts restored for Electron forensics and CUA guardrails.
- Fixed dangling skill references and release script paths; rule-directory references stay valid where the source directory is not shipped, and the repository's newer recheck and memory-update guidance is preserved through merges.

### Contributors / 贡献者
- @liushikuan63

## [0.0.12] - 2026-11-01

### 中文摘要
- 为 19 个随包技能补齐 108 个已核实的配套参考与脚本，逐文件记录来源、许可与敏感内容检查回执。
- 加固 MCP 安装（保留损坏配置、校验离线包完整性、非系统盘空目录要求、失败不写设置）与认证锁库（跨入口合并计数、锁定保留至人工清除、不存密码文本、查询行不误判为认证错误）。
- 收紧提权/UAC、服务重启、记忆写入、TLS 下载、进程停止、取证 pristine 主张、mtime 归属等技能指引；归档清理防复制清单与失败恢复误删；发布门禁校验所选标签与随包目录来源。

### English Summary
- Restored 108 verified companion references and scripts for 19 shipped skills, with per-file source, license and sensitive-content receipts.
- Hardened MCP installation (malformed configuration preserved, offline archive integrity verified, non-system-drive empty directory required, no settings write on failure) and authentication locking (counts merged across entry points, blocks kept until manual clear, no password text stored, query rows not mistaken for auth errors).
- Tightened skill guidance on UAC denial, service restarts, memory writes, TLS downloads, process stops, forensic pristine claims and mtime-based ownership; archive purge is protected from copied manifests and failed restores; release gates verify the selected tag and shipped catalog sources.

### Contributors / 贡献者
- @liushikuan63

## [0.0.10] - 2026-10-31

### 中文摘要
- 新增 RECHECK 复核协议：重新取证、用不同盲区的方法交叉核对、明确未验证项、按覆盖范围收敛；对「再次检查/循环审查/质疑旧成功结论」类请求追加协议摘要，普通轮输出不变。
- 区分真实复核请求与否定、定义、例句、引文和代码块；修复标准输入按字节分块时中文被破坏的问题；已有同范围修复授权继续有效，不重复索取批准。

### English Summary
- Added the RECHECK protocol: renewed evidence gathering, cross-checks with independently blind methods, explicit verification gaps and coverage-based convergence; supported repeated-check requests and challenges to prior success reports receive the protocol summary while ordinary turns stay unchanged.
- Real recheck requests are distinguished from negations, definitions, examples, quotations and code blocks; UTF-8 input survives byte-split stream chunks; existing same-scope authorization stays valid without duplicate approval asks.

### Contributors / 贡献者
- @liushikuan63

## [0.0.9] - 2026-10-31

### 中文摘要
- 修复上一版引入的回归：双重否定或反问形式的成功说法（「没有不通过」「不是通过了吗」）不再无证据放行；只有否定直接作用于结果时才按失败结果处理。
- 「不是全部通过」「无法通过」等常见失败说法正确识别为失败结果；「无头」「非阻塞」等修饰词与因果前件不再误判为双重否定。

### English Summary
- Fixed a regression from the previous release: double-negative or rhetorical success wording no longer passes without verification evidence; a negation counts as a failed outcome only when it applies directly to the outcome.
- Common failure wording such as "not all passed" and "could not pass" is correctly treated as failure; headless/non-blocking modifiers and causal antecedents are no longer mistaken for double negation.

### Contributors / 贡献者
- @liushikuan63

## [0.0.8] - 2026-10-31

### 中文摘要
- 国际化验证更准：命名空间别名与块内初始化后的翻译绑定正确识别，改写过的方法不再当作已翻译证据；static 块作用域隔离，初始化/赋值/解构按 JavaScript 求值顺序处理；递归调用作用域明确标为未验证。
- 测试与构建命令按真实命令边界识别：字符串、注释、未执行分支、拼接控制词与吞错不再冒充测试证据；带等号的 Node 帮助/版本查询、依赖安装与单独清理都不计入。
- 可见字面量问题按源码节点去重，重复调用不再虚增基线旧债；完整短回复按全文检查证据，失败结果与成功主张分开处理。

### English Summary
- More accurate i18n verification: translator bindings survive namespace aliases and block-scoped initializers, overwritten methods no longer count as translation evidence, static-block scopes are isolated, initializers/assignments/destructuring follow JavaScript evaluation order, and recursive call scopes are explicitly marked unverified.
- Test and build commands are recognized at real command boundaries: quoted text, comments, skipped branches, concatenated control words and masked failures no longer masquerade as test evidence; equals-form Node help/version queries, dependency installs and standalone cleaning are excluded.
- Visible-literal issues dedupe by source node so repeated calls cannot inflate baseline debt; complete short replies are checked as full text, and failed outcomes stay distinct from success claims.

### Contributors / 贡献者
- @liushikuan63

## [0.0.7] - 2026-10-30

### 中文摘要
- 修复 `var` 初始化、循环隐式赋值与解构成员写入后仍沿用旧翻译绑定的问题。
- 约定来源与检查输入按原始字节计算指纹，UTF-8 BOM 与 Git 暂存内容变化不再被文本解码掩盖。
- 正确识别 Node 绝对路径与测试入口：短路未执行、吞掉失败或 here-document 文本不算测试成功；目录型脚本模块按单条目计数，不再误报包文件缺失。

### English Summary
- Fixed stale translator bindings after `var` initializers, implicit loop assignments and destructured namespace-member writes.
- Convention sources and check inputs are fingerprinted from raw bytes, so UTF-8 BOMs and staged Git blob changes are no longer masked by text decoding.
- Absolute Node executables and the test entry point are recognized correctly: skipped branches, swallowed failures and here-document text do not count as successful tests; directory-based script modules count as single catalog entries instead of false missing-file reports.

### Contributors / 贡献者
- @liushikuan63

## [0.0.6] - 2026-10-30

### 中文摘要
- 原生验证答复必须对应完整展示的提案，并记录提案来源消息，防止答复绑错对象。
- 循环与 switch 中的国际化绑定按词法作用域解析（含 `var` 提升），静态未知文本不算已翻译；本地检查命令或其声明输入变化时约定回执自动失效。
- 验证基准按开发集与保留集分开统计，轻量档保留集须独立满足提速门槛。

### English Summary
- Native verification answers must follow the complete displayed proposal, with the proposal's source message recorded so answers cannot bind to the wrong object.
- i18next bindings resolve by lexical scope in loops and switches (including `var` hoisting), static-unknown text never counts as translated, and convention receipts invalidate when a selected check executable or its declared inputs change.
- Verification benchmarks report development and holdout splits separately, with the light holdout plan required to meet the speed threshold independently.

### Contributors / 贡献者
- @liushikuan63

## [0.0.5] - 2026-10-30

### 中文摘要
- 新增按需采用的项目约定检查：国际化、编码风格、工具、依赖与版本约束，绑定规则来源与任务级选择；配套验证选档、人工待验清单与配对基准评估。
- 国际化计划漏掉必需约定覆盖的文件时直接拒绝；目录型脚本依赖在安装中保留锁定，第三方环境需求单独报告；草稿发布按 REST 发布 ID 创建与确认。
- 公开调用约定随技能与安装说明分发，本地 docs 不入包；源码发布不自动启用现役客户端流程。

### English Summary
- Added opt-in project convention checks for internationalization, coding style, tools, dependencies and version constraints, bound to rule sources and task-level decisions, with adaptive verification tiers, manual verification handling and paired benchmarks.
- i18n plans missing files covered by a required convention are rejected; locked directory-based script dependencies survive catalog installation with third-party setup reported separately; draft releases are created and confirmed by REST release ID.
- Public usage contracts ship with the skills and installation guide while local docs stay out of the package; source releases never auto-enable live client workflows.

### Contributors / 贡献者
- @liushikuan63

## [0.0.4] - 2026-10-29

### 中文摘要
- 敏感扫描增强：JSON 凭据键解码后扫描、嵌套压缩包有界展开、不一致的 ZIP 目录直接拒绝。
- 安装前预检依赖与跨层重复，失败后回滚文件与索引；包校验豁免从分发源读取而非接收方 HOME；记忆合并保留删除意图、冲突导入写前拒绝；只读审计不再写心跳，验证失败以非零退出码传播。
- 版本文档、完整技能描述与依赖元数据从公开包源生成；MCP 离线组件拆为带独立校验和的可选附件；可恢复下载与完整交付校验合并为一个维护入口，认证失败不重试。

### English Summary
- Stronger secret scanning: JSON credential keys scanned after decoding, nested archives expanded with bounds, and inconsistent ZIP directories rejected.
- Installation preflights dependencies and cross-tier duplicates and rolls back files and indexes on failure; package validation exemptions load from the distributed source instead of the recipient's HOME; memory merges preserve deletion intent and refuse conflicting imports before writing; read-only audits stop writing heartbeats and verification failures propagate as nonzero exits.
- Versioned docs, full skill descriptions and dependency metadata generate from public package sources; MCP offline components ship as an optional ZIP with its own checksum; resumable download and full delivery verification share one maintainer entry point, and authentication failures are never retried.

### Contributors / 贡献者
- @liushikuan63

## [0.0.3] - 2026-10-28

### 中文摘要
- 新增两个按需技能：注入上下文无损瘦身（量化→备份→只压叙述不删判据→覆盖断言→双侧同写验收）与双侧记忆分叉修复（先测行集包含关系再分档处置）。
- 全局规则瘦身至 160 行：只压叙述与重复条款，阈值、命令与硬禁止词逐条保留；新增超红线时按层级优先级转索引的处置顺序。
- 周检新增记忆索引超 200 行告警，提示索引可能被客户端截断加载。

### English Summary
- Added two on-demand skills: lossless slimming of per-turn injected context (measure, back up, compress prose without dropping criteria, assert coverage, verify both sides) and two-sided memory divergence repair (test line-set containment first, then tiered handling).
- Global rules slimmed to 160 lines by compressing prose and duplicates only, keeping every threshold, command and hard prohibition; added the priority order for converting overflow into indexes.
- The weekly audit now warns when the memory index exceeds 200 lines, since clients may silently load only part of it.

### Contributors / 贡献者
- @liushikuan63

## [0.0.2] - 2026-10-28

### 中文摘要
- 建立完整发布链路：推 tag 触发发布门禁，构建带版本顶层目录的 ZIP 与 SHA-256 校验和并附到 Release；远端资产按下载内容而非文件名比对，已发布附件永不覆盖，修复以新补丁版本发布。
- 新增 CHANGELOG 与 README 下载区/版本表，用户无需克隆即可选版本下载；包与资产名不含空格，避免平台改写。
- 常驻技能精简到 12 个但不删除任何技能；catalog 从公开包源生成并先校验 schema；修复资源查找、零写预演、迁移范围与索引失败上报；敏感扫描消除版本号/相对路径误报。

### English Summary
- Established the full release pipeline: pushing a tag runs the release gate, builds a versioned-top-folder ZIP with a SHA-256 checksum and attaches both to the Release; remote assets are compared by downloaded content rather than name, published assets are never replaced, and fixes ship as new patch releases.
- Added the CHANGELOG plus a README download section and version table so users can pick a version without cloning; package and asset names contain no spaces so the platform cannot rewrite them.
- The resident set was reduced to 12 without deleting any skill; the catalog generates from public package sources with schema validation before registration; fixed resource lookup, zero-write previews, migration scopes and index-failure reporting; secret scanning no longer flags versions or relative paths.

### Contributors / 贡献者
- @liushikuan63
- @YuneTech — README pull request / README 改写 PR 提交者。
- @Owsmyf — commit author (`Maverick`) / Git 提交作者。

## [0.0.1] - 2026-10-27

### 中文摘要
- 首次开源发布（MIT 许可）：123 个技能分为常驻层与按需库，87 个带自测的守卫/打包/校验/桌面自动化脚本，10 个指令、2 个子智能体、20 份领域与流程规则。
- 提供五类事件的 hook 接线模板与仅占位的 MCP 配置；随包附脱敏记忆导出与离线 MCP 资产；安装从双语 README 开始。

### English Summary
- First open-source release under the MIT license: 123 skills split into a resident layer and an on-demand library, 87 scripts covering self-tested guardrails, packaging, validation and desktop automation, plus 10 commands, 2 sub-agents and 20 domain/process rule files.
- Ships hook wiring templates for five events and placeholder-only MCP configuration, a de-identified memory export and offline MCP assets; installation starts from the bilingual READMEs.

### Contributors / 贡献者
- @liushikuan63

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.2.1
[0.2.0]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.2.0
[0.1.7]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.7
[0.1.6]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.6
[0.1.5]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.5
[0.1.4]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.4
[0.1.3]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.3
[0.1.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.2
[0.1.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.1
[0.1.0]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.1.0
[0.0.8]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.8
[0.0.7]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.7
[0.0.6]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.6
[0.0.5]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.5
[0.0.4]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.4
[0.0.3]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.3
[0.0.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
