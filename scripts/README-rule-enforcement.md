# 全局规则强制层（机制化，不靠提示词）

**为什么有这套东西**：2026-09-19 复盘某真实会话轨迹（11266 行 / 4220 条助手消息 / 6 次上下文压缩），
发现"默认持续推进""裁决弹窗""前台必须截图""记忆随任务更新"四条规则在长会话里反复失效——
用户被迫说 18 次"按最佳方案继续进行"、两次追加纠偏。根因是这四条**只有提示词、没有机制**。
细则与取证见记忆 `rule-enforcement-mechanisms`。

## 组成

| 机制 | 入口 | 作用 |
|---|---|---|
| 每轮规则提醒 | `scripts/rules-reminder.js`（UserPromptSubmit） | 把首要纪律每轮重注入，抗压缩丢失与注意力衰减；并内置目标候选、自进化采集、含混初筛、理解确认与 `/clarify` 纠正稿推荐、B05 自动选档触发（新装默认 `--workflow-mode model`：结构化判定 + `verification-trigger-core.js` 关键词兜底；回退 `route` 时仅走关键词判定，可写 `~/.qoder/verification-trigger.json` 的 `{"enabled":false}` 关闭）及主动联网查证/工具获取提示。纠正稿与理解确认只作建议、不构成执行授权。禁止联网或引用不触发，只读/禁止下载只提示查证；hook 不联网、不下载或安装，不改变平台权限 |
| 停手门禁 | `scripts/stop-gate.js`（Stop） | 收尾文本命中 R1 停手等待 / R1b 声明下一步未做 / R2 裁决未弹窗 / R3 前台无视觉证据 / R4 明确记忆请求无成功证据 / R5 无主张踢皮球 / R6-R6c 队列与阻塞 / R7 大会话交接 / R8 记忆证据 / R10 安装更新未询问 / R11 发布后未询问部署 ⇒ `decision:block` 逼回正轨；只检查当前授权任务，只读/交接不催办 |
| 规则真源体检 | `scripts/global-config-guard.js`（SessionStart） | AGENTS.md 与 `rules/*.md` 两侧漂移、memory 分叉、规则里的悬空文件引用；健康时零输出。**两路 bash 检查共用一个 11s 截止线**（hook 只给 15s，各设 8s 会相加越界、被掐时连提醒都不输出）：到点跳过剩余项并明说「未检查」，检查器跑不起来（退出码非 0/1）也一律出声 |
| 会话体积与接续 | `scripts/session-budget.js`（UserPromptSubmit + SessionStart） | **三个独立信号**：① 体积 ≥8MB 节约模式 / ≥15MB **先落盘再继续** / ≥25MB **立即落盘**；② transcript 里 `isCompactSummary:true` 的**压缩次数** ≥1 条提醒落盘、≥2 条**落盘并继续**。体积说"会不会被掐断"，压缩次数说"已经丢过几次上下文"（context rot），**③ 上一回合的上下文增量**（≥2MB 报警，`SB_TURN_GROWTH_MB` 可调）说"上一回合灌得太快"——这是**返回侧入账**：读取侧守卫只拦"明显超标的单条"，拦不住多条中等返回累积。**已知局限**：增量只有回合粒度，看不出是哪一个工具贡献的（要单工具粒度需 PostToolUse，尚未接）。SessionStart 另注入两样：未完成的 `.qoder-work-queue.md` 接续点（文案是"**第一条未完成项就是你本轮的第一件事，直接接着做**"） + **看门狗**（见下行）。**为什么必须前移**：被掐断的回合到不了 Stop，R7 兜不住它要防的那件事。**文案定调**：落盘与换会话都是手段、都**不是收工信号**——到档位先落盘，**然后继续推进当前任务**，任务不停只是换个地方跑 |
| 看门狗（谁看住看门的人） | 同上，`session-budget.js` 的 SessionStart 分支 | 周检会查其它机制的心跳，但**周检自己没跑**（cron 失效 / 周一机器关机）没人知道。会话开台是与 cron **完全独立**的通道 ⇒ 用它查"周检上次成功是多久前"，超 `SB_AUDIT_STALE_DAYS`（默认 10 天，允许漏一轮不报）或台账根本不存在时在开局提示并给出手工命令 |
| **hook 崩溃可见化** | `scripts/hook-crash-guard.js`（各 hook 顶部 `require('./hook-crash-guard.js').install('<名字>')` 一行接入） | hook 抛错本来就是 **fail-open**（非 `exit 2` 不拦），但这意味着**一个坏掉的守卫可以连着几周"看着没事"**：不响、台账不涨，也没人知道它没在干活。装了它之后仍退 0（语义不变），但把 `uncaughtException` / `unhandledRejection` 连同栈写进 `scripts/hooks-crash.log`；周检 `checkHookCrashes()` 读近 7 天记录，有就报 warn 并给样本。已接入 13 个：`stop-gate` / `rules-reminder` / `session-budget` / `global-config-guard` / `huge-output-guard` / `edit-guard` / `commit-scope-guard` / `cua-cursor-guard` / `risky-match-guard` / `auth-lock-guard` / `attempt-lock-guard` / `tool-payload-guard` / `win-path-guard` |
| **同类连败计数** | 判据 `scripts/attempt-lock-core.js`；入口 = `risky-match-guard.js`（Pre）+ `attempt-lock-guard.js`（Post，`^Bash$`） | 把"同类操作连败 3 次即停"从数据库认证泛化到**构建 / 测试 / 部署**：按工作目录、workspace 与命令签名隔离目标，连续失败 3 次即硬拦下一次同类调用；成功一次清零；拿不到明确信号的返回记 neutral 不计数；多个不同目标的复合命令汇总返回同样记 neutral，不凭最后退出码给其中一个目标计数或清零。`cd`、工具 cwd 和包管理器目录选项指向同一目标时共用预算；`echo` / `rg` 中引用命令不建账。解封 `attempt-lock-guard.js --clear`，关掉 `~/.qoder/attempt-lock.json` |
| **返回侧体积** | `scripts/tool-payload-guard.js`（PostToolUse，Bash/Read/Agent/Task/mcp_call） | 单条工具返回 >2MB（`TPG_BYTES`）时当场提示改用摘要推进；同会话同工具只提醒一次。补的是 Pre 守卫拦不住的"返回才知道多大"（子代理报告、工具默认回显、多条中等返回） |
| 备份提醒 | `scripts/edit-guard.js`（PreToolUse） | 给"改文件前先备份"补机制。**只堵不可恢复那一格**：`Write`（整文件覆盖）且文件已存在、≥2KB、**一路向上无 `.git`**（有版本库时 git 就是备份）、不在临时/备份路径下；同会话同文件只提醒一次。命中技能 / 规则 / 记忆 / hook / MCP / agent 等载体目录时追加 `carrier-preflight` 提醒（含新建载体）。动作是 **allow + 提示**（advisory 不拦截），每次判定落台账。关掉：`~/.qoder/edit-guard.json` |
| **认证锁库门禁** | 判据 `scripts/auth-lock-core.js`；入口 = `risky-match-guard.js`（PreToolUse，2026-10-21 并入）+ `auth-lock-guard.js`（PostToolUse） | 把"连败三次即停"从提示词变成计数器：按目标（srv/host/user 任一相同）累计**认证类失败**，满 3 次硬拦该目标的一切连接动作，出现锁定签名一次即拦；连接被拒/超时算中性、SQL 语法错算清零。**防的是"重试到把生产库账号锁死"**（2026-10-21 事故：CRLF 尾巴的密码连发 10 次 → 账号锁死，只能人工解锁）。解封 `--clear`，关掉 `~/.qoder/auth-lock-guard.json` |
| 两侧同步 | `scripts/sync-global-config.sh`（`--check` 只报） | AGENTS.md / `rules/*.md` / **`commands/*.md`** 实体副本保持一致（2026-09-22 起把 commands 也纳进来：**只挂一侧的指令会让另一侧静默没有这个 `/命令`**）；被 SessionStart 以 8s 超时**内联**调用 ⇒ 同样"极少 spawn"（2026-09-19 重写：一次 md5sum 全量取哈希） |
| 记忆同步 | `scripts/sync-memory.sh`（`--copy-missing` 只补单边文件） | 分叉文件一律不自动覆盖，交人合；被 SessionStart 以 8s 超时**内联**调用 ⇒ 实现保持"极少 spawn"（2026-09-19 重写，选型实测见脚本头注释；周检 `PERF_BUDGETS` 盯着这张预算表） |
| 技能门禁 | `scripts/skills-doctor.cjs`（由周检 3i 调用） | 四类红：**规则引用的技能在 CN 侧不可见**（10-07 实测 9 个：verify-before-claim / verify-ui-in-browser / ship-clean-pr / write-repowiki / vibecoding-doc / vibe-coding-workflow / postgresql-* / kafka-best-practices 只在非 CN 侧，规则每轮点的是空指针）、**两侧同名 SKILL.md 漂移**、**正文引用不存在的自带文件**（前置式跨技能依赖另计，see-also 式只上报）、**CN 可见技能 description 超 300 字符或含 ASCII `": "`**（前者是每轮注入成本，实测 15444→7689 字符；后者会撞 `skill_manage patch` 的 YAML 闸门）。另一侧（非 CN）客户端的长描述只上报不判红——手改上游包会与源分叉。`--selftest` 16 组含 8 条必红对照；`apply-sync --apply` 补齐两侧（旧内容进 `~/.qoder-cn/_skill-backups/<ts>/`，CN 独有的 16 个永不反向覆盖）。**已知局限**：doctor 走本机绝对路径，沙箱周检测试覆盖不到它的红路径（红路径已在真机植入 MISSING-IN-CN=1 验证，报 `[WARN] 技能库`） |
| 配置面对齐 | `scripts/config-doctor.cjs`（周检 3j 调用） | 两个 Qoder 客户端的**插件 / hooks / MCP / 安全开关**逐项对比，只报不改（`fix` 子命令才动手，改前备份 settings.json 与插件注册表）。抓的都是"只有对比两侧才暴露"的形状：跨机器残留的 `installPath`（Presentations 记录仍指向 `<用户目录>\...`，本机该用户目录不存在 ⇒ 插件静默加载失败）、**单侧空转的记忆 hook**（polarmem0 三条挂在非 CN 侧，但 `status` 读数 base_url=null / api_key_set=false、空 stdin 时 0 输出、且不认 `qoder-cn` 这个 agent 名）、只有一侧有的 `securityScan`、`enabledPlugins` 与插件集合差异。`--selftest` 4 组含 3 条必红对照 |
| 磁盘水位与清理 | `scripts/disk-sweeper.js` + 指令 `/clean-disk`（SessionStart 注入由 `session-budget.js` 的 `diskNote()` 负责） | C 盘空间不足时的**三档清理**：一档我方产物按超期天数可清；**三档＝C 盘其余无用缓存 / 过期内容，按 id 逐条点名才可清且只删超限文件不删目录**；二档＝会话记录**永不删**。硬否决名单挡住 `memory`/`rules`/`scripts`/`commands`/`credentials`/`.git`/`settings.json`/`qoder-*-cwd`。推荐**归档到他盘**（复制并核字节后才删源，产 `manifest.json` + `INDEX.md`，INDEX 自带一条可粘贴的长期记忆条目与 `--restore` 命令）。**弹窗一次问全（清理两问 + 迁移一问）**——一档处置、是否顺带清三档、是否顺带排查目录迁移同一轮问，清理两问都答完才 `--apply`，迁移走独立流程 |

## 关键入口

- 接线：挂在 `~/.qoder/settings.json` 的 `hooks.{UserPromptSubmit,Stop,SessionStart}`（改前先落 `.bak-rulefix-*`）。**用双客户端时再往 `~/.qoder-cn/settings.json` 挂同一套**——单客户端不需要第二份；两侧同步脚本在缺另一侧时会自动进"单端模式"跳过，不会报假故障。
- 门禁判据与阈值：`stop-gate.js` 内 `RULES[]` + `MAX_BLOCKS_PER_RULE=2` / `MAX_BLOCKS_PER_SESSION=3`（**这两个上限按 `BLOCK_WINDOW_MS=30 分钟`的滑动窗算**，不按每会话累计 —— 见下）
- 运行状态与契约观测：`~/.qoder/tmp/stop-gate/last-invocation.json`（每次 Stop 落一次：事件名、stdin 字段、判到的文本长度）、`<session_id>.json`（各规则已拦次数）、`violations.log`（**拦截台账**，追加式一行一条：`时间|R号|sess=会话前8位|hash=文本sha1前8|len=长度`，只落哈希不落原文，避免把凭据/内网信息带进日志）

## 怎么验

```bash
node ~/.qoder/scripts/stop-gate.test.js        # 336 条：各规则违规必红 + 对照组必绿 + 真实历史原文回放 + 台账 + 防死循环 + fail-open + R6b 阻塞过期复核 + R6 持有豁免 + R10 安装/更新询问 + R11 发布后部署询问
echo '{"last_assistant_message":"剩下的待办要继续下一格吗？","session_id":"t"}' | node ~/.qoder/scripts/stop-gate.js
node ~/.qoder/scripts/stop-gate.js --report 7   # 按规则汇总近 7 天命中；台账为空会显式打"零命中"
node ~/.qoder/scripts/rules-reminder.test.js   # 条数以本轮实测为准：注入/心跳/请求回注/目标候选/自进化/B05 + 联网与工具缺口正例、引用/禁联网/只读/禁下载负例及变异对照
node ~/.qoder/scripts/hook-crash-guard.test.js # 6 条：接守卫后崩溃仍退 0（fail-open）+ 日志 +1 + 含 hook 名与错误 + **对照组（不接守卫同样抛错必须非 0 退且不写日志）** + `readCrashes` 读得到；跑完**恢复**原日志（不是删——真崩溃记录不能被测试清掉）
bash ~/.qoder/scripts/sync-memory.test.sh       # 15 组：判一致/分叉/单边与 --copy-missing/索引/尾换行字节级/guard 端到端/无 md5sum 必报红/**单端（无 ~/.qoder-cn）退 0 且明说跳过**/前置真缺则退 2
bash ~/.qoder/scripts/sync-global-config.test.sh # 15 组：一致/漂移与同步取新侧/单边补齐/无 md5sum 必报红/**单端退 0 明说跳过**/**目标 rules/ 整个不存在时补齐真落地（T8）**/**复制真失败必须 COPY-FAIL+exit 1（T9）**/真实目录冒烟
node ~/.qoder/scripts/session-budget.test.js    # 31 组（沙箱 HOME）：三档必触发 + 压缩信号独立触发 + **返回侧增量（首次无基线/低于阈值/超阈值不吞别的信号）** + 看门狗四种状态 + 接续点催开工 + disabled + 非法输入 fail-open
node ~/.qoder/scripts/rules-weekly-audit.js     # 周检本体（--no-fix 只看不改）；退出码 0 健康 / 1 有告警
node ~/.qoder/scripts/skills-doctor.cjs          # 技能门禁（周检 3i 调它）：退 0 CLEAN / 1 有红 / 2 前置失败；`--selftest` 16 组；`apply-sync --apply` 补齐两侧
node ~/.qoder/scripts/config-doctor.cjs          # 配置面对齐（周检 3j 调它）：插件/hooks/MCP/安全开关；`fix` 看计划，`fix --apply` 才改（自动备份）；`--selftest` 4 组
node ~/.qoder/scripts/attempt-lock-guard.test.js # 阈值 / Pre 硬拦 / 成功清零 / neutral / 跨项目与 workspace 隔离 / 等价目录写法 / 命令引用 / 沙箱隔离；条数以实际输出为准
node ~/.qoder/scripts/tool-payload-guard.test.js # 7 条：超阈值出声 / 同工具降温 / 换工具再报 / 小返回静默 / 非 Post 事件静默 / 台账 / 沙箱隔离
node ~/.qoder/scripts/disk-sweeper.test.js      # 47 条（水位三档 + 一档按年龄删对 + 硬否决 survives --apply + 归档→manifest→回取→purge 闭环 + **三档未点名不删 / 缺 --apply 拒绝 / 未知 id 退 2 / 只删超限文件不删目录**）。`--simulate-free` 驱动水位，不需要真把盘填满
node ~/.qoder/scripts/disk-sweeper.js            # 只列清单：一档可清数 / 三档按 id 的体积 / 二档只报 / 建议归档盘；退 1＝该弹窗了
node ~/.qoder/scripts/edit-guard.test.js        # 19 组（沙箱 HOME）：该提醒的备份/载体预检 + 不该提醒的多类（git 内/小文件/临时路径/备份文件/普通新建/Edit/开关）+ fail-open + 台账
node ~/.qoder/scripts/rules-weekly-audit.test.js # 22 组（沙箱 HOME）：基线零告警 + **单端（无 ~/.qoder-cn）也必须零告警** + 悬空引用/frontmatter/冲突回归/放宽纪律/hook 缺失/**单边接线**/心跳过期/篇幅/**机制掉了**/耗时超预算/**串行合计越过 hook 超时** 逐项植入必红
node ~/.qoder/scripts/global-config-guard.test.js # 7 组（沙箱 HOME，按 pid 独立目录）：健康零输出 + 两类漂移必报 + **检查器跑不起来（退码 2）不许静默** + **两路都慢时总耗时压在预算内且明说跳过了哪一路**（旧写法实测 10s+，会被 hook 的 15s 掐死）
```

- 改 `RULES[]` 正则后**必须**跑一次 test：违规用例里含历史真实违规原文（"下一步待你定：…还是留给并行那条线收口？"），改坏了会红。
- 体检脚本同理：植入单边漂移 + 悬空引用应报，还原后应零输出。
- 改 `session-budget.js` 的档位/取值来源后跑它自己的 test：**每档都要有"必须触发"的用例**，否则阈值写错也发现不了（该测的另一个方向是"不该触发必须静默"——守卫最容易犯的错是噪声太多被忽略）。
- 周检 `rules-weekly-audit.js` 同理，测试已落在 `rules-weekly-audit.test.js`（11 类植入必红 + 基线零告警 + 自动修还原），改动周检时**必须**跑它——包括"遵守率"那节：改了 `ADHERENCE` 映射或机制里的规则号，探针失配会立刻红。

## 判据依据（2026-09-19 联网调研后的选型）

- **业界主流是"token 占窗口百分比"**（Copilot CLI 约 80% 压缩 / 95% 停手；Trae 直接显示占用百分比），因为它能回答"还能撑几轮"。
- **本 harness 上不可靠，故不采用**：transcript 里确有 `usage.input_tokens` 字段，但实测 616 条里只有 58 条非零、且**全部停在会话早期**（本项目某会话最后一次有效值停在 7 天前）——按它分档会用一个陈旧值判当前状态，比体积更糟。
- **因此用两个可稳定拿到的信号**：transcript 体积（payload 代理量）+ `isCompactSummary` 压缩次数（上下文已丢几次的直接计数）。**体积与真实 payload 会脱钩**（工具输出可被转存文件），这是已知局限。
- **阈值要前置**：context rot 随长度连续恶化、**没有安全悬崖**（Chroma 对 18 个模型的实测），所以不设"到 X 才动手"，而是 8MB 就开始降速。
- **不要一路 compaction**：官方指引区分 `/compact`（摘要续用，同一件事没完）与 `/clear`（清空重开，换任务）——已被压过 2 次就该考虑换会话，而不是继续压。

## 关掉 / 调松

- 临时全关：新建 `~/.qoder/stop-gate.json` 写 `{"disabled": true}`（不用改 settings.json）。
- 会话体积档：`~/.qoder/session-budget.json` 写 `{"disabled":true}` 关；阈值 `SB_YELLOW_MB` / `SB_ORANGE_MB` / `SB_RED_MB` / `SB_TURN_GROWTH_MB`（默认 8 / 15 / 25 / 2）；台账 `~/.qoder/tmp/session-budget/checks.log` 每回合一行（体积 / 档位 / comp=N / 取值来源），`keys-<事件>.json` 记录该 hook 首次触发时的 stdin 字段集（用来核实字段名，别靠猜）。
- 调阈值：环境变量 `STOP_GATE_MAX`（每类上限）、`STOP_GATE_SESSION_MAX`（每会话上限）、`STOP_GATE_TAIL`（读 transcript 尾部字节）、`STOP_GATE_TAIL_CHARS`（R1/R2 只看结尾多少字，默认 500）、`STOP_GATE_WINDOW_MS`（上限的滑动窗，默认 30 分钟）。
- 误拦兜底：**滑动窗内**每类最多拦 2 次、全会话最多 3 次后自动放行，且 `stop_hook_active=true` 时一律放行，不会死循环。
- **2026-09-19 修的一处"静默失效"（值得记住的教训）**：这两个上限原先按**每会话累计**算，而本机一次"会话"能横跨几十个回合、好几天 ——
  上限一打满，门禁对剩下的回合**全部静默放行**。症状正是那几天反复出现的"声明下一步却没开工、连过好几轮没人拦"：
  R1b 只在当天早期响过，之后每次 Stop 都直接 return，**台账上还看不出门禁已经停摆**。
  修法两条：① 上限改滑动时间窗（30 分钟内 2 次/类、3 次/会话，防死循环的作用不变）；② 被上限压住时**落一条 `-SUPPRESSED` 台账**，
  让"这一段门禁在放行"变成事后看得见的事实。判据在 `stop-gate.test.js`：老口径的累计计数不再让门禁永久失效 +
  窗口内仍会压住且落台账（两条都做了植入式验证）。

## 当前状态 / 未做

- 已做并验证：门禁五判据（29 条用例全绿，含 2026-09-19 加的两条"上限滑动窗"回归）、真源体检（植入-还原双验证）、`rules/frontend.md`+`rules/testing.md` 的 glob 补 `**/*.js`/`.mjs`/`.cjs`/`.wxml`/`.wxss`/`.wxs`/`game.json`/`project.config.json`/`app.json` 与 `*.test.js`/`tests/**`，两侧已同步。
- **R5 运行期与校准计划（2026-09-19 起，用户拍板"先按窄条件运行"）**：R5 = 踢皮球句式 + 无主张词才拦（宁窄勿滥）。校准方式——先跑一周，用 `node stop-gate.js --report 7` 看命中：**误报多则收窄句式表，漏检多则补句式**。已知边界：中英文关键词句式对"换说法踢皮球"（如"你更懂，来定吧"）存在固有漏检，未做语义判定（成本过高）。
- **Stop hook 契约已端到端实测**（2026-09-19 15:08 本会话真实触发一次）：stdin 字段 = `cwd, hook_event_name, last_assistant_message, model, parent_business_info, parent_request_set_id, permission_mode, session_id, stop_hook_active, transcript_path`；
  门禁输出的 `{"decision":"block","reason":...}` **确实被采纳**——回合被拦下并要求继续，计数落 `tmp/stop-gate/<session>.json`。
- **首跑抓到的误拦已修**：报告正文里**引用**历史违规原文当证据（"下一步待你定：…"）被 R2 命中。
  修法：R1/R2 判的是"收尾行为"→ 先剥行内代码与引号内引用（`` ` ``、`"…"`、“…”、「…」），再只看结尾 `STOP_GATE_TAIL_CHARS` 字；
  加两条回归用例（引用示例必放行 + 同短语落在结尾未引用必拦）。
- R3 证据：核本轮截图工具结果与文件存在性；“截图待补 / 尚未比对”不算证据。
- R3 判据更新：**主张词是必要条件——无主张词绝不拦**；主张词与 UI 词还须**同句共现**才拦（修复跨句拼接误报）。回归用例 77 条含跨句拼接放行、无主张词放行等对照。
- **CN 侧已接线**（2026-09-19 15:15，改前备份 `settings.json.bak-rulefix-20260919T1515`）：`~/.qoder-cn/settings.json` 的 Stop 与 SessionStart 各挂一组；用 CN 同款命令串实测过两脚本（违规样本 → 退避 block；体检 → 零输出）。
  **未在 CN 客户端里端到端跑过一次真实收尾拦截**（需下次在 CN 开会话才会触发，届时看同一份 `tmp/stop-gate/` 台账）。
- 拦截台账与 `--report` 已加（5 条用例：命中落行 / 放行不落行 / 字段可解析 / 不落原文 / 空台账有显式说明）。
- **`sync-memory.sh` 重写（2026-09-19 周检首周抓到并修复）**：旧版逐文件 `cmp`/`grep`（84 文件×两侧 ≈200 次 spawn × ~320ms）实测 41.5s，顶穿 SessionStart 的 8s 预算 ⇒ 记忆检查**永远超时、等于没做**，还让每次开会话白等 8s（guard 实测 11.0s）。重写为"通配符列目录 + 内建解析索引 + 每侧一次 md5sum"（零/极少 spawn），实测 0.75~1.1s；guard 实测 4.0~4.4s，且记忆检查真生效（假 HOME 植入分叉端到端已验）。回归套件 `scripts/sync-memory.test.sh` 14 组全绿；备份 `<历史脚本>/backups/sync-memory.sh.bak-20260919`。
- **`sync-global-config.sh` 同法重写（2026-09-19 同一轮）**：旧版逐文件 `cmp` + `ls|sed|sort` 流水线（~15 次 spawn）闲时 2.5~4.5s、**负载高时实测 12.3s** ⇒ 随机顶穿 8s 预算（周检复跑抓到）。改为一次 md5sum 全量取哈希 ⇒ 0.3~0.7s；与旧版做过 4 组夹具差分对照（stdout 逐字节一致、退出码/ stderr 一致），同步行为（取较新侧覆盖、单边补齐）逐条验过。回归套件 `scripts/sync-global-config.test.sh` 8 组全绿；备份 `<历史脚本>/backups/sync-global-config.sh.bak-20260919`。
- **`sync-global-config.sh` 的"假绿 COPIED"（2026-10-06 周检抓到并修复）**：另一侧 `rules/`、`commands/` 目录**整个不存在**时（本机 CN 侧实态：12 条 rules + 3 条指令从未到达），脚本 `cp` 报 `No such file or directory` 却**照样打印 `COPIED` 并退 0** ⇒ 周检按退出码判定，每轮都报「[FIX] 两侧漂移，已自动同步」，连修 6 轮、台账 `warn=9 fixed=1` 恒定不动。**判据盲区**：`cp` 的退出码没人接，`changed` 无条件自增。修法＝`mkdir -p "$(dirname dst)"` + `if cp …; then 计数 else COPY-FAIL; cp_fail++ fi`，收尾 `cp_fail>0` 退 1（`--check` 的输出协议与退出码未改，调用方 `global-config-guard.js` / `rules-weekly-audit.js` 不受影响）。回归 T8/T9 三条用例对旧版判红、对新版全绿。
- **周检新增 2g「关键目录对等」（2026-10-06）**：比较两侧的 `scripts/` 与 `skills/` 是否存在，**只有一侧有 ⇒ 报 warn；两侧同缺 ⇒ 静默**（单能力/单端是合法形态，不能判红）。动机：本机 CN 侧 10-04 重装后这两个目录整个消失（CN 客户端零技能），而当时告警清单一条都没有——`sync-global-config.sh` 只管 `AGENTS.md`/`rules`/`commands`，这两个目录**不在任何同步机制覆盖面内**。用例 V20（缺一侧必红）/ V20b（同缺必静默），并给 harness 加了 `want: 0` 与 `want: 'any'` 两条通道——原先硬要求 `code===1`，"不得出现"型对照组根本写不进来。守卫的承重性用变异验证：删掉 `if (a === b) continue;` 后 V20b 场景确实误报（1 命中），还原后 0 命中。
- 预算结论：本机 Git Bash 单次 spawn 成本**随负载浮动（实测 130~800ms）**，内联脚本一律按"极少 spawn"写；三个 hook 脚本的预算表在 `rules-weekly-audit.js` 的 `PERF_BUDGETS`。

## 大输出守卫（2026-09-19 新增，修的是"任务老中断"）

**症状**：用户反复看到任务中途停下、要再敲一次"继续"。取证（遍历本项目九个会话的 transcript）显示：
119MB / 65.8MB 两个会话里出现过 **9 次传输层掐断** ——
`Model stream timed out before response headers after 60s` ×3、`The model service rejected this request` ×4、
`The request could not be completed` ×2。**因果链**：单条工具返回越大 → 单请求 payload 越大 → 服务端 60s 内发不出响应头 → harness 中止本回合。

**炸点分布**（>20KB 的返回共 81 条 / 3MB）：Read 整读大文件 921KB（`收口清单.md` 一次 913KB、项目记忆文件被整读五六遍）、
Edit 回显 849KB、Bash 无上限输出 454KB、子代理报告 382KB。

**三层机制**（都不依赖"我记得"）：

| 层 | 入口 | 行为 | 怎么验 |
|---|---|---|---|
| PreToolUse 守卫 | `~/.qoder/scripts/huge-output-guard.js`（两侧 settings.json 已挂） | ① `Read` 大文件（>40KB 或 >600 行）且没带 offset/limit → **deny**；② `Bash` 命中 `cat`/`grep`/`git log`/`mvn`/`npm test`/`find`/`ls -R` 等形态且无任何限流（管道 / 重定向 / head / tail / `-l` / `-c` / `-m` / `--oneline`）→ **deny**；③ `Agent` 提示词末尾追加"只回结论、≤300 字"硬约束（**改输入而不是拒绝**，子代理本身是必要的） | `node scripts/huge-output-guard.test.js`（**23 条**：该拦的拦、该放的放；含两条自测抓出来的真问题：`/-l\b/` 匹配不到 `grep -rl` 的组合短参、`find` 带 `-name` 仍可能上千行） |
| 会话体积哨兵 | `stop-gate.js` 规则 **R7**（Stop hook） | 会话 transcript ≥ 25MB（`STOP_GATE_SESSION_MB` 可调）时拦停，要求先交接（队列 + 台账 + 明说"建议开新会话"） | `node stop-gate.test.js`（27/27）+ R7 专项两端自检（26MB 拦 / 小会话放行） |
| **阻塞过期复核** | `stop-gate.js` 规则 **R6b**（Stop hook） | 队列里 `- [~] … 阻塞：` 若**声称某文件正脏/被持有**，收尾前实测这些文件（`git ls-files` 解析 → `git status --porcelain`）：全部干净 ⇒ 判"这条阻塞已过期"并拦停——现在开工，或换成新的真实条件。**三道保守闸门**：① 只判含脏态词（脏/持有/在途/未提交/正被/并行会话）的条目，"等数据产出/等关卡"这类与文件无关的不判；② 含 git 查不了的条件（凭据/端口/上游规格/真机/模拟器/mvn）整条跳过；③ 提到的文件有一个在版本清单里找不到就整条不判（**不许把"查不到"当"已过期"**）。git 跑不动 ⇒ fail-open | `node stop-gate.test.js`（44/44，含 6 条 R6b：过期必拦 2 条 + 确实脏/无脏态声明/文件查不到/含凭据 各放行对照）；真队列冒烟：V03-d 那条"heroes=0"过期阻塞被拦出、修文案后静默 |
| 规则层 | `AGENTS.md` §任务处理 | 写清"上下文体积是回合的生死线"+ 正误对照 | `sync-global-config.sh --check`（12 文件逐字节一致） |

**现场验证（同一会话内触发，不是只跑单测）**：
`Read 收口清单.md` → 被拦（提示 913KB/840 行，并给出 grep→offset/limit 的改法）；
`cat 收口清单.md` → 被拦（给出 `> /tmp/x.log; tail -30` 的改法）；
派一个子代理 → 台账出现 `augment` 行，子代理回了 3 句结论。
每次都落 `tmp/huge-output-guard/decisions.log`（只落动作与工具名，不落正文）。

**判据 2b（2026-09-21 加）：`node -e "…"` / `python -c "…"` 这类双引号内联脚本里出现反引号 → deny。**
bash 会**先做命令替换**再交给解释器，所以文本里的 `` `xxx` `` 不是"原样写进目标文件"，而是**当场执行一遍**。
现场代价（同一会话实测两次）：一次误触发了一次全量 `<历史脚本>/build.sh`；另一次把替换结果（空串）写进脚本，
让"防重复写"的判断键变成空串 ⇒ `includes('')` 恒真 ⇒ 四条记忆全部报"已写过"而实际一条都没落盘。
正解：文本走带引号的 heredoc（`<<'EOF'`）落成文件，脚本落成 `.cjs` 再 `node` 跑。
自测：`node --test huge-output-guard.test.js` 里这组有 5 条（拦 2 / 放行 3），植入一条反向期望后汇总变 `27 PASS / 1 FAIL` 且退 1。

**关掉 / 调松**：`~/.qoder/huge-output-guard.json` 写 `{"disabled":true}`（守卫立即静默）；阈值用环境变量
`HOG_READ_BYTES` / `HOG_READ_LINES`（默认 40KB / 600 行）、会话线 `STOP_GATE_SESSION_MB`（默认 25）。
守卫与门禁一样 **fail-open**：任何异常一律放行，绝不因为守卫自己出问题而卡住会话。

**未做 / 已补**：① ~~图片没有体积口径~~ **已补（2026-10-27）**：Read 整张 >1.5MB 图片直接拦（base64 还会放大 1/3）；
② 子代理报告仍是"追加提示词 + PostToolUse 体积提示"，**没有硬截断**——返回已经进上下文，Post 层截断是假的；
③ Edit 回显（849KB）来自工具行为，守卫动不了它，只能靠"少来回改、一次改到位"。

## commit-scope-guard.js —— 拦"用 pathspec 提交工作区还脏的文件"（2026-09-20 新增）

**它管的那条规则**：同一 worktree 里有并行会话时，`git commit … -- <路径>` 取的是**工作区内容**，
会绕过刚用 `git update-index --cacheinfo` 做好的 partial blob，于是把别人的在途改动扫进本次提交
（或反过来，把别人**已入库**的行删掉）。2026-09-19 同一晚踩了两次，提示词写了照样踩 ⇒ 上 hook。

**判据不是文件名黑名单**，是可核对的事实：命令里出现 `git commit` + 独立的 `--`，
且某个 pathspec 的 basename 同时出现在 `git diff --name-only`（工作区未提交改动）里 ⇒ `deny`，
理由里直接给四步正确做法（造 blob → update-index → 核 `--cached --name-only` → **不带 pathspec 提交**）。
干净文件用 pathspec 提交是本仓库常规做法，**必须放行**，所以"只拦脏的"这条不能省。

**接线**：`~/.qoder/settings.json` 的 `hooks.PreToolUse` 加一条（**双客户端时再挂一份到 `~/.qoder-cn/settings.json`**）
（改前备份在 `~/.qoder/tmp/backups/settings.json.<时间戳>`；命令写法沿用"不带引号的 `node.exe 路径`"）。
**自检**：`node scripts/commit-scope-guard.test.js` ⇒ 7/7，其中三条是关键反例
（干净文件放行 / 中文路径被 git 转义成八进制时仍拦得住 / cwd 不是仓库时 fail-open 且退出码 0）。
台账：`~/.qoder/tmp/commit-scope-guard/decisions.log`，一行一次判定，可核对"它到底拦没拦"。

## 2026-09-20：Stop 门禁的"续停免检"与"cwd 假绿"（同一次停住的两个原因）

**现象**：一个交付了五格的长回合收尾时没有被 R6 拦下，用户第二次问"为什么又停了"。
`violations.log` 里那一时刻**没有任何记录** ⇒ 不是命中后被抑制，是**根本没判**。

**两个独立缺陷，任一都足以静默放行**：

1. `if (input.stop_hook_active) return;` —— 防死循环的让路写成了**整体免检**：
   一个回合里只要被拦过一次，之后每次收尾都不再判任何规则。而"被拦 → 补做很多活 → 再收尾"
   恰恰是这条规则最想管的情形。
   **改法**：续停照判，防死循环交给滑动窗（30 分钟内每规则最多拦 N 次，超限写 `-SUPPRESSED` 台账后放行）；
   并新增 `SECOND-STOP` 台账行，让"这是续停"本身可见。
2. `openQueueItems(ctx.cwd)` 只信 hook 报的 `cwd`。它不是项目根时找不到队列文件 → 返回 `null`
   → 语义是"本项目没有队列，放行" ⇒ **门禁瞎了却报一切正常**（正是本文件反复强调的最坏假绿）。
   **改法**：按候选目录探测（`input.cwd` → `process.cwd()`），并把探测结果记进 `lastQueueProbe`；
   两处都没有才算"无队列"。

**判据（`stop-gate.test.js`，29 → 36 条）**：R6 此前**零覆盖**，补 7 条
（含 `- [ ]` 拦、`- [x]` 放行、`- [~]` 带"阻塞："放行、不带理由仍拦、**续停仍判**、**cwd 报错靠进程目录兜底**、两处都无才放行）。
旧那条「stop_hook_active 放行」是**把缺陷钉成规格**的用例，已改写为期望 `block`。

**端到端复现**（比单测更硬，因为它用真实队列与真实收尾文字）：
`cwd` 故意给一个真实存在的项目目录、`stop_hook_active:true` ⇒ 修前静默放行，修后 `decision:block`。

**通则**：**门禁不能依赖"某个事件一定会发生"**。被传输层掐断的回合到不了 Stop；
凡是只在 Stop 上做的检查，在长会话里都会退化——所以每轮必到的 UserPromptSubmit/SessionStart
要能**补算**上一轮的收尾是否违规（本轮的 R6 注入就是走这条路进来的）。

## 认证锁库门禁（auth-lock-core.js）—— 拦"重试到把数据库账号锁死"（2026-10-21 新增，同日按用户要求合并入口）

**事故**：部署前从 `application-prod.yml` 提取生产库密码，该文件有 99 行 CRLF，按行截取的值带尾部 `\r`，
连发 **10 次**"错密码"把账号锁到 `Too many invalid attempts. Please contact the syssso user to unlock.`
——解锁只能由 sysso/DBA 手工做，Agent 无法自助恢复。规则里早就有"同类修复连败三次即停"，**但它是纯提示词**。
全仓 grep `三次|连败|consecutive|failCount` 在所有 hook 里**命中 0 条**——此前没有任何失败计数器。

**架构：判据一份、入口两个**（按事件面分，不按文件分）：

| 角色 | 文件 | 干什么 |
|---|---|---|
| 判据真源 | `auth-lock-core.js` | 目标维度抽取、失败签名分类、计数与状态、台账、`preCheck()` / `postRecord()` |
| PreToolUse 入口 | `risky-match-guard.js` 末尾委托 | 调用发出**之前**查状态并硬拦该目标（2026-10-21 并入，不再单挂第 7 个 hook ⇒ 预检峰值回到 5） |
| PostToolUse 入口 | `auth-lock-guard.js` | 只看**工具返回**给次数记账（失败签名只出现在返回里，PreToolUse 结构上看不到）；另带 `--status` / `--clear` 人工 CLI |

**为什么 Pre 能并、Post 不能并**：Pre 只是"读一次状态"，与 `risky-match-guard` 同属"发出去之前拦一手"，语义同类；
Post 是另一个事件面（要看返回），塞进 `risky-match-guard` 就等于给它挂一个永不触发的分支。
判据若抄两遍必然分叉，所以两个入口都只做"读 stdin → 调 core → 出声"。

**判据**（宁窄勿宽，噪声多就被忽略）：只对已识别的数据目标建账（dbhub `execute_sql_*` / psql / mysql / sqlplus / redis-cli 等）；Shell 从命令词和独立连接参数取目标，SQL 正文不作为身份，引用、注释和普通文档 heredoc 不建目标。
认证与锁定签名计数；先解包 JSON 和 MCP 文本块，再识别账号和错误，连接被拒、超时、空返回和未知错误均为**中性**。只有可识别的结果行或 SQL 语法错误证据才清除尚未封锁的计数；裸数值 `1045` 不是认证错误，明确的 `ERROR 1045` 仍计数。
同一目标（srv / host / user 任一维度相同）保留已观测别名并合并失败次数，累计 3 次即 PreToolUse 拦截，锁定签名一次即拦；旧状态键中的身份也保留。
已封锁目标不因成功返回或时间流逝自动解封；`ttlHours` 只作用于未封锁记录，`blockTtlHours` 不再自动解除。`threshold` 限定在 1–3，非对象配置或全无效的维度列表按默认值处理，只有布尔 `disabled: true` 才关闭守卫。
解封是人的决定：`--clear <精确目标键>` 或显式 `--clear ALL`，缺参数/选项误入会拒绝，不做模糊匹配。新错误样本只存失败类别，不复制可能含密码的返回正文；连接 URI 只提取账号和主机。关闭仍由 `~/.qoder/auth-lock-guard.json` 的 `{"disabled":true}` 控制。

同一次工具调用涉及多个数据库目标时，汇总 rows/退出码不证明其中一个目标认证成功；只有错误返回的身份无冲突地唯一对应一个目标时才归属失败，否则保留原计数并记 neutral。需要逐目标结果时拆成独立调用。

命令解析覆盖常见直接调用、分隔命令、Shell `-c` 包装、命令替换和 Shell heredoc；不会求值动态变量、函数或别名，也不替代平台权限与人工批准。这里的 hook 仍可能 fail-open，不能当作安全边界。

**首跑自己踩到的三个坑**（都进了测试判据，别再靠肉眼）：
1. **台账静默为空**：`ledger(f)` 签名收数组，6 个调用点全传字符串 → 抛错被 `catch{}` 吞掉 → 看起来一切正常，
   但"守卫到底跑没跑"的唯一证据没了。改法：`Array.isArray(f) ? f.join('|') : String(f)`。
   教训：**catch 吞错的日志写入＝假绿**，日志函数必须对参数形态容错。
2. **假目标键**：真机台账里出现过 `-/-/3_40`、`4_47`、`5_50` 这类"账号"——是普通命令里的 `-u`、`x@y` 片段被正则吃成维度。
   假键撞上真账号就是误拦。Bash 现在先识别实际命令词，再从客户端的独立连接参数解析 host/user；
   返回侧只在认证/锁定错误中补全身份，SQL 正文与结果行不提取账号，避免数据被误当连接信息。
   PG/瀚高报错的 `for user "x"` 也用于关联 MCP 与 Shell 的同一账号。
3. **工具面太宽**：收紧 Bash 解析后，真机台账仍出现 `-/203.0.113.10/probe_appuser`——来源是 **Edit/Write 的 `new_string` 里"引用"了 psql 命令**
   （写测试、写文档时必然出现）。守卫只该守"能真的发起连接"的工具面 ⇒ 加 `SHELLISH | mcp_call | DBTOOL` 前置门，
   其余工具直接退出。判据同 ②：**假键撞上真账号就是误拦**，而"引用一段字符串"永远不可能发起连接。

**自测**：`node auth-lock-guard.test.js` 26 组，红/对照双向（Pre 类判据一律 spawn **合并后的入口** `risky-match-guard.js`，
否则测的是已不存在的接线、全绿也是假绿）。两条变异验证：
① 判据 ㉑（沙箱不污染真实 `state.json` **与** `decisions.log`）——去掉 `AUTH_LOCK_STATE_DIR` 隔离后必须判红；
② `node auth-lock-merge-mutation.test.js`——把 `risky-match-guard.js` 里那段委托摘掉做成 mutant，
同一已拦目标在 mutant 上必须**不拦**，证明 Pre 拦截确实来自合并进来的委托段而非恒绿。
**接线取证**：真机跑 `psql -h 192.0.2.1 -U mergeprobe2`（RFC5737 TEST-NET，不可路由，零认证风险），
真实台账出现 `eval|allow|-/192.0.2.1/mergeprobe2|n=0`；此时 auth-lock 自己的 PreToolUse 接线**已从两侧 settings.json 摘除**
⇒ 这一行只可能由合并后的入口写出。合并后全量真机台账 26 行**全是 allow**、`state.json` 无条目
⇒ 测试输出里引用的报错字符串没有被误计数（Post 半边要求"调用本身带数据目标维度"才建账）。

## 2026-10-27：通用任务检查强化（R3 / R9 / 连败计数 / 返回侧）

用户要求把上一轮复盘出的缺口一次做完。判据与证据如下（每条都有红/绿对照用例）：

| 缺口 | 改法 | 判据 |
|---|---|---|
| R3 误报：复盘时引用规则原文被当成交付主张 | R1/R2 的引用剥离抽成 `stripQuoted()`，R3/R9 共用 | `stop-gate.test.js`「引号内引用规则原文不拦」 |
| R3 漏检：正文不出现"界面/截图"就放行 | **改动面驱动**：本轮编辑过 `.vue/.tsx/.wxml/.html/.css…` 且正文有完成主张 ⇒ 必须有截图证据 | 「改了前端文件且声称完成必须拦」+「有本轮截图则放行」 |
| 说"测试全绿"但本轮没跑 | **R9-claim-without-run**：声称测试/构建全绿时，要求本轮有成功的测试/构建 Bash 记录；显式写了"未运行"则放行 | R9 五条（失败记录 / 没跑过 / 成功跑过 / 纯讨论 / 已声明未运行） |
| 没有队列文件的会话 R6 空转 | R6 兜底：本轮 `TaskCreate` 了却没 `TaskUpdate completed/deleted` ⇒ 视为还有待办 | 「建了任务却没关掉必须拦」+「任务全部关闭则放行」 |
| 滑动窗抑制后门禁"静默放行"被误读为"没违规" | `rules-reminder.js` 读 `violations.log` 的 `-SUPPRESSED` 行，近 30 分钟有就提醒一次（同批不重复） | 提醒脚本 ⑩/⑪ |
| R2 噪声：已经按推荐项继续的仍被当"等裁决" | R2 增加放行条件：正文同时写了"先按推荐/默认项继续推进" | 「已按推荐项继续推进则放行」 |
| "连败 3 次即停"只有数据库认证被机械化 | 新增 `attempt-lock-core.js`（判据）+ `attempt-lock-guard.js`（Post）+ `risky-match-guard.js` 委托（Pre），覆盖构建/测试/部署 | 10 条：阈值前放行 / 第 3 次叫停 / Pre 硬拦 / 不串账 / 成功清零 / neutral 不计数 / --clear / 复合命令取键 / 沙箱隔离 |
| 证据报告靠回忆写 | `evidence-audit.cjs --from-transcript <jsonl> [--out report.json]`：抽取本轮 Bash 命令与退出码生成**草稿**，每项 `unverified`，审计结论必为 INCOMPLETE | 「草稿采集命令与退出码且不判绿」+「本轮无 Bash 时明确失败」 |
| 图片没有体积口径 | huge-output-guard：Read 整张 >1.5MB 图片直接拦（`HOG_IMAGE_BYTES`） | 2MB 图片拦 / 200KB 放行 |
| 返回侧体积只有回合粒度 | 新增 `tool-payload-guard.js`（PostToolUse）：单条返回 >2MB 当场提示改用摘要，同工具 30 分钟内只提醒一次 | 7 条（出声/降温/换工具/小返回静默/事件过滤/台账/沙箱） |

**未做（明确说明）**：子代理报告的**硬截断**做不了——PostToolUse 拿到的返回已经进入上下文，那里"截断"只是假动作；
现有做法是 PreToolUse 追加"只回结论 ≤300 字"+ PostToolUse 超 2MB 提示，两个都是提醒而非机械保证。
接口探针（curl/Invoke-WebRequest）未纳入连败计数：404 常常是合法的负向用例，纳进去必然误拦（宁窄勿宽）。

**生效方式（容易误判的一点）**：脚本改动**即时生效**（hook 每次调用都重新执行脚本）；但**新增 / 删除 hook 条目**要重启客户端才会被加载。
2026-10-27 用真机探针确认：`attempt-lock` 的 Pre 半边（`risky-match-guard.js` 内的委托）在本会话内已生效（台账有 allow 行）；
`attempt-lock-guard.js` 与 `tool-payload-guard.js` 的 PostToolUse 实时投递**待重启后复验**——当前证据是两侧接线 +
契约级自测（payload 形状与 `auth-lock-guard` 同源）。重启后自查：跑一次失败的 `npm run build`，看
`~/.qoder/tmp/attempt-lock/decisions.log` 是否出现 `fail|build@npm run build|n=1`。

## 2026-10-27（第二轮）：按审阅结论做完整修复

| 问题 | 改法 | 判据 |
|---|---|---|
| memory-first 按"文本出现"判定，文档里写 curl 也拦 | `risky-match-guard.js` 新增 `executableText()`：Bash 只看可执行段（剥 heredoc 正文与引号字面量）；`curl` 只在**写请求**（-X POST/PUT/PATCH/DELETE、-d、-F、-T）时算"对外动作"，只读 GET 放行 | risky 用例 ⑲b–⑲e（heredoc 引用/GET 放行、POST 与 ssh 仍提醒） |
| R2 判据与 AGENTS 冲突（≥3 方案 / 未答复继续） | 只有"真需要拍板"才拦：明确要求选择/裁决，或让用户确认的是高风险动作（部署/发布/删除/覆盖/回滚/停服/改配置）；理由改为"真实备选 ≥2 + 推荐项；只读/可逆项可继续，写入类未授权不动" | 「确认部署窗口仍必须弹窗」+「变量命名确认不算裁决」 |
| R1 reason 写"只有三种情形"，与 AGENTS 六项不符 | 改为引用 AGENTS 六项例外 | stop-gate 92 条全绿 |
| win-path-guard 把正则转义 `description:\s` 当盘符路径 | 盘符改为词边界判据 `(?<![A-Za-z0-9_])[A-Za-z]:\`，`n:\` 不再误伤 | 「description:\s 放行」「https:\ 放行」+ 原事故原形仍拦 |
| 大输出守卫一律 deny，7 天 60 次返工 | 只读查询（cat/git log/git diff/grep/find/ls -R/tree/journalctl）**自动追加 `| head -100` 后执行**；构建/测试与复合命令仍拦；`hogMode:"deny"` 可回退；台账记录命令头 | 6 条 rewrite 断言 + 复合命令/构建仍拦 + HOG_MODE=deny 对照 |
| AGENTS 备份要求比机制宽 | 备份只强制"无版本控制兜底的覆盖式改动"；git 跟踪的增量编辑以提交为回滚点 | `sync-global-config --check` |
| CN 未启用 open-code-review 但 AGENTS 无条件引用 | 改为"已启用时用 ocr，否则用只读子代理" | — |
| `/i-have-adhd` 入口不存在（库内技能、无命令） | 改为 skill-load 定位后 Read | — |
| computer-use 插件与 CUA 阶梯重叠 | `rules/cua-automation.md` 明确其为备用面，不得混用 | — |
| verify-before-claim 与目标推进抢触发 | description 加"不用于目标推进/接续（→goal-driven-execution）"，保持 ≤300 字符 | skills-doctor CLEAN + 索引重建 128 |
