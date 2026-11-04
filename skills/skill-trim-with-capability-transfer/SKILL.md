---
name: skill-trim-with-capability-transfer
description: 技能降量的可执行 playbook（停入口、不丢能力）。当用户说「技能太多要精简」「降量 / 停用技能」「同域不装第二个」「几个技能抢同一个触发」「停掉的技能能力不能丢」「skills-disabled 怎么回退」「降量后周检 / 全局体检判红」时使用。按引用关系分档决定谁能停，把只此一家的能力用真代码或规则条目搬进留存内容，同步会被钉死的机械判据，再用周检加提及扫描收口。不用于外部分享包并入（走 merge-inbound-qoder-package）、C 盘腾空间（走 disk-junction-migration）、本机出包发给别人（走 update-share-package）。
---

# 技能降量与能力迁移

## 何时用 / 何时不用

- 用：技能数偏多要精简、同域出现第二个技能、几个技能的 description 互相抢触发、要停用某些技能但**不能丢能力**、`skills-disabled/` 里的技能要回退、降量之后周检或全局体检判红。
- 不用：外部回流包并入本机 → `merge-inbound-qoder-package`；C 盘腾空间 → `disk-junction-migration`；本机出包发给别人 → `update-share-package`。

## 三条前置（违反任何一条就停手）

1. **降量强度必须弹窗拍板**：`AskUserQuestion` 给 ≥3 档（停多少、停哪些域）+ 推荐项，写明每档的收益与代价；不自行整批停用。
2. **停用＝移入 `~/.qoder/skills-disabled/`**（移走不删、可随时移回）。**绝不 `rm`**，也不要在降量过程中删任何技能目录。
3. **改任何已有文件前先备份**：`rules/*.md`、`scripts/verify-*.js`、`memory/*.md`、分享包文档都算（停在 skills-disabled/ 的技能目录本身就是备份）。

```bash
HOME_Q=~/.qoder
SK=$HOME_Q/skills; DIS=$HOME_Q/skills-disabled; BK=$HOME_Q/.backups/$(date +%F)-skilltrim
SCAN=$SK/skill-trim-with-capability-transfer/scripts/skill-mention-scan.cjs
mkdir -p "$BK"
```

## 阶段 1 · 引用分档：决定谁能停

先读已完成的盘点（`$HOME_Q/docs/skill-audit-*.md`），**不要重新盘点**，直接在其基础上拍板强度。然后按引用关系分三档：

| 引用形态 | 判据 | 处置 |
|---|---|---|
| 硬保留 | `AGENTS.md` / `rules/*.md` 里有 `` `name` `` 反引号引用 | 不停（停了必然悬空） |
| 可停但需随改 | 仅被 `memory/*.md` 提到 | 停，并同批更新那几处提及 |
| 点名依赖 | 被留存技能的正文点名（如「细节见 X 技能」） | 要么留着，要么改那一行 |

**别只信周检**：周检的严格引用检查实测只覆盖 4 个技能，而真实被引用集是 21 个（含 `i-have-adhd`、`db` 这类短名，正则会漏）。自己扫一遍四类引用源再定名单：

```bash
cd "$HOME_Q"
comm -12 <(ls skills | sort) \
         <(grep -rhoE '`[a-z0-9][a-z0-9-]*`' AGENTS.md rules commands 2>/dev/null | tr -d '`' | sort -u)
```

输出＝被反引号引用且确已安装的技能名（硬保留候选）。再对 `memory/` 里提到的名字逐条判「可停但需随改」。

## 阶段 2 · 停入口不丢能力（本流程的核心）

用户口径：**尽量不要缺失能力，如果关闭相近，要把相近的能力抽离补充到留存内容中。**

1. **读留存技能的正文核实覆盖，不按名字猜**。名字像不等于覆盖到——实测：小程序域确实已被留存技能覆盖（记一条文档即可）；Python / Redis / Spring / AOP 在留存内容里**有缺口**（必须补）。
2. **落地形式优先「真代码 > 规则条目 > 纯文档」**：
   - 真代码：把只此一家的能力写成承接技能里的新脚本（实测：给 `office-docs` 补 `../office-docs/scripts/docx-surgery.js`——解包 / 回包 / 跨 run 文本替换 / 校验，`--selftest` 11 通过 0 失败，含「非 zip 文件头」负对照）。新文件不碰并行会话在改的老文件。
   - 规则条目：并入已有 `rules/*.md` 的对口章节（Redis → `rules/databases.md`；Spring / AOP → `rules/java-spring.md`）；整块新领域才新建 `rules/<域>.md` 并用 `glob` 触发（`rules/python.md`：不碰 `.py` 就不吃上下文）。
3. **被停技能自带的脚本原地保留**（不搬、不覆盖，避免与并行会话互相覆盖），但**必须补齐依赖让它真能跑**。反例：官方 `docx` 的 Python 脚本缺 `defusedxml`，`unpack.py` 直接 `ModuleNotFoundError`；补装（官方源）后 `unpack.py` / `pack.py` / `validate.py` / `comment.py` / `accept_changes.py` 全部 exit=0。**这是「能力还在」的可失败证据，写文档不算。**
4. **产能力去向表**：在承接技能里落 `CAPABILITIES.md`（谁的能力搬到哪、怎么调、依赖怎么装），并从该技能的 SKILL.md 指过去。

判据：迁移完成＝承接内容里有可跑的代码或可执行的规则条目 **+** 一条能失败的验证命令（退出码为证）。

## 阶段 3 · 同步会被钉死的机械判据

降量必然打红一批「计数 / 集合」类断言，先过一遍再谈验收：

- 写死的技能数下限（实测 `verify-global-setup.js` 用 `sk.length < 76` → 降到 55 必红；改为下限 40）。
- 两侧 `mcpServers` 键集合严格相等（国际版独有 `cua-driver` → 改为显式例外名单）。
- 分享包 / 规则文档里的计数（如「家用机实际装 N 个」）。
- 任何「文档称 X / 实测 Y」的对照断言。

每改一条自问：**改动之后，这条断言还能失败吗？** 恒真的判据等于没有判据。改脚本前先 `cp` 到 `$BK/`。

## 阶段 4 · 收口验收（每条都要能失败）

```bash
node "$HOME_Q/scripts/rules-weekly-audit.js" --no-fix     # 0 告警；checkApplicability 不报悬空引用
bash "$HOME_Q/scripts/sync-global-config.sh" --check      # IN-SYNC
bash "$HOME_Q/scripts/sync-memory.sh" --check             # 两侧一致、索引自洽
node "$HOME_Q/scripts/verify-global-setup.js"             # exit 0
node "$SCAN"                                              # 提及扫描（见下）
```

**提及扫描必须分两栏**（最容易做错的一步）：扫 `AGENTS.md` + `rules/` `commands/` `memory/` `skills/` 里对「已不在 `skills/` 的名字」的提及：

- **有意留痕**：写明「已停用 X，能力去向见 Y」、回退说明、收敛决策记录 —— 正确留痕，**不要当告警反复改**。
- **真悬空**：把已停技能当「当前可用」引用（「细节见 X 技能」）；记忆里 `[[链接]]` 指向不存在的文件或文件名不符（实测 4 处：3 处改指向、1 处由新建目标文件补上）。

**回退可失败验证**（做一次往返，证明「可回退」不是口头承诺）：

```bash
mv "$DIS/<一个技能>" "$SK/" && ls "$SK/<该技能>/SKILL.md"   # 计数 +1 且 SKILL.md 就位
mv "$SK/<该技能>" "$DIS/"                                     # 再移回，计数复原
```

实测口径：55 → 56 → 55。

## 阶段 5 · 留痕

- 落一份记忆 `reference-skill-trim-<日期>.md`：降量口径（停多少、依据哪一档）、被停清单、能力去向、回退命令；同步 `MEMORY.md` 索引。
- 更新所有技能数口径（`AGENTS.md` / 记忆 / 分享包文档里的计数要一起改，否则下一轮打包必然判红）。
- 要出包走 `update-share-package`，本技能到留痕为止。

## 已知反例（2026-09-29 实测，逐条对号）

- **只信周检会误停**：周检严格检查只覆盖 4 个被引用技能，真实集 21 个。
- **分清「我打红的」与「本来就红的」**：降量后体检报 6 条 FAIL ＝ 2 条判据被钉死（技能数下限、`mcpServers` 集合）+ 4 条既存悬空链接；别把既存缺陷当成自己改坏，也别把钉死判据当缺陷放着。
- **两栏混判会改坏正确留痕**：8 条「已停技能名仍被提及」里，console 三件属有意留痕、`docx` / `Excel---XLSX` 属待更新。
- **文档充数不算能力迁移**：`defusedxml` 没装时官方脚本 `ModuleNotFoundError`，装完 exit=0 才算数。
- **能力去向文档本身会踩分享包敏感词门禁**（写到内网字样就被拦）→ 改写法，不绕过门禁。

## Resources

`scripts/skill-mention-scan.cjs` — 只读提及扫描器：列出 `AGENTS.md` + `rules/` `commands/` `memory/` `skills/` 中对「已不在 `skills/` 的名字」的提及，每条给 `文件:行` + 上下文 + 名字状态（在 `skills-disabled/` ＝可回退；两处都没有 ＝ 不明来源，用 `--names-file` 补），并对「已停用 / 能力去向 / 回退」等措辞打**留痕提示**。

```bash
node "$SCAN"                          # 名字来源＝skills-disabled/ 全部目录
node "$SCAN" --names-file names.txt   # 追加历史名字（曾彻底移除、不在 skills-disabled/ 的）
node "$SCAN" --strict                 # 有「待读」命中即 exit 2，可做门禁
node "$SCAN" --selftest               # 自测：正例 / 留痕 / 不明 / 词边界 / 负对照
```

命中是**待读线索不是判决**：留痕提示只是措辞启发式，最终「有意留痕 vs 真悬空」由人 / AI 读原文判定。脚本绝不写文件、绝不删文件。
