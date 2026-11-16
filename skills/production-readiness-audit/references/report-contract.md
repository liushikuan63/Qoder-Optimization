# 审查报告契约

报告是**机器可读 JSON**，由 `scripts/readiness-report-check.cjs` 校验。校验器只判「报告自身是否诚实、完整、可核对」，不替你判断产品好坏。

```bash
node scripts/readiness-report-check.cjs <report.json>
node scripts/readiness-report-check.cjs <report.json> --checklist <清单.md> --json
```

退出码：`0` 通过（可带 advisory）／`1` 有违约／`2` 用法或环境错误（文件读不到、清单解析不出 ID）。**清单解析不出 ID 一律判错，不静默跳过**——否则覆盖判据空转。

## 结构

```json
{
  "schema": 1,
  "product": { "name": "示例产品", "kind": "saas", "root": "<被审查仓库的绝对路径>" },
  "items": [
    { "id": "ACZ-02", "verdict": "finding", "severity": "critical", "risk": "data-leak",
      "note": "订单接口只按 id 查询，未校验归属；换 id 可读到他人订单",
      "evidence": [{ "path": "src/orders/get.ts", "line": 42 }] },
    { "id": "AUTH-01", "verdict": "pass",
      "evidence": [{ "path": "test/auth-plus-sign.e2e.ts", "line": 12 }] },
    { "id": "CMP-05", "verdict": "not-applicable", "reason": "系统不处理受保护健康信息，数据字典中无 PHI 字段" },
    { "id": "TST-07", "verdict": "unverified", "reason": "拿不到客户运维机型信息，无法确认最低支持配置" }
  ],
  "top": ["ACZ-02"]
}
```

## 字段语义

- `product.kind`：`saas` / `web-app` / `api-service` / `internal-service` / `cli` / `library` / `desktop` / `mobile` / `agent-config`。它只影响你对适用性的判断，不影响校验器判据。
- `product.root`：被审查仓库的**绝对路径**，必须真实存在。所有证据路径都必须落在它里面——指向仓库外的文件不算证据。
- `items`：必须**恰好覆盖清单全部 ID**，一条不多一条不少，不重复。漏项＝「假装检查过」，直接判红。
- `verdict` 四态，各有硬性要求：

| verdict | 含义 | 必填 | 禁止 |
| --- | --- | --- | --- |
| `finding` | 适用且确认有问题 | `severity`、`risk`、`note`、≥1 条 `evidence` | 无证据的 finding |
| `pass` | 适用且实测通过 | ≥1 条 `evidence` | 「看起来没问题」式无证据通过 |
| `not-applicable` | 不适用于本产品 | `reason`（为什么不适用） | `severity` |
| `unverified` | 适用但没查到 | `reason`（为什么查不到） | `severity`、`risk` |

- `severity`：`critical` / `high` / `medium` / `low`。
- `risk`：`data-leak`（泄露·越权·隐私）／`money-loss`（资金·计费·成本）／`outage`（中断·不可用·数据丢失）／`other`（功能·体验·维护·流程）。
- `evidence[]`：`path` 相对 `product.root` 或绝对路径均可，但解析后必须在 root 内且文件真实存在；给了 `line` 就必须是 ≥1 的整数且不超过该文件行数。**行号是可选的，路径存在性是硬性的。**
- `top`：最多 10 条，全部是 `finding` 的 ID，不重复，且必须等于按下列规则排序后的前 N 条（N = min(10, finding 总数)）：
  1. `severity` 降序：critical → high → medium → low；
  2. 同级按 `risk`：data-leak → money-loss → outage → other；
  3. 仍同级按 `id` 字典序升序。

这条排序规则就是「先告诉我最值得修的 10 个问题，尤其泄露/资金/中断」的机械化形态：**顺序错了校验器判红**，不靠自觉。

## advisory（不阻断，但必须写进汇报）

- `unverified` 占比 > 30%：结论覆盖不足，别把报告当「已审查完毕」。
- `not-applicable` 占比 > 60%：先回头确认产品类型判断是否过窄，别用「不适用」把清单洗空。

## 人读版

JSON 之外再给一份 Markdown 摘要：前十问题（每条＝风险是什么 + 严重度 + 文件定位 + 建议修法），随后是「不适用清单及理由」「无法确认清单及原因」。**摘要里的每条 finding 必须能在 JSON 里找到同 ID**，不许摘要里多出一条 JSON 里没有的问题。

## 边界

- 校验器不判断严重度定得对不对，也不判断证据是否真的支撑结论——那需要人或独立复核。**它只保证：没有漏项、没有无证据的结论、没有给未查项排严重度、前十顺序没被人为调换。**
- 报告本身是只读审阅产物。写报告不等于获得整改授权。