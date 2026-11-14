# 实例：Qoder-Optimization 0.1.7 超长任务合并接管

本范式的一次完整落地。主线流程见 `../SKILL.md`；本文件只放本次的具体身份、读数、踩坑与入口，作后续同类任务的对照样本。

**占位约定（本文件已脱敏，可直接复用到别的机器）**：`<repo-root>`＝公开包仓库本地根目录；`<tmp-root>`＝该机唯一临时根（本机策略是「临时产物只写临时根、不写系统盘」，具体盘符由使用者自定）。制作端的会话 ID、内部任务编号、进程 PID 与本机配置哈希一律不写入本文件；可公开核对的出处锚点是下文提交哈希。读数原始出处＝制作端任务工作队列（合并接管块）、验收矩阵文档与当轮 transcript；工作队列与 `docs/` 均**不随包**，接收者按提交哈希与本文读数对照即可。

## 1. 三个任务的身份

- **A 批**（自进化收口）：自进化候选修复（A29–A34 / A57 / A60）＋守卫写入侧负载超时窄修＋全量套件＋现役两侧同步＋文档对账＋证据登记。入口 `<tmp-root>/evolution-fixes/`。
- **B 批**（通读与出包）：通读覆盖在最终 HEAD 重闭＋C8 七卡 40 格逐卡实施验收＋最终 HEAD 冻结树出包四道门禁＋0.1.5→新版升级实测。入口 `<tmp-root>/qo-read-ext/`、`<tmp-root>/qo-t15-evidence/`、`<tmp-root>/qo-c8/`、`<tmp-root>/qo-upgrade/`。
- **合并接管**：停两原会话、单会话串行接管 A＋B，延伸到发布 0.1.7＋现役三路合并部署＋图像识别/OCR 离线 bundle 入包。入口 `<tmp-root>/qo-merge/`。

## 2. 死锁真因（范式 §1 的实例）

B 批恢复 ④⑤ 的唯一放行判据 `QUIET_EXT`＝「A 批证据目录静默 ≥600s ＋ 工作区脏＝0」。A 批持续产新候选（A57→A59/A60）并部署现役 ⇒ A 证据目录永不静默 ⇒ B 永远不放行。合并为单会话串行即解除（出处：工作队列合并理由行）。

接管时继承的分离进程 `a60-mutants.cjs` 在停会话后仍存活继续跑，**保留让它跑完**，其 `a60-mutants.exit` 正是 A 批第一格判据。首次 v13 套件是**主动中止**（对抗审查抓出 A60、被测字节要变），不是崩溃 ⇒ 无需另查根因。

## 3. 具体处理方式与读数（磁盘 .exit，不经管道）

- **A60 守卫负载窄修**：deadline 6500→5500、新增 `CUA_GUARD_SPAWN_RESERVE_MS`（默认 1200）、`budget()` 扣余量、四个起进程原语＋powershell 回落＋重试＋readSettled 全过 `noTimeToSpawn()` 门控。拦截范围/deny 文案/fail-open 一字未动，计时判据一条未放宽。测试 115→130 条。提交 `9caa22f`（只加 `scripts/cua-cursor-guard.js`＋`.test.js`，并行会话的 13 项改动未动）。
- **负载 A/B 单变量证明**：第二轮 `a57-load-ab-m2.exit` 为 0、18 PASS、0 红、`VERDICT=A57_LOAD_FIX_VERIFIED`；loaded(load=8) 130/130、idle 130/130、oldwrite 负对照 exit 1 且 FAIL=2 全在写入侧（write=2 deadline=0 read=0）⇒ 单变量成立。机制取证 `probe-overshoot.log`／`probe-cost.log`：load=8 时 OS 创建 node 段 preChild 904–1387ms 落在任何进程内时钟之外（换时钟无用）。
- **全量套件 v13**：`full-suite-v13.exit` 为 0、durationMs 1346428（22.4min）、headStable=true（起跑/跑完均 `952c30f`）、worktreeCleanAfter=true；70 条 `EXIT=` 零非零，三段 global/skill/contracts 全 EXIT=0；`SUMMARY total=67 green=67 red=0`。守卫字节在 `9caa22f` 变 ⇒ 发布前在最终 HEAD 重跑（v23）。
- **最终 HEAD 套件 v23**：`full-suite-v23.exit` 为 0、67/67；验收器 `accept-suite-v23.log` 52 PASS、0 红。v22 曾红（硬编码计数，见 §4），保留为诚实缺陷证据。
- **出包四道门禁**：`GATES_GREEN_82cfcea` 16/16（build-release＋引用完整性＋pkg-verify＋secret-scan＋pkg-truth＋sidecar）。
- **升级实测**：0.1.5→0.1.7，26/26 CLEAN（`install-upgrade-test-v4`，old=0.1.5/new=0.1.7）。
- **发布 0.1.7**：Release 六资产（core/offline/OCR 各 zip＋sha256），publish 36/36，下载件 sha256 与本地构建一致；main 推至 `82cfcea9477c28b42cc569221cbba036fb98698c`。
- **三路部署**：KEEP 261 / REVIEW_UPDATE 41 / SKIP 18 / UPDATE 1（`script:workflow-profile.cjs`，现役==旧 pristine）；deploy verify 20/20、两侧 scope CLEAN、现役自测 8/8；41 项 REVIEW_UPDATE 逐字节保留本地；两侧 `settings.json` 各自基线哈希 KEEP 未动；CN 侧 junction realpath 解析到同一真源。
- **对账与证据**：`doc-disk-reconcile` 到 `DOC_DISK_CONSISTENT` pending=0；证据登记 merge keep=830 / evo keep=423 missing=0。

## 4. 具体踩坑与修复（范式 §7 的实例）

- **硬编码计数假绿**：`scripts/skill-trigger-uniqueness.test.js` 写死 `result.skills===133`，0.1.7 新增 image-detail-inspect 后真值 134 ⇒ v22 套件 global EXIT=1。修复：改「现算目录全量」（`skills/*/SKILL.md` 目录数，与 scan 同一来源，scan 漏扫仍红），`.github` 下限同步 134。提交 `82cfcea`。不是放宽——断言仍可失败。
- **对账器引用语法**：首版文档引用用 `pass=N fail=M`（被读成「N fail」）、`4/4`/`782/779` 比值、裸 `VERDICT=CLEAN`、通配 `deploy-v22-*-scope.exit`（幻影 scope.exit）、证据目录外的 `expected.json` ⇒ 22 红→2 红。修复：改对账器认的语法（`X.exit 为 N`、`X.log 为 N PASS、0 红`、点名段、一句一号、文件名须在证据目录内），并把 ab-score 产物并入 merge 目录重登记 ⇒ CONSISTENT pending=0。
- **运行时缓存件误判越界**：`umid-cache.json`（设备 machineToken 缓存）被客户端在快照间刷新，不在 catalog ⇒ INTL scope 判越界。修复：`deploy-snap.cjs` 加 `EXCLUDE_ROOT_FILES=['umid-cache.json']`＋「排除件∉获准落地清单」断言＋保留幻影负对照。不是放宽。该文件含设备令牌，**不回显、不进一步持久化**。
- **生成文档漂移门禁红**：OCR 章节写在 README `offline-bundle` 块之后，pack-share-extras 规范化把块移到末尾 ⇒ 漂移。修复：`--apply` 把章节移到块前（内容逐字保留），重跑 doc-test-tally 13/13，提交 `f8dff3f`。
- **pkg-truth V-6 红**：CHANGELOG 缺 `[0.1.7]:` 脚注 ⇒ 补，提交 `a2617a8`。
- **升级 v3 ABORT**：误把 0.1.6 当 old，但 v3 是为 old=0.1.5/new=0.1.6 建的 ⇒ 生成 v4（new 字面 0.1.7）、old 用 0.1.5 ⇒ 26/26 CLEAN。
- **stop-gate R13 误报**：把三路部署（capability-advisor 哈希三分类）误判成 merge-inbound-qoder-package 文本合并，要求逐文件 AskUserQuestion 重开已授权决策。处理：按范式 §9——机制非授权来源，41 分歧件已逐字节保留本地、唯一 UPDATE 是无分歧 pristine 件，R13 想防的「未经审阅覆盖本地」未发生；报告差异、不重开已授权完成的工作、不重复问已答项。
- **polling 冲动**：反复重读套件日志浪费轮次 ⇒ 改靠 Monitor/背景通知，退出码落盘后一次性现读。
- **网络代理残留**：为连通隐藏启动的本地代理客户端改了系统代理位 ⇒ 用户授权恢复无代理基线（ProxyEnable=0、停 GUI 与 Core 进程，helper 进程不动），只读核实本地代理端口静默。

## 5. 收尾与边界

- v17 冻结 worktree 按显式单条路径移除并验收；`head-check`（`196b8e4`，属并行会话）全程不动；main clean 于 `82cfcea`。
- 临时产物按精确路径清理（`--only`）＋负对照（保护目录存在、目标已删）；临时物只写唯一临时根 `<tmp-root>`，不写系统盘。
- 登记待审项（非本轮工作）：CN 侧跨端 rules-reminder 接线按用户口径「保持原样」，等后续批准。
- 诚实边界：v22 红保留为缺陷证据；`docs/` 被 gitignore ⇒ 文档回填不产生提交；引用历史结果均标出处。

## 6. 关键入口

- 合并队列：`<repo-root>/.qoder-work-queue.md`（合并接管块，不随包）。
- 验收文档：`<repo-root>/docs/evolution-learning/{spec,plan,tasks,验收矩阵}.md`（不随包）。
- A 批脚本：`<tmp-root>/evolution-fixes/`（`a60-mutants.cjs`、`ab-cua-load-a57.cjs`、`a57-live-sync.cjs`、`doc-disk-reconcile.cjs`、`extend-evidence.cjs`）。
- B 批脚本：`<tmp-root>/qo-read-ext/`、`<tmp-root>/qo-t15-evidence/`、`<tmp-root>/qo-c8/run-card.cjs`、`<tmp-root>/qo-upgrade/install-upgrade-test-v4.cjs`。
- 发布/部署：`<tmp-root>/qo-merge/`（`run-gates-3796ab5.cjs`、`publish-v017.cjs`、`deploy-snap.cjs`、`deploy-v22-verify.cjs`、`accept-suite-v23.cjs`）。
- 公开可核对锚点：提交 `952c30f`（A60 首修）、`9caa22f`（A60b 负载窄修）、`3796ab5`（0.1.7 入包）、`f8dff3f`（生成块顺序）、`a2617a8`（CHANGELOG 脚注）、`82cfcea`（计数判据派生真值）。