---
name: mechanize-rule-into-hook-guard
description: "把提示词里的纪律做成会判红的门禁 hook 取证流水线：缺口取证 → carrier-preflight 问限额 → 判据抽成 core 真源，PreToolUse 拦 / PostToolUse 记账 → 红与负对照自测 → 逐断言变异验证 → 台账非空核查 → RFC5737 真机探针 → 两侧接线与周检复跑。触发词：机制化、做成 hook、加门禁、加守卫、guard、这条规则没生效、反复违反、为什么没拦住、连败三次、停手上报、hook 是否生效、两侧接线一致性、config-doctor、事件×命令集合、生成物被覆盖、分发包落后、台账取证、假绿、负对照、变异测试。不用于：认证/锁定签名与防锁号现场操作（db-credential-auth-lock-safety）；同域旧版 mechanize-rule-as-hook-guard、enforcement-hook-lifecycle 已并入本 Skill。"
---

# 把规则机制化成会判红的 hook 门禁

## Overview

一条纪律被反复违反时，正确的修复通常不是改文案，而是补一个**能失败**的门禁。本 Skill 给出「取证缺口 → 落地 → 证明它真的在拦」的执行顺序，每步都带可失败判据；并附带一个已按此流程实现并验证过的窄判据守卫 `fail-streak` 作为可复跑样板。

金标准既有实现是本机 auth-lock 三件套：`~/.qoder/scripts/auth-lock-core.js`（core 真源）、`auth-lock-guard.js`（Post 入口）、`risky-match-guard.js` 末尾委托段（Pre 入口）。

## 与其他同域内容的边界

| 内容 | 它管什么 | 本 Skill 的关系 |
|---|---|---|
| `verify-before-claim` | 任何断言都要能失败的通用验收纪律 | 本 Skill 是它在「机制化」这一具体场景的执行手册 |
| `db-credential-auth-lock-safety` | 凭据校验与防锁号的现场操作 | 认证/锁定签名归它，本 Skill 的守卫**必须对它中性**（见签名互斥） |

同域另两份 `enforcement-hook-lifecycle`（接线一致性与分发补遗）与 `mechanize-rule-as-hook-guard`（六步流程旧版）的内容**已全部并入本 Skill**（流水线 1–9 + §9 的接线/生成物/分发包/前置门口径），两份目录 2026-10-22 移入 `~/.qoder/skills-disabled/`，本表不再指向它们。

## 何时该机制化（三条都满足才动手）

1. 用户**重复**纠正过同一行为，或已造成不可逆后果（实例：连发 10 次错密码把生产账号锁到只能 DBA 手工解锁）。
2. 违规**可静态识别**——能写成「命令形态 / 工具面 / 返回签名」三元组。写不出三元组就还不该机制化，退回提示词层。
3. 判据**宁窄勿宽**：守卫噪声多就会被忽略（本项目实测教训）。只拦「一次错就不可逆或越搅越乱」的形态，并明确列出**不计数**的类别。

**反例（不要机制化）**：需要主观判断的纪律（"代码要简洁"）、失败即正常的迭代（编译错、单测失败、故意构造的 404 负对照）、已由别的守卫视为权威结论的签名（认证/锁定 → auth-lock）。

## 流水线

### 1. 缺口取证：证明「确实只有提示词」

跑 `node scripts/hook-gap-scan.cjs`（本 Skill 自带）。它**只扫 settings.json 真实引用的 hook 脚本**，顺一层局部 `require`（现役入口多是薄壳，判据在被 require 的 core 里——不顺这层就把真机制判成「没有」），逐个分档为 `counting`（有阈值比较）/ `state`（落盘但不比较）/ `mention`（关键词只出现在注释与提示词字符串里）/ `none`，并排除 `.bak`、`_backup*` 的命中——否则会把废弃副本当成现役机制，得出「已经有门禁了」的假结论。默认口径 `/三次|连败|consecutive|failCount|streak|threshold/i`，可 `--pattern` 覆盖；`--json` 机器可读；`--home <目录>` 换体检根；`--no-follow` 关掉顺 require。

**计数判据跑在「剥掉注释与字符串字面量」之后的代码上，而 `require` 路径、状态文件名本身就在字符串里——两者必须分开取**，取错就得到「机制不存在」的假红（本机两个真实坑：先拿剥过字符串的文本提 `require`，委托 core 整个漏扫；再把正则字面量里的撇号 `/user'?/` 当字符串起点，一路吞掉后面的 `threshold`）。`--selftest` 用 5 个夹具 + 端到端把这两类错误钉住：机制夹具必判 `counting`、纯文案夹具必判 `mention`、**两者同向即判红、结论不许采信**；端到端那格再把委托段摘掉一次，缺口结论必须翻回「成立」。

手工等价口径 `grep -rlE "三次|连败|consecutive|failCount|streak|threshold" ~/.qoder/scripts/*.js` 只能当粗筛：它把 `.bak` 副本和提示词一起算成机制。

**判据：目标纪律在全部现役 hook（含被 require 的 core）里机制级命中 0 条，才算证明无机制。** 只在 `rules-reminder.js`（每轮重注入的提示词）里出现，正是「纯提示词」的特征。

本机实测（2026-10-22 跑 `node scripts/hook-gap-scan.cjs`）：已接线 10 个 hook，关键词命中 2 个（`rules-reminder.js` 提示词、`auth-lock-guard.js` 注释），顺 require 找到的 `auth-lock-core.js` 判 `counting`；目标纪律「同类连败 3 种不同手段即停」机制级命中 **0** ⇒ 缺口成立。

### 2. carrier-preflight：先问限额，优先复用入口

```
node ~/.qoder/scripts/carrier-preflight.cjs --type hook --name <守卫名>
```

**判据：PASS 才继续；判 BLOCK 就如实回报软上限/同类候选，不擅自改阈值、不换目录规避。**

实测限额形态：PreToolUse 峰值已达 5、软上限 6 ⇒ 新守卫的 **Pre 半边必须委托进既有宿主**（`risky-match-guard.js`），Post 半边新开一条目（Post 峰值低，不触顶）。每多挂一个 hook，每次工具调用的耗时和排障面都涨。

### 3. 按事件面拆分（多数缺口死在这一步）

**PreToolUse 只看得到「将要发出的命令」，失败只出现在工具返回里。**

- 计数（记账）→ **PostToolUse**：读 `tool_response` / `tool_output` / `result`。
- 拦截 → **PreToolUse**：输出 `{"decision":"block","reason":"..."}`。

单挂 PreToolUse 的计数器永远数不到 ⇒ 门禁恒绿。**Pre 可并、Post 不可并**：Pre 只查状态能挂进别的守卫；Post 必须读本轮返回，事件面不同。

判据抄两遍必然分叉 ⇒ 抽一个 `*-core.js` 作唯一真源，两个入口都只做「读 stdin → 调 core → 该出声才出声」。

### 4. 写 core 与入口（必须齐备的六件事）

- 路径从 `HOME` 派生（`USERPROFILE || HOME || os.homedir()`），状态与台账落 `~/.qoder/tmp/<守卫名>/{state.json,decisions.log}`。
- 开关配置 `~/.qoder/<守卫名>.json`：`{"disabled":true}` + 阈值/TTL 可配；**缺省即取默认值**（配置文件允许不存在）。
- **解封只能走人工 CLI**（`--status` / `--clear <key>` / `--clear ALL`）：已拦目标不因一次「看起来成功」自动解封，否则一次误判绿灯就绕过门禁。未拦目标成功即清零。
- **目标维度抽取要加锚点 gate**：文本里必须先出现该领域真实入口特征（远程客户端名、DB 客户端名），否则引用文本、`-H "Accept: */*"` 这类片段会被抽成假目标键——假键与真键撞上就是误拦。
- **「真的动手」只算执行面**：判断一次调用是否算「连库 / 登录远程 / 部署」时，只能算真把命令交给 shell 或确实打到远端的那一面（Bash/Shell 与执行类 MCP 调用）；Edit/Write 的 `new_string` 里出现远程客户端与数据库客户端命令名字符串不计入，建自动化任务的 prompt 正文里引用这些命令名同样不计入——引用字符串≠动手。否则改守卫自己的代码、甚至把这条判据写进文档，都会被自己的门禁拦下（2026-10-22 连撞两类现场：Edit 载荷误拦、qoder_cron 参数误拦）。负对照必配：断言「只包含命令名字符串的非执行类载荷 → 放行且不建账」。
- 分类留**中性档**：拿不到「目标是否失败」的证据时既不计数也不清零；属于别的守卫的签名一律中性（互斥断言要写进自测）。
- 入口顶部挂 `require('hook-crash-guard.js').install('<守卫名>')`，让守卫自己崩溃时留痕而不是静默放行；委托段的 `catch` **不许静默**，core 抛错要往台账写 `*-pre-error|...`。

### 5. 红/对照双向自测

独立 `<守卫名>.test.js`，用 `child_process.spawnSync` 跑**真入口**。

- **红**：应拦的必须拦（`decision` 与退出码入判据，不看「有没有报错」）；台账必须出现本轮目标行；拦截 reason 必须带 `[<守卫名>]` 归因前缀。
- **对照**：至少一条「本不该命中」的样例确实放行且不进状态；已拦目标不影响同族另一目标。
- **沙箱隔离**：core 把路径**在 require 时**从 `process.env` 固化 ⇒ 必须先设 env 再 require；只设 spawn 的 env 不够（实测：直调 core 的断言读到了真实 `~/.qoder/tmp`，把自测写进生产台账 274 字节，被「逐字节一致」断言判红）。断言真实目录跑前跑后**逐字节一致**。
- **不接管道**：`... | tail` 把退出码吞成 0。
- 自查恒真断言：`|| true`、「只要不抛错就算通过」、以及**payload 缺字段导致分类永远走「成功」分支**（本项目首轮就是这么把套件 bug 读成守卫假绿的）。断言数量由计数器得出，不手写数字。
- **共用宿主入口必须断言归因**：往已有 Pre 宿主里加新门禁时，宿主既有测试若只断言 decision 等于 block，会被新门禁顶包变成恒绿——拦截确实发生了，只是换了人。既有断言要一并判定 reason 的归因前缀（如锁号类、风险匹配类、记忆优先类各自的前缀），新用例同样带自己的前缀。
- **新门禁要给既有测试预置状态**：一次性提醒类门禁读的是会话状态，宿主 fixture 里没有该状态就整批被拦。按同一 key 在测试开头预写（实证：风险匹配守卫的测试第 20 行预置已读记忆标记），不要放宽判据——放宽等于把跨套件污染改成永久假绿。

### 6. 变异验证：每条判据都被破坏一次

`<守卫名>-merge-mutation.test.js`，变异后**行为必须翻转**，翻不过来就说明对应断言是假绿：

| 变异 | 必须看到 |
|---|---|
| 摘掉 Post 入口的「出声」 | 达阈值不再拦（证明拦截来自那一行） |
| 去掉 env 隔离 | 真实台账出现改动（证明隔离断言不是恒真） |
| 阈值调成不可能命中 | 放行（证明阈值不是摆设） |
| 破坏手段签名去重 | 同一手段重跑也涨到拦（证明「重跑不计」由该函数保证） |
| 摘掉中性短路 | **认证 + 连接层重叠签名**被本守卫计数（证明互斥） |
| 摘掉本地/噪声排除 | 「本地命令里打远程」的失败也建账（证明噪声防线存在） |
| 摘掉锚点 gate | 引用文本被建成假目标 |
| 摘掉 blocked 保护 | 已拦目标被一次 `{"ok":true}` 自动解封（证明「解封只能是人的决定」由那一行守着） |
| 摘掉宿主对新门禁的委托段 | 该门禁判据必须全丢（转红）；仍绿＝这条断言被别的门禁顶包，属恒绿 |

**后两行是本机踩过的「空断言」坑**：变异体永远不翻转，多数不是守卫失灵，而是**变异根本走不到被测分支**。① 摘中性短路那条，报错文本必须**同时**命中两类签名——真实 MySQL 形态 `ERROR 1045 (28000): Access denied for user … (2002: Connection refused)` 正好重叠；只写 `password authentication failed` 时连接层签名不成立，变异体也判「成功」，断言恒不翻转。② 摘本地排除那条，命令必须**首 token 属本地类、正文真的在打远程**（`make deploy curl http://…`）；纯 `mvn -q test` 摘掉排除后依旧没有远程入口特征，同样是空断言。写完每条变异先问：**让它翻红的那条路径，输入真的走到那一行吗？**

判据条数由计数器打印，不手写：本机 `node scripts/fail-streak-merge-mutation.test.js` → **8 个变异 + 1 项收尾残留检查 = 9 项全绿，EXIT=0**。

**变异体写在被测脚本同目录**，跑完即删并断言无残留：落到 `os.tmpdir()` 会让 `__dirname` 解析不到 core，表现为成片假红，然后你会去查一个不存在的缺陷。

### 7. 台账非空核查：证明守卫真跑了

**被 `catch {}` 吞掉的日志函数 = 守卫静默不干活**（auth-lock 真机第一版：签名收数组、6 个调用点传字符串，`f.join` 抛错被吞，台账整段为空而一切「看起来正常」）。台账函数对数组/字符串都容错；核查方式是**读台账文件确认含本轮条目**，不看退出码（hook 恒 `exit 0`，退出码在这里无信息量）。

### 8. 真机零风险探针取证

真实会话里让守卫判一次红，用来证明「接线生效 + 无需重启即生效」。探针必须零认证、零生产风险：目标用 **RFC5737 / TEST-NET 不可路由地址**（`192.0.2.1` / `198.51.100.x` / `203.0.113.x`），不碰生产库、不拿真实凭据、不打需登录接口。

**判据：三种不同手段打到同一 TEST-NET 目标 → 下一次调用被 block 且 reason 带手段集 → 台账有 `streak-new`×3 与 `block` → `--clear` 后放行 → 收尾清掉探针状态。** 分发物（README/分享包/测试夹具）里不得出现内网 IP 与真实账号名，转义写法（`10\.18\.1\.32`）也算命中。

### 9. 接线、周检、回写

- 改 `settings.json` 与任何既有 hook 脚本前先 `node ~/.qoder/scripts/backup-file.js "<文件>"`。
- **两侧客户端都要接**：`~/.qoder/settings.json` 与 `~/.qoder-cn/settings.json`；改完 `bash ~/.qoder/scripts/sync-global-config.sh --check` 要 IN-SYNC，周检会抓出「另一侧未接线」。
- **先分清「一个真源」与「两份文件」**：本机 `~/.qoder-cn/scripts` 是指向 `~/.qoder/scripts` 的 junction（脚本只装一次，另一侧的计划会自动判「已同步」），但两侧 `settings.json` 是各自独立的文件（条目要各加一条）。命令里的脚本路径写 **realpath**（`.qoder/scripts/...`）而不是 `<root>/scripts/...`——照 root 拼会给 -cn 侧写出 `-cn/scripts/...`，与现役条目形态不一致，接线体检查不出功能差异、只会在别的口径上判你漂移。
- **接线判据只认 `config-doctor.cjs` 的 `HOOK-DIFF` 行**（`node ~/.qoder/scripts/config-doctor.cjs` 输出里那一行为 `OK`，它比的是两侧「事件 × 命令」**集合**，不是文件字节）。`sync-global-config --check` 只看文件是否同源，**看不出某侧少挂了一个事件**。别拿整体 `EXIT=0` 当接线判据：同一脚本还体检插件注册表与 MCP，两侧插件集合本就不同 ⇒ 整体恒红＝**永红的假判据**，写完没人再看。**被取代的旧条目必须两侧都摘**——只摘一侧＝同一判据在另一侧跑两遍、计数翻倍＝误拦。
- 永红判据同款坑：`carrier-preflight.cjs` 对**已存在**的同名载体恒给一条 BLOCK「同名 skill 已存在」（脚本无更新态豁免）。**修改**既有技能时不能拿 `PASS` 当门禁，只看有无**自匹配以外**的阻断项与 description 预警（超 CN 300 字符可见预警线就要瘦身）。
- 同一入口里多个门禁抢着出声时按**紧急度排序**：硬停（已拦目标）在前，一次性提醒（记忆优先）在后——谁先出声就只能给一条理由，硬停必须赢；顺序反过来会让变异验证拿到提醒类的假结果。
- **收窄工具面（前置门）与「标记已履行门禁」的先后要单独想一遍**：如果被门排除掉的只读调用，正好就是那一步把状态标成已履行的 actor，状态就永远标不上，门禁每轮重新提醒——表现像「门禁失灵」，实际是**自锁**。动前置门之前先问一句：这条路上负责标记的那一步还在不在门内。
- 收口复跑 `node ~/.qoder/scripts/rules-weekly-audit.js --no-fix`（EXIT=0、无悬空引用）与 `--check`。
- 要进分享包的脚本必须加进 `pack-share-extras.js` 白名单，否则被「剪除旧产物」逻辑删掉；core 与宿主守卫**同批分发**。
- **`hooks/hooks.example.json` 与 `README-hooks.md` 是 `pack-share-extras.js` 的生成物**：直接编辑会在下次出包时被生成器覆盖回模板，要改**生成器本体**。发现这类「改了不生效」的口径＝解压产出的 zip、断言目标关键字命中数从 0 变成期望值，别肉眼看目录。
- **判包内脚本是否落后只用 `node ~/.qoder/scripts/pack-share-extras.js <包目录> --check`**：它先套 `SCRIPT_SANITIZE` 脱敏表再逐字节比。**别用裸 md5 对比**——裸比把「已脱敏」读成「已陈旧」，会反向将内网形态的路径样例覆盖回分发包（2026-10-21 实测这样误报 3 个脚本）。
- 回写既有载体：`~/.qoder/scripts/README-rule-enforcement.md` 对应小节就地更新 + `rules-reminder.js` 那条提示词补「已由 `<守卫名>` 按目标硬拦」；**不新建平行文档**。
- hook 是 **fail-open**，不替代平台权限，也不构成安全边界。

### 10. UserPromptSubmit 提示词触发注入

给既有 `UserPromptSubmit` hook 增加“提示词命中才追加”的能力时，按下面做，别把关键词判断直接塞进入口：

1. **纯函数检测器**：输入 prompt，输出是否触发 + 命中理由；覆盖否定（“不要用 X”）、元提及（“这条规则怎么说”）、假设（“如果我说 X”）、定义/引用（“X 的定义是”）等排除形态。
2. **仅触发轮追加**：触发轮在原有注入后追加目标段落；普通轮的输出必须与改动前**逐字节相同**（模式隔离）。
3. **变异对照**：把检测器改坏一条（如去掉否定排除、去掉元提及排除），断言自测会红；不改坏时全绿。证明断言能失败。
4. **依赖闭包与隔离消费者验收**：入口、core、状态/台账、配置文件的依赖要在隔离 HOME 里跑通；安装后从真实消费者路径再验一次。
5. **全量回归**：既有 hook 的自测、周检、两侧接线 `HOOK-DIFF` 同批跑；提示词触发不改变既有门禁的拦截范围。
6. 不因本流程自动扩大权限、审批边界或安全拦截范围；需要改这些时单独批准。

## 交付判据（汇报前逐条核对）

1. 缺口有 grep 证据（命中数、被排除的废弃副本数）
2. carrier-preflight 结论原文（PASS/BLOCK 与峰值数字）
3. 判据在 core 里只有一份，入口无重复逻辑
4. 红用例 + ≥1 条负对照，退出码入判据且未接管道
5. 真实台账跑前跑后逐字节一致
6. 每条关键判据都有对应的「变异后翻转」记录（基线与变异各跑一次）
7. TEST-NET 探针在真实台账留下本轮记录
8. 两侧 settings.json IN-SYNC、`config-doctor.cjs` 的 `HOOK-DIFF` 行为 OK（整体退出码不作为接线判据）、周检 EXIT=0
9. 「已验证」与「未验证 + 原因」严格分开写

## 样板：fail-streak（同类操作按 3 种不同手段连败即停）

窄判据落地形态，可直接读作模板：

| 文件 | 作用 |
|---|---|
| `scripts/fail-streak-core.js` | 判据真源：远程入口 gate、连接层失败签名、手段签名去重、状态与台账 |
| `scripts/fail-streak-guard.js` | PostToolUse 薄入口 + 人工 CLI |
| `scripts/fail-streak-guard.test.js` | 红/对照双向自测，**22 组判据**（条数由计数器输出，不手写）；`--installed` 复验真实 Pre 宿主 |
| `scripts/fail-streak-merge-mutation.test.js` | 8 个变异 + 1 项收尾残留检查（共 9 项）验证断言可失败 |
| `scripts/hook-gap-scan.cjs` | 第 1 步缺口取证；`--selftest` 5 个夹具 + 端到端双向（共 9 项） |
| `scripts/install-fail-streak.cjs` | 一键安装：复制 core/入口 + 往 `risky-match-guard.js` 插入 Pre 委托段 + 两侧 settings.json 加 PostToolUse 条目（默认 dry-run，`--apply` 才写；逐个备份、写完 `node --check`、复验幂等）；`--selftest` 在临时体检根里真跑宿主 Pre 判红、再摘委托段判绿（12 项） |

计数口径与 auth-lock 的分工：**认证/锁定签名归 auth-lock；连接层失败（refused / no route / timed out / 502 / publickey 拒绝）归 fail-streak**，两套签名互斥，互不重复计数。

**已实测的判据边界**（下面两条是真跑出来的，不是推测——手段签名 = `首命令|子命令|去重后的 flag 集合`，**不含 URL 路径与目标值**）：

- **同一手段换 endpoint 不算新手段**：`curl -sS` 依次打同一主机的 `/api`、`/health`、`/v2/x`、`/admin` 四次 → 手段集恒 =1、`blocked=false`、全程不出声。这是**已知松点**：同一工具在同一主机上换路径穷举不会被计成多种手段。收紧的办法是把 path 纳入签名，代价是「一次配置写错的连续重跑」也会被算成连败——判据宁窄勿宽，先留着。
- **同一工具换 flag 算不同手段、三次即拦**：`curl -sS http://…` / `curl -v http://…` / `curl --connect-timeout 5 http://…` → 三个不同签名，第三次建满阈值、Post 出声、`blocked=true`。

## Resources

见上表。`hook-gap-scan.cjs`：`--home <目录>` 换体检根、`--json` 机器可读、`--pattern` / `--discipline` 换关键词与目标纪律口径、`--no-follow` 关顺 require、`--selftest` 自检。`install-fail-streak.cjs`：默认 dry-run 一个字节都不写，`--apply` 才落盘；`--home` / `--second` 指定目标侧，`--node` / `--matcher` / `--timeout` / `--backup` 覆盖命令路径、matcher、超时与备份器；未知选项、缺值或非正有限超时退 2，且在探测目标前停止。幂等检查要求 `type=command`、完整 Node 与守卫两参数命令、matcher 和 timeout 一致；错误解释器、额外参数（包括 `--clear ALL`）及 shell 包裹均作为冲突保留供人工核对。`--selftest` 全程在临时体检根里跑，不碰生产配置。

**本样板当前状态（2026-10-22）**：四套都真跑过——自测 22 组、变异 9 项、缺口扫描自检 9 项、安装器自检 12 项，均 EXIT=0；TEST-NET 逻辑探针在真实台账留下 `streak-new`×3 + `block`，`--clear ALL` 后放行。**但真机接线未做**：`--apply`（复制脚本 + 宿主委托段 + 两侧 settings.json）属拦截范围变更，需使用者明确批准并亲自在终端执行。在那之前，「Pre 半边在真实宿主里生效」只在沙箱体检根验证过；跑完 `--apply` 必须按 §9 复验：`node scripts/fail-streak-guard.test.js --installed`、`config-doctor.cjs` 的 `HOOK-DIFF` 行、`rules-weekly-audit.js --no-fix`、`hook-gap-scan.cjs`（缺口判定应从「成立」翻成「已有机制」）。
