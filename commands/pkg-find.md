---
name: pkg-find
description: 从分享包索引按关键词检索技能 / 脚本 / 命令 / 插件 / MCP，并在发现可安装或可更新条目时主动询问是否安装/更新
---

# /pkg-find —— 从分享包索引检索并按需安装/更新

```bash
node ~/.qoder/scripts/pkg-catalog.cjs search "$ARGUMENTS"
```

首次使用先登记分享包位置：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`。

## 状态与必须动作

- `shipped` + `本地未发现` → **可安装**；`本地文件已存在（…内容与包内不同…）` → **可更新**；`与包内一致` → 已安装，不重复询问。
- 检索输出带 `NEXT_ACTION: ASK_INSTALL_OR_UPDATE` 时，**必须用 `AskUserQuestion` 询问用户**，给真实备选：① 安装/更新（推荐）；② 查看差异（逐文件列出包内与本地差异）；③ 保持现状。**未获明确选择不得执行安装或更新**；沉默、取消只保留检索结果。
- 安装先预演：`node ~/.qoder/scripts/pkg-catalog.cjs install <id>`；确认后加 `--apply`。技能默认进 `~/.qoder/skills-library/`（不注入），要常驻加 `--tier core`，安装后自动重建索引。
- **更新**（内容与包内不同）先做三路比对：包内当前版本 / 本地当前版本 / 上次安装来源；备份本地文件，保留本地较新或用户自改内容；确认后再 `install <id> --apply --force`，随后重建索引并跑 `skills-doctor`。不得把本地改动直接覆盖掉。
- 同一任务内用户已明确拒绝的条目不再重复询问；任务范围变化或用户重新要求时才再问。
- `external` 只给官方安装方式；`template` 给合并说明；`disabled` 本机已停用、按需恢复。插件 / 社区技能 / MCP 不代装、不转发源码。
- 批量查看已安装条目哪些落后于分享包：`node ~/.qoder/scripts/pkg-catalog.cjs drift`；对照指定包加 `--catalog <包目录>/catalog.json`。发布升版后的部署询问必须带上这份清单。

## 汇报

分开写「已安装 / 已更新 / 本地较新未覆盖 / 用户拒绝 / 未验证（第三方依赖、现役装载）」。
