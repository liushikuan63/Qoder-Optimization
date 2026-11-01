# Qoder-Optimization 包专用细节

> 只放本仓库的路径、脚本名与门禁清单；通用顺序见 SKILL.md。

## 仓库与产物

- 仓库：`D:\Java\GitHub\Qoder-Optimization`（默认分支 `main`，发布 tag `vX.Y.Z`）。
- 本地目录名 / zip 顶层 = `Qoder-Optimization - X.Y.Z`；`VERSION` 写成 `vX.Y.Z`。
- 主 zip 与离线 zip 各带 `.sha256`，共 4 个 Release 资产。
- 主 zip 不含 `mcp/offline/`（6 文件），该目录只随离线包；成员口径是「zip 358 + offline 6 = manifest 364」。

## 生成与门禁脚本

| 脚本 | 作用 | 关键坑 |
|---|---|---|
| `scripts/pack-share-extras.cjs` | 枚举 `skills/` 生成 `catalog.json` / `skills-manifest.json` / `INDEX.md` / `VERSION` | 必须在 `VERSION` 升版后运行；否则插入旧版本行 |
| `scripts/pack-share-docs.cjs` | 从本机 `~/.qoder/AGENTS.md` + `~/.qoder/rules/` 生成规则文档 | 断言首节逐字节一致 |
| `.github/check-release.js` | README 八项硬判据 | 8 条漂移：徽章 `version-X-Y-blue.svg`、英/中各一行版本、下载 URL 恰好 2 处、10 条计数行、4 条分层字符统计 |
| `.github/build-release.js` | 从 git 树构建发布目录 | 输出目录必须全新；脏工作树会误报 |
| `.github/verify-delivery.js` | 分发校验 | 传 `build.json` 路径 + 目录，不是只传目录 |
| `.github/run-tests.js` | 全量隔离回归 | 先装 office-docs 与 convention-runtime 的锁依赖 |

## 发布与补救

- 推 main 与 tag 后，`.github/workflows/release.yml` 触发；tag 与 main 两条 CI 都要 success。
- `publish` 报 `invalid remote release metadata` 时：
  `gh workflow run release.yml -f tag=vX.Y.Z`
  这是校验并完成既有 tag 的通道，**不要移动 tag**。
- 仓库外下载：`gh release download vX.Y.Z -R liushikuan63/Qoder-Optimization ...`。

## 隔离消费者探针的 Windows 坑

- 隔离 HOME 放 `D:/UserData/...`，不要放 `/tmp`（沙箱豁免会让探针失去隔离意义）。
- `npm ci --prefix` 经 `cmd.exe` 会保留字面引号并报 `EUSAGE`；用 `process.execPath` 直调 `npm-cli.js`，参数用数组。
- 5 字符短回复曾绕过 stop-gate 的 `noText<8` 门槛；消费者夹具必须覆盖短回复、空输出与失败路径。
- 解压 zip 后先对齐顶层目录再做 `diff -r`，否则整树误报。

## 历史证据

- 0.0.3：README 漂移 + 草稿回读竞态，两次红都不是环境问题。
- 0.0.6：脏工作树误报，改为先提交再 `build-release`。
- 0.0.8：主 zip 358 + offline 6 = 364；四资产逐字节一致。
- 0.0.10 / 0.0.11：隔离消费者探针抓到短回复缺陷；全量审查后按证据层级汇报。
