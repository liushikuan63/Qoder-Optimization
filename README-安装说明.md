# Qoder-Optimization-0.0.8 安装说明

## 包内容与落点

| 内容 | 说明 | 放到哪 |
|---|---|---|
| `Qoder-AI编码通用规则.md` | 全局规则与纪律（分层机制 / 验证 / 交付 / 排查 / 文档 / 记忆等） | 摘录进 `~/.qoder/AGENTS.md` |
| `Qoder-个人规则生成提示词.md` | 让 AI 按你的环境生成个人规则的提示词 | 直接喂给 AI 使用 |
| `skills/` | 随包技能源码（每个子目录一份 `SKILL.md`，tier 见 manifest/catalog） | **默认不整目录复制**；先登记包，再按任务用 `pkg-catalog.cjs search/install` 选择 |
| `agents/` | 全局子智能体（运行期真值核验 / 部署后真实验收） | 拷到 `~/.qoder/agents/`（用户级，官方机制） |
| `plugins/` | 推荐插件清单（装哪些 / 为什么 / settings.json 怎么写） | 见 `plugins/README-plugins.md` |
| `scripts/` | 技能与规则引用的脚本（办公文档 / wiki 校验 / 临时产物清理 / 规则强制层 hook / 同步与打包工具） | 拷到 `~/.qoder/scripts/` |
| `mcp/` | MCP 配置示例（占位符版，无凭据） | 见 `mcp/README-mcp.md` |
| `hooks/` | **hooks 接线模板**（占位符版）+ 事件×脚本对照（脚本不接线不会自己跑） | 并入 `~/.qoder/settings.json` 的 `hooks`，见 `hooks/README-hooks.md` |
| `qoder-memory-export-*.tar.gz` | 通用脱敏记忆包（方法论与工具类，已剔除个人与内网信息）；解包后 `rules-summary.md` 就是**筛选菜单**（逐条勾选） | 按提示词文档第 3 步筛选后并入 `~/.qoder/memory/` |

## 安装

推荐 Node.js 24。在解压包的顶层目录使用包内脚本开始，不假设本机已经安装检索工具；修改已有文件前先备份。

1. 基础检索：先用 `node scripts/pkg-catalog.cjs register .` 登记当前包，再用 `node scripts/pkg-catalog.cjs install script:skill-load.cjs` 预演。确认后加 `--apply`，安装器会列出并安装缺失的包内依赖；已存在的依赖不覆盖，不需要逐个重复安装。
2. 技能与其他脚本：用包内 `search "<关键词>"` 查找，再按 ID 预演和安装。技能层级由 manifest/catalog 指定，`--tier core` 可显式选择常驻；不要整目录复制，已存在目标不自动覆盖。
3. 规则：把 `Qoder-AI编码通用规则.md` 中与你的环境相符的部分并进 `~/.qoder/AGENTS.md`——按你的实际工具与环境删改，不必整篇照抄
4. **hooks 接线**（不做这步，脚本躺着不跑）：照 `hooks/README-hooks.md` 把 `hooks.example.json` 的占位符替换后**并入该客户端的** `settings.json` 的 `hooks`（双端都装才各挂一份；只装一个就只挂一个）
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
- 重建索引：任何增删移技能后显式跑 `node ~/.qoder/scripts/build-skills-index.cjs`；`skill-load` 只读扫描实际文件，不在查询时写盘，包候选不等于已安装或已授权安装
- **新增技能先判层级**：元/跨域高频或被 AGENTS·rules 硬引用（引用处未注明按需检索）→ `skills/`；单领域专用 → `skills-library/`；拿不准默认进库。创建前用 `node ~/.qoder/scripts/carrier-preflight.cjs --type skill --name <名> --path ~/.qoder/skills-library/<名>/SKILL.md` 预检——会列出两层同名/同类候选、提示本次拟入层与常驻预算（40 软 / 60 硬）

包内实物：125 个技能（12 常驻 + 113 按需）；常驻描述 2645 字符，全部技能描述 26252 字符，占比 10.1%。按 catalog 计算，不是接收者的已安装数量。

## 按需加装（分享包索引）

包内收录经脱敏门验证的完整能力集，但安装时默认不全量复制；按技术栈和任务从 catalog 选择，以后用到别的也不用重新翻包：

- 登记位置（一次）：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`
- 检索：`node ~/.qoder/scripts/pkg-catalog.cjs search "<关键词>"`，或 `/pkg-find "<关键词>"`
- 安装：`install <id>` 先预演依赖闭包，确认后加 `--apply`；技能按 manifest/catalog 的 tier 落点安装。另一层已有同名技能时拒绝写入，迁移请使用 tier-skills；失败会回滚本批文件与索引。
- 插件 / 社区技能 / MCP：只给官方安装命令与合并说明，不代装、不转发源码
- 兜底：`skill-load` 查不到时，会自动到已登记的包内索引里找，并给出加装命令

索引：`catalog.json`（机器可读）/ `INDEX.md`（人读），状态区分随包 / 外部 / 模板 / 已停用。

## 需求澄清与提示词优化

按个人习惯启用：将《Qoder-AI编码通用规则.md》中「分级澄清与提示词优化」并入已有 rules/long-task.md（保留原内容），或按同章直接使用；commands/clarify.md 是薄入口，不要求另装澄清技能。
明确需求直接交付，轻微歧义说明假设，关键歧义优先核心问题并保留其他阻塞项，回答后复核剩余条件；理解确认不等于执行授权，本次仅优化提示词时不沿用历史执行授权。只有本次明确要求执行或接续有效的同范围任务时才实施。契约检查：node scripts/clarify-contract.test.js（静态覆盖，不保证所有模型场景行为）。

## 项目约定与验证选档

这两套模块按需采用，分发源码不等于在现役客户端启用。根 `docs/` 是本地设计资料，不跟踪、不随包；公开调用说明保留在对应技能与源码测试中。

- **项目约定**：检查国际化、编码风格、工具、依赖和版本约束，保留来源、范围与未知项。使用包内 `node scripts/pkg-catalog.cjs install script:convention-session.cjs` 预演，确认后加 `--apply`，安装器连同 `convention-runtime` 的入口和锁文件一起安装；第三方依赖仍需另行安装。
- **验证选档**：用 `node scripts/pkg-catalog.cjs install script:verification-session.cjs` 预演，再按明确批准安装。该文件是宿主调用的 CommonJS 库，不是直接执行的检查命令；强化、标准、轻量和人工选项的绑定流程见 `skills/verify-before-claim/references/adaptive-verification.md`。
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
- `node ~/.qoder/scripts/work-queue-check.js` —— 接续队列可恢复性校验（四要素齐不齐 / 阻塞有没有理由 / 关键入口路径还在不在；退出码 3 = 没有队列文件）；配套指令 `/checkpoint` 与 stop-gate 的 R6c 门禁
- `node ~/.qoder/scripts/skills-doctor.cjs` / `config-doctor.cjs` / `skill-collisions.cjs` —— 技能门禁（描述长度 / 悬空引用 / 两侧可见性）、配置面对齐（插件 / hooks / MCP / 安全开关）、技能撞名扫描；均带 `--selftest`
- `node ~/.qoder/scripts/edge-net-check.cjs [--fix]` / `gh-accel-plan.cjs` —— 浏览器打不开网页的定性诊断与"该不该交还直连"的六桶清单；配套指令 `/edge-net-check`
- `node ~/.qoder/scripts/pack-folder.js <目录> <zip>` —— 生成 Unix 来源 zip（中文文件名在 unzip 下不乱码）

## 未随包的部分

- 与作者本机强绑定的脚本未提供：`export-memory.sh` / `import-memory.sh`（凭据文件清单是本机的）、`verify-global-setup.js`（含本机例外登记）、`check-share-docs.js` / `verify-share-package.js` / `pack-generic-memory.js`（本包自身的构建与校验链）、项目专有脚本。
- `link-cn-dirs.ps1` / `sync-projects-junction.ps1` 是**作者本机双客户端迁移的历史脚本**，随包只为保留方法，**别照跑**；单客户端不需要。
- 记忆包（tar.gz）内另有一套 `scripts/`（记忆导出 / 导入工具）。

## 依赖

- Node.js ≥24.16（脚本使用内置模块，包括归档CRC与SQLite；不适用于Node 20）。
- `office-docs` 需另行安装锁定依赖，`node_modules` 不随包。默认按需落点使用 `npm ci --ignore-scripts --prefix <客户端目录>/skills-library/office-docs`；显式装到core时使用安装器实际打印的目录。不自动联网装包。
- Git Bash（Windows）：`sync-*.sh` 与部分守卫要用 bash；非 Windows 直接用系统 bash。
