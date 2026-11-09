---
name: desktop-update-push-triage
description: "Windows 客户端（electron-updater + NSIS）更新失败分层取证：读状态文件 lastError 与日志状态机，按 checking→downloading→installing 分段；下载失败查缓存目录符号链接/junction 拦截，安装失败走 NSIS 静默重装（/S，spawn 必 EACCES）；版本三处一致收口。触发词：收不到更新推送、更新不生效、自动更新失败、junction 更新、electron-updater、NSIS 静默重装；不用于：edge-net-check、disk-junction-migration。"
---

# 桌面客户端更新推送排查（通用）

## 适用边界

- **主战场**：Windows 上由 electron-updater / electron-builder 打包、NSIS 安装的客户端（Qoder、VS Code 系、大量国产 Electron 客户端）。
- **同构可套用**：Squirrel、MSIX、macOS Sparkle、Linux AppImage —— 前三步（三分类、阶段分诊、成功判据）不变，只是入口文件不同（见第 8 节）。
- **产品实例**：Qoder 国际版 / CN 版的路径、日志标签、当前状态见 [references/qoder-desktop.md](references/qoder-desktop.md)。

## 总原则

1. **客户端自证优先**：状态文件里的 `lastError` / 决策字段是权威原文，比日志 reason 码和任何网络猜测都可靠。
2. **先三分类，再按阶段分段**：不要一上来把网络 / 磁盘 / 权限 / 杀软重排一遍。
3. **每条判据都要能失败**：写清「什么样算修好」，并准备负对照。

## 1. 三分类：服务端没发 / 下载失败 / 安装失败

读状态文件与更新日志，先回答「到底卡在哪」：

| 分类 | 判据 | 处置 |
|---|---|---|
| 服务端无更新 / hold | 状态里是 no-update / hold 决策，无 `lastError` | **不是故障**，向用户说明；关注 `retryAfterSeconds` |
| 下载环节失败 | `lastError` 有原文，或 stage 停在 downloading | 第 4 节 |
| 安装环节失败 | 包已下载完、stage 到 installing 后报错或版本不变 | 第 5 节 |

## 2. 通用取证四件套

1. **数据目录**：`%APPDATA%\<产品数据目录>`（状态文件、日志）；有的产品用 `%LOCALAPPDATA%`。
2. **安装目录 `resources\`**：`app-update.yml`（`provider` / `url` / `updaterCacheDirName`）、`install-type.json`（system / user）、`product.json`（下载 base url、数据目录名）、`build-manifest.json`（实际版本、installerType）。
3. **更新缓存**：`%LOCALAPPDATA%\<updaterCacheDirName>` —— 下载产物在 `attempts\<uuid>\pending\` 或 `pending\`。
4. **日志**：`<数据目录>\logs\<会话>\main.log`，按产品自己的标签过滤（Qoder 是 `[DesktopUpdate]` 系列）。

> 数据目录本身可以是 junction（只读穿透没问题）；**禁止成链接的只有更新缓存目录**（第 4 节）。

## 3. 阶段分诊与反直觉判据

阶段链一般是 `idle/checking → available → downloading → installing`。

- **亚秒失败（几百 ms）＝本地前置校验失败，还没上网**。看 `pending` 是否零字节；是则与网络 / CDN / 代理 / TLS 全无关。
- **拿到 available 但从不进 downloading**：下发被 hold，或下载前置检查失败。
- **下载中途慢 / 断**：才轮到网络层（第 6 节）。
- **installing 后失败 / 版本不变**：安装环节（第 5 节）。
- **跨会话计数**：统计全部历史日志里的 download-started / failed / completed，判断「从未成功过」还是「最近才坏」——0 次 completed 而多次 failed ⇒ 问题从来就在。

## 4. 下载失败：更新缓存目录不能是符号链接

electron-updater 系客户端在较新版本会把「缓存目录不许是符号链接 / junction」做成**硬校验**（每次发版都在下载开始时秒失败）。提权启动、改用另一安装类型都绕不过。

判定（Windows）：

```powershell
$cache = "$env:LOCALAPPDATA\<updaterCacheDirName>"
$i = Get-Item $cache -Force -ErrorAction SilentlyContinue
if ($i) { "{0} | LinkType={1} | Target={2}" -f $cache,$i.LinkType,($i.Target -join ',') }
# 交叉验证：必须用 PowerShell 包一层，Git Bash 直接跑 fsutil 会被 MSYS 路径转换弄坏
powershell -NoProfile -Command "fsutil reparsepoint query `"$cache`""
```

修复（**只摘链接，禁 `rm -rf`——会穿透删真源**）：

```cmd
cmd /c rmdir "%LOCALAPPDATA%\<updaterCacheDirName>"
mkdir "%LOCALAPPDATA%\<updaterCacheDirName>"
```

复验两条都要做：① 往新目录写标记文件，确认它**不出现**在旧真源；② 对相邻的正常目录做链接查询作**负对照**，确认没误碰。旧的真源目录原地保留当回滚（回滚＝`mklink /J` 指回去，但指回去更新会再次失败）。

其余下载侧排查：磁盘水位、缓存目录可写性、旧包是否被占用（`fs.openSync(p,'r+')` 只开不写探测）。

## 5. 安装失败：NSIS 静默重装 + 三处一致

安装器报「多个旧安装记录 / 无法安全完成此次更新」时，**先信官方文案**（例如明确说"不要改用 User 安装包"就别改），用已校验的安装包静默重装：

```powershell
powershell -NoProfile -Command "Start-Process -FilePath '<安装包>' -ArgumentList '/S' -Wait -PassThru"
```

- **只用 `/S`，不要加 `/D=`**：路径含空格会破坏 NSIS 解析；安装目录由注册表原路径自动解析。
- **别用 Node `spawn` / `execFile`**：走 CreateProcess 不带提权提升，对 system 包一律 `EACCES`，**复制到别的目录照样 EACCES**（拦的是文件不是路径）。只有 ShellExecute（`Start-Process`）能过。
- **别乱动安装器自己留下的恢复目录**：先证明它是原因再动手，实测常有"看起来像元凶、其实无关"的目录。

收口判据（三处一致才算装好）：

```powershell
(Get-Item '<安装目录>\<主程序>.exe').VersionInfo.FileVersion
Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*, `
  HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '<产品名>*' } | Select-Object DisplayName,DisplayVersion
Get-Content '<安装目录>\resources\build-manifest.json' -Raw
```

## 6. 只有真的进了 downloading 才查网络

1. **先证实服务端已发版**：日志里的更新检查 / assignment 请求应有返回（版本号、assignmentId）；按 `channel` + `installType` 取对应清单：**system → `latest-system.yml`，user → `latest.yml`**（文件名与包都不同，别拿 user 清单判断 system 安装）。
2. **别用 navigate 打开 `.yml`**：会触发下载而非导航，返回 `ERR_FAILED` 是**假信号**。验可达性用 `fetch(url, {mode:'no-cors'})`；自动化浏览器的网络栈与客户端不同，只能作参考。
3. 逐层排除：磁盘、`hosts` / `PAC` / `ProxyEnable`、代理残留。
4. 别把「启动器 / 手工事务安装」的记录当成自动更新成功过（两条链路）。

## 7. 成功判据（可失败）

- 状态文件的 `lastError` 清空、`stage` 前进到 `downloading`。
- `pending` 下的临时包**字节持续增长**到清单里的 `size`；日志里的 download progress 与之双源一致。
- 装完版本三处一致（第 5 节）。
- 等下一轮后台自动检查（间隔以日志时间戳为准，别硬编码），而不是手动点「检查更新」冒充自动化通过。

## 8. 换一个客户端：入口定位法

1. **找数据目录**：`Get-ChildItem $env:APPDATA,$env:LOCALAPPDATA | Where-Object Name -match '<产品名>'`
2. **找日志**：在数据目录下按修改时间找最新 `.log`，`Select-String -Pattern 'update|updat'` 找状态机标签。
3. **找更新配置**：`Get-ChildItem '<安装目录>\resources' | Where-Object Name -match 'update|manifest|install-type|product'`。
4. **找缓存**：`app-update.yml` 的 `updaterCacheDirName` → `%LOCALAPPDATA%\<该名>`。
5. **找版本真源**：build-manifest / exe FileVersion / 注册表 Uninstall DisplayVersion。

其他框架：**Squirrel**（`%LOCALAPPDATA%\<App>\packages\` + `app-<version>` 目录）、**MSIX/AppX**（AppXManifest.xml + 系统更新）、**macOS Sparkle**（`~/Library/Application Support/<product>`）、**Linux AppImage**（`~/.config/<product>`）。

## 9. 已排除项（跨产品共通，别再重排）

提权启动、改装另一种安装类型、磁盘空间、缓存目录 ACL、文件句柄占用、hosts / 代理 / TLS、CDN 多解析 IP、明文 grep 打包产物（`app.asar` 等：新版本常已混淆/编译进快照，明文搜索是死路，还会吐出巨大二进制）。

## 10. 状态文件权限 / ACL 失败

“下载看似完成、随后提示无法连接 / 更新失败”可能是本地状态持久化被拒，不是网络：

1. **先独立验证 CDN**：HTTP 码 + 字节数 + SHA-256；网络侧正常才继续。
2. **读应用日志定位阶段**：`persist` 失败（如 error code 10）、`StartDownload` 失败（如 9），并看 `lastError` 原文里是否出现 `Permission denied ... download.json` 一类路径。
3. **检查状态文件 ACL / 占用**：文件属主、ACL、是否被进程持有；更新缓存目录不能是重解析点（第 4 节）。
4. **修复顺序**：记录 PID → 结束客户端 → 备份状态文件 → 提权 `icacls` 授权 → 重启 → 等下一轮自动检查，确认 `stage` 越过原失败阶段。
5. 复验用“stage 前进 + 版本三处一致”，不只看“点了检查更新没报错”。

CEF 窗口截图优先用 `capture-window.ps1`（按 Hwnd）；`PrintWindow` 对 CEF 可能失败。提权窗口的点击会被 UIPI 丢弃，见第 11 节。

## 11. 边界

- **High integrity 安装器窗口只能由用户手动关**：中等完整性进程的 CUA / 模拟点击会被 UIPI 静默丢弃（返回成功但不落地），`taskkill` 亦「拒绝访问」。
- **迁移工具纪律**：任何把 `*-updater` 缓存目录做成 junction 的迁移都会静默废掉自动更新；迁移工具必须把更新缓存当「永不迁移 + 发现链接就回退」。

## 相关

- 产品实例（Qoder 国际版 / CN）：[references/qoder-desktop.md](references/qoder-desktop.md)
- 迁移与六档处置：`disk-junction-migration`
- 用户浏览器打不开网页：`edge-net-check`
