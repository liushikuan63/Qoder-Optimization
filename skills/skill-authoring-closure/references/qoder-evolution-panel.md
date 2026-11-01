# Qoder「自进化建议」面板取证

## 建议存在哪

- 面板来自 Qoder Desktop 应用侧，完整建议文本存在 `<数据目录>\main.sqlite`（本机约 811MB），**不在** `~/.qoder/evolution/`（那是 self-evolution 技能的本地台账）。
- 数据目录真实路径见 `~/.qoder/desktop/storage/stable/location.v1.json`；本机为 `D:\qoder-data\appdata-roaming\com.qoder.app.stable`。
- 记录格式：`<建议名>create<完整描述>`；同一建议可能在索引表、记录体、会话 payload 里各出现一次。

## 取全文

```bash
node ~/.qoder/skills-library/large-sqlite-text-extraction/scripts/scan-binary-text.cjs \
  "/d/qoder-data/appdata-roaming/com.qoder.app.stable/main.sqlite" \
  "<建议名前缀>" --window 3000 --max 5 --filter "create"
```

- 面板名字被截断（如 `dedupe-evolution-suggestions-int…`）时用前缀搜，别带省略号。
- 只拿到「技能名清单」时是命中了命名空间表，加 `--filter`。

## 处理顺序

1. 取全文 → 2. 按主题分组（同域合并成一个）→ 3. 通用化拆分 → 4. 走 `skill-authoring-closure` 第 4–8 步。
2. 已处理过的建议记进状态文件（建议用 `~/.qoder/evolution/suggestion-scan-state.json`，字段：`processed: [{id, name, at, skill}]`）。去重**先按 id**；只有旧记录没有 id 时才用 name + 主题兜底。新 id 即使同名也不得跳过。

## 本机已处理的批次

| 日期 | 面板条数 | 合并结果 |
|---|---|---|
| 2026-10-23（第 1 批） | 5 条（收不到更新推送） | `desktop-update-push-triage` |
| 2026-10-23（第 2 批） | 5 条（SQLite 取证 + 建议合并上线） | `large-sqlite-text-extraction` + `skill-authoring-closure` |
| 2026-10-26（第 3 批） | 10 条（外包吸收 2 / 分层路由 1 / 产物回环 1 / Windows 守护 1 / BYOK 中转与代理 3 / 验证与审阅主张 2） | `merge-inbound-qoder-package` + `skills-router` + `share-package-rebuild-triage` + `windows-hidden-autostart-daemon`（新增按需库）+ `byok-model-retry` + `verify-before-claim` + `rules-conflict-audit` |
| 2026-10-26（第 4 批） | 6 条（守护下换版重启 1 / 本机反代超时归属 2 / 运行态版本一致性 1 / 审阅证明力 1 / 启动期校验 clamp 1） | `windows-hidden-autostart-daemon` + `local-reverse-proxy-triage`（新增按需库，2 条合一）+ `verify-before-claim` + `concurrent-edit-attribution-check` + `rules-conflict-audit`；byok 侧改为指向反代真源，避免两套判据 |
| 2026-10-27（第 5 批） | 3 条（单点变异对照 1 / 本机 SSE 反代 1 / 门禁有效性审计 1） | 新建 `mutation-control-verification`（常驻，+references/checker-suite-recipes.md）与 `rule-enforcement-effectiveness-audit`（按需库，+references/local-enforcement-layer.md）；`local-sse-proxy-triage` 已由 `local-reverse-proxy-triage` 覆盖，仅登记不新建 |

| 2026-10-27（第 5 批） | 15 条（图像验收 1 / 证据先行 1 / 家族审计 1 / 产物审计 2 / 会话恢复 2 / vibecoding 校验 1 / 合同对账 2 / 中断修复 1 / SQL 预演 2 / 配置根 2 / 目标主机 1） | 新建 7 库技能（`image-result-visual-verify` / `evidence-first-skill-redesign` / `generated-artifact-content-audit` / `interrupted-test-repair` / `mapper-sql-live-dry-run` / `single-client-config-root` / `target-host-verification`）＋扩展 4 既有（`continuation-state-audit` 会话恢复分支 / `rules-conflict-audit` 家族一致性节 / `vibecoding-doc` §11.1–11.4 / `contract-docx-gap-analysis` 合规对账节）；2 条同名对已系统过期（contract-clause / mapper-rehearsal） |

标记动作用 `--ids`（同名多行）与 `--backup-dir`（备份出 C 盘），见 SKILL.md 第 11 步；已处理名同步进 `~/.qoder/evolution/suggestion-scan-state.json`。

## 注意

- 面板建议是**候选**，不是实施授权；是否落成技能、落哪个层级，按当前任务与用户指令判断。
- 不要因为面板有建议就自动改权限、改 hook 或改审批边界。
