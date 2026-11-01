# Qoder-Optimization 包专用细节

> 只放本仓库的路径、脚本名与门禁清单；通用顺序见 SKILL.md。

## 仓库与产物

- 仓库：`D:\Java\GitHub\Qoder-Optimization`（默认分支 `main`，发布 tag `vX.Y.Z`）。
- 正式 ZIP 顶层 = `Qoder-Optimization-X.Y.Z`（无空格）；`VERSION` 第一行 `vX.Y.Z`、第二行 `YYYY-MM-DD`。
- 主 zip 与离线 zip 各带 `.sha256`，共 4 个 Release 资产。
- 主 ZIP 不含 `mcp/offline/`，该目录只随离线包；两包成员无遗漏、无交集，数量以本次 `build.json` 为准，历史版本计数不能套用。

## 生成与门禁脚本

| 脚本 | 作用 | 关键坑 |
|---|---|---|
| `scripts/pack-share-extras.cjs` | 从公开仓库生成目录、清单、版本、安装文档与工具归档，不读取 HOME | 用 `--version X.Y.Z --date YYYY-MM-DD` 先预演、备份再 `--apply`；不要先手改 VERSION，否则生成器不能识别升版并插入新下载行；用 `--check` 验零漂移 |
| `scripts/pack-share-docs.cjs` | 按专门授权从本机配置导出规则文档的旧工具 | 不是公开源发布门禁；普通发布不运行，避免把私有配置导入仓库或覆盖公开仓库已审定的规则正文 |
| `.github/check-release.js` | 版本、公开文件、目录/依赖、工具归档及中英文文档一致性门禁 | 检查的是本次公开文件集；包/提交导出副本中运行，避免把工作目录的未纳管备份当发行成员 |
| `.github/build-release.js` | 从指定不可变 Git 提交构建发布目录 | 输出目录必须全新且在仓库外；只导出已提交批准文件，未提交内容不会入包，先冻结要发布的提交 |
| `.github/verify-delivery.js` | 分发校验 | 传 `build.json` 路径 + 目录，不是只传目录 |
| `.github/run-tests.js` | 全量隔离回归 | 先装 office-docs 与 convention-runtime 的锁依赖 |

维护入口：`node scripts/pack-share-extras.cjs . --version X.Y.Z --date YYYY-MM-DD` 预演，核对范围并备份后加 `--apply`，随后 `node scripts/pack-share-extras.cjs . --check`。规则文档正文由仓库维护，元数据同步只更新版本和统计，不重建这些已审定正文。

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
