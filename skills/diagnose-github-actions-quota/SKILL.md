---
name: diagnose-github-actions-quota
description: GitHub Actions 无job、零步骤、日志缺失、runner排队或账户限制疑点的只读取证。按实际run、attempt、job、step、annotations与可比成功运行区分原因；短时失败或404不直接判配额。成本优化另用audit-ci-cost-levers。
argument-hint: "<owner>/<repo> [run-id]"
---

# GitHub Actions 失败与账户限制取证

先确认失败属于代码/环境、执行通道、等待审批、取消还是账户限制。使用已连接GitHub工具，能力不足再用已登录gh；不输出token或完整认证配置，不改计费、注册runner、cancel或重跑任务。

## 1. 固定目标与当前运行

读取本仓workflow和入口脚本，记录仓库、run id、attempt、head SHA、事件、runner类型与观察时间。CLI可用以下只读入口：

```text
gh run view <run-id> --repo <owner/repo> --json databaseId,headSha,status,conclusion,jobs,url
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs
```

大型结果按需要分页、筛字段，避免全量日志灌入上下文。认证或接口失败只说明取证通道未就绪，不能当成“没有job”或账户额度结论。

## 2. 从实际步骤定性

| 观察 | 后续核对 |
| --- | --- |
| 有明确失败step | 读取该step对应日志，沿workflow→入口→子脚本定位代码、依赖或环境原因；失败step不自动等于代码缺陷 |
| queued/waiting/action_required | 查runner在线/标签、并发、environment审批与贡献者授权，保留等待状态 |
| cancelled | 查实际取消者、并发策略和运行记录，不能归为测试失败 |
| 无job、零step、很短时长或日志404 | 仅是线索；还可能是权限、取消、日志保留期、接口/ID错误或账户限制 |
| annotations明确说明付款/预算限制 | 可确认该次运行的限制证据；不足以区分全部账单原因或推算剩余额度 |

job id、run id与check-run id不是可以互换的恒定编号。使用API返回的`check_run_url`或已核验的check-run对象，再请求其annotations。若字段缺失或权限不足，记录PREREQ/未验证，不猜ID或以404作否定。

## 3. 对照与证据缺口

取同仓库、同类runner和相近workflow的成功运行作只读对照。核对同一判据能区分成功与失败；对照不要求dispatch一个新run，也不授权重跑。成功job通常没有失败注释，但不能由此反推另一个空响应一定是配额问题。

保存准确命令、返回状态、关键原始日志、run/attempt/SHA、首个失败位置和不能取得的字段。运行中日志未准备好、接口拒绝、日志已过期与真实零步骤分别说明。仅对有新证据的临时传输故障在既有预算内恢复；不靠反复认证请求解决额度问题。

## 4. 计费与后续处置

仓库所有者、plan、runner类型、计算使用量、存储和实际账单分别核对。挂钟时长或`updated_at`不能直接当账单分钟；并行job、重试与排队会改变口径。当前额度、费率和API可见范围从官方文档与获准账户界面核验，不沿用历史机器样本。

需要优化时读取`audit-ci-cost-levers`，先量化收益并追踪门禁输入。修改支付/预算、注册服务、外部写入或运行新任务仍需适用授权；本技能的只读取证不授予这些操作权限。

## 来源

根据Codex个人github-ci-evidence的证据方法重新整理，纠正旧技能的零step/404即配额、job/check-run等值和固定费用断言；未移植账户状态或旧辅助脚本。

官方资料：[workflow jobs REST](https://docs.github.com/en/rest/actions/workflow-jobs)、[GitHub Actions计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
