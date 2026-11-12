---
description: 清理我方临时产物（截图 / 探针脚本 / 日志）——普通任务按本地授权自动清理，分享包默认弹窗确认；扫描 → 清理 → 复验并反馈。触发词：清理临时文件、临时文件、临时产物、临时目录、清理截图、清理探针
---

# /clean-temp

显式 /clean-temp 或跨任务批量清理先列清单、弹窗确认；**每轮结束清理是必须的**：普通任务按本机授权自动清理本轮推荐范围，分享包默认每轮询问（获明确授权时可自动清理）；两种方式都要在最终回复反馈删除/保留结果。

**触发**：① `session-budget.js` 在 SessionStart 扫一次多根临时目录——有超期件且距上次提醒 >7 天时注入「清理提醒」（含数量）；② **任务结束**时 stop-gate 的 `R14-temp-artifacts-unhandled` 会检查本任务在 `canonicalRoot` 下新产生的顶层条目：本机 `autoClean.enabled=true` 时要求跑 `tmp-round-scan.cjs --since <本轮开始> --apply --json` 自动清理并在最终回复反馈；未开启该开关的机器仍要求用 AskUserQuestion 确认清理范围；③ **使用分享包（安装/合并/发布构建）后默认每轮结束询问**：先跑 `tmp-round-scan.cjs --since <本轮开始> --json` 列本轮包产物，再用 AskUserQuestion 确认清理范围（超期清单只作参考，可能来自其他机器或包内配置，与本机不一定一致）；只有用户本轮明确授权自动清理或配置 `autoClean.sharePackage=true` 时，才可跳过询问，改用 `--apply --include-share-package --json` 自动清理，且仍须反馈结果；stop-gate `R15-share-package-temp-scan-missing` 兜底。以上机制只提醒/拦截；自动清理只删本轮**新建**条目，超期件、已登记证据、仅被修改的旧目录与分享包回滚点不自动删；节流状态在 `~/.qoder/tmp/tmp-sweeper/last-reminded.json`。

## 步骤

1. **扫描（只列不删）**：跑 `node ~/.qoder/scripts/tmp-round-scan.cjs --since <本轮开始> --json` 列本轮新增/改动条目；再跑 `node ~/.qoder/scripts/tmp-sweeper.js --json` 看超期件。根＝`canonicalRoot`（本机 `D:/tmp`）+ 历史遗留 `%TEMP%/qoder-work` + 客户端 `%TEMP%/qoder-cli` + C 盘遗留 `%LOCALAPPDATA%/Temp/qoder-work`（若存在）。阈值：图片 / 文本 3 天、媒体 7 天、压缩包 / 文档 / 脚本 15 天、未分类扩展名 30 天兜底。
2. **分类**：本轮新建可清条目 / 本轮仅修改的旧条目（默认保留）/ 已登记证据与回滚点 / 分享包产物（默认受保护）/ 超期件（只作参考，不进入自动清理范围）。本轮产物包括截图、`*.log`、一次性 `.cjs` / `.mjs`、导出的中间 `.json` / `*.md`——它们多半还没满 3 天，扫描器不会报，但"用完即删"针对的正是这一批。
3. **普通任务执行**：本机 `~/.qoder/tmp-sweeper.json` 的 `autoClean.enabled=true` 时，直接跑 `node ~/.qoder/scripts/tmp-round-scan.cjs --since <本轮开始> --apply --json`，不弹窗；**只删本轮新建条目**，仅被修改的旧目录（确需删除用 `--only <精确路径>` 或 `--include-modified`）、已登记证据、`.keep` 证据目录、回滚点与受保护项保留。未开启该开关的机器，仍用 `AskUserQuestion` 一次问全（推荐项＝**全部清理本轮新建产物**；备选＝仅清截图 / 仅清日志与脚本 / 全部保留），按答复执行。
4. **分享包任务执行**：默认**每轮结束询问**——扫描后用 `AskUserQuestion` 给清理范围（推荐＝全部清理本轮包产物；备选＝保留回滚点与已登记证据目录 / 全部保留），确认后只用精确路径删除并复扫；用户选「保留」的目录**同批**用 `--mark-evidence` 落 `.evidence.json`（三字段齐，见下「保留」答复必须同批落标记）。只有用户本轮明确授权自动清理（或配置 `autoClean.sharePackage=true`）才可跳过询问，改用 `--apply --include-share-package --json`；未授权时禁止使用该参数预删包产物。回滚点、已登记证据与超期件始终不自动删；包产物默认**移入 `<root>/.trash/<时间戳>/` 隔离区**（保留 7 天后自动回收；`--trash` 可显式强制，只有 `--no-trash` 才永久删除）。
5. **复验并反馈**：再跑一次不带 `--apply` 的扫描，确认推荐清理清单为空；**最终回复必须反馈** `删除 N 个 / 保留 M 个（含保留原因） / 复验结果`。脚本每次清理都会往 `~/.qoder/tmp/tmp-sweeper/heartbeat.log` 追加一行，可事后核对。**并行会话共用 `D:/tmp` 时**（预览里出现非本会话的活跃目录），不要按时间窗整根清理；用 `--only <精确路径>` 逐项清理本任务产物，或在新产物名里带 `.<8位会话id>` 后使用 `--session <8位会话id>`，其余保留。

## 一次性 vs 可复用（命名即归属，收尾按此分流）

命名只提供线索，必须结合本会话产物记录与引用核验；不能仅凭文件名决定删除。

| 形状 | 归属 | 收尾处置 |
| --- | --- | --- |
| `*.<8位会话id>.*`（如 `mb-diag-7ef52d28.ps1`、由它产出的日志） | **本会话一次性探针** | 逐个精确 `rm`；并行场景可加 `--session <8位id>` |
| 中间截图 `*-after-<n>.png` / `*-final.png` / `*-1.png` | 一次性过程件 | 删，只留**修复前 / 修复后各一张** |
| 语义命名（`asus-mbmanager-recycle.ps1`、`capture-printwindow.ps1`） | **可复用助手** | 保留；被记忆 / 文档引用的路径不得删 |
| 证据件（带结论语义的名字，如 `asus-mbmanager-before-s1003.png`） | 长期证据 | 保留；目录内放 `.keep` / `.evidence.json` 自声明（用 `--mark-evidence` 落三字段标记） |
| 本轮仅被修改的旧目录 | 可能是复用目录 | 默认保留；确需删除用 `--only <精确路径>` |

- **证据自声明优先**：在证据目录内放 `.keep` 或 `.evidence.json`，`tmp-sweeper` 与 `tmp-round-scan --apply` 都会整棵保留；中心清单 `excludePaths` / `excludeTopPrefixes` 继续兼容，新增证据目录时优先用标记而不是改配置。
- **「保留」答复必须同批落标记（C10）**：用户选「保留」后，不能只把答复留在对话里——同一轮跑
  `node ~/.qoder/scripts/tmp-round-scan.cjs --mark-evidence <证据目录> --task <任务ID> --session <8位会话id> --doc <登记文档路径> --json`
  （`--mark-evidence` / `--doc` 可重复）。三字段缺一即 exit 2 且不写；目录必须在临时根内、不是硬否决路径。
  **已有 `.evidence.json` 一律不改写**（可能是别的会话登记的证据）：跳过并 exit 3；写失败 exit 1；全部写成 exit 0。
  该模式只写标记、不删任何东西，**不与 `--apply` 同批执行**（同批给会 exit 2）：先标记，再单独跑清理。
- **保留意图优先**：用户明确保留或被证据/文档引用的产物不得因会话ID命名而删除。
  名称不清晰时可在获准范围内改名，但不把改名或写记忆作为保留文件的前置。
- **唯一临时目录（2026-11-09 起）**：本机所有新临时产物统一写 `D:/tmp`（`tmp-sweeper.json` 的 `canonicalRoot`，与 AGENTS.md「不往 C 盘写、临时文件全部走 D 盘」一致）；**不再新建** `%TEMP%/qoder-work`。其余目录均为兜底对象：`%TEMP%/qoder-work`（历史遗留）、`%TEMP%/qoder-cli`（Qoder CLI 会话任务输出）、`%LOCALAPPDATA%/Temp/qoder-work`（C 盘遗留，可能被客户端进程直接寻址）；`~/.qoder/tmp` 是机制状态（台账/心跳），不是产物目录，不纳入清理。
- **扫描根**：额外根只能由 `~/.qoder/tmp-sweeper.json` 的 `extraRoots` 或显式 `--root` 给出，**脚本不接受通配或相对路径**；`--apply` 只允许 `canonicalRoot`（其他根需 `--force`）。
- **活跃保护**：任一顶层条目 24h 内有改动 ⇒ 视为活跃会话产物、整棵跳过（`--include-fresh` 可解除）；删除后回收本次扫描过的空目录。
- **证据排除**：`tmp-sweeper.json` 的 `excludePaths` / `excludeTopPrefixes` 列出被记忆或交付文档引用的取证目录（本机含 `D:/tmp/context-continuity-924e5d4b`、`D:/tmp/qo-deploy-*`、`D:/tmp/QO-REL-*` 等），一律不扫不删；新增证据目录时同步登记或放 `.keep`。
- **本机临时目录约定**：`D:\tmp` 是临时文件专用目录（AGENTS.md「不往 C 盘写」）；放在未登记位置的产物**扫不到**，需补 `extraRoots` 或按精确路径处理。

## 分享包必问 vs 本地自动清理（互不干扰）

| 场景 | 结束动作 | 门禁 |
| --- | --- | --- |
| 普通任务（未使用分享包） | `autoClean.enabled=true` 时按推荐范围自动清理本轮**新建**产物并反馈；未开启则弹窗确认后执行 | `R14` |
| 分享包安装 / 合并 / 发布 | **默认每轮结束询问**：扫描 → AskUserQuestion → 按答复执行并反馈 | `R15` |
| 分享包 + 用户本轮明确授权自动清理 | 跳过询问，跑 `--apply --include-share-package --json`（默认进隔离区），仍须反馈删除/保留结果；回滚点与证据保留 | `R15` |
| 同一轮既有普通产物又有包产物 | 包产物受保护、不自动删；先按分享包规则询问或授权清理，普通产物可另行自动清理 | `R14` 让位给 `R15` |

**优先级**：分享包必问/授权规则 > 本地普通任务自动清理。`R14` 在分享包轮次不拦截，避免与 `R15` 形成双重要求；`R15` 不因 `autoClean.enabled=true` 而放行。自动清理默认保护 `Qoder-Optimization*`、`share-package*`、`install-package*`、`pkg-*`、`qoder-download*`、`qoder-consumer-home*`、`qo-*pkg/release*` 等分享包命名；`QO-REL/AUDIT/FIX-*`、`qo-deploy/wip-*` 回滚点与 `excludePaths` / `excludeTopPrefixes` 始终保留。只有显式 `--include-share-package` 才放开分享包类命名，回滚点与证据不放开；放开后默认进隔离区，`--no-trash` 才永久删。

## 安全边界（违反即停手）

- **只扫 `canonicalRoot`（本机 `D:/tmp`）、遗留/客户端兜底根与显式 `--root` 传入的目录**。
  **绝不用 `qoder*` 这类宽前缀扫 `%TEMP%`**：Qoder 会为每个会话建 `qoder-XXXX-cwd` 目录
  （实测数百个），宽前缀会把宿主自己的会话目录当垃圾删掉——那等于掀掉正在跑的会话。
  脚本里已有一条硬否决（路径任一段匹配 `qoder-*-cwd` 一律跳过，即使被 `--root` 指到）。
- **绝不删**：仍在使用的证据（台账引用的截图、还没提交完成的补丁）、
  别人会话的在途产物、`.git` 下任何内容、配置目录。
- 不确定属不属于本会话 ⇒ **保留并在清单里点名**，不要靠猜删除。
- 自动清理只允许通过 `tmp-round-scan.cjs --apply --json`（必须显式 `--since <本轮开始>`）执行；禁止直接 `rm` 本轮目录或用通配。`--since` 不能晚于当前时间、不能早于 7 天（越界需 `--force`）；`--apply` 只允许 `canonicalRoot`（其他 `--root` 需 `--force`）。分享包未获授权时不得加 `--include-share-package`。并行会话共用临时根时用 `--only <精确路径>` 或 `--session <8位id>` 限定范围，`--only` 只接受临时根的直接子条目。
- **收尾门禁校验**：`--apply` 命令必须带 `--json`；stop-gate 会解析结果里的 `deleted / recommended.preserve / failed`，要求本轮探测到的条目全部被删除或保留、`failed=0`，且 `--since` 与本轮用户消息时间相差不超过 10 分钟。
- 守卫自身要先自证会咬：`node ~/.qoder/scripts/tmp-sweeper.test.js`（40 条，含"新鲜文件不许被列、
  不许被删"的对照组）、`node ~/.qoder/scripts/tmp-round-scan.test.js`（63 条，含分享包/证据/超期件保护、`--only`、`--session`、未来/超期 since、非 canonicalRoot `--root` 与隔离区负对照）与 `node ~/.qoder/scripts/tmp-round-scan-evidence.test.js`（31 条，含 `.trash` 整棵还原逐文件 sha256 比对、`--mark-evidence` 三字段与"不改写他人标记"负对照、文档登记保护与去标记必删负对照）。
