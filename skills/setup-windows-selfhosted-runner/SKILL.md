---
name: setup-windows-selfhosted-runner
description: "在 Windows 上安装、注册、验证并持久化 GitHub Actions 自托管 runner 的完整链与九类实测坑避坑顺序。用于要装 self-hosted runner、把门禁挪到本机跑以省 GitHub Free 的 2000 分钟/月、job 在含空格的 runner 目录下秒红（/usr/bin/bash 报 D:\\Program 无此文件）、runner 随会话结束即停或开机弹常驻终端、硬杀 listener 后报 A session for this runner already exists。"
---

# Windows 自托管 GitHub Actions Runner

## 目的与边界

把一台 Windows 机器变成 GitHub Actions 的执行者：**跑通、验真、重启后还在**。四步之外都是别人的格子（见 description 的指针），不要在这里复述。

适用：私有仓库、账户级配额被计费闸门挡住但仍要 CI 真读数；或本来就需要本机能力（本地服务、真机、内网依赖）的 job。
不适用：需要 `jobs.<id>.services:` 的服务端全量测试——**自托管 runner 不支持 `services:`**，那是托管 runner 专有；需要"必然是一次全新检出"这个性质的门禁也不能迁过来（本机环境是既成事实的一部分，会掩盖行尾/大小写/路径分隔符类缺陷）。

**动手前必须知道的两件事**：注册与注销 runner 是**账户级、对外可见**的动作，推送 workflow 也是——先取得用户确认再执行；CI 从此依赖这台机器的开机状态。

## 开工前两条硬判据（都能失败）

```bash
# 判据 1：落点路径不含空格。含空格必须停下来换目录，不许先装再修。
# 负例可实跑（判据不是纸面话）：RUNNER_DIR='D:\Program Files\actions-runner' bash -c '…本段…' ⇒ 必须 BLOCK 且 rc=1
RUNNER_DIR="${RUNNER_DIR:-D:\actions-runner\<repo>}"
case "$RUNNER_DIR" in *[[:space:]]*) echo "BLOCK(路径含空格) :: $RUNNER_DIR"; exit 1;; *) echo "PASS :: $RUNNER_DIR";; esac

# 判据 2：这台仓库是否已有 runner（有就先决定复用还是注销，别堆同名）
gh api repos/<owner>/<repo>/actions/runners --jq '"total=\(.total_count)", (.runners[] | "\(.name) :: \(.status) labels=\(.labels|map(.name)|join(","))")'
```

**为什么路径空格是第一判据而不是踩完再修**：Actions 把临时脚本路径**不加引号**拼进 bash 命令行，而临时脚本就落在 runner 的工作目录下 ⇒ 路径在第一个空格处被切断。实测报错只有孤零零一行，看不出是环境问题：

```
shell: D:\software\Git\usr\bin\bash.EXE --noprofile --norc -e -o pipefail {0}
/usr/bin/bash: D:\Program: No such file or directory
##[error]Process completed with exit code 1.
```

`--work` 只接受**相对路径**（仍在 runner 根之下），绕不开 ⇒ 唯一解是把 runner 本体放进无空格目录。**这与「软件一律不装 C 盘 ⇒ 默认落 `D:\Program Files\...`」的既有约定直接冲突，actions-runner 属显式例外**，用 `D:\actions-runner\<repo>\` 这类路径。同类"路径含空格即坏"的工具（Node 生态里不少 spawn 实现）装前先想这一条。

## 步骤 1 取包（版本动态取，别硬编码）

```bash
gh api repos/actions/runner/releases/latest --jq '.tag_name'
gh api repos/actions/runner/releases/latest \
  --jq '.assets[] | select(.name|startswith("actions-runner-win-x64")) | .browser_download_url'
```

下载目标放**非系统盘**，安装包也不落 C。优先让系统信任加速器证书或直接走可验证的官方下载。默认保持完整 TLS 校验；若加速器证书链导致吊销检查失败，可单独加 `--ssl-no-revoke`（仍校验证书链）。**不要用 `-k`**；确需关闭校验证书时必须先取得用户明确批准，并在下载后核对官方 SHA256 与来源。

```bash
curl -L -sS -o /d/tmp/actions-runner-win-x64.zip "<browser_download_url>" \
  -w "HTTP=%{http_code} size=%{size_download}\n"
```

## 步骤 2 解压到无空格目录

PowerShell 的 `Expand-Archive` 最稳。**落成 payload `.ps1` 再用 `-File` 跑**——inline `-Command "…$d…"` 从 Git Bash 传过去时 `$d` 会被 bash 先展开成空串，PowerShell 收到 `= 'D:\…'` 直接报 `无法将=识别为 cmdlet`（2026-10-07 本机实测）。heredoc 必须用**单引号形式** `<<'PS1'`，否则转义在同一行上再咬一层。

```bash
cat > /d/tmp/extract-runner.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'
$d = 'D:\actions-runner\<repo>'
New-Item -ItemType Directory -Force -Path $d | Out-Null
Expand-Archive -Path 'D:\tmp\actions-runner-win-x64.zip' -DestinationPath $d -Force
Write-Output ('files=' + (Get-ChildItem $d -File | Measure-Object).Count)
PS1
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\tmp\extract-runner.ps1'
```

判据：目录里能看到 `run.cmd`、`config.cmd`、`bin\`，且 `files=` 是实数不是 0（拿不到数字就是没解成，别往下走）。

## 步骤 3 注册（token 只进变量，日志就地脱敏）

registration token **有效期 1 小时，每次重取**；它一旦进过日志文件，就地 `sed` 脱敏，且绝不写进汇报、记忆或提交。

```bash
cd /d/actions-runner/<repo> || exit 1
TOKEN=$(gh api repos/<owner>/<repo>/actions/runners/registration-token -X POST --jq .token 2>/dev/null)
[ -z "$TOKEN" ] && { echo "取 registration token 失败"; exit 1; }
echo "token_len=${#TOKEN}"                      # 只印长度，不印内容
cmd //c "config.cmd --url https://github.com/<owner>/<repo> --token $TOKEN --name <repo>-win-self --labels <repo>-self --work _work" > /d/tmp/runner-config.log 2>&1; rc=$?
sed -i "s/$TOKEN/<REDACTED>/g" /d/tmp/runner-config.log
echo "config_rc=$rc"; tail -12 /d/tmp/runner-config.log
gh api repos/<owner>/<repo>/actions/runners --jq '"runners=\(.total_count)", (.runners[] | "\(.name) :: \(.status)")'
```

- Git Bash 里调 cmd 批处理写 `cmd //c`（双斜杠，单斜杠会被当路径）。
- 名字与 label 都要带仓库标识：`runs-on` 用**数组** `[self-hosted, <repo>-self]`，只写 `self-hosted` 会让别的仓库的 job 误派到这台机器。

## 步骤 4 起 listener

`cmd //c run.cmd` 是**前台常驻**，会话一停就死——这是"跑通"与"一直可用"的分界，步骤 7 才补上持久化。

```bash
cd /d/actions-runner/<repo> && cmd //c run.cmd > /d/tmp/runner-listen.log 2>&1   # 后台跑，收尾用步骤 7 的自启
sleep 20; gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | "\(.name) :: \(.status) busy=\(.busy)"'
```

在线判据是 `status=online`；运行态核对进程与日志：

```bash
powershell -NoProfile -Command "Get-Process | Where-Object { \$_.ProcessName -like 'Runner.*' } | Select-Object -ExpandProperty ProcessName"
tail -4 "$(ls -t /d/actions-runner/<repo>/_diag/Runner_*.log | head -1)"
```

## 步骤 5 车道 workflow

新写一份（**不替代**原托管 workflow，托管车道仍是权威门禁），要点：

```yaml
name: gates-selfhosted
on: {push: {branches: [<default>]}, pull_request:, workflow_dispatch:}
concurrency: {group: selfhosted-${{ github.ref }}, cancel-in-progress: true}
jobs:
  static-gates:
    runs-on: [self-hosted, <repo>-self]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4          # 版本写死在文件里
        with: {node-version: '20'}
      - run: bash scripts/check.sh
```

- **不要复用本机已有的 node/工具绝对路径**（如 `D:\Java\nodejs\node20.13.0`）：那会让 workflow 依赖"这台机器恰好装在那儿"，换机即静默漂移。
- **自托管的 `_work` 跨 run 复用，且 `actions/checkout` 默认浅克隆**（本机实测 `_work/<repo>/<repo>/.git/shallow` 存在、`git rev-list --count HEAD` = **1**，同仓库完整克隆是 1135）⇒ 凡用 `git log --since` / 提交窗口 / "最近 N 笔"的门，在这里会**安静地给出看着合理但错的读数**。要么显式 `fetch-depth: 0`，要么把历史类统计留给托管车道，别让它冒充绿。
- 先在本地用**车道里同一个版本**跑一遍门脚本再推——本机默认 node 与车道装的版本不同，末段可能一红一绿（实测默认高版本会让客户端门判红，显式装 20 才绿）。

## 步骤 6 验收（判据要能失败）

```bash
# 只重跑失败 job，自托管不占托管分钟
gh run rerun <run_id> -R <owner>/<repo> --failed
# 或手动触发车道
gh workflow run gates-selfhosted -R <owner>/<repo> -r <default-branch>
sleep 40
rid=$(gh api "repos/<owner>/<repo>/actions/runs?per_page=3" --jq '.workflow_runs[] | select(.name=="gates-selfhosted" and .event=="workflow_dispatch") | .id' | head -1)
gh run view "$rid" -R <owner>/<repo> --json status,conclusion,jobs \
  --jq '"run: \(.status)/\(.conclusion // "-")", (.jobs[] | " [\(.name)] \(.status)/\(.conclusion // "-") steps=\(.steps | length)")'
```

读数的三条硬口径：

1. **步骤数 > 0 且逐步有耗时**才算真跑；`attempt=2 全绿`是重跑后的终态，比首跑红更能证明车道成立。
2. **runner 掉线（关机 / 休眠）时 job 会一直排队到超时** —— 那是"**没验**"，既不能读成"通过"，也不能读成"代码红"。
3. 首跑必有红（车道第一次跑就会暴露本机与镜像的差异）。逐步定位用 `--json jobs` 里的 `steps`，红因见坑表；**红在那一步≠代码缺陷**，先核环境判据（路径、node 版本、缓存目录）。

## 步骤 7 持久化自启（免管理员）

`Register-ScheduledTask -AtLogOn` 在非管理员 PowerShell 下 **PermissionDenied 0x80070005** ⇒ 走 **Startup 文件夹快捷方式**（免提权、一条命令可回退）。外层再套 **wscript 壳**：Windows Terminal 被设为默认终端时会无视 `-WindowStyle Hidden`，开机弹一个常驻终端窗口（同类现象见记忆 `reference-autostart-console-popups`）。

`D:\actions-runner\<repo>\run-hidden.vbs`：

```vb
' 用 wscript 起 runner：窗口完全隐藏。runner 自己的日志不依赖这里的重定向，它写在 _diag\Runner_*.log。
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\actions-runner\<repo>"
sh.Run """D:\actions-runner\<repo>\run.cmd""", 0, False
Set sh = Nothing
```

`D:\actions-runner\<repo>\register-autostart.ps1`（**留在 runner 目录里**，别放临时目录，方便下次重建）：

```powershell
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'GitHub-Actions-Runner-<repo>.lnk'
if (Test-Path $lnkPath) { Write-Output "already_exists=$lnkPath" } else {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = 'D:\actions-runner\<repo>\run-hidden.vbs'
  $lnk.WorkingDirectory = 'D:\actions-runner\<repo>'
  $lnk.Description = 'Start self-hosted GitHub Actions runner for <owner>/<repo> at logon. Remove this shortcut to disable.'
  $lnk.Save()
  Write-Output "created=$lnkPath"
}
Write-Output ("target_lnk_size_bytes={0}" -f (Get-Item $lnkPath).Length)
$sh = New-Object -ComObject Shell.Application
Write-Output ("resolves_to={0}" -f $sh.NameSpace((Split-Path $lnkPath)).ParseName((Split-Path $lnkPath -Leaf)).LinkTarget)
```

验收必须**走与开机同一条路径**（直接 `start wscript.exe <vbs>`），而不是再手敲一次 `run.cmd`：

```bash
cmd //c start wscript.exe "D:\\actions-runner\\<repo>\\run-hidden.vbs"
sleep 25
powershell -NoProfile -Command "Get-Process | Where-Object { \$_.ProcessName -like 'Runner.*' } | Select-Object -ExpandProperty ProcessName"
gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | "\(.name) :: \(.status) busy=\(.busy)"'
```

真跑过一遍后，把 `register-autostart.ps1` 的实际路径与 `.lnk` 文件名记进项目接续文档——重启后是否自启**只有重启才能证**，未重启就标"未验证 + 原因"。

## 坑判读表

| 现象 | 根因 | 正确做法 |
|---|---|---|
| 某步秒红，只有一行 `/usr/bin/bash: D:\Program: No such file or directory` | 临时脚本路径含空格且未被引用 | 换无空格目录重装（见下条），**不要**试着用 `--work` 绕 |
| 换目录后需要重来 | `.runner` / `.credentials` 里存的是旧绝对路径 | 注销旧注册 `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>` → `rm -f .runner .credentials` → 重取 token → 重新 `config.cmd` |
| 硬杀 `run.cmd` 后新 listener 打 `A session for this runner already exists`，每 30 秒重试 | 服务端旧 session 还没过期（约 1~2 分钟） | **等它过期即恢复，不是注册坏了，别重装 runner**（这条被误判过一次，白重装一趟） |
| `Register-ScheduledTask` 报 `0x80070005` | 非管理员 | 用 Startup 快捷方式（步骤 7） |
| 开机弹常驻终端窗口 | WT 作默认终端时无视 `-WindowStyle Hidden` | 套 wscript 壳，`sh.Run(..., 0, False)` |
| 车道里客户端门红、本地不红 | 本机默认运行时版本与车道不同 | 车道显式 `setup-node` 装版本；本地用同版本复跑取决定性证据再判 |
| 从 Git Bash 传 `powershell -Command "…$d…"` 后 PowerShell 报 `无法将=识别为 cmdlet` | bash 先把 `$d` 展开成空串，等号左边没了（与嵌套引号、与编码都无关） | 走 `<<'PS1'` heredoc + `-File`；非要用 inline 就把每个 `$` 写成 `\$` |
| 需要 Mongo 等 `services:` 的测试迁不过来 | 自托管不支持 `services:` | 这类门禁留在托管车道，配额解冻后再取数；如实写明"未覆盖" |
| 历史窗口类门（`git log --since` / 最近 N 笔）在自托管上给出与本地完全不同的数 | `_work` 跨 run 复用 + 默认浅克隆（实测 `rev-list --count HEAD` = 1） | `actions/checkout` 加 `fetch-depth: 0`，或把这类门留给托管车道；**别把残缺历史当"这个仓库就一笔提交"** |

## 回退（都是可逆的，逐条点名）

```bash
# 1) 关自启（只删那个 .lnk，不碰别的东西）
rm "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/GitHub-Actions-Runner-<repo>.lnk"
# 2) 注销注册（对外可见，先确认）
gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | "\(.id) \(.name)"'
gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>
# 3) 停进程 + 删目录；车道 workflow 文件回滚 = 恢复推送前的备份
# 先按安装目录锁定 Runner.Listener 的 PID，核对命令行后再停；禁止按 Runner.* 名称批量强杀。
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='Runner.Listener.exe'\" | Where-Object { \$_.ExecutablePath -like '<安装目录>*' } | Select-Object ProcessId,ExecutablePath"
```

推送 / 注册前先备份被改的 workflow（`cp .github/workflows/ci.yml /d/tmp/ci.yml.bak-<ts>`）——本链路的每一步都能单独回退，**唯一不可逆的是已消耗的托管分钟**（那条本来就不该出现在这里，因为自托管不计费）。

## 收尾

- 临时产物（下载的 zip、`runner-config.log`、`runner-listen.log`、一次性 `.ps1`）按推荐直接清理；**`register-autostart.ps1` 是可复用助手，移进 runner 目录留用，不要一起删**。
- 汇报里凭据一律不落原文：token 只报长度或 `<REDACTED>`。
