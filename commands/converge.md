---
name: converge
description: 一键收敛与优化——技能描述瘦身、同域技能合并、规则冲突体检。装好本套配置后或定期跑一遍。
---

# /converge —— 收敛与优化

按顺序执行五步，每步都有**可失败判据**；任一步不绿就停在那一步修完再往下。

## 第 1 步 · 体检（只读，先拿基线）

```bash
node ~/.qoder/scripts/skills-doctor.cjs          # 描述长度 / 悬空引用 / 两侧可见性 / 撞名
node ~/.qoder/scripts/skill-collisions.cjs       # 每轮注入开销 + 触发重叠对
node ~/.qoder/scripts/rules-weekly-audit.js --read-only   # 规则漂移 / 篇幅 / 接线 / 心跳
node ~/.qoder/scripts/carrier-preflight.cjs --type skill --name <拟新增名称>   # 仅在要新增载体时
```

记下两个数：`skill-collisions` 输出的「每轮注入≈N 字符」、`skills-doctor` 的 `DESC-LONG` 计数。

**判据**：`skills-doctor` 的 RED 项全部列出来（DESC-LONG / YAML-HAZARD / DANGLING-REF）；`rules-weekly-audit` 的 WARN 全部列出来。

## 第 2 步 · 收敛技能描述

只改 `SKILL.md` frontmatter 的 `description`，正文不动：

- 目标 **≤300 字符**（每轮注入按字符计费，常驻技能多到几十个时，长描述能吃掉几十 KB）
- **保留**：用途一句话 + 触发词 + 「不适用于 → 另一技能」分流句
- **删掉**：实现细节、示例、长篇理由（这些在正文里）
- 不要出现 ASCII `": "`（会破坏补丁工具；用全角「：」或改写）
- 改前备份：`node ~/.qoder/scripts/backup-file.js <SKILL.md>`

**判据**：`skills-doctor` 的 `DESC-LONG=0` 且 `YAML-HAZARD=0`；再跑 `skill-collisions` 确认「每轮注入」明显下降、触发重叠对=0。

## 第 3 步 · 同域技能合并

用技能 `skill-trim-with-capability-transfer` 的流程：**停入口、不丢能力**。

1. 先看 `skill-collisions.cjs` 的「未互相指认」重叠对——这类才是真正会抢触发的
2. 两条路：① 在 description 里互相指认（分工写清）；② 真正合并——把被停技能里「只此一家」的能力搬进留存技能（真代码或规则条目）
3. 停用走 `~/.qoder/skills-disabled/`（移走不删、可回退）
4. 停完必须复查引用：`node ~/.qoder/scripts/skills-doctor.cjs`（悬空引用）与 `rules-weekly-audit.js --read-only`（提及扫描）

**判据**：重叠对=0；`skills-doctor` 无 DANGLING-REF；被停技能的能力在留存内容里有落点（能指出文件与行）。

## 第 4 步 · 规则冲突体检

用技能 `rules-conflict-audit`：六维交叉比对 `AGENTS.md` ↔ 每轮提醒 ↔ 收尾门禁 ↔ `rules/*.md` ↔ 记忆索引 ↔ 技能 description。

- 产出按 P0/P1/P2 分级，每条带「原文引用 + 文件:行 + 行为影响 + 具体改文 + 扩权标注」
- **先报告后改**；涉及放宽红线、改权限或拦截范围的，逐条要批准
- 改完必须跑：`node ~/.qoder/scripts/rules-weekly-audit.js --read-only`

**判据**：周检 0 告警；门禁自测 `node ~/.qoder/scripts/stop-gate.test.js` 全过。

## 第 5 步 · 复验与记录

```bash
node ~/.qoder/scripts/skills-doctor.cjs | tail -1     # 期望 VERDICT=CLEAN
node ~/.qoder/scripts/skill-collisions.cjs | head -1  # 记下新的每轮注入值
node ~/.qoder/scripts/rules-weekly-audit.js --read-only  # 期望「健康（0 告警）」
```

把「收敛前 / 收敛后」的两个数记进项目 README 或接续文档；下次跑还能对比。

## 边界

- 描述收敛是**语义改写**，不是截断：别把触发词砍掉，否则技能不再被唤起
- 合并是**能力搬家**，不是删文件：删之前先确认独有能力已有落点
- 规则审计默认只读；改规则属实施动作，按你所在环境的授权边界走

## 附：分层按需注入

技能多时用分层降低每轮注入：`node ~/.qoder/scripts/tier-skills.cjs --apply` 把单领域技能移入 `~/.qoder/skills-library/`，之后用 `node ~/.qoder/scripts/skill-load.cjs "<关键词>"` 检索并 Read；恢复用 `--restore` / `--restore-all`。详见 `README-安装说明.md`。
