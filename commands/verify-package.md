---
description: 打包前校验分享包——描述长度、垃圾文件、零字节、必需件、catalog 计数、规则文档与真源一致。触发词：校验分享包、打包前校验、分享包校验、发布前检查
---

# /verify-package

在把分享包发出去**之前**跑一次，避免"README 说 ≤300、包里却有超长项"或 `.bak` 混入。

## 用法

```bash
# 只校验目录
node ~/.qoder/scripts/share-package-verify.cjs "<tmp-root>/Qoder-Optimization-<版本>"

# 额外校验规则文档第一节是否与 AGENTS.md 逐字节一致
node ~/.qoder/scripts/share-package-verify.cjs "<包目录>" --agents ~/.qoder/AGENTS.md

# 校验器自身自测（57 条：14 正例 / 43 负例）
node ~/.qoder/scripts/share-package-verify.cjs --selftest
```

## 提交前的仓库侧契约门（秒级，先跑这个）

`share-package-verify` 校验的是**已构建的包目录**；新增/修改 skill、rule、command、agent、hook、script 后，
在**提交与出包之前**先跑仓库侧契约门，把过去只有 24–27 分钟全量套件才暴露的冲突提前到秒级：

```bash
# 在公开仓库根跑（默认 base=origin/main，只扫本批改动的载体正文）
node scripts/carrier-contract-gate.cjs

# 指定上游基线 / 机器可读输出
node scripts/carrier-contract-gate.cjs --base origin/main --json

# 门自身的正负对照自测（53 条：每项判据都配了能失败的反例）
node scripts/carrier-contract-gate.cjs --selftest
```

退出码：0 全绿 / 1 有硬违约 / 2 用法或环境错误。**硬违约必须修掉再提交**，不得为了凑绿放宽判据。

九项判据（已有检测器一律 delegate，不复制判据）：

| 项 | 判据 | 真源 |
|---|---|---|
| C1 | 触发短语唯一性（新技能触发词不得与既有技能撞） | `skill-trigger-uniqueness.cjs` |
| C2 | 技能引用完整性（不得悬空、不得引用未随包件） | `skill-reference-integrity.cjs --check` |
| C3 | 包元数据无漂移（8 处计数声明点 + catalog/manifest） | `pack-share-extras.cjs --check` |
| C4 | description 上限（载体按 `DESC_CARRIERS` 放宽） | `share-package-verify.cjs` 的 `DESC_MAX`/`carrierCaps` |
| N1 | 手写技能清单一致性（分组计数、合计、常驻标记⊆core、无漏列无幻影） | 本门 |
| N2 | **本批**载体正文的机器专属标识（真实家目录/会话ID后缀/内部任务ID/机器临时根） | 本门 |
| N3 | 版本三载体一致 + 最新已发布节脚注 | 本门 |
| N4 | HOOKS 表脚本存在且入 catalog | 本门 |
| N5 | git 跟踪垃圾件（`.bak`/`.log`/`node_modules` 等会随包） | 本门 |

**为什么 N2 只扫本批改动件**：存量 Windows 域技能（`disk-junction-migration`、`powershell-windows-display-interop`、
`clean-disk` 等）正文里的盘符路径是**正当主题内容**，一刀切禁盘符会误伤 35 件。历史债列 advisory 不阻断。

**advisory（报告但不阻断）**：历史 CHANGELOG 节缺脚注、名字像 hook 但属合法 helper 的未接线脚本
（`hook-crash-guard.js`、`run-package-hook.cjs` 等）、存量载体正文里的机器路径。

## 判据（任一不过 → 退出码 2）

1. 每个 `skills/<名>/SKILL.md` 的 `description` ≤300 字符；**载体技能按 `skills-doctor` 的 `DESC_CARRIERS.max` 放宽**（真源在该脚本里，不另存一份）。**`skills/` 目录缺失或里面没有任何技能目录一律判红**——0 个技能不算通过（空集会让这道判据恒真）。**载体上限表读不到、找不到 `DESC_CARRIERS` 定义、或解析出 0 条上限，也一律判红并点名「载体上限表不可用」**——不得静默退回 `{}` 把所有技能按 300 判（那样载体技能会被误判超长，且红得不可归因）。
2. 无 `.bak` / `.log` / `backups` / `node_modules` / `.export-*` / `.DS_Store` / `Thumbs.db`（**文件与目录同名皆拦**）。**空的垃圾目录同样判红**——只收文件会让「目录在但里面没文件」漏检；目录单独收集，并按「带尾斜杠」与「去尾斜杠」两种形态各测一次（否则 `.log$` 这类以 `$` 结尾的分支对 `x.log/` 目录名失效），且不混进零字节判据（目录 `size===0` 恒真会把每个目录都误判成零字节文件）。符号链接目录只登记名字、不递归（避免环与越界跟随）。**目录读不出或文件 `stat` 失败一律显式判红**，不得崩溃退出冒充判红。
3. 无零字节文件。
4. 必需件齐全：`VERSION` / `catalog.json` / `skills-manifest.json` / 规则文档 / `README-安装说明.md` / `INDEX.md`。
5. `catalog.counts` 与目录实际数量一致（skill / command / agent / script）；`catalog.entries` 的来源存在性与依赖齐全同样**空集判红**——`entries` 缺失、不是数组或没有 `shipped` 条目都不算通过。
6. 可选：规则文档「一、全局开发规则」与 `AGENTS.md` 正文逐字节一致。**缺分节标记、第一节为空、`AGENTS.md` 剥掉标题与版本行后为空，一律判红**——空对空不算一致（否则这道校验会静默变成摆设）。

## 与体检的分工

- **本机体检**（`skills-doctor`）只看常驻层，因为 300 字符限制的理由是「每轮注入成本」。
- **本包校验**看**要发出去的全部技能**（含按需库），因为 README 的承诺是对整包说的。
- 两者不重复、也不互相替代。
