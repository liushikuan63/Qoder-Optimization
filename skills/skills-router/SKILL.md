---
name: skills-router
description: 领域任务的技能入口。任何非纯对话任务开始前，先用 node ~/.qoder/scripts/skill-load.cjs "<关键词>" 检索技能索引（常驻 + 按需库，数量以 ~/.qoder/skills-index.json 实测为准）；命中就 Read 对应 SKILL.md 再动手。覆盖 Java/Spring、数据库、前端、部署、运维、文档、小程序、爬虫等。不检索等于这些技能不存在。新增技能先判层级：元/跨域高频或硬引用进 skills/，单领域默认进 skills-library/。触发词：用什么技能、技能索引、skill-load、按需技能、领域技能、路由回归。
---

# 技能路由（分层按需加载）

技能分两层：`~/.qoder/skills/` 放元/高频入口，`~/.qoder/skills-library/` 放按需技能；数量以现场扫描为准，不在正文固定。只读检索元数据，命中后再读取对应工作流。

## 按需装载与新增标准

- 只加载当前任务单元需要的技能正文和必要引用；已在上下文且未变化的内容直接复用，不重复整读，不把全部候选正文一次性注入。
- 后续生成、新增或导入技能默认进入按需库；确需常驻时按现有分层规则说明跨域高频或硬引用依据并确认，不能因批量维护自动扩大常驻集。
- 分发包收录不等于全部安装或常驻加载；安装先预演，按需选择，不改变已有技能层级来凑数量。

## 何时必须查

任务落到具体领域时（Java/Spring、数据库、前端/UI、部署、服务器、文档、小程序、PPT、测试……），**先查索引再动手**：

```bash
node ~/.qoder/scripts/skill-load.cjs "i18n 国际化"
node ~/.qoder/scripts/skill-load.cjs "postgresql 索引"
node ~/.qoder/scripts/skill-load.cjs "技能分层"
```

输出形如：

```
1. api-i18n-three-locale-delivery   [library]  …/skills-library/api-i18n-three-locale-delivery/SKILL.md
   既有 API 三语国际化落地：…
```

命中后**Read 该 SKILL.md 再执行**。多关键词必须全部命中；无本地命中则查已登记的分享包目录，候选不等于已安装或授权安装。换同义词再查仍无相关候选，才说明能力缺口。

## 首次业务操作前的项目约定

- 普通小改动、工具操作和文档任务都先核对国际化、编码风格、工具选择、依赖管理、版本约束；架构、测试、数据、安全和交付按任务触发。明确规范直接继承，实质冲突才问；缺证据不能写成不适用。
- 已获准使用约定机制且脚本与依赖已就绪时，先调用已核验脚本目录的 `convention-core.cjs discover --project <项目绝对路径>`；只读发现不执行项目配置，也不创建政策。再按下方[本地接口与边界](#本地接口与边界)解析来源、范围与逐维决定。
- 在第一次业务命令或写入前冻结任务约定包，配套资源与检查一起规划；任务扩大或规则、工具、依赖变化后重新解析。基础只读预检不依赖这个包。
- 实施范围按本地、隔离、指定项目、现役逐段选择；验证方式独立提供自动、分工、交由用户。已有明确选择不重复询问；仅在范围变化或下一段未获准时重新选择。人工模式不自动测试，保持未验证。
- `convention-session.cjs prepare` 给出原生提问参数；真实问答与宿主批准分别绑定后才可 `run`。仓库自报批准、缓存选择和推荐项不能代替用户答复；回执只证明所选范围，不证明现役已启用。
- 缺脚本/依赖时保留必要人工预检并报告能力缺口，不为了通过路由擅自安装、改设置或接线。仓库技能源码更新与现役装载是两件事。

### 本地接口与边界

- [convention-core.cjs](../../scripts/convention-core.cjs) 的 `resolve(request, authority)` 读取 `schema: 1`、绝对 `projectRoot`、`taskId`、`sessionId`、`mode`、`snapshotMode`、`files`、`applicability` 与 `rules`；来源按项目相对路径和原始字节 SHA-256 固定，工作树与索引均不因文本解码忽略 BOM 变化。规则只声明维度、范围、值与检查 ID，不执行其中命令。
- `authority` 由获准宿主核对真实来源与批准，绑定任务、会话、工作树及范围；不得从仓库自报政策或示例 JSON 制造批准。返回 `decisions`、`requiredCheckIds`、`ready` 和 `packageDigest`；`ready: false` 必须补证或澄清，不能当通过。
- [convention-session.cjs](../../scripts/convention-session.cjs) 的 `prepare(bundle, {requestMessageId, checks})` 要求每项提供 `id`、`phase`、`level`、`input`、独立 `expectationRef`；`questions()` 生成范围和验证方式的原生问题。`select()` 绑定当前真实问答快照及宿主授权解析器，`run()` 执行所选本地检查，`auditReceipt()` 只读复核内容与环境未变；环境指纹包含所选本地命令的可执行文件真实路径、字节及声明的 `inputs`，即使它们不在业务文件清单内，变化也使旧回执失效。
- 国际化检查显式提供 `sourceRoots` 和 `catalog`（语言、默认语言、命名空间及资源路径），必须覆盖所有约定绑定文件。JavaScript 按词法作用域识别 i18next，循环或 switch 内的同名局部绑定不算翻译函数，初始化、解构和循环写入会使已有翻译绑定失效；无法静态确定的可见文本保持未验证。现有静态适配器只证明所支持的 JavaScript/HTML 与 JSON 资源检查；不支持的语法保持未验证，真实 UI/Agent 试点和现役接线均需另行批准。
- 包内安装器可预演 `install script:convention-session.cjs`；确认后才加 `--apply`，并在实际安装目录对 `scripts/convention-runtime` 执行锁定的 `npm ci --ignore-scripts`。不复制 `node_modules`，不自动联网安装或启用。

## 索引与维护

- 真源：两层实际 SKILL.md；`build-skills-index.cjs` 的扫描函数供检索与显式建索引共同使用。
- 派生快照：`~/.qoder/skills-index.json`（name / tier / path / description）；增删移后显式重建，检索本身不写盘。
- 包候选：`pkg-catalog.cjs` 统一匹配与状态展示；本地文件存在不证明已装载，插件/MCP 需通过平台工具核对。
- 分层原则：按 AGENTS 当前「技能分层」条款判定，不复制另一套门槛。
- 验证：`node ~/.qoder/scripts/skill-load.test.js`；涵盖过期/缺失索引、同名冲突、候选状态、只读与正负查询。

## 分层路由隔离回归

目录中的候选、文件存在、已安装与运行期可用不是同一状态。路由与目录搜索复用实际扫描及统一多词匹配函数，不维护第二套判断。

1. 隔离 `HOME`、`USERPROFILE`、`TEMP`、`TMP`、`TMPDIR` 与包目录覆盖变量；夹具不能读写本机配置。缺失或陈旧索引下仍应查询现场，查询前后逐文件哈希与路径集合不变。
2. 构造同词干、不同描述的技能：多词必须全部匹配；无关负对照退出 3 且不返回目标。跨层同名退出 2，不静默挑选，也不覆盖已有派生索引。
3. 分别覆盖已存在脚本、未安装候选、插件/MCP 未核验、失效登记和损坏目录；只给预演入口，不自动安装，也不把「未核验」改称「未安装」。
4. 用 `node ~/.qoder/scripts/skill-load.test.js` 跑路由回归，用 `node ~/.qoder/scripts/global-config-smoke.test.js` 验证检查器缺失、非零退出及超时计红。仅当前明确不适用的检查器可跳过，跳过不计通过。
5. 原版失败对照与修订版使用同套夹具；断言输入、返回内容、退出码和零写入，而不是只报测试条数。包内搜索与 fallback 对同一多词输入须保持一致。

## 不做什么

- 不凭记忆猜技能名，不把派生索引当作比现场更高的真源
- 不要为了「可能用到」把库里的技能搬回注册目录（那会把注入成本加回去）
