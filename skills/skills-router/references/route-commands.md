# 路由命令的操作细则（/skill-load 与 /pkg-find 正文的落点）

命令只做入口；检索、询问与安装更新的判据以此处为准。

## 按需检索（/skill-load）

```bash
node ~/.qoder/scripts/skill-load.cjs --record "$ARGUMENTS"
```

- 有命中：只读扫描两层实际文件，多关键词全部匹配，按分数列出前 6 个 → **Read 命中的 SKILL.md 再动手**。`--record` 只把首选命中记为一次「检索需求」（技能名/时间/来源，不记查询），供 `skill-usage.cjs suggest` 按重复使用给层级建议；不加 `--record` 的检索不写盘。
- 实际使用某个技能后，追加 `node ~/.qoder/scripts/skill-usage.cjs log <技能名> --source use`；Qoder 原生 Skill 调用无法被脚本自动观测，需显式记录。已命中条目还会与已登记包内同名技能比对内容；出现 `NEXT_ACTION: ASK_UPDATE` 时按下面的更新流程询问。
- 无本地命中：输出 `NO_MATCH`（退出码 3），再用同一匹配逻辑查已登记的分享包。包候选标明「本地未发现 / 与包内一致 / 内容与包内不同」，插件与 MCP 标未核验；检索本身不安装、不写索引、不改登记位置。
- 包候选出现 `NEXT_ACTION: ASK_INSTALL_OR_UPDATE`，或标为「本地未发现」「内容与包内不同」时，**必须用 `AskUserQuestion` 询问是否安装/更新**（安装/更新（推荐） / 查看差异 / 保持现状），再按 `/pkg-find` 的流程执行；未获明确选择不得写盘。更新前做三路比对并备份，保留本地较新内容。用户拒绝后如实说明能力缺口，同一任务内不重复询问同一技能。
- 无相关候选：换同义词再查一次；仍无才说明缺口并按现有工具处理。
- 已装命中但尚无使用选择时主动询问是否用于本任务；已有明确指名/授权就读取入口推进。缺失候选仅通用、符合明确偏好或本轮明确选择才询问安装；其他跳过，不因仓库收录就逐项安装。见[能力闭环](capability-lifecycle.md)。
- 退出码 2：实际目录读取失败或两层同名；核对真源，不覆盖或自动选择副本。
- `CATALOG_UNAVAILABLE`：包指针失效或索引损坏；明确报告缺口，确认包位置后使用 `/pkg-find` 的登记流程，不自动换包。

分层原则：`~/.qoder/skills/` 是常驻元技能，`~/.qoder/skills-library/` 是按需技能；增删移后显式运行 `node ~/.qoder/scripts/build-skills-index.cjs` 供其他工具使用。生成索引是快照，不替代实际文件。

## 包检索与安装更新（/pkg-find）

```bash
node ~/.qoder/scripts/pkg-catalog.cjs search "$ARGUMENTS"
```

首次使用先登记分享包位置：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`。

### 状态与必须动作

- `shipped` + `本地未发现` → **可安装**；`本地文件已存在（…内容与包内不同…）` → **可更新**；`与包内一致` → 已安装，不重复询问。
- 检索输出带 `NEXT_ACTION: ASK_INSTALL_OR_UPDATE` 时，**必须用 `AskUserQuestion` 询问用户**，给真实备选：① 安装/更新（推荐）；② 查看差异（逐文件列出包内与本地差异）；③ 保持现状。**未获明确选择不得执行安装或更新**；沉默、取消只保留检索结果。
- 安装先预演：`node ~/.qoder/scripts/pkg-catalog.cjs install <id>`；确认后加 `--apply`。技能默认进 `~/.qoder/skills-library/`（不注入）；交互安装会询问是否常驻，非交互用 `--tier core|library` 明确选择，安装后自动重建索引。**常驻数量按用户习惯决定**：常用者再用 `tier-skills.cjs --promote <名>` 升上去，低频用 `--demote <名>` 退回，选择会写入 `skills-resident.json` 并在后续分层中保留；不要求照搬包内默认数。
- **更新**（内容与包内不同）先做三路比对：包内当前版本 / 本地当前版本 / 上次安装来源；备份本地文件，保留本地较新或用户自改内容；确认后再 `install <id> --apply --force`，随后重建索引并跑 `skills-doctor`。不得把本地改动直接覆盖掉。
- 同一任务内用户已明确拒绝的条目不再重复询问；任务范围变化或用户重新要求时才再问。
- `external` 只给官方安装方式；`template` 给合并说明；`disabled` 本机已停用、按需恢复。插件 / 社区技能 / MCP 不代装、不转发源码。
- 批量查看已安装条目哪些落后于分享包：`node ~/.qoder/scripts/pkg-catalog.cjs drift`；对照指定包加 `--catalog <包目录>/catalog.json`。发布升版后的部署询问必须带上这份清单。
- `drift` 同时核对常驻与按需层中的副本；包源缺失或不可比较时会输出 `DRIFT_UNVERIFIED`、退出 2，需先恢复来源再判断是否更新。

### 汇报

主动规划按[能力闭环](capability-lifecycle.md)：已有能力核对更新，本地自改先审差异；缺失仅通用、符合明确偏好或本轮明确选择才询问安装，其他跳过。已装能力任务命中时主动询问使用；已有指名/授权不重复询问。

分开写「已安装 / 已更新 / 本地较新未覆盖 / 用户拒绝 / 未验证（第三方依赖、现役装载）」。
