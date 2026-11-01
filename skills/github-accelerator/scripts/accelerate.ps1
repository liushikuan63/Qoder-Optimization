# ============================================================
# github-accelerator v1.4.0 —— 诊断驱动的小白 GitHub 加速器 (Windows)
# [BETA] 本脚本按 Windows 标准方案编写，尚未经真机验证，请内测后再定版
#
# 用法（由 AI Agent 按引导调用，不建议小白手动操作）:
#   powershell -ExecutionPolicy Bypass -File accelerate.ps1 check     # 只诊断（无需管理员）
#   powershell -ExecutionPolicy Bypass -File accelerate.ps1 apply     # 诊断+修复（自动弹 UAC）
#   powershell -ExecutionPolicy Bypass -File accelerate.ps1 rollback  # 回滚
#   powershell -ExecutionPolicy Bypass -File accelerate.ps1 status    # 查看状态
#   powershell -ExecutionPolicy Bypass -File accelerate.ps1 watt      # 一键下载安装 Watt Toolkit（需先征得用户同意）
#
# 纯 PowerShell 零外部依赖（Windows 10+ 自带 curl.exe，缺失时自动降级 Invoke-WebRequest）
# ============================================================

param(
    [Parameter(Position = 0)]
    [ValidateSet('check', 'apply', 'rollback', 'status', 'watt')]
    [string]$Cmd = 'check'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Version = '1.4.0'
$MarkStart = '# GitHub-Accelerator Start'
$MarkEnd = '# GitHub-Accelerator End'
$MarkSshStart = '# GitHub-Accelerator SSH Start'
$MarkSshEnd = '# GitHub-Accelerator SSH End'
$SysRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$HostsPath = if ($env:SystemRoot) { Join-Path $SysRoot 'System32\drivers\etc\hosts' } else { '/etc/hosts' }
# 测试钩子: 可重定向 ssh config 路径
$SshCfg = if ($env:SSH_CONFIG_FILE) { $env:SSH_CONFIG_FILE } else { Join-Path $env:USERPROFILE '.ssh\config' }
$BackupKeep = 3
$UA = "Mozilla/5.0 (compatible; GitHub-Accelerator/$Version)"
$TimeoutSec = 6

# 需要修复的域名清单
$Domains = @(
    'github.com', 'api.github.com', 'codeload.github.com', 'gist.github.com',
    'raw.githubusercontent.com', 'gist.githubusercontent.com', 'objects.githubusercontent.com',
    'avatars.githubusercontent.com', 'camo.githubusercontent.com', 'user-images.githubusercontent.com',
    'cloud.githubusercontent.com', 'desktop.githubusercontent.com'
)
$FastlyPool = @('185.199.108.133', '185.199.109.133', '185.199.110.133', '185.199.111.133')
# v1.4.1 同组边缘分组: 下列域名由同一批边缘节点服务（同 IP 池，靠 SNI 区分站点）。
# 某域名自身候选全灭时，复用同组其他域名"已实测通过"的 IP（复用前仍需对该域名实测通过才写入）。
$GhEdge = @('github.com', 'api.github.com', 'codeload.github.com', 'gist.github.com', 'ssh.github.com')
$FastlyEdge = @('raw.githubusercontent.com', 'gist.githubusercontent.com', 'objects.githubusercontent.com',
    'avatars.githubusercontent.com', 'camo.githubusercontent.com', 'user-images.githubusercontent.com',
    'cloud.githubusercontent.com', 'desktop.githubusercontent.com')
# 同组复用登记表: 只记录"自身候选命中"的 IP（域名 → IP 数组）
$script:PassedIps = @{}
$GhPool = @('140.82.112.3', '140.82.112.4', '140.82.113.3', '140.82.113.4', '140.82.114.3', '140.82.114.4',
    '140.82.116.3', '140.82.116.4', '140.82.121.3', '140.82.121.4', '140.82.122.3', '140.82.122.4',
    '20.205.243.166', '20.205.243.168', '20.27.177.113', '20.200.245.247')
$Mirrors = @('https://ghfast.top', 'https://gh-proxy.com', 'https://ghproxy.net', 'https://ghproxy.cc',
    'https://github.moeyy.xyz', 'https://ghps.cc')
$MirrorTestPath = '/https://raw.githubusercontent.com/521xueweihan/GitHub520/main/hosts'
$DohServers = @('https://223.5.5.5/resolve', 'https://1.12.12.12/resolve')

# 沙箱代理检测（v1.1.2）: WorkBuddy 等 Agent 的沙箱会注入 127.0.0.1 本地代理，
# git/curl 默认服从该代理，可能导致"hosts 修好了但沙箱里 Agent 的 git 仍不通"
$SandboxProxy = $null
foreach ($pname in @('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')) {
    $pv = [Environment]::GetEnvironmentVariable($pname)
    if ($pv -match '^http://(127\.0\.0\.1|localhost):\d+$') { $SandboxProxy = $pv; break }
}

function Write-Hr { Write-Host ('-' * 60) }

function Test-HttpOk {
    param([string]$Url, [string]$Resolve = $null, [int]$Sec = $TimeoutSec)
    # 优先系统 curl（Windows: System32\curl.exe；macOS/Linux: PATH 中的 curl），否则降级 IWR
    $curlExe = $null
    if ($env:SystemRoot -and (Test-Path (Join-Path $env:SystemRoot 'System32\curl.exe'))) {
        $curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
    }
    elseif (Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue) { $curlExe = 'curl.exe' }
    if ($curlExe) {
        $devNull = if ($env:SystemRoot) { 'NUL' } else { '/dev/null' }
        $args2 = @('--noproxy', '*', '-s', '-A', $UA, '-m', $Sec, '-o', $devNull, '-w', '%{http_code}')
        if ($Resolve) { $args2 += @('--resolve', $Resolve) }
        $args2 += $Url
        $code = & $curlExe @args2 2>$null
        return ($code -and $code -ne '000' -and $code -match '^[234]')
    }
    else {
        try {
            $prev = [System.Net.WebRequest]::DefaultWebProxy
            [System.Net.WebRequest]::DefaultWebProxy = $null
            $resp = Invoke-WebRequest -Uri $Url -TimeoutSec $Sec -UseBasicParsing -DisableKeepAlive -UserAgent $UA -ErrorAction Stop
            [System.Net.WebRequest]::DefaultWebProxy = $prev
            return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
        }
        catch {
            [System.Net.WebRequest]::DefaultWebProxy = $prev
            if ($_.Exception.Response) {
                $sc = [int]$_.Exception.Response.StatusCode
                return ($sc -ge 200 -and $sc -lt 500)
            }
            return $false
        }
    }
}

function Test-DomainOk { param([string]$Domain) Test-HttpOk -Url "https://$Domain/" }

# 经指定代理测试（模拟 Agent 沙箱默认路径）
function Test-HttpOkVia {
    param([string]$Url, [string]$Proxy, [int]$Sec = $TimeoutSec)
    $curlExe = $null
    if ($env:SystemRoot -and (Test-Path (Join-Path $env:SystemRoot 'System32\curl.exe'))) {
        $curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
    }
    elseif (Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue) { $curlExe = 'curl.exe' }
    if ($curlExe) {
        $devNull = if ($env:SystemRoot) { 'NUL' } else { '/dev/null' }
        $code = & $curlExe -s -x $Proxy -A $UA -m $Sec -o $devNull -w '%{http_code}' $Url 2>$null
        return ($code -and $code -ne '000' -and $code -match '^[234]')
    }
    else {
        try {
            $resp = Invoke-WebRequest -Uri $Url -Proxy $Proxy -TimeoutSec $Sec -UseBasicParsing -DisableKeepAlive -UserAgent $UA -ErrorAction Stop
            return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
        }
        catch {
            if ($_.Exception.Response) {
                $sc = [int]$_.Exception.Response.StatusCode
                return ($sc -ge 200 -and $sc -lt 500)
            }
            return $false
        }
    }
}

function Test-IpOk {
    param([string]$Domain, [string]$Ip)
    Test-HttpOk -Url "https://$Domain/" -Resolve "$Domain`:443:$Ip"
}

function Test-TcpPort {
    param([string]$Host2, [int]$Port)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($Host2, $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(5000, $false) -and $client.Connected) { $client.Close(); return $true }
        $client.Close(); return $false
    }
    catch { return $false }
}

# SSH 认证状态（v1.3.0）: 'authed'=已认证可用 / 'nokey'=通道可达但无有效密钥 / 'dead'=通道不通
# GitHub 连公开仓库的 SSH 克隆也要认证，所以"通道活着"不等于"能用"
function Test-SshAuth {
    $ssh = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $ssh) { $ssh = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue }
    if (-not $ssh) { return 'dead' }
    $out = ''
    try {
        if (Test-TcpPort -Host2 'github.com' -Port 22) {
            $out = (& ssh -T -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=6 git@github.com 2>&1 | Out-String)
        }
        elseif (Test-TcpPort -Host2 'ssh.github.com' -Port 443) {
            $out = (& ssh -T -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=6 -p 443 git@ssh.github.com 2>&1 | Out-String)
        }
        else { return 'dead' }
    }
    catch { return 'dead' }
    if ($out -match 'successfully authenticated' -or $out -match '\bHi ') { return 'authed' }
    if ($out -match 'Permission denied') { return 'nokey' }
    return 'dead'
}

# 写 ~/.ssh/config 标记块（幂等合并，不动用户其他内容）
function Write-SshConfigBlock {
    param([bool]$Use443)
    $sshDir = Split-Path $SshCfg -Parent
    if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }
    $content = ''
    if (Test-Path $SshCfg) {
        $content = Get-Content -Path $SshCfg -Raw -ErrorAction SilentlyContinue
        if ($null -eq $content) { $content = '' }
        if ($content -notmatch [regex]::Escape($MarkSshStart)) {
            Copy-Item -Path $SshCfg -Destination "$SshCfg.ghacc.bak" -Force -ErrorAction SilentlyContinue
        }
        $pattern = "(?ms)\r?\n?" + [regex]::Escape($MarkSshStart) + '.*?' + [regex]::Escape($MarkSshEnd) + "\r?\n?"
        $content = [regex]::Replace($content, $pattern, "`n")
    }
    $block = @($MarkSshStart, "# Managed by github-accelerator v$Version. Re-running apply updates this block.", 'Host github.com', '  User git')
    if ($Use443) { $block += @('  HostName ssh.github.com', '  Port 443') }
    $block += $MarkSshEnd
    $newContent = $content.TrimEnd() + "`r`n" + ($block -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($SshCfg, $newContent)
}

function Get-Candidates {
    param([string]$Domain)
    $ips = @()
    # 源1: GitHub520 国内直连源
    try {
        $txt = (Invoke-WebRequest -Uri 'https://raw.hellogithub.com/hosts' -TimeoutSec 10 -UseBasicParsing -UserAgent $UA -Proxy $null).Content
        $m = [regex]::Match($txt, "(?m)^([0-9a-fA-F.:]+)\s+$([regex]::Escape($Domain))\s")
        if ($m.Success) { $ips += $m.Groups[1].Value }
    }
    catch {}
    # 源2: DoH（阿里 / DNSPod，绕过本地 DNS 污染）
    foreach ($doh in $DohServers) {
        try {
            $j = Invoke-RestMethod -Uri "$doh`?name=$Domain&type=A" -TimeoutSec 6 -UserAgent $UA -Proxy $null
            foreach ($a in $j.Answer) { if ($a.data -match '^\d+\.\d+\.\d+\.\d+$' -and $ips -notcontains $a.data) { $ips += $a.data } }
        }
        catch {}
    }
    # 源3: 硬编码候选池
    if ($Domain -like '*githubusercontent.com' -or $Domain -like '*.github.io') { $pool = $FastlyPool } else { $pool = $GhPool }
    foreach ($ip in $pool) { if ($ips -notcontains $ip) { $ips += $ip } }
    return $ips
}

# 收集某域名最多 $Max 个实测可用 IP（多 IP 冗余 + v1.4.1 同组复用兜底，抗线路抖动）
function Find-Ips {
    param([string]$Domain, [int]$Max = 3)
    $found = @()
    foreach ($ip in (Get-Candidates -Domain $Domain)) {
        if ($found.Count -ge $Max) { break }
        if (Test-IpOk -Domain $Domain -Ip $ip) {
            $found += $ip
            if (-not $script:PassedIps[$Domain]) { $script:PassedIps[$Domain] = @() }
            $script:PassedIps[$Domain] += $ip   # 登记表只记"自身候选命中"
        }
    }
    if ($found.Count -eq 0) {
        # v1.4.1 同组边缘复用: 自身候选全灭时，尝试同组兄弟域名登记过的 IP
        $grp = $null
        if ($GhEdge -contains $Domain) { $grp = $GhEdge }
        elseif ($FastlyEdge -contains $Domain) { $grp = $FastlyEdge }
        if ($grp) {
            foreach ($sib in $Domains) {
                if ($sib -eq $Domain -or $grp -notcontains $sib) { continue }
                foreach ($ip in $script:PassedIps[$sib]) {
                    if ($found.Count -ge $Max) { break }
                    if (Test-IpOk -Domain $Domain -Ip $ip) { $found += $ip }
                }
                if ($found.Count -ge $Max) { break }
            }
        }
    }
    return $found
}

# 为域名找到第一个实测可用 IP（返回 $null 表示全灭）
function Find-Ip {
    param([string]$Domain)
    $ips = @(Find-Ips -Domain $Domain -Max 1)
    if ($ips.Count -gt 0) { return $ips[0] }
    return $null
}

# 判断某域名的可用 IP 是否来自同组复用（找到 IP 但登记表为空）
function Test-IsReused {
    param([string]$Ip, [string]$Domain)
    if (-not $Ip) { return $false }
    return ($script:PassedIps[$Domain] -notcontains $Ip)
}

function Find-Mirror {
    foreach ($m in $Mirrors) {
        if (Test-HttpOk -Url "$m$MirrorTestPath" -Sec 10) { return $m }
    }
    return $null
}

function Get-IsAdmin {
    # 兼容 Windows PowerShell 5.1 / PowerShell 7 / 非Windows PS7(测试环境)
    try {
        if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
            return ((id -u) -eq 0)  # 非Windows: root 即管理员
        }
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Backup-Hosts {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$HostsPath.ghacc.bak.$ts"
    Copy-Item -Path $HostsPath -Destination $bak -Force
    Write-Host "已备份: $bak"
    Get-ChildItem "$HostsPath.ghacc.bak.*" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $BackupKeep | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ============ check ============
function Invoke-Check {
    Write-Host "GitHub-Accelerator v$Version —— 诊断报告（只读，未修改任何系统配置）"
    Write-Host ("时间: {0:yyyy-MM-dd HH:mm:ss}" -f (Get-Date))
    Write-Hr
    Write-Host '[1/4] 域名直连状态'
    $bad = @()
    foreach ($d in $Domains) {
        if (Test-DomainOk -Domain $d) { Write-Host ("  [OK] {0,-45} 直连正常" -f $d) }
        else { Write-Host ("  [X ] {0,-45} 直连失败" -f $d); $bad += $d }
    }
    Write-Hr
    # [1.5/4] Agent 沙箱环境双路检测（v1.1.2）
    if ($SandboxProxy) {
        Write-Host "[1.5/4] Agent 沙箱环境检测（检测到注入代理: $SandboxProxy）"
        if (Test-HttpOkVia -Url 'https://github.com/' -Proxy $SandboxProxy) {
            Write-Host '  [OK] 沙箱代理路径: github.com 可通 -> Agent 自己的 git/curl 可保留默认环境'
        }
        else {
            Write-Host '  [X ] 沙箱代理路径: github.com 不通（沙箱代理拦截 GitHub，Agent 默认路径会失败）'
            if (Test-DomainOk -Domain 'github.com') {
                Write-Host '  对策: Agent 自己的 git/curl 操作前先清除代理环境变量:'
                Write-Host '    $env:HTTP_PROXY=""; $env:HTTPS_PROXY=""; $env:http_proxy=""; $env:https_proxy=""'
                Write-Host '  若 git 报证书吊销检查失败(0x80092012)，追加: git -c http.schannelCheckRevoke=false clone ...'
            }
            else { Write-Host '  直连与代理路径均不通 -> 继续看下方 hosts/镜像修复' }
        }
        Write-Host '  注: hosts 修复对两条路径都生效（沙箱代理进程也使用本机系统解析）'
        Write-Hr
    }
    Write-Host '[2/4] SSH 通道'
    if (Test-TcpPort -Host2 'github.com' -Port 22) { Write-Host '  [OK] git@github.com:22 可通' } else { Write-Host '  [X ] 22 端口不通' }
    if (Test-TcpPort -Host2 'ssh.github.com' -Port 443) { Write-Host '  [OK] ssh.github.com:443 可通（SSH-over-443 兜底可用）' } else { Write-Host '  [X ] ssh.github.com:443 不通' }
    if ((Test-TcpPort -Host2 'github.com' -Port 22) -or (Test-TcpPort -Host2 'ssh.github.com' -Port 443)) {
        $authState = Test-SshAuth
        if ($authState -eq 'authed') { Write-Host '  [OK] SSH 认证有效 -> 若 HTTPS 全灭，apply 可启用 SSH-only 模式（git 全功能兜底）' }
        elseif ($authState -eq 'nokey') { Write-Host '  [!!] SSH 通道可达但未配置有效密钥（SSH 克隆需 GitHub 账号并添加公钥；否则 SSH 无法用于 git）' }
    }
    Write-Hr
    Write-Host '[3/4] 为失败域名寻找可用 IP（逐条实测，可能需要 1-2 分钟）'
    $unfixable = @()
    foreach ($d in $bad) {
        $ip = Find-Ip -Domain $d
        if ($ip) {
            if (Test-IsReused -Ip $ip -Domain $d) {
                Write-Host ("  [OK] {0,-45} 可修复 -> {1}（复用同组域名已验证 IP）" -f $d, $ip)
            }
            else {
                Write-Host ("  [OK] {0,-45} 可修复 -> {1}" -f $d, $ip)
            }
        }
        else { Write-Host ("  [X ] {0,-45} 所有候选 IP 均不通（含同组复用尝试）" -f $d); $unfixable += $d }
    }
    Write-Hr
    Write-Host '[4/4] 镜像通道'
    $m = Find-Mirror
    if ($m) { Write-Host "  [OK] 可用镜像: $m" } else { Write-Host '  [X ] 所有镜像均不可用' }
    Write-Hr
    if ($bad.Count -eq 0) { Write-Host '结论: 所有域名直连正常，无需任何修复。' }
    else { Write-Host "结论: $($bad -join ', ') 存在问题；执行 apply 前请用户确认。" }
    if ($unfixable.Count -gt 0) {
        Write-Hr
        Write-Host '自救指引（以下域名已无法用 hosts/镜像修复时的合法加速方案）:'
        Write-Host '  推荐工具: Watt Toolkit（原 Steam++，开源免费、GitHub 官方在加速名单内，是国内合法网络优化工具，不是 VPN）'
        Write-Host '  一键安装: 征得用户同意后，Agent 可直接运行 watt 子命令自动下载安装（下载 Gitee 直链安装包并启动安装向导）'
        Write-Host '  Windows 安装三步:'
        Write-Host '    1. 打开「Microsoft Store」（微软商店），搜索 Watt Toolkit，点安装（Win10 17763+ 可装，官方上架）'
        Write-Host '    2. 商店打不开时: 浏览器打开官网 https://steampp.net 下载 x64 安装包安装'
        Write-Host '    3. 打开软件 -> 「网络加速」-> 勾选 GitHub -> 点「一键加速」（推荐系统代理模式）'
        Write-Host '  备用下载: Gitee 发行页 https://gitee.com/rmbgame/SteamTools/releases （国内直连）'
        Write-Host '  注: 安装加速工具后建议重新运行本工具 check 复查，hosts 兜底可与加速工具并存。'
    }
}

# ============ apply ============
function Invoke-Apply {
    if (-not (Get-IsAdmin)) {
        # 自提权重启（弹 UAC）：用与当前会话相同的引擎重启，UAC 被拒时友好退出
        try {
            $engine = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
            $p = Start-Process $engine -Verb RunAs -PassThru -Wait -ArgumentList @(
                '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'apply'
            )
            if ($p) { exit $p.ExitCode }
            exit 2
        } catch {
            Write-Host '未获得管理员授权（UAC 被取消），本次未做任何修改。'
            Write-Host '请以管理员身份运行 PowerShell 后重试，或让 AI Agent 引导你重新授权。'
            exit 2
        }
    }
    if (-not (Test-Path $HostsPath)) { Set-Content -Path $HostsPath -Value '' -Encoding ASCII }
    Backup-Hosts

    $content = Get-Content -Path $HostsPath -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) { $content = '' }
    # 移除旧标记块
    $pattern = "(?ms)\r?\n?" + [regex]::Escape($MarkStart) + '.*?' + [regex]::Escape($MarkEnd) + "\r?\n?"
    $content = [regex]::Replace($content, $pattern, "`n")

    # 构建新块（v1.0.2: 每个域名最多 3 个实测通过的 IP，多行=系统自动备胎）
    $block = New-Object System.Collections.Generic.List[string]
    $block.Add($MarkStart)
    $block.Add("# Written by github-accelerator v$Version at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $block.Add('# Up to 3 tested-alive IPs per domain (multi-line = automatic fallback); re-running overwrites this block')
    foreach ($d in $Domains) {
        $count = 0
        foreach ($ip in (Get-Candidates -Domain $d)) {
            if ($count -ge 3) { break }
            if (Test-IpOk -Domain $d -Ip $ip) {
                $block.Add(('{0,-16} {1}' -f $ip, $d))
                $count++
            }
        }
    }
    if (-not (Test-TcpPort -Host2 'github.com' -Port 22) -and (Test-TcpPort -Host2 'ssh.github.com' -Port 443)) {
        foreach ($ip in (Get-Candidates -Domain 'ssh.github.com')) {
            if (Test-IpOk -Domain 'ssh.github.com' -Ip $ip) { $block.Add(('{0,-16} {1}' -f $ip, 'ssh.github.com')); break }
        }
    }
    $block.Add($MarkEnd)

    $newContent = $content.TrimEnd() + "`r`n" + ($block -join "`r`n") + "`r`n"
    # UTF-8 无 BOM 写盘（.NET 默认），PS 5.1/7 行为一致，且不破坏用户 hosts 里原有的非 ASCII 内容
    [System.IO.File]::WriteAllText($HostsPath, $newContent)
    Write-Host 'hosts 已更新（仅标记块内容，其余未动）。'

    # 刷新 DNS
    ipconfig /flushdns | Out-Null
    Write-Host 'DNS 缓存已刷新。'

    # ============ git 兜底决策（v1.3.0）============
    # ① SSH-only 模式（SSH 可达且已认证，git 全功能走 SSH，无第三方中转）
    # ② 镜像模式（SSH 不可用但镜像活着）
    # ③ 全不可用 → 诚实报告
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (Test-DomainOk -Domain 'github.com') {
        Write-Host 'github.com 直连正常，跳过 git 兜底配置（不引入不必要的第三方中转）。'
    }
    elseif ($gitCmd) {
        $sshAlive = (Test-TcpPort -Host2 'github.com' -Port 22) -or (Test-TcpPort -Host2 'ssh.github.com' -Port 443)
        $sshState = if ($sshAlive) { Test-SshAuth } else { 'dead' }
        if ($sshState -eq 'authed') {
            Write-SshConfigBlock -Use443 (-not (Test-TcpPort -Host2 'github.com' -Port 22) -and (Test-TcpPort -Host2 'ssh.github.com' -Port 443))
            & git config --global 'url.git@github.com:.insteadOf' 'https://github.com/'
            & git config --global 'github-accelerator.gitmode' 'ssh'
            Write-Host 'SSH-only 模式已启用: git 全部 https 地址自动转 SSH（clone/pull/push 全功能可用，无第三方中转）。'
            Write-Host '  Agent/小白照常执行 git clone https://github.com/用户名/仓库名.git 即可。'
        }
        else {
            $m = Find-Mirror
            if ($m) {
                & git config --global "url.$m/https://github.com/.insteadOf" 'https://github.com/'
                & git config --global 'github-accelerator.mirror' $m
                Write-Host "git 已配置镜像加速: $m"
            }
            else { Write-Host '警告: github.com 直连失败且所有镜像不可用，git 兜底未能配置。' }
            if ($sshState -eq 'nokey') {
                Write-Host '提示: SSH 通道可达但未配置有效密钥（SSH 克隆需 GitHub 账号并添加公钥）。'
                Write-Host '  配置好 SSH 公钥后重跑 apply，可启用更稳的 SSH-only 模式。'
            }
            elseif ($sshState -eq 'dead') {
                Write-Host '提示: SSH 通道也不通，git 仅能依赖镜像（若上方配置成功）。'
            }
        }
    }

    Write-Hr
    Write-Host '端到端验证（写入后实测）:'
    $fail = 0
    foreach ($d in $Domains) {
        if (Test-DomainOk -Domain $d) { Write-Host "  [OK] $d" }
        else { Write-Host "  [X ] $d （hosts 已写入但仍不通，见诊断报告的出路指引）"; $fail++ }
    }
    if ($fail -eq 0) { Write-Host '全部域名修复成功 [OK]' } else { Write-Host '部分域名未能修复，详见上方报告。' }
    # 沙箱环境提示（v1.1.2）
    if ($SandboxProxy -and -not (Test-HttpOkVia -Url 'https://github.com/' -Proxy $SandboxProxy) -and (Test-DomainOk -Domain 'github.com')) {
        Write-Hr
        Write-Host '沙箱提示: 检测到 Agent 沙箱代理拦截 GitHub（直连已修复）。'
        Write-Host 'Agent 后续执行 git clone / curl / 下载安装前先清除代理环境变量:'
        Write-Host '  $env:HTTP_PROXY=""; $env:HTTPS_PROXY=""; $env:http_proxy=""; $env:https_proxy=""'
        Write-Host '若 git 报证书吊销检查失败(0x80092012)，追加: git -c http.schannelCheckRevoke=false clone ...'
    }
}

# ============ rollback ============
function Invoke-Rollback {
    if (-not (Get-IsAdmin)) {
        try {
            $engine = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
            $p = Start-Process $engine -Verb RunAs -PassThru -Wait -ArgumentList @(
                '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'rollback'
            )
            if ($p) { exit $p.ExitCode }
            exit 2
        } catch {
            Write-Host '未获得管理员授权（UAC 被取消），本次未做任何修改。'
            exit 2
        }
    }
    $baks = Get-ChildItem "$HostsPath.ghacc.bak.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($baks) {
        Copy-Item -Path $baks[0].FullName -Destination $HostsPath -Force
        Write-Host "hosts 已还原自: $($baks[0].Name)"
        ipconfig /flushdns | Out-Null
    }
    else {
        $content = Get-Content -Path $HostsPath -Raw
        $pattern = "(?ms)\r?\n?" + [regex]::Escape($MarkStart) + '.*?' + [regex]::Escape($MarkEnd) + "\r?\n?"
        [System.IO.File]::WriteAllText($HostsPath, [regex]::Replace($content, $pattern, "`n"))
        Write-Host '未找到备份，已移除标记块内容。'
    }
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        # git 清理（镜像模式）
        $m = & git config --global --get github-accelerator.mirror 2>$null
        if ($m) {
            & git config --global --unset "url.$m/https://github.com/.insteadOf" 2>$null
            & git config --global --unset github-accelerator.mirror 2>$null
            Write-Host 'git 镜像配置已移除。'
        }
        # git 清理（SSH-only 模式，v1.3.0）
        $gitmode = & git config --global --get github-accelerator.gitmode 2>$null
        if ($gitmode -eq 'ssh') {
            & git config --global --unset 'url.git@github.com:.insteadOf' 2>$null
            & git config --global --unset github-accelerator.gitmode 2>$null
            Write-Host 'git SSH-only 配置已移除。'
        }
    }
    # ssh 配置清理
    if (Test-Path $SshCfg) {
        $sshContent = Get-Content -Path $SshCfg -Raw -ErrorAction SilentlyContinue
        if ($sshContent -and $sshContent -match [regex]::Escape($MarkSshStart)) {
            $pattern = "(?ms)\r?\n?" + [regex]::Escape($MarkSshStart) + '.*?' + [regex]::Escape($MarkSshEnd) + "\r?\n?"
            [System.IO.File]::WriteAllText($SshCfg, [regex]::Replace($sshContent, $pattern, "`n"))
            Write-Host 'SSH 兜底配置已移除。'
        }
    }
    Write-Host '回滚完成。'
}

# ============ status ============
function Invoke-Status {
    Write-Host "GitHub-Accelerator v$Version —— 当前状态"
    Write-Hr
    if (Test-Path $HostsPath) {
        $content = Get-Content -Path $HostsPath -Raw
        if ($content -match [regex]::Escape($MarkStart)) {
            $s = $content.IndexOf($MarkStart); $e = $content.IndexOf($MarkEnd) + $MarkEnd.Length
            Write-Host 'hosts 标记块内容:'
            $content.Substring($s, $e - $s) -split "`r?`n" | ForEach-Object { Write-Host "  $_" }
        }
        else { Write-Host 'hosts 中无本工具标记块（未安装或已回滚）。' }
    }
    Write-Hr
    Invoke-Check
}

# ============ watt: 一键自助安装 Watt Toolkit（v1.4.0）============
# 调用前提: Agent 已征得用户同意（SKILL.md 把关），或用户本人主动运行。
# 流程: Gitee API（国内直连）拿最新版 exe 直链 → 下载到 Downloads → 自动启动安装向导
#       → 使用教程。下载失败时自动打开微软商店页/官网下载页，绝不引导翻墙。
function Invoke-WattTutorial {
    Write-Host '  1. 打开 Watt Toolkit -> 左侧「网络加速」'
    Write-Host '  2. 勾选 GitHub（可按需勾选其他平台）'
    Write-Host '  3. 点「一键加速」（推荐「系统代理」模式），状态显示运行中即生效'
    Write-Host '  提示: 加速生效后重新打开浏览器再访问 github.com；浏览器若装有代理插件请先关闭，避免冲突。'
}

function Invoke-Watt {
    Write-Host 'Watt Toolkit 一键自助安装（开源免费、国内合法网络优化工具，非 VPN）'
    Write-Hr
    Write-Host '[1/3] 从 Gitee 获取最新版安装包直链...'
    $asset = $null
    try {
        $rel = Invoke-RestMethod -Uri 'https://gitee.com/api/v5/repos/rmbgame/SteamTools/releases/latest' -TimeoutSec 20
        if ($rel -and $rel.assets) {
            $asset = $rel.assets | Where-Object { $_.name -match 'win_x64\.exe$' } | Select-Object -First 1
            Write-Host ("  [OK] 最新版本: {0}" -f $rel.tag_name)
        }
    } catch { Write-Host '  Gitee API 访问失败，改用固定版本 3.1.0...' }
    if (-not $asset) {
        $asset = [pscustomobject]@{
            name = 'Steam++_v3.1.0_win_x64.exe'
            browser_download_url = 'https://gitee.com/rmbgame/SteamTools/releases/download/3.1.0/Steam%20%20_v3.1.0_win_x64.exe'
        }
    }
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    $out = Join-Path $downloads $asset.name
    Write-Host "[2/3] 下载安装包（约 63MB）-> $out"
    $dlOk = $false
    $curlExe = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($curlExe) {
        & $curlExe.Source --noproxy '*' -sL -m 900 -o $out $asset.browser_download_url 2>$null
        $dlOk = (Test-Path $out) -and ((Get-Item $out).Length -gt 50000000)
    }
    if (-not $dlOk) {
        try {
            $wc = New-Object System.Net.WebClient
            $wc.Proxy = $null
            $wc.DownloadFile($asset.browser_download_url, $out)
            $dlOk = (Test-Path $out) -and ((Get-Item $out).Length -gt 50000000)
        } catch { }
    }
    if (-not $dlOk) {
        Write-Host '  [X ] 自动下载失败。已为你打开下载页，可任选一个渠道:'
        Write-Host '    1. Microsoft Store: 搜索 Watt Toolkit（官方上架，Win10 17763+，自动更新）'
        Write-Host '    2. 官网: https://steampp.net/download'
        Write-Host '    3. 蓝奏云: https://wwn.lanzouy.com/b01v4iz1g （提取码 1234）'
        Start-Process 'ms-windows-store://pdp/?ProductId=9MTCFHS560NG'
        return 1
    }
    Write-Host '  [OK] 下载完成'
    Write-Host '[3/3] 启动安装向导（请在弹出的窗口中点「下一步/安装」，默认设置即可）'
    Start-Process -FilePath $out
    Write-Hr
    Write-Host '使用教程（安装完成后执行）:'
    Invoke-WattTutorial
    Write-Host '  备选安装: Microsoft Store 搜索 Watt Toolkit（官方上架，自动更新）。'
    Write-Host '完成提示: 安装后可重跑本工具 check 复查直连状态。'
}

switch ($Cmd) {
    'check' { Invoke-Check }
    'apply' { Invoke-Apply }
    'rollback' { Invoke-Rollback }
    'status' { Invoke-Status }
    'watt' { Invoke-Watt }
}
