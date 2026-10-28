---
name: global-config-smoke-runner
description: "本机 Qoder 全局配置冒烟：枚举 ~/.qoder/scripts 下全部 *.test.js 与 skills-doctor / skill-collisions / config-doctor / rules-weekly-audit，逐项运行并只汇总名称+退出码，再对非零项按真缺陷/检查器假阳性/可接受平台差异三分类并给修复动作。用于改规则/技能/hook/脚本后、重打分享包前、体检报红时。触发词：完整冒烟、全局配置冒烟、配置回归、检查器误报。不跑 mcp-smoke、dbhub、浏览器与生产库。"
---

# 全局配置冒烟

## 用途

对本机 Qoder 全局配置跑一轮可复跑的冒烟：执行 `~/.qoder/scripts` 下全部 `*.test.js` 与 4 个只读体检器，只汇总「名称 + 退出码」；对非零项按真缺陷 / 检查器假阳性 / 可接受平台差异三分类，再给修复动作。

## 何时用

- 用户说「跑一轮完整冒烟」「全局配置冒烟」「确认稳定 / 回归」。
- 改完规则、技能、hook 或全局脚本后。
- 重打分享包前（打包本身走 `update-share-package`）。
- 体检报红，需要区分真缺陷与检查器误报时。

不用于：单个 hook 的机制化改造、分享包打包、规则内容冲突审阅、生产库 / MCP 连通性、前台 UI 验收。

## 范围

默认执行：

- `~/.qoder/scripts/*.test.js`（非递归；排除 `.bak*`）
- `skills-doctor.cjs`
- `skill-collisions.cjs`
- `config-doctor.cjs`
- `rules-weekly-audit.js --no-fix`

默认不执行：

- `mcp-smoke.js`：需要目标命令，`--call` 会真调工具，可能连生产库。
- dbhub `execute_sql_*`、browser-use、computer-use。
- `config-doctor fix*`、`skills-doctor apply-sync --apply`、任何 `--apply`。
- 分享包打包 / 校验（走 `update-share-package`）。
- `.test.sh`：依赖 bash；本技能默认不纳入。

生产库、核心服务、对外发布动作不在本技能内执行。

## 运行

```bash
node ~/.qoder/skills-library/global-config-smoke-runner/scripts/smoke-runner.cjs
```

常用参数：

- `--only edit-guard`：只跑名称含该子串的项。
- `--tests-only`：只跑脚本自测，不跑体检器。
- `--timeout-ms 300000`：调整单项超时，默认 180000。

输出只有 `名称 EXIT=码`；完整 stdout / stderr 落在 `os.tmpdir()/qoder-smoke-<时间戳>/`。CN 侧不存在时，三个双客户端检查器显示 `SKIP(single-client)`，这是合法安装形态，不是红。

## 退出码语义

| 码 | 含义 | 动作 |
|---|---|---|
| 0 | 该项通过 | 不处理 |
| 1 | 该项判红 / 有告警 | 读日志，进入三分类 |
| 2 | 前置失败 | 先修前置，不当作配置缺陷 |
| MISSING | 必需检查器文件缺失 | 计红、总退出码非零；不伪装为合法跳过 |
| TIMEOUT | 超过单项超时 | 计红；看日志定位原因，不能以未跑完代替通过 |
| CRASH | 无退出码 / 被信号终止 | 计红；看 stderr，先按环境问题排查 |

`skill-collisions` 是例外：脚本恒退出 0、无 VERDICT。runner 会额外打印 `ADVISORY 未指认=N`，必须打开日志看重叠对；只看退出码会假绿。

## 三分类

### A. 真缺陷

配置、脚本、hook 接线或规则内容确实有问题。

动作：先备份，做最小完整修复，跑该单项，再全量复跑。修一处后扫同族缺陷，逐条给证据。

### B. 检查器假阳性

必须同时给出三样证据：

1. 失败断言原文；
2. 检查器判定逻辑（文件 + 行号）；
3. 现场事实（实际临时目录、真实用户名、两侧路径、配置现值）。

动作：修检查器，不改配置去迎合检查器。修复后加负对照——修复前失败、修复后通过——并跑该检查器的 `--selftest` 或对应 `.test.js`。

历史案例（2026-10-22）：

- `edit-guard` 只认 `/tmp` 与 `AppData\Local\Temp`；Git Bash 的 `TMP=D:\Temp` 被误判。改为按 `os.tmpdir()` 前缀判定。
- `config-doctor` 把本机用户名写死成 `Admin`，非 Admin 机器全部合法插件假红；改为真实用户名集合，并把市场插件单侧差异降为 INFO。
- 修检查器时不要在注释、日志或测试样例里写真实用户名、路径或凭据；`pack-share-extras` 会拦下。

### C. 可接受平台差异

例如市场插件单侧上架、单客户端安装、Git Bash 路径差异、缺少可选外部工具。

动作：记 `INFO` / `SKIP` + 理由，不复制、不删除配置去凑绿，也不把差异静默隐藏。

### D. 不可得

生产库、浏览器真机、需要凭据的外部系统。

动作：标「未验证 + 原因」；最多尝试一次合理恢复，不反复重试。

## 修复纪律

- 改已有文件前先备份：`node ~/.qoder/scripts/backup-file.js "<文件>"`。
- 只修当前授权范围内的问题；无关红项写进报告，不顺手改。
- 修完先跑单项，再全量复跑；不要用「重跑一次」代替修复。
- 同类修复 3 种不同手段仍失败，停手上报。
- 不自动提交、不自动打包、不自动部署。

## 验收判据

- runner 输出项数 = 枚举到的 `.test.js` 数 + 实际执行的体检器数 + 跳过的体检器数。
- 每个非零项都有分类、证据和动作。
- 修过的项单项复跑为 0，且负对照在修复前确实失败。
- 最终全量复跑没有未解释的红。
- 报告写明：命令、退出码、未验证项（生产库 / 浏览器等）。

## 资源

- `scripts/smoke-runner.cjs`：枚举、执行、日志、汇总；只读执行器，不传 `fix` / `--apply`。
