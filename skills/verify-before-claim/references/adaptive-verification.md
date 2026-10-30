# 按需：自适应验证选档（四选项）

只在用户要求“按难度选验证强度”“给我选验证方式”“人工验证”或已明确启用本任务选档流程时读本文件。未启用时不要调用这些模块，也不新增弹窗或状态。
公开调用约定见本文件，字段校验与反例见随包的 `scripts/verification-*.cjs` 及对应测试，不依赖本地设计文档。下列命令从源码仓库或解压包根运行；只有另行获准安装并核对文件/装载后，才可将 `scripts/` 换成实际客户端的脚本目录，不能从本文件推定已经安装。

## 1. 准备事实（不执行验证）

1. 只读核对本轮请求、实际改动（含未跟踪、删除、重命名）、已有测试入口和现行验收要求；不要为了打分先做全仓审查或先跑测试。
2. 请求 JSON 字段见 `scripts/verification-policy.cjs` 校验：`taskId`、`sessionId`、`requestMessageId`（本任务真实用户请求 id）、`workspaceKey`、`environmentKey`、`facts`（含 `sourceRefs`）、`modelSuggestedTier`、`userCheckIds`、`baselineCheckIds`、`baselineSourceRef`、`checks`。
3. 每个检查必须有 `evidenceType`（static/simulation/runtime/artifact，互不替代）、可失败预期引用与执行前置；敏感项写 `sensitive: true`，未知事实写 `unknown`/`null`，不要猜。

```bash
node scripts/verification-policy.cjs <request.json>
```

输出 `recommendedTier`、四项 `options`（推荐在首位，人工在最后）、`mandatoryCheckIds`、`blockers`。清单必须在展示前展开依赖；`blockers` 非空时先补事实，不要启动验证。

## 2. 主动询问（必须）

1. 先将 `displayQuestionFor(session)` 完整文本作为助手消息展示，再用原样 `questionFor(session)` 调用已有 `AskUserQuestion`。问题含提案 id 与摘要，四项原样展示，推荐置首，不隐藏低档。
2. 用户可自由选择强化、标准、轻量或“交由人工验证”。选择只改变验证范围，不授予安装、启用、发布或生产操作权限。
3. 未答复、取消、超时、工具报错≠选择：不自动采用推荐，不自动转人工，不循环弹窗；保留未完成状态，继续独立已授权工作。
4. 普通文本点档作为 `explicit-current-user-request` 绑定请求锚点、已展示完整提案及当前用户消息；裸文本不能授权事后新建提案。新请求打断窗口；同任务合法改档按最新答复处理，旧运行失效。
5. 原生答复也必须匹配完整提案展示，缺失、截断或改写的展示不得确认；选择保留 `questionSourceRef`。核对整个相关窗口最后一个问答事件，后续取消/未答复/失败不可忽略。assistant 仍 streaming 时可接受其中已 completed 的明确工具结果；同消息的展示先后由可信宿主核对，event 位置只是快照顺序，不是稳定工具 ID。scope/政策变更需要新提案和新答复，内容变更只使旧证据失效。

## 3. 绑定与执行

`verification-session.cjs` 是 CommonJS 库，不是可执行检查。宿主编排使用下列导出；request、activation、真实快照与 resolveAuthority 必须由获准宿主提供，不在示例中编造批准对象。

```js
const {
  createSession, displayQuestionFor, questionFor, applyChoice,
  selectedPlan, beginVerification, auditVerification, saveSession, loadSession,
} = require('./scripts/verification-session.cjs');
```

状态机：

| 选择 | 状态 | 实际执行 |
|---|---|---|
| 自动档 | `confirmed` | assisted＝所选清单；shadow＝基线 ∪ 所选 |
| 交由人工验证 | `awaiting_manual` | 自动集合为空，只输出 `manualChecklist`，结论 `INCOMPLETE` |
| 未答复/取消 | `awaiting_choice` 或宿主暂停 | 不执行 |

- `beginVerification()` 校验内容指纹、运行目录、前置与授权；复制并冻结 expectations 中的数组并保留 expectedOutcomeRef。轻量单检查可只给 positive，其余报告路径必须有正负独立期望。
- `resolveAuthority` 必须由可信宿主核对原批准及 sourceRef、scopeDigest、mode、activationKind、policyVersion；模块只核对返回结构，不把自填 JSON、布尔、签名或函数返回值当权限凭证。实验授权不能移用于普通任务。
- `reassessSession()` 在内容变化时使旧证据失效，边界/政策变化才生成新提案。
- 持久化显式传入获准绝对路径 stateDir，不存在 `--state-dir` CLI。缓存文件保存 choice/run，但 `loadSession` 清空可执行选择与运行，只返回 previousSelection 提示；恢复必须重新读取当前真实来源并核对授权。
- 实际执行只用现有工具与项目命令；脚本不执行 JSON 里的命令字符串，不新增通用执行器。

## 4. 验收与汇报

```bash
node --test scripts/verification-session.test.js scripts/evidence-audit.test.js
node scripts/verification-benchmark.cjs <实验清单.json> --json
```

- 直接 `node scripts/verification-session.cjs` 会给出库用法错误并退出2，不是成功的检查入口。
- 报告恰好覆盖实际清单，正负期望匹配 begin 冻结值；报告绑定 proposal/choice/content 摘要，runDigest 检查运行记录未被替换。摘要只证明一致性，不证明来源真实。
- 记录用原 `evidence-audit.cjs` 审计，证据类型等于计划类型；未执行项只给 reason，保留原有 PARTIAL/INCOMPLETE，不编造正负记录补齐。
- 轻量单判据的 direct 原始记录必须有明确绝对 cwd、当前 runId 和 proposalDigest/choiceDigest/contentDigest，不得只在包装器标“当前”；不强制双记录报告。
- 汇报区分：所选范围通过、未执行的扩展覆盖、待人工验证项、未验证原因。不得写“所有场景全绿”。
- 人工模式不自动跑测试或审查；人返回证据后仍需逐项核对，再更新结论。

## 5. 影子与配对实验

- 影子：明确告知自动选项只影响候选清单，实际仍跑基线与所选并集；人工选项不跑基线，返回待验清单。影子选择不得宣传为已节省时间。
- 配对实验：只在单独获准的冻结批次与隔离环境中用 `assisted + isolated-trial`；实验结果达标且另获正式启用批准，才可在日常任务用 `enabled-workflow`。未达标维持原流程。
- 评估器核对清单内原始数据、版本与来源引用，不执行命令、不读取外部引用或认证其真伪；完整字段与统计门槛见 [verification-benchmark.cjs](../../../scripts/verification-benchmark.cjs) 的 `validate`、`summarize` 及对应测试。缺数据、家族泄漏、轮次不齐或不等权、轻量速度不足、非有限统计、高风险漏检都不得判通过。
- 每档 `bySplit.dev` / `bySplit.holdout` 分别报告任务数、配对轮数及含/不含人工等待的耗时。除原有合并门槛，轻量保留集须独立满足含等待 p50 改善至少20%、候选 p95 不劣于基线，不能用开发集收益抵消保留集不足。
- 人工样本不进入自动提速、三档、开发/保留集分母；没有质量违规时结论为 INCOMPLETE。模拟数据只验证公式，来源真实性和真实收益另由获准宿主核对。

## 6. 边界

- 本流程不覆盖推送/发布前的完整检验、UI 真跑截图、授权与备份纪律；选档不能替代它们。
- 未启用时不改现役 hooks、提醒、settings；接入现役属单独批准，不随源码分发自动启用。
- 真实端到端问答与截图证据需要另行批准的试点；仅单测通过不得宣称用户链路已验证。
