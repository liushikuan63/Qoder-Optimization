---
name: diagnose-github-actions-quota
description: "私有仓库 GitHub Actions CI 全红时先定性再修——用一组能失败的只读 gh 判据阶梯区分账户计费与配额闸门和真实代码红，并强制在成功 run 上重跑同一阶梯证明判据可失败。当出现推送后 2~3 秒即红、看不到步骤或日志、gh run view 空输出、run 里 total_count=0 没有 job、日志端点返回 BlobNotFound、annotation 含 payments have failed，或任务涉及 Actions 配额与 GitHub Free 2000 分钟/月时使用。止血测算与车道落地用 audit-ci-cost-levers。"
argument-hint: "<owner>/<repo> [run-id]"
---

# Diagnose GitHub Actions quota / billing gate

## Overview

私有仓库 CI 跑在 GitHub 托管 runner 上，配额见底后 job 被计费闸门拦下——红得"不像代码问题"。本技能给出一条可复跑的只读判据阶梯：先定性、再折算消耗、最后按代价选处置。全程只读 `gh api`，不改动仓库与账户。

止血手段的收益测算、自托管车道选型与否证表交付 ⇒ 用技能 `audit-ci-cost-levers`，本技能只负责"这波红到底是不是配额"。

## 何时使用 / 何时不要用

**使用**：推送后数秒即红且无步骤输出；日志取不到；run 里没有 job；annotation 出现闸门文案；需要判断个人版/组织配额与用量取证边界。

**不要用这套读数**（另有成因，annotation 文案不同）：

- job **有 steps 且某步 `failure`** ⇒ 真实代码红，按排查纪律读日志。
- `action_required`（首次贡献者待人工批准）、`waiting`/`queued`（车道排队或自托管 runner 离线）、`workflow_dispatch` 缺 trigger。
- 公共仓库标准 runner 不计配额 ⇒ 公共仓库全红基本不是配额。

## Step 0 — 先证明 gh 与网络可用（否则后面全是假阴性）

```bash
gh auth status --hostname github.com
gh api rate_limit --jq '.resources.core | "api used=\(.used) remaining=\(.remaining)"'
```

`remaining` 必须远大于 0。若 gh 未登录、代理残留或 hosts 解析异常导致 API 不通，**"拿不到 job"是通道故障，不是配额证据**——先把 `gh api repos/<o>/<r>` 打通再走阶梯。

## 判据阶梯（Step 1→4 任一命中即闸门；全不命中则不是配额）

```bash
R=<owner>/<repo>
gh api "repos/$R/actions/runs?status=failure&per_page=8" \
  --jq '.workflow_runs[] | "\(.id) \(.created_at) \(.status)/\(.conclusion) \(.name)"'
RUN=<上面取到的 id>
```

**1. job 存活时长与步数**

```bash
gh api repos/$R/actions/runs/$RUN/jobs \
  --jq '{total:.total_count, jobs:[(.jobs // [])[] | {id, name, conclusion, secs:((.completed_at|fromdate)-(.started_at|fromdate)), steps:((.steps // [])|length)}]}'
```

- 闸门读数：`conclusion=failure`、`secs` 约 **2**、`steps=0`，同 run 后续 job 为 `skipped`。
- 真实代码红：`secs` 数百到数千、`steps` 有值且某步 `conclusion=failure`。

**2. run 根本没被派发**

同一端点 `total=0`（或 `jobs` 为 `null`）⇒ 一次都没跑起来；无 job 可读时直接走 Step 4。

**3. 日志不存在**

```bash
gh api -i repos/$R/actions/jobs/<job_id>/logs 2>&1 | grep -Ei "HTTP/|BlobNotFound" | head -3
```

- 闸门读数：`HTTP/1.1 404 The specified blob does not exist.` + `<Code>BlobNotFound</Code>` ⇒ runner 从未启动。
- 区分两种 404：**404 + BlobNotFound = 没跑过**；404 + `{"message":"Not Found"}` = 端点或 ID 写错。

**4. annotation（决定性证据）**

```bash
gh api repos/$R/check-runs/<job_id>/annotations \
  --jq '.[] | "[\(.annotation_level)] \(.message)"' | head -3
```

闸门标准文案：`The job was not started because recent account payments have failed or your spending limit needs to be increased.`

## 四个会造出假否定的陷阱（每条都已实测复现）

| 陷阱 | 现象 | 正确做法 |
|---|---|---|
| 把 annotations 挂在 Actions 路径下 | `repos/<o>/<r>/actions/jobs/<id>/check-run/annotations` → `{"message":"Not Found"}`，被读成"没有拦截证据 ⇒ 不是配额" | `repos/<o>/<r>/check-runs/<check_run_id>/annotations`，Actions job 的 `check_run_id` 等于 `job.id` |
| 用 commit 级 check-runs 取证 | 对 `total_count=0` 的 run 返回**空数组**，同样读成"没有证据" | 按 run→job→check-run 顺序取 ID，别从 commit 反查 |
| 拿 `run_id` 当 ID | **workflow run 对象的 `run_id` 恒为 `null`**（list 与单 run 端点均已证实）⇒ 变量为空、下一跳 404，被误读成"run 不存在" | ID 一律取 `.id` |
| jq 里用中文对象键 | gh 内置 gojq 直接报 `failed to parse jq expression ... unexpected token` | jq 构造对象只用 ASCII 键；中文说明放注释或正文 |

任何一步 404，**先按上表怀疑端点形态与 ID 字段，再下"没有证据"的结论**。

## 对照验证（必跑，否则整套判据不算成立）

在同仓库取最近一条**成功** run，把 Step 1→4 原样重跑：

```bash
S=$(gh api "repos/$R/actions/runs?status=success&per_page=30" --jq '[.workflow_runs[] | select(.conclusion=="success")][0].id')
gh api repos/$R/actions/runs/$S/jobs --jq '[.jobs[] | {name, conclusion, secs:((.completed_at|fromdate)-(.started_at|fromdate)), steps:((.steps // [])|length)}]'
SJ=$(gh api repos/$R/actions/runs/$S/jobs --jq '[.jobs[] | select(.conclusion=="success")][0].id')
gh api repos/$R/check-runs/$SJ/annotations --jq '[.[] | select(.message | test("payments have failed"))] | length'
```

期望（本机 2026-10-07 实测）：成功 job `secs=217`、`steps=8`，闸门文案命中数 **0**。对照组若也报"闸门"，说明判据写法错了（多半是上表的 ID 字段或端点形态），**不得据阶梯下结论**。

## 配额算术（把"为什么是今天烧穿"算出来）

```bash
node <本机辅助脚本>/quota-usage.cjs <owner>/<repo> [workflow-name] [--days 30] [--plan 2000]
```

分页拉取成功 run 的 `run_started_at`→`updated_at`，输出单次平均分钟、窗口总量、日均与月度投影，并与 `--plan` 比较。本机实测：`build-and-gates` 30 天 466 次成功 run，mean 5.3 分钟/次，合计 2452 分钟 > 2000 ⇒ 判"会（或已经）烧穿"。

口径与边界：

- **GitHub Free = 2000 分钟/月** + 500 MB 工件存储；公共仓库标准 runner 不计费。
- 脚本按**挂钟分钟**统计，**未套用 runner 倍率**：Linux 为基准档，Windows、macOS 单价更高（文档现价 Windows $0.010/分钟、macOS $0.062/分钟）⇒ Windows 车道实际烧配额比读数更快，报数时一起说明。
- `concurrency: cancel-in-progress` 只回收"被取消后不再跑的那半截"，**已消耗分钟照常计费**，不是免费额度。

## 取证边界（必须如实标注"未验证"）

- `users/<u>/settings/billing`、`accounts/<u>/billing`、`users/<u>/settings/billing/usage` **三端点对个人账户全 404**（billing/usage API 只对组织/企业开放）⇒ **不许凭"API 拿不到"断言没超额，也不许把"还剩多少分钟"写成已验证结论**；剩余额度只能看网页 Settings → Billing and plans。
- 闸门文案是**二合一**：扣款失败 / 花费上限为 0 需上调，两种都出同一句 ⇒ 账户是否绑了付款方式无法程序化确认，标"未验证"。两种情形止血动作相同，不必先定性再动手。
- 组织与个人配额是**独立账本**：先确认失败仓库属于哪个主体，再套用数字。
- 切到自托管车道后，托管历史样本口径作废，下次要重新取数。

## 汇报模板

- **定性**：配额闸门 / 真实代码红 / 通道故障——各附本次实际读数（run id、`secs`、`steps`、annotation 原文）。
- **对照**：成功 run 上重跑同一阶梯的结果（证明判据能失败）。
- **算术**：单次分钟、窗口次数、折算总量 vs 上限，并注明倍率口径。
- **未验证**：剩余额度、是否绑卡——点名"个人版无 billing API"。
- **处置**：需要测算止血收益或装自托管车道时转 `audit-ci-cost-levers`；**付费解冻（绑卡 + 上调花费上限）属对外可见且有实际花费，必须用户本人操作**。

## Resources

- `<本机辅助脚本>/quota-usage.cjs` — 分页取样成功 run，折算托管分钟并与配额上限比较（只读 `gh api`，输出已限长）。
