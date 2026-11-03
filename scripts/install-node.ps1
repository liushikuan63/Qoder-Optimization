#requires -Version 5.1
param(
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Select-Menu {
  param([string]$Title, [string[]]$Options)
  $index = 0
  while ($true) {
    Clear-Host
    Write-Host $Title
    Write-Host ''
    for ($i = 0; $i -lt $Options.Count; $i++) {
      if ($i -eq $index) { Write-Host ('  > ' + $Options[$i]) -ForegroundColor Cyan }
      else { Write-Host ('    ' + $Options[$i]) }
    }
    Write-Host ''
    Write-Host '↑/↓ 选择，Enter 确认，Esc 跳过'
    $key = [Console]::ReadKey($true)
    switch ($key.Key) {
      'UpArrow' { $index = ($index - 1 + $Options.Count) % $Options.Count }
      'DownArrow' { $index = ($index + 1) % $Options.Count }
      'Enter' { return $index }
      'Escape' { return $Options.Count - 1 }
    }
  }
}

if ($NonInteractive -or [Console]::IsInputRedirected) {
  Write-Host '未检测到可用的 Node.js。'
  Write-Host '请安装 Node.js 24.16+ 后重新运行 install.cmd：https://nodejs.org/en/download'
  exit 0
}

$options = @(
  '用 winget 安装 Node.js LTS（推荐；需要网络，默认装到系统盘）',
  '查看便携版下载方式（不写系统盘，解压到 D 盘后重跑）',
  '跳过'
)
$index = Select-Menu 'Qoder-Optimization：未检测到可用的 Node.js' $options

if ($index -eq 0) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 winget。请手动安装 Node.js 后重试：https://nodejs.org/en/download'
    exit 3
  }
  Write-Host '正在通过 winget 安装 Node.js LTS...'
  & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
  $wingetExit = $LASTEXITCODE
  if ($wingetExit -ne 0) {
    Write-Host ('winget 安装未成功（退出码 ' + $wingetExit + '）。请手动安装后重试。')
    exit $wingetExit
  }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
  $node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $node) {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { $node = $command.Source }
  }
  if ($node) {
    & $node (Join-Path $PSScriptRoot 'install-package.cjs')
    exit $LASTEXITCODE
  } else {
    Write-Host '安装完成，但当前终端找不到 node.exe；请重开终端后运行 install.cmd。'
    exit 3
  }
} elseif ($index -eq 1) {
  Write-Host '便携版：打开 https://nodejs.org/en/download 下载 Windows x64 ZIP，解压到例如 D:\tools\node。'
  Write-Host '然后运行：D:\tools\node\node.exe scripts\install-package.cjs'
  Write-Host '或把该目录加入 PATH 后重新运行 install.cmd。'
} else {
  Write-Host '已跳过。'
}
exit 0
