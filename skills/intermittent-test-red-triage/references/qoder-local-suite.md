# 本地套件 harness 参考

以下为 Qoder 本机套件的结构示例；其他项目按同一结构替换路径与脚本名。

## 入口与日志

- 套件入口：`run-tests.js`（仓库 scripts 目录），逐项测试由 smoke-runner 之类聚合器执行。
- 持久化：每个测试的 `.exit` 文件、`TEST_LOGS/` 逐件日志、`summary.json` 汇总。
- 单测脚本可能只打印 `exit=N`；套件内红项的事后归因需要插桩副本打印 `r.out`。
- 聚合日志的 DIAGNOSTIC 可能截断底层工具原文；以逐件日志为准。

## 忠实运行环境

- env 白名单：`PATH`、`SYSTEMROOT` 等最小集合；隔离 `HOME`、`TEMP`、`APPDATA`。
- cwd：与 runner 一致（例如 `scripts`）。
- 副本插桩时把 `__dirname` 钉回真源 scripts，避免相对路径 ENOENT。

## 负载与预算

- 超时预算写在测试或 runner 常量里；先读当前值，不要凭记忆。
- 量余量示例（历史实测，仅作方法示例）：脚本空闲 214ms → 进程 churn 381ms，对 8000ms 预算仍有约 20 倍余量，可否证「负载打满预算」的假设。
- 两种负载画像：CPU 忙等、进程 churn；分别 A/B。
- 并发负载源：统计其他会话证据目录在套件时间窗内的写入文件数，取同窗口无关目录 = 0 作负对照。

## 版本判定

- `git diff --name-only <绿>..<红>` 只证明提交范围，不证明字节。
- `git rev-parse <ref>:<path>` 比对 blob 才是字节同一性。
- 版本独有断言名出现在分测日志，才能证明「跑的是哪一版」。
