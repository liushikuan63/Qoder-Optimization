---
name: skill-tiering-lazy-load
description: "技能分层懒加载 playbook：注入过大时，把 ~/.qoder/skills 拆成「常驻元/高频 + skills-library 按需库」，用 tier-skills 迁移、build-skills-index 重建索引、skill-load 检索；含常驻集拍板、library 回退修补、注入降幅测量、可失败验收、回滚与分享包复现。触发词：技能分层、按需库、skills-library、skill-load。不用于停用合并（skill-trim-with-capability-transfer）、描述瘦身（skill-description-route-cue-rewrite）。"
---

# 技能分层与按需懒加载

## 定位

把「所有技能都注册」改成「常驻元/高频 + `skills-library/` 按需库」：

- `~/.qoder/skills/`：常驻，description 每轮注入
- `~/.qoder/skills-library/`：按需，不注入；用 `skill-load` 检索后 Read

分层只改变“注不注入”，不改变技能内容与可用性：移动是 rename，不是删除；回退是 restore，不是重装。

与相邻流程的分工：

| 需求 | 走哪 |
|---|---|
| 停用/合并/能力迁移 | `skill-trim-with-capability-transfer` |
| 单条 description 太长 | `skill-description-route-cue-rewrite` |
| 运行时按需检索 | `skills-router` / `/skill-load` |
| 分层件随分享包 | `update-share-package` |

## 何时用 / 何时不用

用：

- 技能数上百、每轮 description 注入数万字符，影响上下文预算
- 新增/删除技能后，要维持“常驻 + 按需”的边界
- 分层后打包、文档计数、周检、全局自检报红
- 要把库技能恢复常驻，或整批回滚分层

不用：

- 只是 description 太长 → 先做描述瘦身
- 要停用/合并技能 → 走 trim
- 只是 C 盘空间 → 走 `disk-junction-migration`

## 三条前置门禁

1. **常驻集必须用户拍板**：给两档以上（元/高频最小集 vs 更激进），写明每档留下的技能与注入成本；不自行整批移动。`tier-skills.cjs` 内置的 CORE 是默认值，不是政策，执行前先读一遍。
2. **只移不删**：只允许 `rename`；禁止 `rm -rf`、禁止清空 `skills-library/`。迁移前做 md5 清单，迁移后按“技能名 → 哈希”比对，证明内容未变。
3. **硬引用先扫**：`AGENTS.md` / `rules/*.md` / `commands/*.md` 里用反引号点名的技能，要么留在常驻，要么同批把引用改成“先 `skill-load` 再 Read”。库技能不会被自动注入，引用它的规则可能“看得见名字、找不到描述”。

本技能是低频分层维护流程，默认按需加载，不因自称元技能而保留常驻。迁移执行器独立位于 scripts，不随技能目录移动；报告工具按 skill-load 返回的实际目录定位。

## 阶段 1 · 盘点与基线

```bash
node ~/.qoder/skills-library/skill-tiering-lazy-load/scripts/skill-tier-report.cjs
```

输出：core/library/total 计数、core 每轮注入字符（`name + description + 4` 同口径）、最长 description、索引 stale/missing/extra/duplicate、硬引用警告、入口文件是否齐全。先记下基线，再谈降幅；同一口径前后对比，不追求与平台实际注入字节完全相等。

真源是两层实际 SKILL.md；`~/.qoder/skills-index.json` 由 `build-skills-index.cjs` 显式生成，供盘点等工具读取。`skill-load` 复用同一只读扫描函数，避免快照过期返回旧路径。

## 阶段 2 · 定常驻集

优先常驻：

- 跨任务必要入口：路由、验证、交付与当前常用工作流；降量、分层、审计等专项默认按需，不凭元技能标签扩大常驻集
- 跨域高频：一周会用 ≥3 次的技能
- 硬引用：AGENTS/rules/commands 点名的技能
- 入口：`skills-router` 及其依赖（`skill-load.cjs` / `build-skills-index.cjs` / `tier-skills.cjs` 不随技能移动）

单领域、项目专用、低频技能进库。不要为了“可能用到”把库技能搬回常驻，那等于把注入成本加回来。

**新增技能先判 tier（常设政策）**：创建技能前用 `node ~/.qoder/scripts/carrier-preflight.cjs --type skill --name <名> --path ~/.qoder/skills-library/<名>/SKILL.md` 预检——它会列出两层同名/同类候选、`[分层]` 提示本次拟入哪层与常驻预算。只有元技能、跨域高频、或被 AGENTS·rules·commands 硬引用才进 `skills/`；其余默认 `skills-library/`。落盘后必须 `build-skills-index.cjs`，使盘点工具读取的派生索引与现场一致；路由查询自身不写盘。

## 阶段 3 · 迁移与索引

```bash
node ~/.qoder/scripts/tier-skills.cjs                 # dry-run：先看名单
node ~/.qoder/scripts/tier-skills.cjs --apply --keep a,b,c
node ~/.qoder/scripts/build-skills-index.cjs          # 显式重建
```

- `tier-skills.cjs` 默认 dry-run，`--apply` 才 rename；库中已有同名会 SKIP，不会覆盖。
- `--restore <名>` / `--restore-all` 先预览，增加 `--apply` 才反向恢复。
- 移动后必须显式重建派生索引；`skill-load.cjs` 只读扫描现场，既不采用旧路径也不在查询时自动写索引。
- 校验：总数不变；md5 清单按技能名一致；report 脚本 exit 0。
- 不要在会话中途移动 `skills-router`；技能列表是运行期快照，移动后 `/skills reload` 或新会话再看注入面。

md5 清单（Git Bash）：

```bash
find ~/.qoder/skills ~/.qoder/skills-library -name SKILL.md -print0 \
  | xargs -0 md5sum | sed -E 's#.*/([^/]+)/SKILL.md#\1#' | sort > /tmp/skills-md5.txt
```

迁移前后各跑一次，`diff` 应为空；路径变了，技能名到哈希的映射不应变。

## 阶段 4 · 路由接线

- `skills-router`（常驻）：描述里必须写清“不检索等于这些技能不存在”，给 2-3 个正例查询；计数用实测值，不手写。
- `commands/skill-load.md`：`/skill-load "<关键词>"` 指向 `skill-load.cjs`。
- `AGENTS.md`：加一条“领域任务先 `skill-load`，命中就 Read；查不到换同义词，仍无才自行处理”。
- 验证正/负查询：

```bash
node ~/.qoder/scripts/skill-load.cjs "postgresql 索引"; echo EXIT=$?   # 安装对应技能时应命中 [library]，0
node ~/.qoder/scripts/skill-load.cjs "zzz-no-such"; echo EXIT=$?  # 期望 NO_MATCH，3
```

负对照必须真跑：只验证“能查到”不能证明“查不到时会报错”。

## 阶段 5 · 修补单目录假设

分层后，任何“枚举 `skills/` 就算全部技能”的工具都会少看库。已知站点与通用审计法见 `references/single-dir-assumptions.md`。最小检查：

| 站点 | 症状 | 补法 |
|---|---|---|
| `~/.qoder/scripts/pack-share-extras.js` 的 `resolveSkillDir` | 打包判“技能缺失” | `skills/` → `skills-library/` → `skills-disabled/` 依次回退 |
| `~/.qoder/scripts/check-share-docs.js` 计数 | “实际装 N 个”与磁盘不符 | 计数 = core + library |
| `~/.qoder/scripts/rules-weekly-audit.js` 的 `SKILL_DIRS` | 规则引用库技能被判悬空 | 把两个 `skills-library` 路径加入存在性集合 |
| `~/.qoder/scripts/verify-global-setup.js` 的技能数下限 | 常驻数低于下限（如 26<40）假红 | 已改为 core+library 计总数（下限 40）并保留“常驻 ≥10”防 `skills/` 被清空；输出写明两层计数 |
| `skill-trim-with-capability-transfer` 的 `skill-mention-scan.cjs` | 库技能被当“不明来源” | 把 `skills-library/` 加入 active 集合；库文件按需纳入扫描 |

**不要盲目给所有工具加 library**：`skills-doctor` / `skill-collisions` 只关心“注入面”，只看 core 是对的；给它们加库会把不注入的描述也拉进质量门禁，制造噪声。判断标准：这个工具问的是“技能是否存在/能否打包/是否被引用”，还是“每轮注入了什么”。

新增工具时按四问审计：枚举技能目录？做计数？做存在性检查？读取 description？前三个通常要加 library，最后一个通常只该看 core。

## 阶段 6 · 可失败验收

| 判据 | 命令 | 期望 |
|---|---|---|
| 索引与磁盘一致 | `node ~/.qoder/skills-library/skill-tiering-lazy-load/scripts/skill-tier-report.cjs` | exit 0，stale=missing=duplicate=0 |
| 无技能丢失 | core+library 总数 vs 迁移前 | 相等；md5 映射一致 |
| 检索可用 | 正/负查询各一条 | 正例 exit 0 且路径在库；负例 `NO_MATCH` exit 3 |
| 周检不新增红 | `node ~/.qoder/scripts/rules-weekly-audit.js --no-fix` | 与迁移前对比，新增告警 0 |
| 全局自检 | `node ~/.qoder/scripts/verify-global-setup.js` | 记录既存红；分层新增红必须为 0 或已解释 |
| 回滚可逆 | `--restore <一个>` → 计数 +1 → `--apply` → 计数复原 | 索引随之重建，内容哈希不变 |
| 分享包（如本轮出包） | `pack-share-extras --check`、`check-share-docs`、`verify-share-package` | 全 0；包内含 tier/load/build/router/命令/规则说明 |
| 注入面 | 新会话或 `/skills reload` 后的技能列表 | 只列常驻；report 的 core≈ 明显低于迁移前 |

既有红与新增红分开写；不要把“本来就红”算成本轮成果，也不要把“我改红的”当缺陷放着。

## 回滚

```bash
node ~/.qoder/scripts/tier-skills.cjs --restore <名> --apply
node ~/.qoder/scripts/tier-skills.cjs --restore-all --apply
node ~/.qoder/scripts/build-skills-index.cjs
```

- 恢复后保留阶段 5 的补丁（它们对单层部署无害：目录不存在时回退分支不会命中）。
- 绝不用 `rm -rf` 删 `skills-library/`；它是库，不是垃圾桶。
- 若只回滚一个技能，仍须重建索引；现场查询可找到恢复项，不代表盘点快照也已更新。

## 已知坑（2026-10-22 来源会话实测）

- **三处工具同批打红**：移动后 `pack-share-extras` 判缺失、`check-share-docs` 计数不符、`rules-weekly-audit` 把 `i-have-adhd` / `python-programmer` 判悬空。三处都要在同批补 library 回退，不能只补一处。
- **第四/第五处**：`verify-global-setup` 的技能数下限、`skill-mention-scan` 的 active 集合，静态审计才发现；说明“已知站点表”必须配通用 grep，不能只信清单。
- **索引与查询分工**：显式重建维护派生快照，查询只读现场；不要把查到了技能当作索引已更新。
- **计数会漂移**：来源会话完成后实际是 24 常驻 + 88 按需 = 112，而 `skills-router` 描述仍写 23+88=111；后续新增又变为 26+88=114。任何“N 个技能”都要由脚本实测或在文案里改成“以索引为准”，文档/描述同批更新。
- **库技能里的悬空引用不要乱补**：实测 3 条（`merge-inbound-qoder-package` → `~/.qoder/scripts/stop-gate.js`、`vibecoding-batch-append` → `validate.mjs`、`vibecoding-batch-execution` → `check-wiki-refs.js`；后两条是任务包/仓库内相对路径，不在本技能目录）。先判断它指的是全局脚本、技能自带脚本还是任务包内脚本；不要为了消红把全局脚本复制进技能。
- **分享包**：收件人要能复现分层，必须随包带 `tier-skills.cjs` / `skill-load.cjs` / `build-skills-index.cjs` / `skills-router` / `commands/skill-load.md`，并在规则/README 写清一键命令与恢复方式；只把技能分层了、包没带工具，等于收件人只能手工搬目录。
- **干净环境端到端安装未验证**：来源会话只在本机既有配置上验证；换机器时必须重跑正/负查询与包校验。

## Resources

- `scripts/skill-tier-report.cjs` — 只读盘点/验收（`--root` 可指夹具，`--top N`，`--json`）。
- `references/single-dir-assumptions.md` — 各工具的具体补法、通用 grep 审计、哪些工具不该看库。
- 全局脚本（不随技能复制）：`~/.qoder/scripts/tier-skills.cjs`、`build-skills-index.cjs`、`skill-load.cjs`、`check-share-docs.js`、`rules-weekly-audit.js`、`verify-global-setup.js`、`pack-share-extras.js`。
