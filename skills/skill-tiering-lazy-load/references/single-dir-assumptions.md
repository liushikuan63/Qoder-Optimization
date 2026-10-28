# 单目录假设审计与补丁台账

分层后 `~/.qoder/skills/` 只是「常驻集」，`~/.qoder/skills-library/` 才是全集。任何写死单目录的工具都会少看库。本文件记录审计法、已知站点、不该补的工具，以及回滚时必须保留的补丁。

## 四问审计

对每个可能接触技能目录的脚本依次问：

| 问题 | 答“是” | 结论 |
|---|---|---|
| 是否枚举技能目录？ | 打包、清单、扫描、迁移 | 通常要加 `skills-library/` |
| 是否做计数？ | 文档“实装 N 个”、注入统计 | 计数口径改为 core + library（或明确只数 core） |
| 是否做存在性检查？ | 规则引用、悬空引用、打包缺失 | 存在性集合加入 library |
| 是否只读 description？ | 注入成本、描述质量门禁 | 只该看 core，不要加 library |

一句话判据：**问“技能是否存在 / 能否打包 / 是否被引用” → 加库；问“每轮注入了什么” → 只看 core。**

## 已知站点与补法

| 站点 | 位置 | 症状 | 补法 |
|---|---|---|---|
| `pack-share-extras.js` 的 `resolveSkillDir` | `~/.qoder/scripts/pack-share-extras.js:87` | 打包判“技能缺失” | `skills/` → `skills-library/` → `skills-disabled/` 依次回退 |
| `pack-share-extras.js` 的自制技能枚举 | `~/.qoder/scripts/pack-share-extras.js:191` | 按需库里的自制技能漏进清单 | 统计“在用”时并入 library，或显式只发布常驻集 |
| `check-share-docs.js` 计数 | `~/.qoder/scripts/check-share-docs.js:37` | 文档“实际装 N 个”与磁盘不符 | `totalSkills = installed + library`，两层都数 |
| `rules-weekly-audit.js` 的 `SKILL_DIRS` | `~/.qoder/scripts/rules-weekly-audit.js:336` | 规则引用库技能被判悬空 | 存在性集合加入两侧 `skills-library` |
| `verify-global-setup.js` 的技能数下限 | `~/.qoder/scripts/verify-global-setup.js:96` | 常驻数低于 40 假红（分层后常驻 26，实际总数 114） | 已改为 core+library 计总数（下限 40）+ 常驻 ≥10；两层 frontmatter 一并校验，输出写明“常驻/按需”；**不要静默删判据** |
| `skill-mention-scan.cjs` 的 active 集合 | `skills/skill-trim-with-capability-transfer/scripts/skill-mention-scan.cjs:60` | 库技能被当“不明来源” | 把 `skills-library/` 加入 active 集合；库文件按需纳入扫描 |

补丁写法优先**回退链**而不是二选一：

```js
const resolveSkillDir = (name) => {
  for (const root of [SKILLS_DIR, SKILLS_LIBRARY_DIR, SKILLS_DISABLED_DIR]) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return path.join(SKILLS_DIR, name);
};
```

## 不该加 library 的工具

- `~/.qoder/scripts/skills-doctor.cjs`：扫描 `~/.qoder/skills` 与 `~/.qoder-cn/skills`，判 DESC-LONG / DANGLING-REF / 注入面质量。库技能不注入，加进来只会给不参与每轮路由的描述制造门禁噪声。
- `~/.qoder/scripts/skill-collisions.cjs`：比较两侧技能集的触发冲突与注入成本，口径就是“每轮注入面”，同样只看常驻。

`skills-doctor` 的 `REF_RE` 只认裸 `scripts|references|assets|templates/...`。若技能正文要举别的技能/任务包里的路径，写不带 `scripts/` 前缀的文件名，或写成 `~/.qoder/scripts/...` 绝对引用，避免被判 DANGLING-REF。

## 库内悬空引用的处置

来源会话实测 3 条，先判归属再决定补不补：

| 引用 | 归属 | 处置 |
|---|---|---|
| `merge-inbound-qoder-package` → `~/.qoder/scripts/stop-gate.js`（原文为裸 `scripts/stop-gate.js`） | 全局脚本，正文在 `cd "$HOME/.qoder"` 后的相对语境 | 保持文字说明；已在 `skills-doctor` 的 WAIVERS 中裁定为误报 |
| `vibecoding-batch-append` → `validate.mjs`（原文为裸 `scripts/validate.mjs`） | 任务包自带校验器，不属于技能目录 | 不改全局脚本，也不复制进技能；在正文标注“任务包内相对路径” |
| `vibecoding-batch-execution` → `check-wiki-refs.js`（原文为裸 `scripts/check-wiki-refs.js`） | 目标仓库自带校验器 | 同上 |

判定顺序：

1. 路径是否指向 `~/.qoder/scripts/` 的全局脚本？→ 只改文字口径，**不要把全局脚本复制进技能**。
2. 是否技能自带脚本？→ 真缺就补文件；不打算随技能发布就删引用。
3. 是否任务包 / 目标仓库内脚本？→ 保留说明并标注归属，或加进 `skills-doctor` 的 WAIVERS 并写明裁定理由。

禁止为了消红把全局脚本复制成技能副本：会产生第二真源，回滚与升级都会漂移。

## 回滚分层时保留的补丁

`tier-skills.cjs --restore` / `--restore-all` 只搬目录，不会撤销本文件的站点补丁。**保留它们**：

- 回退链在 `skills-library/` 不存在时不会命中，对单层部署无害；
- 删掉补丁后，下次再分层会重新踩同一批红；
- 回滚后仍要跑 `build-skills-index.cjs`，并复跑 `skill-tier-report.cjs` 与正/负检索。

## 通用扫描命令

```bash
# 找仍然写死单目录的站点（排除已补 library 的行）
grep -rn "readdirSync(.*skills\|path.join(.*'skills'\|path.join(.*\"skills\"" \
  ~/.qoder/scripts/*.js ~/.qoder/scripts/*.cjs | grep -v skills-library

# 盘点所有技能目录的期望集合
node ~/.qoder/skills-library/skill-tiering-lazy-load/scripts/skill-tier-report.cjs
```
