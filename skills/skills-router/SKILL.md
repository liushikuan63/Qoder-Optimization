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
