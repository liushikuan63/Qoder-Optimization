# 双客户端配置块同步（含凭据）

> 同一台机器上国际版与 CN 版各存一份 `settings.json`，provider 配置需要手动同步。通用判据见 SKILL.md。

## 安全顺序

1. **掩码盘点两侧**：逐 provider 导出 `baseUrl` / `protocol` / `models[].model` / `displayName` / `maxOutputTokens`；`apiKey` 只打印 `head(4-8)`、`len`、`sha256` 前 12 位，不打印明文。
2. 核对编码 / 缩进 / 行尾：LS 的 `settings.json` 可能是无尾换行、2 空格、LF；不要做 JSON 往返重写。
3. `backup-file.js` 备份两侧目标文件。
4. 落成一次性 `.cjs`：`--dry-run` 打印将写入的键，`--apply` 才写；同 id 冲突不覆盖，只用源侧新增/更新的字段做深拷贝合并。
5. 复扫：逐字段一致、其余顶层键完好、mtime 未被运行中进程回写。
6. 端到端凭据探针：真 Key 200 / 不存在端点 404 / 篡改 Key 401（三者缺一不可）。
7. 到目标客户端的安装包（`app.asar` / unpacked worker）grep 特征串，证明该 schema / 功能确实存在，不是只写了一堆没人读的键。
8. 检查依赖的本地代理是否在监听（常不自启）；最后声明“界面态需重启才可见”，不假装已做视觉验证。

## 边界

- 不把明文 Key 写入日志、汇报或临时文件。
- 运行中的客户端可能回写配置；写前确认 mtime 与进程状态，写后复扫。
- 两个客户端字段名/嵌套层级可能不同；先读各自的 schema，不要直接复制整块。
