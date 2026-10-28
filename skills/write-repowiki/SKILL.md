---
name: write-repowiki
description: 按 Qoder 标准格式生成或维护仓库 wiki（.qoder/repowiki/）。当任务要"先查 wiki 再动手""给仓库建/补/改 wiki""代码改了要同批回写 wiki"、或多写手并行写长文档时使用。关键词：repowiki、仓库 wiki、知识卡、wiki_plan、四层结构、回写 wiki、wiki 与代码冲突、knowledge-plan、/knowledge。
---

# 生成与维护 repo wiki（`.qoder/repowiki/`）

## 何时用 / 不用

- **用**：仓库已有 `.qoder/repowiki/`（先查再动手、改完回写）；要新建 wiki；要按官方四层标准补知识卡或内容页。
- **不用**：只是想在对话里解释一段代码——那直接读码回答，别为了"留痕"建 wiki。

## 官方生成器与面板（有官方通道，别手搓）

- **CLI**：`qoder wiki`（可多选项目）；**IDE**：`/knowledge`（生成 / 修改 / 补充 / 重写）与 `/knowledge-plan`（定制生成策略）；**面板**：Generate / Update / Sync 三键。
- **手改内容会被标记保护并反向同步**——"手写 + 官方生成器"两条路可以并存，不必怕手改被覆盖；但要让面板呈现"生成态"，需跑一次官方生成器。
- **结构细节的权威出处**：随包官方技能 `qoder-context-knowledge-plan`（`documents` 上限、`scope` 未实现等都在其内）；公开说明见 `docs.qoder.com/zh/user-guide/repo-wiki` 与 `docs.qoder.com/zh/cli/repo-wiki`。**本技能与校验脚本的口径以该官方技能为准**——它是会变的，冲突时信它。

## 四层结构（缺一不可）

```
.qoder/repowiki/
├── wiki_plan.yaml              # 项目范围 / 模板 / notes（章节地图）
├── knowledge/zh/_index.yaml    # 模块索引：dir_name, title, scope, children, depends_on, related_to
├── knowledge/zh/<模块>/         # 每模块知识卡：_module.yaml + 概述.md + 技术栈.md + 架构设计.md + 编码规范.md + 特殊配置与命令.md
└── zh/content/<章节>/<页>.md    # 面向"上手/查资料"的长文页（按功能主题分层）
```

- `wiki_plan.yaml`：**别写 `scope` 块**——`scope.include/exclude` 当前版本**未实现**，解析后只告警然后忽略（本条已对官方技能 v1.0.42 逐字核对）。有用的是 `template`（如 `architecture`）与 `notes`（章节地图）。
- 硬上限（超出**静默截断**，不报错）：`notes` ≤ 50 条、单条 ≤ 10000 字符；`documents` ≤ 50 页 / 顶级 ≤ 12 / 每个顶级 ≤ 8 子页。
- `documents` 是**白名单 = 上限**：需要更多页或两级子目录时**正确做法是删掉整块 `documents`**，改用 `notes` 写"章节地图"（固定一级章节名单、允许两级子目录、每个目录有同名索引页、新页必须被本目录索引页提及），并让校验脚本切"无白名单模式"。
- `zh/meta/repowiki-metadata.json` **不要手写**（工具生成物，含 repo_id / 加密 blob）；手写权威面 = `wiki_plan.yaml` + `knowledge/` + `zh/content/`。
- 知识卡 schema：`_index.yaml` 的模块键须与各 `_module.yaml` 的 `module_path` 一致；独立卡放 `<标题>/<标题>.md`，frontmatter 必含 `kind/name/category/scope`，`category` 取 overview / architecture_design / tech_stack / coding_conventions / unique_setup_and_commands / configuration_system / dependency_management / logging_system / error_handling / build_system / frontend_style / business_term。

## 内容页格式契约（每页必须满足）

- 顶部 `<cite>` 块列出引用文件（`file://` 相对路径 + **`#Lx-Ly` 行号**）。
- `## 目录` 章节 + 正文 + mermaid 图表；每章节末尾 `**章节来源**` / `**图表来源**`。
- **目录锚点按 github-slugger 语义算**：小写 → 去标点（保留 `_`、`-`、字母数字与 CJK）→ **每个空格替换为一个 `-`（不折叠连续空格）**。所以 `## 症状 B：点了没反应 / 没有报错` → `#症状-b点了没反应--没有报错`，**双横线是对的**。
  - 这条有实测依据：用官方 `github-slugger` 对 6314 个真实标题逐条比对，唯一容易写错的就是"连续空白要不要折叠"——折叠会一次性误报几十处。**别自己发明锚点规则**，算错就批量错。
- 长度：知识卡 200–400 B 量级（概述 / 技术栈本就短，别套正文阈值）。

## 生成流程（无 wiki → 建库）

1. **交付三件套先就位**（见 `rules/doc-authoring.md`）：`_FACTS.md`（已核验事实 + `路径:行号` + 冲突裁决）、`_AUTHORING.md`（格式契约 / 禁编造清单 / 凭据一律 `<redacted>`）、**校验脚本**（见下）。
2. **先读码后落笔**：模块划分按代码事实（入口文件、依赖、路由、表结构），不按"应该有什么"；每个事实带 `file://...#Lx-Ly`。
3. **多写手并行**：每个写手 **≤10 个文件**、独占目录，prompt 明写"边写边落盘，不要先通读"；共享索引页与跨目录登记**由主会话写**，写手禁改。写手异常退出后**先做差集**（已落盘 vs 应产出）再补缺口，**禁止整批重跑**。
4. **事实传播**：写手回报的分歧当线索不当结论，主会话亲自复验（`grep -c`、`wc -l`、看分支常量）再定性；结论定了按"事实源 → plan notes → 知识卡 → 各页"四处传播，改完 grep 复查旧说法残留。
5. **收尾**：跑校验脚本全绿 + 抽查读码；汇报区分"已落地并验证"与"未做 / 未验证"。

## 校验与修复（机器判据，别靠通读）

两个脚本**随本技能分发**（在技能目录里，不在 `~/.qoder/scripts/`）：

```bash
node ~/.qoder/skills-library/write-repowiki/scripts/validate-repowiki.js <repo 路径>            # 只读，退 0/1/2
node ~/.qoder/skills-library/write-repowiki/scripts/fix-repowiki-toc.js <repo 路径>             # 只报
node ~/.qoder/skills-library/write-repowiki/scripts/fix-repowiki-toc.js <repo 路径> --apply     # 落盘（逐文件备份 .bak-<时间戳>）
```

- `validate-repowiki.js` 查七项：`wiki_plan.yaml` 顶层键（`version` / `repowiki` / `knowledgecard` —— **不含 `scope`**）、四层目录、代码围栏闭合、内链可达、`#Lx-Ly` 行号、疑似明文凭据、plan↔磁盘一致；另查 YAML 两个真实坑（tab 缩进、双引号标量里嵌引号）。
- `fix-repowiki-toc.js` 按 slug 反查改写目录锚点（归一化后**唯一命中**才自动改，其余只报交人工）；`--apply` 才落盘。解析规则与 validate 逐字一致（`file://x` 与 `/x` 都是仓根相对，普通相对链接才按当前文件所在目录解析）——**两处口径漂移会出现"一个说红一个说绿"**。
- **读数口径（实测标定，别自己猜）**：行号锚点分三类——合法（查越界/倒置）、**`#L1-Ln` 整文件写法**（`n` 超行数时锚点仍能打开文件 ⇒ **降级为计数说明，不算问题**，否则一次刷出 160+ 条噪声）、**写法残缺**（如 `#L31-L...`，既不是合法行号也不是标题，两边检查都会漏，故显式报）。一次真语料基线（366 页）：526 悬空内链 + 8 切片越界 + 76 残缺行号锚点 + 164 整文件锚点降级——**判断"是不是我改坏的"全靠先跑一次留基线**。
- 无白名单模式：校验"章节名单合规 / 索引页存在 / **每页被本目录索引页提到**（防孤儿页）"。
- **改前先备份**：重写整套 wiki 前先在 `.qoder/` 下做 `repowiki.bak-<date>` 快照（顺带清理快照里的明文口令）。

## 维护既有 wiki（有 wiki → 更新）

- **随时回写**：代码改动后同批更新受影响的知识卡 / 内容页（引用行号变了要一起改）；文档不同批更新就会变成"第二真相"。
- **被取代的旧页用隔离而非删除**：`mv` 到 `.qoder/_backups/<工程>-repowiki-superseded-<date>/<章节>/`，汇报里给可恢复路径。
- 新增页：先看本目录索引页格式，登记进索引页与 `_index.yaml`，再补 `<cite>`。
- 报告"已完成"前必须能说明：本轮跑了哪个校验命令、退出码、覆盖面。

## 反模式（会直接判红）

- ❌ 用 `documents` 白名单硬顶页数（超出静默截断，看不出来）——要更多页就删整块，改用 notes 章节地图。
- ❌ 手写 `zh/meta/repowiki-metadata.json`，或把 `scope.include/exclude` 当生效配置写进 plan。
- ❌ 页面没有 `<cite>` / 行号写错 / 锚点自己发明规则 / 引用指向不存在的文件。
- ❌ 多写手整批重投（覆盖已完成页并引入新幻觉）——先做差集。
- ❌ 只删旧页不隔离（无法回溯），或重写前不打快照。
- ❌ 把未核验的推断写成事实（"应该是…"），或把凭据 / 内网地址写进页面。
