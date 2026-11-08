# Qoder-Optimization-0.1.0 安装说明

## 包内容与落点

| 内容 | 说明 | 放到哪 |
|---|---|---|
| `Qoder-AI编码通用规则.md` | 全局规则与纪律（分层机制 / 验证 / 交付 / 排查 / 文档 / 记忆等） | 摘录进 `~/.qoder/AGENTS.md` |
| `Qoder-个人规则生成提示词.md` | 让 AI 按你的环境生成个人规则的提示词 | 直接喂给 AI 使用 |
| `skills/` | 随包技能源码（每个子目录一份 `SKILL.md`；manifest/catalog 的 tier 只是默认值） | **默认不整目录复制**；先登记包，再按任务用 `pkg-catalog.cjs search/install` 选择；安装时按你的使用习惯决定是否常驻 |
| `agents/` | 全局子智能体（运行期真值核验 / 部署后真实验收） | 拷到 `~/.qoder/agents/`（用户级，官方机制） |
| `plugins/` | 推荐插件清单（装哪些 / 为什么 / settings.json 怎么写） | 见 `plugins/README-plugins.md` |
| `scripts/` | 技能与规则引用的脚本（办公文档 / wiki 校验 / 临时产物清理 / 规则强制层 hook / 同步与打包工具） | 主安装器按依赖闭包安装到 `~/.qoder/scripts/`；高级手动安装需自行核对依赖 |
| `mcp/` | MCP 配置示例（占位符版，无凭据） | 见 `mcp/README-mcp.md` |
| `hooks/` | **hooks 接线模板**（占位符版）+ 事件×脚本对照（脚本不接线不会自己跑） | 并入 `~/.qoder/settings.json` 的 `hooks`，见 `hooks/README-hooks.md` |
| `qoder-memory-export-*.tar.gz` | 通用脱敏记忆包（方法论与工具类，已剔除个人与内网信息）；解包后 `rules-summary.md` 就是**筛选菜单**（逐条勾选） | 按提示词文档第 3 步筛选后并入 `~/.qoder/memory/` |

## 先核对能力，再安装和使用

安装器及技能升降级会同时维护机器索引 `skills-index.json` 和人读导航 `SKILLS.md`，两份派生文件随事务一起提交或回滚。手动编辑技能后，运行 `node ~/.qoder/scripts/build-skills-index.cjs` 重建；加 `--check` 只检查导航是否过期，检索本身不写盘。

实验性上下文工具按需选择：`node scripts/install-package.cjs --yes --install script:context-governor.cjs`，再读已安装脚本的 `--help`。`report --transcript <文件>` 报告用量，`fold --summary <文件> --dry-run` 预览逻辑折叠，`show --range <句柄>` 分页追回原文；可用 `--data-dir <目录>` 指定本地账本位置。逻辑回执不代表模型请求已压缩：没有独立物理执行证据时 `physicalSavings=0`。`--record false` 不保存加载清单。可选 `context-governor-hook.cjs` 默认不接入 settings，接线和实际宿主事件须另行验证。

Windows 从包根 `install.cmd` 开始；跨平台可运行 `node scripts/install-package.cjs`。主入口主动检查本地已有和缺失能力，默认展示计划，不整包搬入常驻目录。

```bash
node scripts/install-package.cjs --dry-run
node scripts/install-package.cjs --yes
node scripts/install-package.cjs --yes --install skill:parallel-orchestration
node scripts/install-package.cjs --yes --install skill:parallel-orchestration --resident skill:parallel-orchestration
```

- 常驻选择：所选技能默认进按需库；交互运行会询问是否设为常驻，非交互用 `--resident <exact-id>`（需与 `--install` 同时给出）。已安装技能换层用 `tier-skills --promote/--demote`，不重复安装。常驻数量按你的实际使用频率决定，包内默认值不是强制值。
- 已有能力：与新包比较，只有本地完整匹配旧登记包的条目才自动更新；本地自改、额外文件或旧基线不明时列为 `REVIEW_UPDATE`，先核对，不覆盖。
- 缺失能力：通用或符合明确偏好的才询问是否安装，专业不匹配的跳过。`--yes` 不代表同意全部可选条目，`--install <exact-id>` 才选择对应能力。
- `routing`：安装规则提醒、能力规划与检索依赖，合并唯一 `UserPromptSubmit` 接线（新装默认 `--workflow-mode model`；已有接线保留原 route/model，不强制切换），登记当前包并维护完整技能索引；冲突保留现场，不能把半套安装报成功。
- 任务使用：相关已装能力主动提示是否用于本任务；`parallel-orchestration` 命中多模块/并行编排任务时自动触发加载与判定（派发前仍须计划确认，自动触发不等于自动派发）。已有明确指名或适用授权就读取入口执行，不重复询问。hook 不安装、不联网、不执行业务，问答与实际使用仍须宿主完成。
- 详细偏好、更新与验收边界见[能力闭环](skills/skills-router/references/capability-lifecycle.md)。本机现役客户端是否完成真实触发须单独核验。

## 完整工作流：分享包复现通用本机效果

新客户端默认 `complete`，确认安装后落地公开的 12 个核心技能、完整依赖、`/checkpoint` 与 `/fact`、AGENTS 托管规则及 `rules/long-task.md`、`rules/vibe-coding.md`，并接入五类事件共 16 条 hook。AGENTS 和规则中的原有内容保留，托管段有摘要登记；托管段被本地修改时先审查。其他专业技能和 MCP、插件、SQLite 接续仍单独选择。

```bash
# 先看计划；全新客户端默认完整工作流
node scripts/install-package.cjs --dry-run --client-root <客户端目录>
node scripts/install-package.cjs --yes --client-root <客户端目录>
# 已登记的旧基础路由保留，明确选择后升级完整工作流
node scripts/install-package.cjs --profile complete --workflow-mode model --yes --client-root <客户端目录>
# 仅需能力路由的新安装可显式选择 routing
node scripts/install-package.cjs --profile routing --yes --client-root <客户端目录>
# 实际安装后只读检查规则、接线与必要文件
node <客户端目录>/scripts/workflow-profile.cjs <客户端目录>
```

完整工作流使用 `command` 可执行文件与 `args` 数组，避免 shell 解释客户端路径；15 条守卫经白名单 launcher 显式绑定客户端，规则提醒也显式绑定。已验证的宿主为 Qoder 0.5.1 / worker 1.1.79-hotfix.7，其原生 runner 支持这一协议。其他版本需核对原生 exec hook 支持；旧宿主可保留 routing，不能把不执行的完整接线算通过。宿主禁用 hook 或工作目录不受信任时不会成为已触发；安装器保留禁用选择并报告冲突。

只升级有可信旧来源且本地原样的能力。旧登记指向已变化仓库时，可用 `--previous-catalog <可信旧包/catalog.json>` 提供已核验旧源；文件仍须完整相同。没有可追溯来源或含本地定制的项保持 `REVIEW_UPDATE`，不会用本地副本伪造旧基线。完整基础受阻返回 `ACTIVATION_BLOCKED / 3`，旧 hook 与包指针保留；事务备份和并发冲突均有恢复目录。

这里复现的是通用工作流，不分发制作端账号、凭据、聊天/项目数据、私人记忆、私人 BYOK 守卫和特定机器安装路径。文件安装、原生事件投递、模型采用和真实业务结果各自验收；`READY` 仅表示安装结构健康。已有核心技能层级与个人选择保持，不为凑数量迁移；本机独有能力按映射或可选前置处理。

## 已迁移到其他磁盘的按需库

默认仍拒绝未经绑定的 junction/symlink。已有迁移布局可明确绑定：先核对 `skills-library` 当前实际目标，再在主安装器传入真实目录；该参数只登记现有布局，不创建链接、不移动目录，不授权其他外部路径。

```bash
node scripts/install-package.cjs --dry-run --client-root <客户端目录> --bind-library <已有按需库真实目录>
node scripts/install-package.cjs --yes --client-root <客户端目录> --bind-library <已有按需库真实目录> --install skill:parallel-orchestration
```

绑定保存在本机 `capability-roots.json`，关联客户端、链接和目标的物理身份；它不是分享内容。读取、比对、索引、资源入口和写入都使用同一解析器，绑定被撤销或身份改变即拒绝；技能及资源子目录的链接仍不读取。只读索引先隔离跨层同名的两份，再读取其他能力，诊断留在 `skills-index.json` 的 `diagnostics`，不猜来源、不删除或移动任何既存副本。

主安装器与 catalog 安装的旧库备份放在库的同一文件系统，客户端恢复日志关联所有外部恢复目录；后期失败按归属恢复，遇到并发变更保留两方资料。跨卷升降级/整库迁移尚不由 `tier-skills` 执行，会在写入前拒绝；绑定不等于允许用 copy-delete 绕过迁移约束。直接 catalog 安装若发现索引器/解析器不是同一批准版本，先用主安装器更新完整基础。

明确选装并行技能会补齐 plan/context/write 工具；完整核心会补齐备份和载体预检依赖。只安装必要代码，不运行并行任务、修改全局规则或自动启用自进化。可选维护工具和外部服务仍按实际需要选择。

## 接续记忆与追回（安装时可选启用）

基础能力路由不依赖 SQLite。需要接续记忆时单独运行下方 `install-continuity.cjs`，或在主安装入口显式选择 `--continuity`；只有明确启用后才接线与采集：

- **已有 Node.js（24.16+，含内置 `node:sqlite` 与 FTS5）**：询问是否启用 SQLite 接续记忆与追回模式。同意后把 `scripts/continuity.cjs` 安装到客户端 `scripts/`，把 `PreCompact` / `PostCompact` / `UserPromptSubmit` / `SessionStart` / `PostToolUse` 五个事件接入该客户端 `settings.json`，并写入 `<存储目录>/auto-bind.json` 的 `{"schema":1,"enabled":true}`——**后续新会话在首个提示时自动绑定并开始采集**，不需要再手动 `enable`。修改前自动备份，完整接线匹配时不重复添加，同一脚本的 Node 路径变化会就地更新。已有命令、matcher、type 或 timeout 冲突时拒绝修改，保留配置供用户裁决；发布时先核对真实原对象再独占创建目标，并发更改不会被覆盖；配置写入失败时只回滚仍属本事务且内容未变化的脚本，恢复冲突保留 `.previous-<uuid>` 原资料并提示路径。策略失败则保留已接 hooks、降级手工 enable，损坏旧策略也备份。按 catalog 安装 `script:install-continuity.cjs` 会同时补齐接续脚本依赖。
- **没有 Node.js（或版本过低 / 缺 `node:sqlite` / FTS5）**：交互运行时询问是否安装 Node.js LTS（可选择用 winget 自动安装，或查看便携版下载方式，解压到非系统盘后重跑）；无 Node 时带参数的 `install.cmd` 请求（help/skip 除外）返回前置条件退出码 3、不写盘；安装后用原参数重试，避免交互重启时丢失 `--dry-run` 或自定义客户端路径。独立 `install-continuity.cjs --yes` 在 SQLite 不支持时返回 3，基础包安装不受此限制；安装 Node 或后续安装器失败会传播真实非零退出。**未安装前保持原有方式**：不写自动绑定策略、不改配置，由你装好 Node 后重新运行安装器。

跨平台或已装 Node 时也可直接运行：

```bash
node scripts/install-continuity.cjs             # 交互式：启用 / 跳过
node scripts/install-continuity.cjs --dry-run   # 只显示计划（不写策略）
node scripts/install-continuity.cjs --yes       # 非交互启用（含自动绑定）
node scripts/install-continuity.cjs --yes --no-auto-bind # 只接线，仍按会话手动启用
```

**自动绑定与手动模式**：

- 自动绑定策略开启后，任何新会话在首个提示时绑定任务 `AUTO-<日期>-<目录名>`，任务结束可在该会话运行 `disable`；**显式 `disable` 的会话不会被自动重开**，包括首次 hook 前关闭的会话。自动绑定与显式启停共用会话锁，锁被占用时不覆盖其他写入者的选择。
- 想整体关闭自动绑定：把 `<存储目录>/auto-bind.json` 改成 `{"schema":1,"enabled":false}` 或删除该文件；安装器**不会**把你显式设为 `enabled:false` 的策略重开。
- 存储目录：Windows 且存在 `D:` 时为 `D:/qoder-data/context-continuity`，否则 `~/.qoder/context-continuity`；`CONTINUITY_STORE` 环境变量优先。每个会话一个 SQLite（FTS5 trigram 检索），不读 Qoder 内部数据库、不上传。
- 采集边界不变：只存用户正文与 `决策：` / `已否证：` / `验证结论：` / `证据引用：` / `授权边界：` 前缀的助手段落，写入前脱敏。检索与手工启停见 `/checkpoint`。

## 安装

要求 Node.js 24.16+（安装器与接续功能）；独立 MCP 安装器只需 Node 18+。在解压包的顶层目录使用包内脚本开始，不假设本机已经安装检索工具；修改已有文件前先备份。

1. 高级手工安装基础检索（主安装器已处理路由时不用重复）：先用 `node scripts/pkg-catalog.cjs register .` 登记当前包，再用 `node scripts/pkg-catalog.cjs install script:skill-load.cjs` 预演。确认后加 `--apply`，安装器会列出并安装缺失的包内依赖；已存在的依赖不覆盖，不需要逐个重复安装。
2. 技能与其他脚本：用包内 `search "<关键词>"` 查找，再按 ID 预演和安装。技能默认进按需库；交互执行 `install <id> --apply` 时会询问是否设为常驻，非交互用 `--tier core|library` 明确选择。不要整目录复制，已存在目标不自动覆盖。
3. 高级手工规则（complete 已安装通用托管段，不要重复）：把 `Qoder-AI编码通用规则.md` 中与你的环境相符的部分并进 `~/.qoder/AGENTS.md`——按你的实际工具与环境删改，不必整篇照抄
4. **高级手工 hooks**（complete 已接入全部公开通用 hook，无需重复；routing 可按需增补）：先按 `hooks/README-hooks.md` 的「模板脚本与安装 ID」安装要用的脚本，再把 `hooks.example.json` 的占位符替换后**并入该客户端的** `settings.json` 的 `hooks`（双端都装才各挂一份；只装一个就只挂一个）。未安装的守卫接线后会 fail-open 静默放行。
5. MCP：照 `mcp/README-mcp.md` 合并配置，并做一次协议级冒烟（能列出工具名即接线成功）
6. 记忆：先按 `Qoder-个人规则生成提示词.md` 第 3 步分类勾选；`node scripts/import-memory.cjs <归档>` 仅预演，确认后加 `--apply`。支持平铺和带版本外层目录；与现有文件冲突时整批拒绝，先三方合并，不覆盖索引或复制归档里的脚本到现役目录。
7. 子智能体：`cp agents/*.md <客户端目录>/agents/`（目录不存在就建；非官方机制不支持时可直接读该目录下的 md 当提示词用）

## 只装了一个客户端（单端装配）

- **不猜，看实际存在**：`~/.qoder`（国际版）与 `~/.qoder-cn`（CN）哪个在，就往哪个装；只存在一个时，另一个**不会被创建**。
- 依据：状态 / 台账 / 技能索引 / 按需加装的落点都走 `scripts/client-root.js`（HOME 下实际存在的那一侧）；两侧同步类脚本检测到只有一边时只报"单端模式"并退 0，不做 `mkdir`。
- 显式指定优先：`QODER_HOME`（脚本）与 `--config-dir`（`install-mcp.cmd`）按你给的值走——首次安装想放到别处时用它。
- 例外说明：没有任何客户端目录时（脚本直接从包目录跑），默认落点是 `~/.qoder`；正常安装场景不会走到这里。

## 技能分层（按需注入）

技能默认全量注册，每条 `description` 每轮注入——装得多时这是主要成本。本包附带分层方案：

- 常驻：`~/.qoder/skills/`（跨域元技能 + 高频技能），描述每轮注入
- 按需：`~/.qoder/skills-library/`（单领域技能），**不参与注入**
- 检索：`node ~/.qoder/scripts/skill-load.cjs "<关键词>"` → 命中后 Read 对应 `SKILL.md` 再动手；也可用 `/skill-load "<关键词>"`
- **一键分层**：`node ~/.qoder/scripts/tier-skills.cjs`（dry-run 预览）→ 加 `--apply` 执行；`--keep a,b,c` 额外保留；`--restore <名>` / `--restore-all` 恢复。核心保留列表内置在脚本里
- 重建索引：任何增删移技能后显式跑 `node ~/.qoder/scripts/build-skills-index.cjs`；`skill-load` 只读扫描实际文件，不在查询时写盘。包候选会标「本地未发现 / 与包内一致 / 内容与包内不同」；本地已命中但包内内容不同时输出 `NEXT_ACTION: ASK_UPDATE`，包候选可安装/可更新时输出 `NEXT_ACTION: ASK_INSTALL_OR_UPDATE`。出现这两类信号时必须先询问用户是否安装/更新，未获明确选择不得写盘
- **新增技能先判层级**：元/跨域高频或被 AGENTS·rules 硬引用（引用处未注明按需检索）→ `skills/`；单领域专用 → `skills-library/`；拿不准默认进库。创建前用 `node ~/.qoder/scripts/carrier-preflight.cjs --type skill --name <名> --path ~/.qoder/skills-library/<名>/SKILL.md` 预检——会列出两层同名/同类候选、提示本次拟入层与常驻预算（40 软 / 60 硬）

**常驻数量由使用者决定，不由分享包写死**：

- 安装技能时默认按需；交互执行 `install <id> --apply` 会询问「是否设为常驻」，回答 `y` 进 `skills/`，直接回车进 `skills-library/`。非交互安装必须用 `--tier core|library` 明确选择，不会静默把技能加入常驻。
- 用了一段时间后按实际频率调整：`node ~/.qoder/scripts/tier-skills.cjs --promote <常用技能>` 升到常驻，`--demote <低频技能>` 退回按需；都先 dry-run，加 `--apply` 才移动并重建索引。**promote/demote 会写入 `<客户端>/skills-resident.json`**，后续默认分层不会把你的选择移回去；安装时选常驻（`--tier core` / `--resident`）也会自动记入该清单；包升级不覆盖这个文件。`--keep` 和 `--restore-all` 只影响本次操作。
- 想恢复包内默认层级：删除 `skills-resident.json` 后运行一次 `tier-skills --apply`；升级包时若不想保留旧选择，也按这个方式处理。
- **按使用记录给建议，不自动改层级**：`skill-load --record` 记录一次检索需求，实际采用后运行 `skill-usage.cjs log <名> --source use`；`skill-usage.cjs report` 查看 30/90 天使用，`suggest` 按阈值给建议——按需技能 30 天 ≥3 次或 90 天 ≥5 次建议晋升；用户自选常驻且 90 天未用建议降级；包内 CORE 默认常驻不建议降级。建议必须先用 `AskUserQuestion` 确认，再运行 `tier-skills --promote/--demote --apply`。原生 Skill 调用无法被脚本自动观测，未显式 log 的使用不进入统计。
- 包内 12 个常驻只是**默认起点**（基础路由与跨域元技能），不是要求接收者照搬的数量。常驻越多，每轮注入的描述越长；以「这条技能是否靠描述自动命中」为准，不靠堆数量。

包内实物：133 个技能（12 常驻 + 121 按需）；常驻描述 2643 字符，全部技能描述 27093 字符，占比 9.8%。按 catalog 计算，不是接收者的已安装数量；12 只是默认起点，常驻数量由使用者按习惯在安装时与使用中决定。

## 按需加装（分享包索引）

包内收录经脱敏门验证的完整能力集，但安装时默认不全量复制；按技术栈和任务从 catalog 选择，以后用到别的也不用重新翻包：

- 登记位置（一次）：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`
- 检索：`node ~/.qoder/scripts/pkg-catalog.cjs search "<关键词>"`，或 `/pkg-find "<关键词>"`；结果标「本地未发现 / 与包内一致 / 内容与包内不同」，出现 `NEXT_ACTION` 时必须先用 `AskUserQuestion` 询问（安装/更新（推荐） / 查看差异 / 保持现状），未获明确选择不得写盘
- 安装：`install <id>` 先预演依赖闭包，确认后加 `--apply`；技能默认按按需库落点，交互 `--apply` 会询问是否常驻，非交互用 `--tier core|library` 指定。另一层已有同名技能时拒绝写入，迁移请使用 tier-skills；索引先暂存再以归属/内容核对和独占创建提交。失败只回滚本批仍属本事务且未变化的文件；检测到并发修改时保留目标与备份目录、明确报告未完整回滚，先裁决再重试。
- 更新：`内容与包内不同` 表示可更新；先三路比对并备份，保留本地较新内容，确认后 `install <id> --apply --force`，再重建索引并跑 `skills-doctor`
- 批量漂移：`node ~/.qoder/scripts/pkg-catalog.cjs drift` 核对全部已安装副本，列出与包内不同的条目；升版部署询问必须带上这份清单。已安装条目的包源缺失或不可比对时输出 `DRIFT_UNVERIFIED` 并退出 2，不能当作一致。额外本地文件与备份仍不纳入包内文件比对。
- 参数缺值、重复或未知选项会在写盘前拒绝；含空格的目录需整体引用，`--catalog` / `--tier` 不能留空。
- 插件 / 社区技能 / MCP：只给官方安装命令与合并说明，不代装、不转发源码
- 兜底：`skill-load` 查不到时，会自动到已登记的包内索引里找，并给出加装命令

索引：`catalog.json`（机器可读）/ `INDEX.md`（人读），状态区分随包 / 外部 / 模板 / 已停用。

记忆归档导入使用 `node scripts/import-memory.cjs <归档> [--client-root <客户端目录>]` 预演，批准后加 `--apply`。导入先暂存完整输入；失败遇到并发改写时保留目标、暂存内容与可写入时生成的 `RECOVERY.json`，错误中给出恢复目录。不要把该目录当垃圾清理；核对首次错误和冲突后再处理。

## 需求澄清与提示词优化

按个人习惯启用：将《Qoder-AI编码通用规则.md》中「分级澄清与提示词优化」并入已有 rules/long-task.md（保留原内容），或按同章直接使用；commands/clarify.md 是薄入口，不要求另装澄清技能。
明确需求直接交付，轻微歧义说明假设，关键歧义优先核心问题并保留其他阻塞项，回答后复核剩余条件；理解确认不等于执行授权，本次仅优化提示词时不沿用历史执行授权。只有本次明确要求执行或接续有效的同范围任务时才实施。契约检查：node scripts/clarify-contract.test.js（静态覆盖，不保证所有模型场景行为）。

## 项目约定与验证选档

这两套模块按需采用，分发源码不等于在现役客户端启用。根 `docs/` 是本地设计资料，不跟踪、不随包；公开调用说明保留在对应技能与源码测试中。

- **项目约定**：检查国际化、编码风格、工具、依赖和版本约束，保留来源、范围与未知项。使用包内 `node scripts/pkg-catalog.cjs install script:convention-session.cjs` 预演，确认后加 `--apply`，安装器连同 `convention-runtime` 的入口和锁文件一起安装；第三方依赖仍需另行安装。
- **验证选档（默认自动触发，model 优先）**：新装接线默认 `--workflow-mode model`，`rules-reminder.js` 每轮注入工作方式结构化输入，由模型判定 `verification: assess|skip`；再按 `skills/verify-before-claim/references/adaptive-verification.md` 准备事实、询问四档并执行所选清单。已有 route 接线的老用户升级后不会自动切换：安装/升级完成后，Agent 必须先询问用户是否启用 model；同意后运行 `node scripts/install-package.cjs --workflow-mode model --yes`（显式切换已有接线），需要回退时改用 `--workflow-mode route --yes`。0.0.24 及更早版本不认识该参数，不要提前添加。route 路径由 `verification-trigger-core.js` 判定，口语化动作、续接轮和只读请求可能不触发。自检：model 模式看本轮 `WORKFLOW_CONTEXT`，route 模式看 `~/.qoder/tmp/verification-trigger/decisions.log`。选档模块可用 `node scripts/pkg-catalog.cjs install script:verification-session.cjs` 预演，再按明确批准安装；写 `~/.qoder/verification-trigger.json` 的 `{"enabled":false}` 时不触发。
- **第三方依赖**：对安装器实际打印的目录运行 `npm ci --ignore-scripts --prefix <客户端目录>/scripts/convention-runtime`。不随包复制 `node_modules`，安装器不自动联网、执行包脚本或改动现役接线。
- **验证边界**：本地静态检查、模拟问答和依赖安装验收不代表真实 UI/Agent 试点。人工选项不自动执行；未答复不默认同意；发布前完整检验与平台审批要求不受选档影响。

## 收敛与优化（装好之后先跑一遍，之后定期跑）

本包自带收敛工具链，不必从零摸索。直接 `/converge`，或按五步手动跑：

> 按接收者技术栈选择内容；安装后运行下列检查，不能把制作端通过当作目标机器已验证。技能描述保留触发线索，不为压字数截断能力。

| 步骤 | 命令 / 技能 | 可失败判据 |
|---|---|---|
| ① 体检 | `node ~/.qoder/scripts/skills-doctor.cjs`、`skill-collisions.cjs`、`rules-weekly-audit.js --no-fix` | RED / WARN 全部列出来 |
| ② 收敛描述 | 把 `SKILL.md` 的 description 压到 ≤300 字符：保留用途+触发词+分流句，删实现细节；ASCII `": "` 换全角「：」 | `DESC-LONG=0` 且 `YAML-HAZARD=0`，每轮注入明显下降 |
| ③ 同域合并 | 技能 `skill-trim-with-capability-transfer`：停入口不丢能力，独有能力搬进留存内容 | 触发重叠对=0；无悬空引用；被停能力有落点 |
| ④ 规则优化 | 技能 `rules-conflict-audit`：六维交叉比对，按 P0/P1/P2 出「原文/行号/影响/改文/扩权标注」，先报告后改 | 周检 0 告警；门禁自测全过 |
| ⑤ 复验 | 重跑 ①，记录「收敛前 / 后」的每轮注入字符数 | `VERDICT=CLEAN` +「健康（0 告警）」 |

**两条边界**：描述收敛是**语义改写不是截断**（砍掉触发词会让技能不再被唤起）；合并是**能力搬家不是删文件**（删之前确认独有能力已有落点）。新增技能/规则/记忆前先跑 `node ~/.qoder/scripts/carrier-preflight.cjs --type <类型> --name <名称>` 查重。

## 脚本速查

- `node ~/.qoder/skills-library/office-docs/scripts/office.js read-xlsx|write-xlsx|set-xlsx|read-docx|write-docx ...` —— Node 读写 Excel / Word（依赖在技能目录内，见「依赖」；顶层 `~/.qoder/scripts/office.js` 是兼容转发壳）
- `node ~/.qoder/skills-library/office-docs/scripts/office-styles.js themes|render|extract-theme|--selftest` —— Word 主题化排版（公文 / 商务 / 极简三套 + 目录域 + 页码）；`extract-theme --from 图.png -o theme.json` 从截图或 LOGO 取主色板并按 WCAG AA 校准可读性，`render --theme-json theme.json` 直接套用。用法与验证边界见技能内 `STYLES.md`（图像解码依赖 `jimp`，已列入该技能的 `package.json`）
- `node ~/.qoder/scripts/validate-repowiki.js <仓库根>` / `fix-repowiki-toc.js` —— repo wiki 校验与目录修复
- `node ~/.qoder/scripts/tmp-sweeper.js` —— 临时产物清理（默认 dry-run，加 `--apply` 才真删）
- `node ~/.qoder/scripts/disk-sweeper.js` —— C 盘水位三档报告与清理（默认只列，`--apply` 才删；配套指令 `/clean-disk`）
- `node ~/.qoder/scripts/stop-gate.js` / `rules-reminder.js` / `huge-output-guard.js` / `session-budget.js` / `edit-guard.js` / `global-config-guard.js` / `commit-scope-guard.js` / `rules-weekly-audit.js` —— 规则强制层与守卫脚本，**需要在 `~/.qoder/settings.json` 的 `hooks` 里自行接线**才生效（说明见 `scripts/README-rule-enforcement.md`）
- `node ~/.qoder/scripts/work-queue-check.js` —— 接续队列可恢复性校验（四要素齐不齐 / 阻塞有没有理由 / 关键入口路径还在不在；相对入口以队列所在目录为基准，`--file` 可检查其它目录的队列；退出码 3 = 没有队列文件）；配套指令 `/checkpoint` 与 stop-gate 的 R6c 门禁
- `node ~/.qoder/scripts/skill-usage.cjs report|suggest|log <名>` —— 技能使用记录与晋升/降级建议（只记技能名 / 时间 / 来源；建议必须经用户确认后交给 `tier-skills --promote/--demote`）
- `node ~/.qoder/scripts/skills-doctor.cjs` / `config-doctor.cjs` / `skill-collisions.cjs` —— 技能门禁（描述长度 / 悬空引用 / 两侧可见性）、配置面对齐（插件 / hooks / MCP / 安全开关）、技能撞名扫描；均带 `--selftest`
- `node ~/.qoder/scripts/edge-net-check.cjs [--fix]` / `gh-accel-plan.cjs` —— 浏览器打不开网页的定性诊断与"该不该交还直连"的六桶清单；配套指令 `/edge-net-check`
- `node ~/.qoder/scripts/pack-folder.js <目录> <zip>` —— 生成 Unix 来源 zip（中文文件名在 unzip 下不乱码）

## 未随包的部分

- 与作者本机强绑定的脚本未提供：`export-memory.sh` / `import-memory.sh`（凭据文件清单是本机的）、`verify-global-setup.js`（含本机例外登记）、`check-share-docs.js` / `verify-share-package.js` / `pack-generic-memory.js`（本包自身的构建与校验链）、项目专有脚本。
- `link-cn-dirs.ps1` / `sync-projects-junction.ps1` 是**作者本机双客户端迁移的历史脚本**，随包只为保留方法，**别照跑**；单客户端不需要。
- 记忆包（tar.gz）内另有一套 `scripts/`（记忆导出 / 导入工具）。

## 依赖

- Node.js ≥24.16（安装器与接续功能使用内置模块，包括归档 CRC 与 SQLite；不适用于 Node 20）。独立 MCP 安装器只需 Node 18+。
- `office-docs` 需另行安装锁定依赖，`node_modules` 不随包。默认按需落点使用 `npm ci --ignore-scripts --prefix <客户端目录>/skills-library/office-docs`；显式装到core时使用安装器实际打印的目录。不自动联网装包。
- Git Bash（Windows）：`sync-*.sh` 与部分守卫要用 bash；非 Windows 直接用系统 bash。
