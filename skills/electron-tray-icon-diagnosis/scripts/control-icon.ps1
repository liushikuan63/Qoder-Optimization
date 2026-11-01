<#
  control-icon.ps1 - Step 2 of the electron-tray-icon-diagnosis ladder.

  Registers a throwaway notification icon from THIS process and asks the shell (from the same
  process, and from an external uID sweep) whether the icon really got a slot.

  Why this probe exists: it is the only positive assertion in the ladder. A "no icon" reading is
  worthless until something has demonstrably shown an icon on this shell, on this integrity level.
  It answers three separate suspects at once:
    - shell channel alive?        (icon appears / hr=0)
    - the app's PNG usable?       (pass -Png <the app's own icon>)
    - this IL allowed to register?(compare with -Png run from an elevated / different-IL shell)

  Read-mostly: adds and removes one tray icon in the current session. Nothing persistent.
#>
[CmdletBinding()]
param(
    [string]$Png = '',                 # icon file to register (the app's own icon for a fair control)
    [string]$Exe = '',                 # or take an icon out of an executable
    [string]$Tip = 'TRAY CONTROL',     # tooltip, ASCII keeps the console output clean
    [int]$HoldSeconds = 20,
    [int]$Uid = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { . (Join-Path $PSScriptRoot 'win32-tray.ps1') } catch { Write-Output ('>> NO-RUN: helper not loaded: ' + $_.Exception.Message); exit 2 }
if (-not ('TrayProbe' -as [type])) { Write-Output '>> NO-RUN: TrayProbe type missing'; exit 2 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Line([string]$s) { Write-Output $s }

Line ('== 0. probe self-check (must be able to fail) ==')
$negUid = 99999
Line ('  struct sizes: NID=' + [TrayProbe]::NidSize() + ' NII=' + [TrayProbe]::NiiSize() + ' (NII must be 40 on x64)')

$hIcon = [IntPtr]::Zero
$iconOwner = $null
if ($Png -ne '') {
    if (-not (Test-Path -LiteralPath $Png)) { Line ('>> FAIL: PNG not found: ' + $Png); exit 3 }
    $iconOwner = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $Png).Path)
    $hIcon = $iconOwner.GetHicon()
    Line ('  icon from PNG: ' + $Png)
} elseif ($Exe -ne '') {
    if (-not (Test-Path -LiteralPath $Exe)) { Line ('>> FAIL: EXE not found: ' + $Exe); exit 3 }
    $iconOwner = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Exe).Path)
    $hIcon = $iconOwner.Handle
    Line ('  icon from EXE: ' + $Exe)
} else {
    $hIcon = [System.Drawing.SystemIcons]::Application.Handle
    Line '  icon from SystemIcons.Application (generic control)'
}
if ($hIcon -eq [IntPtr]::Zero) { Line '>> FAIL: could not build an HICON (resource side is the suspect)'; exit 3 }

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$hwnd = $form.Handle

$ownIl = [TrayProbe]::IntegrityOf($PID)
Line ('== 1. this process ==')
Line ('  pid=' + $PID + ' IL=' + $ownIl + ' ' + [TrayProbe]::ElevatedOf($PID) + ' hwnd=0x' + ('{0:X}' -f [int64]$hwnd))
# Calibrate the IL reader against the OS's own answer. Absolute System32 path on purpose:
# under MSYS/Git Bash a bare `whoami` resolves to coreutils whoami and dies on /groups.
try {
    $whoami = Join-Path $env:WINDIR 'System32\whoami.exe'
    $exp = (& $whoami /groups 2>$null) | Select-String -Pattern 'S-1-16-\d+' | Select-Object -First 1
    if ($exp) { Line ('  calibration whoami=' + $exp.ToString().Trim() + '  (probe says ' + $ownIl + ')') }
    else { Line '  >> NO-RUN: whoami gave no mandatory label, IL probe is uncalibrated' }
} catch { Line ('  >> NO-RUN: calibration failed: ' + $_.Exception.Message) }

Line ('== 2. register the control icon ==')
$added = [TrayProbe]::AddControlIcon($hwnd, $Uid, $hIcon, $Tip)
if ($added -eq [IntPtr]::Zero) {
    Line ('>> FAIL: NIM_ADD returned FALSE for IL=' + $ownIl)
    Line '   note: this is usually a bad NID shape (NIF_GUID with a zero GUID, or NIF_MESSAGE with no'
    Line '   registered message), not the shell refusing icons. Check uFlags before blaming the system.'
    if ($iconOwner) { $iconOwner.Dispose() }
    $form.Close()
    exit 4
}
Line ('  NIM_ADD ok, holding ' + $HoldSeconds + 's - look at the tray / overflow (^) panel')

Line ('== 3. ask the shell where it put the icon ==')
$deadline = (Get-Date).AddSeconds($HoldSeconds)
$last = ''
$best = ''
while ((Get-Date) -lt $deadline) {
    $r = [TrayProbe]::RectProbe($hwnd, [Math]::Max($Uid, 4))
    if ($r -ne $last) { Line ('  t+' + [int]($HoldSeconds - ($deadline - (Get-Date)).TotalSeconds) + 's ' + $r); $last = $r }
    if ($r -match 'withRect=([1-9])') { $best = 'rect' }
    elseif ($r -match 'noRect=([1-9])' -and $best -eq '') { $best = 'norect' }
    Start-Sleep -Milliseconds 1500
}
$negProbe = [TrayProbe]::RectProbeVariant($hwnd, $negUid, 0)
Line ('  negative control (uID=' + $negUid + ', never registered) -> ' + $negProbe)

[TrayProbe]::DeleteControlIcon($hwnd, $Uid)
$form.Close()
if ($iconOwner) { $iconOwner.Dispose() }

Line ('== 4. verdict ==')
if ($best -eq 'rect') {
    Line ('>> PASS: shell accepted NIM_ADD from IL=' + $ownIl + ' and answers Shell_NotifyIconGetRect (hr=0).')
    Line '   scope of this reading: it proves the tray channel and this bitmap are usable. It does NOT'
    Line '   prove the icon is visible on the bar - measured 2026-10-07, a control icon nobody could see'
    Line '   on the bar reported the same 2282,1392,32x48 as every healthy app, because that coordinate'
    Line '   is the overflow anchor. Confirm visibility by eye or by screenshot.'
    Line '   => an app that still registers nothing on the same PNG is a per-instance problem: compare its'
    Line '      IL with explorer, then sweep its host window with Shell_NotifyIconGetRect.'
    exit 0
}
if ($best -eq 'norect') {
    Line ('>> PASS-with-caveat: registered (hr=0) but the rect is 0x0 => the shell knows it, nothing is drawn.')
    Line '   Open the ^ panel before concluding "missing". Explorer hides newly registered icons by default'
    Line '   per exe path (HKCU\Control Panel\NotifyIconSettings + UIOrderList), so this is the normal'
    Line '   first-run state, not a defect.'
    exit 0
}
Line ('>> FAIL: NIM_ADD succeeded but the shell reports no registration at all (withRect=0 noRect=0) for IL=' + $ownIl)
Line '   => shell-side rejection. Re-run this script from a shell at explorer''s integrity level;'
Line '      if it then registers, the failing variable is integrity level (UIPI), not the app.'
exit 1
