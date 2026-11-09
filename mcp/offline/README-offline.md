# 离线包说明

| 文件 | 说明 |
|---|---|
| `cua-driver-rs-0.44.0-windows-x86_64.zip` | 官方 release 资产（Windows x86_64），MIT 许可，许可见 `LICENSE-cua-driver.txt` |
| `cua-driver-rs-0.44.0-windows-x86_64.zip.sigstore.json` | 官方 Sigstore sidecar（包内同时按 SHA256SUMS 校验） |
| `SHA256SUMS` | 官方资产校验和；`install-mcp.cmd` 选「离线」时会先校验再释放 |
| `bytebase-dbhub-1.2.5.tgz` | dbhub 的 npm 包本体；**依赖仍需联网解析**，完全离线请另带 npm 缓存 |

## 用法

双击 `install-mcp.cmd` → 在 cua-driver 菜单选 `1) 用包内离线版本`，并用 `--install-dir` 指定非系统盘目录。脚本会：

1. 校验 zip 的 SHA256；
2. 只在 Windows x64 上安装；安装目录必须在非系统盘本地路径，且为空或尚不存在；缺失或非法路径直接失败，不写配置；
3. 在目标目录同盘的暂存目录解压，确认存在 `cua-driver.exe` 且版本与包名一致后才复制到目标；
4. 实测 `cua-driver --version` 复核版本；
5. 询问是否设置开机自启（启动文件夹 VBS）；
6. 注册到 `~/.qoder/settings.json` 的 `mcpServers`（改前自动备份）。

任一校验或版本复核失败都会退出非零、清理暂存目录、保留原配置。

## 不含

- 任何凭据、连接串、机器标识。
- 其他平台的二进制（macOS/Linux 请联网安装）。
