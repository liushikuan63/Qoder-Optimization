# hooks 接线（三层机制里的"机制"层，不接不生效）

`scripts/` 里的守卫脚本**只放在磁盘上不会自己跑**——必须在 `settings.json` 的 `hooks.<事件名>` 里接线。
本目录给一份改占位符即可用的接线：`hooks.example.json`（把 `<客户端目录>` 换成你**实际安装的那一个**——`~/.qoder`（国际版）或 `~/.qoder-cn`（CN）；把 `<node>` 换成 node 绝对路径），
并**并入** `settings.json` 的 `hooks` 段（已存在别整文件覆盖）。
**只装了一个客户端**（单端装配）：`<客户端目录>` 全换成那一个（`.qoder` 或 `.qoder-cn`），**另一侧不要建目录、也不要挂第二份**。
脚本里的状态 / 台账 / 索引按 `scripts/client-root.js` 解析到 HOME 下**实际存在**的那一侧；同步类脚本发现只有一侧时只报"单端模式"并退 0，不会 mkdir 出另一个目录。
双客户端都装才各挂一份：只挂一侧会让另一侧静默失效，周检的"两侧接线一致性"就是查这个。

完整安装优先使用 `node scripts/install-package.cjs --profile complete --yes --client-root <客户端目录>`，实际命令为可执行文件+args，不经 shell；模板保留给高级手工/兼容用途。完整 profile 的开台体检只检查本客户端托管规则、16 条接线与必要文件，不依赖私人记忆、另一客户端或 Bash。制作端第 17 条私人 BYOK 守卫不在公开包；账号和外部服务各用自己的配置。

## 事件 × 脚本（公开通用完整工作流）

| 事件 | 脚本 | 超时(s) | 作用 |
|---|---|---|---|
| `UserPromptSubmit` | `rules-reminder.js` | 10 | 每轮注入精简纪律（最易被忽略的兜底）+ 回注本轮请求原文 + 目标候选 / 自进化采集 / 工作方式模型判断（新装默认 `--workflow-mode model`；回退 route 时为 B05 关键词选档触发）；命中"再次检查 / 重复检查 / 循环检查"等复核词时追加复核协议摘要（`recheck-protocol.cjs`，普通轮不追加） |
| `UserPromptSubmit` | `session-budget.js` | 10 | 上下文体积 / 压缩次数 / 接续队列分档提醒 |
| `UserPromptSubmit` | `fact-ledger.cjs --hook` | 10 | 硬事实登记簿：把 ≤12 条长期硬约束按目录隔离注入每轮；无登记时**零输出**（不占 token）；`/fact` 增删查清 |
| `Stop` | `stop-gate.js` | 15 | 收尾门禁：拦住"声明下一步却没做 / 该弹窗没弹 / 无视觉证据 / 明确记忆请求无成功证据 / 无主张踢皮球"；检索到可安装/可更新条目却未询问、发布后未询问部署也拦；**自进化两条**：`R18` 拦"已沉淀为规则/技能"却无本轮成功写入证据，`R19` 拦"采集已生成够格新候选却没把建议弹窗交用户拍板"（只读/交接/禁记忆/暂停轮放行，30 分钟窗口内同规则最多拦 2 次后写 `-SUPPRESSED` 台账可见放行）；只读 / 交接 / 旧队列不催办 |
| `Stop` | `evolution-capture.cjs` | 20 | **自进化确定性采集**：每轮收尾把用户长期偏好 / 重复纠正、工具与 MCP 缺口、同一错误重复失败、助手 `已否证：`/`验证结论：` 笔记脱敏后追加到 `evolution/inbox.jsonl`（候选，`verified:false`），并给出规则/技能/MCP/hook 载体路由建议。**只写候选、心跳与待弹建议，绝不改规则/技能/settings/memory，永不拦截**；只读 / 仅交接 / 禁记忆轮零候选；暂停开关 `evolution/control.json` 的 `enabled=false` 或开关损坏时停采集。判据与提醒层、门禁 R19 共用 `evolution-signal-core.js`。**本轮新增且够格**的候选写 `tmp/evolution-capture/pending-<会话前8位>.json`（≤6 条、24h 过期）交门禁 R19 强制弹窗；本轮已弹过建议卡则不再追加（每轮最多问一次）。`--report [--json]` 只读体检（含 pending/declined）、`--dry-run --transcript <file>` 零写入演算（输出 `wouldPopup`）、`--decline <主题>` 登记用户跳过（只过滤弹窗，inbox 证据保留） |
| `SessionStart` | `global-config-guard.js` | 15 | 开台体检：两侧漂移 + 悬空引用（含 `skills/<技能>/scripts/x` 形态），健康时零输出 |
| `SessionStart` | `session-budget.js` | 10 | 同上（开会话时也看一眼预算与磁盘水位） |
| `PreToolUse` | `edit-guard.js` | 10 | 改不可回滚文件前的备份提醒（advisory，不拦截）；命中技能 / 规则 / 记忆 / hook / MCP / agent 等载体目录时追加 `carrier-preflight` 提醒 |
| `PreToolUse` | `huge-output-guard.js` | 10 | 拦"整读大文件 / 无输出限流"的命令（防大会话被传输层掐断） |
| `PreToolUse` | `commit-scope-guard.js` | 10 | 拦 **`git commit … -- <路径>` 且这些路径在工作区还有未提交改动**：带 pathspec 的提交取的是工作区内容，会绕过 `git update-index --cacheinfo` 暂存好的 partial blob，把并行会话的在途改动扫进这次提交。`git` 与 `commit` 之间的全局选项（`-C <path>`、`--git-dir=`、`--work-tree=`、`-c k=v`）同样识别，cwd 取 `-C` 指定的路径。**它不管 `git add -A` / `.`**——那条禁令属 AGENTS 与 `ship-clean-pr`，放行是正确行为 |
| `PreToolUse` | `cua-cursor-guard.js` | 10 | 拦手搓 Win32/SendInput 级桌面原语，改走 CUA 驱动 |
| `PreToolUse` | `risky-match-guard.js` | 10 | 拦按模式/镜像名杀进程、无 WHERE 的破坏性 SQL 等匹配型危险操作；**还兼作两个门禁的 Pre 入口**：① 认证锁库（末尾委托 `auth-lock-core.js`；core 缺失时该半边会静默失效，故崩错写进本守卫台账 `auth-lock-pre-error|...`，开关 `~/.qoder/auth-lock-guard.json`）② **记忆优先**（本会话一次记忆都没读过就要动远程 / 数据库 / 服务启停 / 对外部署时，拦一次并给出查记忆指引；每类只提醒一次，读过记忆即静默放行；关：本守卫配置文件写 `{"memoryFirst":false}`，整守卫关是 `{"disabled":true}`）。**覆盖面边界（F18c）**：长选项 `rm --recursive --force dir/*` 与 SQL 注释插入 `DELETE /*c*/ FROM t` 已纳入判据；但**变量间接化**（`RM=rm; $RM -rf dir/*`）静态匹配求解不了，属已知边界、会**放行**——这类命令仍须人工先预览命中清单，别把本守卫当完整安全边界 |
| `PreToolUse` | `win-path-guard.js` | 10 | 拦 Bash 命令里混进 Windows 原生路径（`C:\…` 交给 Git Bash 会变成 `C:…`）与盘符形态误判；命中就给可粘贴的 `/c/…` 改法。本机 matcher `^Bash$` |
| `PostToolUse` | `cua-cursor-guard.js` | 10 | 同上（提交后再兜一道） |
| `PostToolUse` | `auth-lock-guard.js` | 10 | **认证失败计数器**：只看工具返回里的认证/锁定类签名，按目标（服务别名/主机/账号任一相同）累计，满 3 次后由上面那个 Pre 入口硬拦该目标的一切连接动作（防"重试到把数据库账号锁死"——锁定阈值约 10 次，且只能人工解锁）；`--status` 查看、`--clear ALL` 人工解除。可选 `matcher` 缩小触发面（本机用 `^Bash$|mcp_call|mcp__dbhub__.*`） |
| `PostToolUse` | `attempt-lock-guard.js` | 10 | **同类连败计数器**：判据在 `attempt-lock-core.js`，同一目标（family + 去开关后的前三个词）连续失败 3 次即由 Pre 入口硬拦下一次同类调用，成功一次清零；覆盖构建 / 测试 / 部署，不限于数据库认证。解封 `attempt-lock-guard.js --clear`，关 `~/.qoder/attempt-lock.json`。本机 matcher `^Bash$` |
| `PostToolUse` | `tool-payload-guard.js` | 10 | **返回侧体积**：单条工具返回 >2MB（`TPG_BYTES`）当场提示改用摘要推进，同会话同工具只提醒一次；补 Pre 守卫拦不住的"返回才知道多大"。本机 matcher `^Bash$|^Read$|^Agent$|^Task$|mcp_call` |

## 模板脚本与安装 ID

`complete` 安装器已事务安装下表全部公开通用脚本及依赖，并生成绑定客户端的 exec 接线；不要再复制模板造成重复。`routing` 只含 `rules-reminder.js` 及路由依赖，需其他守卫时可显式升级 `--profile complete`，或按下表高级手工安装。安装命令在解压包根目录执行，`pkg-catalog` 会补齐依赖。

| 脚本 | catalog ID | 安装 |
|---|---|---|
| `rules-reminder.js` | `script:rules-reminder.js` | 基础安装已含 |
| `session-budget.js` | `script:session-budget.js` | `node scripts/pkg-catalog.cjs install script:session-budget.js --apply` |
| `fact-ledger.cjs` | `script:fact-ledger.cjs` | `node scripts/pkg-catalog.cjs install script:fact-ledger.cjs --apply` |
| `stop-gate.js` | `script:stop-gate.js` | `node scripts/pkg-catalog.cjs install script:stop-gate.js --apply` |
| `evolution-capture.cjs` | `script:evolution-capture.cjs` | `node scripts/pkg-catalog.cjs install script:evolution-capture.cjs --apply`（依赖 `script:evolution-signal-core.js`、`script:parallel-context-redact.cjs`、`script:client-root.js`、`script:hook-crash-guard.js`，随依赖一并装入） |
| `global-config-guard.js` | `script:global-config-guard.js` | `node scripts/pkg-catalog.cjs install script:global-config-guard.js --apply` |
| `edit-guard.js` | `script:edit-guard.js` | `node scripts/pkg-catalog.cjs install script:edit-guard.js --apply` |
| `huge-output-guard.js` | `script:huge-output-guard.js` | `node scripts/pkg-catalog.cjs install script:huge-output-guard.js --apply` |
| `commit-scope-guard.js` | `script:commit-scope-guard.js` | `node scripts/pkg-catalog.cjs install script:commit-scope-guard.js --apply` |
| `cua-cursor-guard.js` | `script:cua-cursor-guard.js` | `node scripts/pkg-catalog.cjs install script:cua-cursor-guard.js --apply` |
| `risky-match-guard.js` | `script:risky-match-guard.js` | `node scripts/pkg-catalog.cjs install script:risky-match-guard.js --apply` |
| `win-path-guard.js` | `script:win-path-guard.js` | `node scripts/pkg-catalog.cjs install script:win-path-guard.js --apply` |
| `auth-lock-guard.js` | `script:auth-lock-guard.js` | `node scripts/pkg-catalog.cjs install script:auth-lock-guard.js --apply` |
| `attempt-lock-guard.js` | `script:attempt-lock-guard.js` | `node scripts/pkg-catalog.cjs install script:attempt-lock-guard.js --apply` |
| `tool-payload-guard.js` | `script:tool-payload-guard.js` | `node scripts/pkg-catalog.cjs install script:tool-payload-guard.js --apply` |

安装后运行 `node ~/.qoder/scripts/global-config-guard.js --check`（`~/.qoder-cn` 同理），它会把接线指向不存在脚本的情况报出来。

## 还需要知道的

- `hook-crash-guard.js` **不需要单独接线**：它是被其它 hook 脚本 `require` 的库（`require("./hook-crash-guard.js").install("<名字>")`），把崩溃写进 `hooks-crash.log` 交给周检，保持 fail-open 语义。
- `byok-modelconfigs-guard.js` 也不接线：手动或周检调用的工具。
- **工作方式模型判断（新装默认，可回退 route）**：安装器新建接线默认追加 `--workflow-mode model`，`hooks.example.json` 同样默认 model；已有接线保留原模式（route/model），升级不强制切换。省略参数或使用 `--workflow-mode route` 时回到关键词路由。当前主会话模型从完整需求和最小现场证据判断并行、目标、验证选档、成文；关键词只提供候选数据，不另调云模型。model 模式仍保留 B05 选档提示、目标候选与能力候选；文档、目标并入开工确认卡（`kickoff-core.cjs`）一次问全；只读检查可并行、无需征求，正式开工的并行写入仍要加问确认；结构化判定是语义补充，不替代 AskUserQuestion。
  - hook 输出本轮 `WORKFLOW_CONTEXT` 和 `WORKFLOW_BINDING`。模型提供结构化建议，调用 `node scripts/capability-advisor.cjs --workflow-decision <request.json或-> --binding <本轮值> --json` 校验；`-` 从 stdin 读取，只读任务不需落盘。结果仅为建议，不是操作授权；自评 confidence 和来源引用也不证明模型正确。
  - 绑定完整请求摘要哈希、请求 ID、会话、工作区和本轮随机 ID；过期/错绑/额外授权字段拒绝，证据不足返回 `NEEDS_FACTS`（退出 1），坏输入退出 2。保留明确否定与只读约束，模块/身份缺失不悄悄切回关键词自动启用。
  - 并行复用 `parallel-plan` 的依赖与资源校验；只读任务只展示计划，不能写计划文件或派发。文档、目标并入开工确认卡（`kickoff-core.cjs`）一次问全；只读检查可并行、无需征求，正式开工的并行写入仍要加问确认（写入收敛单会话）；目标先核对活动目标和原始授权，成文先核对需求与现有文档；未确认按不建目标、不成文处理。已有适用选择复用，继续任务不重新弹出同一组问题；模型不创建目标、不派发、不安装、不发布。
  - 验证复用 `verification-policy`，不能删必需/用户检查，外部动作保留完整检查清单；无 `resolveAuthority` 仍是咨询模式，不宣称原生授权链通过。判断为 skip 只省略可选选档，原验证纪律仍生效。框架正负回归不能证明所有模型都比原路由稳定，需用冻结案例和真实模型输出单独比较。
  - 回退只移除 `--workflow-mode model` 或改为 `route`；也可在安装完成后运行 `node scripts/install-package.cjs --workflow-mode route --yes` 显式切换（`model` 同理）；不删除旧入口、接线、用户数据或权限。相关回归：`.github/capability-advisor.test.js`、`.github/capability-trigger.test.js`、`.github/package-activation-install.test.js`。
- **B05 自动选档（model 默认，route 为回退路径，均并入 rules-reminder）**：model 模式每轮注入工作方式结构化输入，由模型判定 `verification: assess|skip`，同时运行 `verification-trigger-core.js` 的关键词兜底，命中可执行任务时照常注入【B05 自动选档 · 已触发】，保证显式询问不因模型漏判而丢失；route 模式仅走关键词判定。route 是关键词启发式，口语化动作、续接轮和只读请求可能不触发；需要每轮稳定判断时用 model（安装器新装默认）。不想要自动选档时写 `~/.qoder/verification-trigger.json` 的 `{"enabled":false}`。
- **能力主动路由**：主安装器安装 `rules-reminder.js`、`capability-advisor.cjs` 与检索依赖后，合并唯一 `UserPromptSubmit` 接线。相关已装能力询问是否使用，缺失仅通用或明确偏好才询问安装；无关/排除能力保持安静。用户明确指名直接读取入口，不重复问。同会话去重台账只证明提示投递；详情见[能力闭环](../skills/skills-router/references/capability-lifecycle.md)。
- **含混请求、理解确认与提示词纠正**：`ambiguity-core.cjs` 对短句、光杆动作和显式「指令/需求不清」做确定性初筛，命中后注入三档判别与 `/clarify` 纠正稿推荐；每轮提醒同时说明绝大多数场景可在开工前用一句话确认理解（至多一次）。除简单纯问答外的任务还会注入开工确认台账（`kickoff-core.cjs`）：允许先只读检查，但同一轮结束前必须出卡并完成 AskUserQuestion + record；未确认就写入或执行副作用命令会被 stop-gate R16 拦下，未出卡就收尾会被 R17 拦下。纯审阅/分析且无变更动词时按只读处理，不注入开工卡；同一轮一旦出现写入仍由 R16 只读守卫拦下。复杂卡的文档/目标选项带机读 `value`，`--record` 必须显式回传 `selections`，不再回落到卡片默认。请求绑定按 requestId、整段摘要、promptKey（前缀+长度）三路匹配，降低多消息或截断造成的失配。安装器会问一次是否常驻开工提示卡（`--kickoff-resident yes|no` 非交互指定），偏好可写成 `{schema:1,resident,inject,enforce}`：`inject=false` 不注入，`enforce=false` 只提示不硬拦（`resident` 作为兼容别名）；`install-package.cjs --status` 只读查看回执与当前偏好。台账可用 `kickoff-core.cjs --status [--session <id>]` 查看、`--gc [--days N] [--apply]` 预览或清理过期条目。纠正稿与理解确认都只是建议，不构成执行授权，且不得借改写扩大范围。`clarify` 命令带触发词并接入能力路由，相关请求会询问是否使用。
- **接续记忆与追回（continuity）**：`PreCompact` / `PostCompact` / `UserPromptSubmit` / `SessionStart` / `PostToolUse` 这 5 个 hook 不在本模板里，由 `scripts/install-continuity.cjs` 在用户明确同意后单独接线，不要从模板直接复制。同意的机器上安装器会同时写入 `<存储目录>/auto-bind.json`，新会话首个提示自动绑定；显式 `disable` 的会话不会被重开，`--no-auto-bind` 可只接线、保留按会话手动 `enable`。
- **拦截语义**：只有 `exit 2` 或 `deny` JSON 真拦截；其余非零退出码 / 超时 / 崩溃默认**放行（fail-open）**——别把 hook 当安全边界，硬权限仍交权限系统。
- **自证在跑**：每个 hook 都要能自证——`rules-reminder` 写心跳日志、各脚本带 `--selftest` 或 `.test.js`、`global-config-guard --check` 会报接线缺失与"指向不存在的脚本"。接完线**新开一次会话**再跑几轮，确认台账 / 心跳有记录。
- 说明全文见 `../scripts/README-rule-enforcement.md`（三层机制全貌与阈值/选型依据）。

## 两种等价接线形态：逐守卫多入口 vs dispatcher 单入口

本包同时随包 `scripts/pre-tool-dispatcher.js` 与 `scripts/post-tool-dispatcher.js`，两种形态**守卫逻辑零改动**，可任选其一：

| 形态 | 接线 | 适用 |
|---|---|---|
| 逐守卫多入口 | 按上表把每个守卫各挂一条 hook | 非 Windows、或 MSYS 进程数不是瓶颈的机器 |
| dispatcher 单入口 | `PreToolUse` 只挂 `pre-tool-dispatcher.js`、`PostToolUse` 只挂 `post-tool-dispatcher.js` | **Windows**：Qoder 用 Git Bash 包每个 hook，一次工具调用会并发拉起 6~12 个 MSYS 进程；MSYS2 挂载表共享段若在首个进程初始化中途被杀，之后每个 bash 自旋约 15.7s 后报 EPERM。dispatcher 用 node 原生 `spawnSync` 串行调用原守卫，把每次调用的 MSYS 进程数从 N 降到 1 |

- **等价性**：dispatcher 内部按原 settings 顺序调用同一批守卫，matcher 与超时逐条保留；缺失的守卫记 `skip-missing` 并继续（fail-open），不会因某个守卫未安装而整条失效。
- **continuity 是可选项**：`post-tool-dispatcher.js` 按 `CONTINUITY_CJS` 环境变量或 `<客户端目录>/scripts/continuity.cjs` 解析，**不硬编码任何本机安装路径**；未安装时自动跳过。
- **关闭**：`<客户端目录>/pre-tool-dispatcher.json` 或 `post-tool-dispatcher.json` 写 `{"disabled":true}`。
- **台账**：`<客户端目录>/tmp/{pre,post}-tool-dispatcher/decisions.log`。
- **体检**：`config-doctor.cjs` 的 `HOOK-DIFF` 比对的是**命令集合**，因此两侧分别采用不同形态时会报红——这是形态差异而非守卫缺失；`HOOK-ENTRY-MISSING` 才判「接线指向不存在的脚本」。要消除该红项，把两侧统一为同一形态（属现役配置改动，需单独批准）。

## 现役体检的只读巡检通道（周检 + 开台提示）

`config-doctor.cjs` 与 `skills-doctor.cjs` 查的是**现役客户端配置**，因此有一条独立于 CI 的巡检通道：

| 环节 | 载体 | 行为 |
|---|---|---|
| 定期巡检 | `scripts/rules-weekly-audit.js` 的 `checkLiveDoctors()` | 按 `client-root` 解析出的客户端 `scripts/` 目录，**无参数**只读运行两个 doctor（绝不触发 `fix` / `apply-sync`），把结论各记 1 条 finding |
| 台账 | `<客户端目录>/tmp/rules-audit/history.log` | 行尾追加 `doctors=<判红的 doctor 名，逗号分隔>`；健康时为空字段 |
| 开台提示 | `scripts/session-budget.js` 的 `liveDoctorNote()`（SessionStart） | 只在 `doctors=` 非空时出声并点名，健康时零输出；不重跑 doctor（开台预算），不自动修 |

- **为什么不进 CI**：`.github/run-tests.js` 用隔离 HOME 跑 `smoke-runner.cjs --tests-only`，四个 CHECKERS 全在 `if (!TESTS_ONLY)` 内被跳过——沙箱里没有现役配置，查了也无意义。`--tests-only` 的行为与本通道接线前完全一致。
- **单端合法**：doctor 脚本不在本机客户端目录时记 INFO 跳过，不判红、**不为了跑它去新建另一侧目录**。
- **判红不等于自动修**：巡检只报告。改现役 `settings.json`（含统一两侧接线形态）属现役配置改动，需单独批准。
- **可失败判据**：`scripts/rules-weekly-audit.test.js` 的 V29–V35（含「造一条 hook 接线漂移 → 巡检判红 → 还原复绿」的真实 config-doctor 负对照、`--no-fix` 零写入、exit 2 前置失败必须出声、单端不造目录）；`scripts/session-budget.test.js` 的「现役体检红项提示」四例（空字段静默 / 双红点名 / 旧格式台账兼容 / 单红只点名该项）。
