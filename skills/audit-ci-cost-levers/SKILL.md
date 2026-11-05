---
name: audit-ci-cost-levers
description: 按真实workflow、run/job/step样本评估GitHub Actions缓存、路径过滤、并发取消、runner与推送频率的收益和代价。区分挂钟时长、计算使用量与费用，沿门禁输入闭包验证；不以零步骤或日志缺失直接判配额。
---

# CI 成本与执行效率审计

先固定仓库、workflow、事件、runner和样本窗口；失败定性用`diagnose-github-actions-quota`。只读取证不授权修改收费设置、注册runner、dispatch/cancel或推送；明确要求实现优化时在当前范围内完成最小改动并验证。

## 建立可比基线

- 从实际run、attempt、head SHA、job/step及日志建立样本，纳入相关失败、重试和取消。`created_at→updated_at`含排队/后处理，不当作runner运行时长；并行job不能只用workflow挂钟相加推账单。
- 分别报告观测耗时、按明确假设计算的估计节省、实际计费口径及未验证部分。当前plan、费率、runner规格、存储和账户额度现查，不写固定历史价格或通用省钱阈值。
- 明确环境、样本数和分母。某次慢运行不自动证明缓存失败、runner性能退化或配额耗尽。

## 候选措施与可失败判据

| 措施 | 要证明的收益与边界 |
| --- | --- |
| path filters | 有边界提交样本中实际可过滤比例；沿workflow→入口脚本→子脚本/生成源确认被忽略路径不是测试、文档或包验证输入 |
| concurrency取消 | 区分重叠比例与可回收的剩余执行时间；已经消耗的资源不会因取消消失；部署/发布的取消策略按项目契约处理 |
| 缓存 | 实际命中与恢复耗时、锁文件/平台/工具链键；恢复后相关测试确实执行；缓存写入/存储成本另算 |
| matrix/重复构建 | 每个目标的兼容性需求与重复输入；共享产物先冻结并证明来源，不能把一个平台通过推广成另一个平台实装通过 |
| self-hosted runner | 核对已有在线runner、标签、隔离、可信事件、工具链和维护代价；看到self-hosted文字不等于机器可用，不自动注册常驻服务 |
| 推送频率 | 按当前项目与会话授权保留可回滚增量，量化实际重复触发；不把某机器的“每格push”或“攒批push”变成全局规则 |

无效或低收益候选也记录分母与原因，不为满足节省目标减少质量门禁。确定性失败先修因，传输恢复沿既有唯一预算，写入结果未知先查回。

## 实施与验收

已授权修改时，先保存当前worktree归属和实际基线，核对workflow结构与受影响本地检查，再核对新的远端job/step和实际耗时。使用完整相同任务作可比对照；输入或环境差异明显时保留估计边界，不宣称因果结论。

交付观测数据、假设、收益/维护代价、通过/失败/跳过及剩余缺口。无需安装本技能未分发的quota-usage或通用runner；已有GitHub工具/gh只读接口足以开始。

来源为Codex个人github-ci-evidence的证据方法与原包CI审计的独有判据，重新编写，未复制私人账单。当前口径查[GitHub Actions计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)和[workflow jobs REST](https://docs.github.com/en/rest/actions/workflow-jobs)。
