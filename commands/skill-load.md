---
name: skill-load
description: 按关键词检索技能索引并给出 SKILL.md 路径（分层路由的按需加载入口）。触发词：加载技能、技能索引、按需加载、技能路径、查技能、查一下技能
---

# /skill-load —— 按需检索技能

入口薄壳：流程与判据见 `~/.qoder/skills/skills-router/SKILL.md` 及其 `skills/skills-router/references/route-commands.md`「按需检索」。

```bash
node ~/.qoder/scripts/skill-load.cjs --record "$ARGUMENTS"
```

- 有命中先 Read 命中的 SKILL.md 再动手；无本地命中（`NO_MATCH`，退出码 3）再查已登记包，包候选出现可安装/可更新时必须先用 `AskUserQuestion` 询问。
- 实际使用技能后追加 `node ~/.qoder/scripts/skill-usage.cjs log <技能名> --source use`。
- 退出码 2 = 目录读取失败或两层同名，核对真源；`CATALOG_UNAVAILABLE` = 包指针失效，报告缺口不自动换包。
