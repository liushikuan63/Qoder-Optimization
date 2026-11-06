---
name: skill-load
description: 按关键词检索技能索引并给出 SKILL.md 路径（分层路由的按需加载入口）。触发词：加载技能、技能索引、按需加载、技能路径、查技能、查一下技能
---

# /skill-load —— 按需检索技能

```bash
node ~/.qoder/scripts/skill-load.cjs --record "$ARGUMENTS"
```

- 有命中：只读扫描两层实际文件，多关键词全部匹配，按分数列出前 6 个 → **Read 命中的 SKILL.md 再动手**。`--record` 只把首选命中记为一次「检索需求」（技能名/时间/来源，不记查询），供 `skill-usage.cjs suggest` 按重复使用给层级建议；不加 `--record` 的检索不写盘。
- 实际使用某个技能后，追加 `node ~/.qoder/scripts/skill-usage.cjs log <技能名> --source use`；Qoder 原生 Skill 调用无法被脚本自动观测，需显式记录。已命中条目还会与已登记包内同名技能比对内容；出现 `NEXT_ACTION: ASK_UPDATE` 时按下面的更新流程询问。
- 无本地命中：输出 `NO_MATCH`（退出码 3），再用同一匹配逻辑查已登记的分享包。包候选标明「本地未发现 / 与包内一致 / 内容与包内不同」，插件与 MCP 标未核验；检索本身不安装、不写索引、不改登记位置。
- 包候选出现 `NEXT_ACTION: ASK_INSTALL_OR_UPDATE`，或标为「本地未发现」「内容与包内不同」时，**必须用 `AskUserQuestion` 询问是否安装/更新**（安装/更新（推荐） / 查看差异 / 保持现状），再按 `/pkg-find` 的流程执行；未获明确选择不得写盘。更新前做三路比对并备份，保留本地较新内容。用户拒绝后如实说明能力缺口，同一任务内不重复询问同一技能。
- 无相关候选：换同义词再查一次；仍无才说明缺口并按现有工具处理。
- 已装命中但尚无使用选择时主动询问是否用于本任务；已有明确指名/授权就读取入口推进。缺失候选仅通用、符合明确偏好或本轮明确选择才询问安装；其他跳过，不因仓库收录就逐项安装。见[能力闭环](../skills/skills-router/references/capability-lifecycle.md)。
- 退出码 2：实际目录读取失败或两层同名；核对真源，不覆盖或自动选择副本。
- `CATALOG_UNAVAILABLE`：包指针失效或索引损坏；明确报告缺口，确认包位置后使用 `/pkg-find` 的登记流程，不自动换包。

分层原则：`~/.qoder/skills/` 是常驻元技能，`~/.qoder/skills-library/` 是按需技能；增删移后显式运行 `node ~/.qoder/scripts/build-skills-index.cjs` 供其他工具使用。生成索引是快照，不替代实际文件。
