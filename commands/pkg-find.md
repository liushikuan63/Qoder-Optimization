---
name: pkg-find
description: 从分享包索引按关键词检索技能 / 脚本 / 命令 / 插件 / MCP，并在发现可安装或可更新条目时主动询问是否安装/更新。触发词：找技能、检索技能、安装技能、技能包、有没有技能、技能清单
---

# /pkg-find —— 从分享包索引检索并按需安装/更新

入口薄壳：流程与判据见 `~/.qoder/skills/skills-router/SKILL.md` 及其 `skills/skills-router/references/route-commands.md`「包检索与安装更新」。

```bash
node ~/.qoder/scripts/pkg-catalog.cjs search "$ARGUMENTS"
```

- 首次使用先登记：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`。
- 随包技能按全量范围安装（`node scripts/install-package.cjs --yes` 默认 `--skills-scope all`，未装技能进按需库、由 skills-router 按需引用），不必逐条征询；脚本、命令、agent、hook 与插件/MCP 仍先预演。
- `NEXT_ACTION: ASK_INSTALL_OR_UPDATE` 只对上述非技能条目与本地差异项出现，必须用 `AskUserQuestion` 给出安装/更新（推荐）、查看差异、保持现状三选一；未获明确选择不得写盘。
- 安装先预演，确认后 `--apply`；更新先三路比对并备份，保留本地较新或自改内容；装完重建索引并跑 `skills-doctor`。
