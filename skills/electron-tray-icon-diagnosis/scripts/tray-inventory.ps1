<#
  tray-inventory.ps1 - read-only ladder for "the Electron/Chromium tray icon is not showing".

  It answers, in order and with numbers you can act on:
    1. what integrity level is explorer, and what integrity level is the app
    2. which tray host windows exist (the shell's own window classes)
    3. does the shell give the app's icon a slot at all (Shell_NotifyIconGetRect per uID)
    4. what does Explorer's per-exe tray state say (NotifyIconSettings + UIOrderList)
    5. what does UIAutomation see in the visible tray / overflow flyout

  Nothing is written, no process is touched, no icon is registered - the control registration
  lives in control-icon.ps1 so the positive assertion stays a deliberate step.
#>
[CmdletBinding()]
param(
    [string]$Process = '',      # process name fragment of the app under diagnosis, e.g. 'DSH Desktop'
    [int]$UidMax = 8,           # uIDs to sweep per host window (Electron typically uses 3)
    [switch]$NoUia,             # skip the UIAutomation walk (adds ~2s, needs UIAutomationClient)
    [int]$MaxRows = 20,
    # Fixture knob: pretend explorer sits at this IL. Lets the IL-MISMATCH verdict be tested on a
    # machine where nothing is currently broken (pass S-1-16-12288 to reproduce the 2026-10-04 shape).
    [string]$AssumeExplorerIl = ''
)

$ErrorActionPreference = 'Stop'
# Tray / flyout names are localized; without UTF-8 output an agent reading a redirected log sees
# mojibake exactly where the answer (the tooltip text) lives.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:findings = New-Object System.Collections.ArrayList
function Say([string]$s) { Write-Output $s }
function Flag([string]$s) { [void]$script:findings.Add($s) }

try { . (Join-Path $PSScriptRoot 'win32-tray.ps1') } catch { Say ('>> NO-RUN: helper not loaded: ' + $_.Exception.Message); exit 2 }
if (-not ('TrayProbe' -as [type])) { Say '>> NO-RUN: TrayProbe type missing'; exit 2 }

Say ('== 0. probe shape guard ==')
$nii = [TrayProbe]::NiiSize()
Say ('  OS=' + [Environment]::OSVersion.VersionString + ' 64bit=' + [Environment]::Is64BitProcess + ' NII cbSize=' + $nii)
if ($nii -ne 40) {
    Say '>> FAIL: NOTIFYICONIDENTIFIER is 40 bytes on x64. Any other size means the struct drifted and'
    Say '   every hr below is meaningless - fix the struct before reading anything else.'
    exit 5
}

Say ('== 1. integrity levels (the gate that decides everything else) ==')
$explorerPids = @(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
foreach ($ep in $explorerPids) {
    Say ('  explorer pid=' + $ep + ' IL=' + [TrayProbe]::IntegrityOf($ep) + ' ' + [TrayProbe]::ElevatedOf($ep))
}
$explorerIl = if ($explorerPids.Count) { [TrayProbe]::IntegrityOf($explorerPids[0]) } else { 'none' }
if ($AssumeExplorerIl -ne '') {
    Say ('  FIXTURE: explorer IL forced to ' + $AssumeExplorerIl + ' (real reading was ' + $explorerIl + ')')
    $explorerIl = $AssumeExplorerIl
}
$uac = 'unknown'
try { $uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction Stop).EnableLUA } catch { }
Say ('  EnableLUA=' + $uac + ' (0 => every admin-session process, explorer included, runs at High)')

$targets = @()
$script:ilByPid = @{}
if ($Process -ne '') {
    $targets = @(Get-Process -Name ('*' + $Process + '*') -ErrorAction SilentlyContinue)
    if ($targets.Count -eq 0) { $targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like ('*' + $Process + '*') }) }
    Say ('  target processes matching [' + $Process + ']: ' + $targets.Count)
    foreach ($t in ($targets | Select-Object -First $MaxRows)) {
        # StartTime throws Access Denied for processes at another integrity level, and the script
        # runs with ErrorActionPreference=Stop - read it defensively or the whole table dies.
        $started = try { $t.StartTime.ToString('MM-dd HH:mm') } catch { '?' }
        $il = [TrayProbe]::IntegrityOf($t.Id)
        $script:ilByPid[[string]$t.Id] = $il
        Say ('    pid=' + $t.Id + ' name=' + $t.ProcessName + ' started=' + $started + ' IL=' + $il + ' ' + [TrayProbe]::ElevatedOf($t.Id))
    }
    # Do NOT flag IL differences here. Chromium spawns helpers deliberately below the browser IL
    # (S-1-16-4096 Low sandbox renderer, S-1-16-0 Untrusted PPF/nacl) and those can never own a
    # tray icon. The only comparison that matters is explorer vs the process that owns the notify
    # icon host window - done in section 3. Measured 2026-10-07: flagging every match turned a
    # known-good install red on its own sandbox processes (a fabricated defect).
    Say '  note: IL per process is listed for context only; the mismatch verdict is made in section 3'
    Say '        against the tray host window owner. Low (S-1-16-4096) / Untrusted (S-1-16-0) rows are'
    Say '        Chromium sandboxes and are NOT defects.'
} else {
    Say '  no -Process given: inventorying every tray host window below'
}

Say ('== 2. tray host windows as the shell sees them ==')
$rows = [TrayProbe]::TrayHostWindows()
Say ('  windows: ' + $rows.Count)
foreach ($r in ($rows | Select-Object -First $MaxRows)) {
    Say ('  pid=' + $r.Pid + ' proc=' + $r.Proc + ' class=' + $r.Class + ' vis=' + $r.Visible + ' rect=' + $r.Rect + ' ' + $r.IconRects)
}

Say ('== 3. does the shell hold a slot for each host window? ==')
$hostClasses = @('Electron_NotifyIconHostWindow', 'Chrome_App_Tray_Host_Window', 'Qt51514WxTrayIconMessageWindowClass')
$hostRows = @($rows | Where-Object { $hostClasses -contains $_.Class })
$targetHosts = @()
$controlHosts = @()
foreach ($h in $hostRows) {
    if ($Process -ne '' -and $h.Proc -like ('*' + $Process + '*')) { $targetHosts += $h } else { $controlHosts += $h }
}
foreach ($h in ($controlHosts | Select-Object -First 3)) {
    $hh = [IntPtr]([Convert]::ToInt64(($h.IconRects -split '0x')[1], 16))
    Say ('  [control] proc=' + $h.Proc + ' ' + [TrayProbe]::RectProbe($hh, $UidMax))
}
# UIPI only blocks upward: a process STRICTLY BELOW explorer's IL cannot reach the shell.
# Equal or higher IL owners are fine, and Chromium's Low / Untrusted helper processes never own
# the host window in the first place - comparing the owner (not every matching pid) is what stops
# this verdict from flagging the sandbox as a defect.
function IlNumber([string]$sid) {
    # Never write [int]$Matches[1] here: PowerShell casts the wrong operand and dies with
    # "cannot convert S-1-16-8192 to System.Int32" at the call site, mid-table.
    $num = 0
    $tail = $sid -replace '^S-1-16-', ''
    if ([int]::TryParse($tail, [ref]$num)) { return $num }
    return -1
}
$targetResult = @()
foreach ($h in ($targetHosts | Select-Object -First $MaxRows)) {
    $hh = [IntPtr]([Convert]::ToInt64(($h.IconRects -split '0x')[1], 16))
    $p = [TrayProbe]::RectProbe($hh, $UidMax)
    $ownerIl = [TrayProbe]::IntegrityOf($h.Pid)
    Say ('  [target] proc=' + $h.Proc + ' pid=' + $h.Pid + ' IL=' + $ownerIl + ' ' + $p)
    $oi = IlNumber $ownerIl
    $ei = IlNumber $explorerIl
    if ($oi -ge 0 -and $ei -ge 0 -and $oi -lt $ei) {
        Flag ('IL-MISMATCH: the tray host window owner pid=' + $h.Pid + ' is ' + $ownerIl + ' but explorer is ' +
              $explorerIl + ' -> UIPI silently drops Shell_NotifyIcon sent upward, and the app sees no error.' +
              ' Fix integrity level, not the icon.')
    }
    $targetResult += $p
}
if ($Process -ne '' -and $hostRows.Count -eq 0) { Say '  >> FAIL: no tray host window class found for any process' }
if ($targetHosts.Count -eq 0 -and $Process -ne '') {
    Flag ('NO-HOST-WINDOW: no process matching [' + $Process + '] owns a notify-icon host window -> the app never' +
          ' reached Tray()/NIM_ADD in this instance (early exit, single-instance handoff, or tray created in a' +
          ' process that already died). The shell is not the suspect.')
}
if ($controlHosts.Count -eq 0) {
    Say '  >> NO-RUN: no control window was probed, so "hits=0" for the target proves nothing yet -'
    Say '     run control-icon.ps1 first and require it to report a real rect.'
}
foreach ($p in $targetResult) {
    if ($p -match 'withRect=0 noRect=0') {
        Flag ('NOT-REGISTERED: the host window exists but Shell_NotifyIconGetRect fails for uID 0..' + $UidMax +
              ' -> NIM_ADD never reached the shell. Check IL first (section 1/3), then compare with a control run.')
    }
    if ($p -match 'noRect=[1-9]') {
        Flag 'REGISTERED-NO-RECT: hr=0 with an empty rect -> the shell knows the icon but draws nothing (overflow flyout / hidden by default).'
    }
    if ($p -match 'withRect=[1-9]') {
        Flag ('HAS-RECT: registered and answered with a rect. Read the scope carefully - the rect is often the' +
              ' overflow anchor and identical across apps, so this is NOT proof of on-bar visibility; confirm by eye.' +
              ' If the user still sees nothing on a control-passing shell, suspect the bitmap (transparent / all-alpha-zero).')
    }
}

Say ('== 4. Explorer per-exe tray state (HKCU\Control Panel\NotifyIconSettings) ==')
try {
    $reg = [TrayProbe]::NotifyIconSettings($Process)
    foreach ($l in (($reg -split "`n") | Select-Object -First $MaxRows)) { Say ('  ' + $l) }
    Say '  note: keys live and die with the running registration; an absent key is not "hidden state".'
    Say '  note: tipLen=0 with a valid IconSnapshot is the classic residue after a TaskbarCreated broadcast'
    Say '        (Electron re-registers without the tooltip) - it does not explain a fully missing icon.'
} catch { Say ('  >> NO-RUN: registry read failed: ' + $_.Exception.Message) }
try {
    foreach ($l in (([TrayProbe]::UiOrderList($Process) -split "`n") | Select-Object -First $MaxRows)) { Say ('  ' + $l) }
} catch { Say ('  >> NO-RUN: UIOrderList read failed: ' + $_.Exception.Message) }

Say ('== 5. what UIAutomation sees in the tray ==')
if ($NoUia) {
    Say '  skipped (-NoUia)'
} else {
    try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
        $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($tray -eq $null) { Say '  >> NO-RUN: Shell_TrayWnd not found via UIA' }
        else {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            # Two traps here. (1) LocalizedControlType is localized, so comparing with 'button'
            # silently yields zero rows on a Chinese Windows and reads as "tray is empty".
            # (2) Use ControlType.ProgrammaticName rather than a static ControlTypes class - the
            # class is not resolvable in every UIA assembly layout.
            $rowsUia = New-Object System.Collections.ArrayList
            $stack = New-Object System.Collections.Stack
            $stack.Push($tray)
            $walked = 0
            while ($stack.Count -gt 0 -and $walked -lt 4000) {
                $walked++
                $el = $stack.Pop()
                $ct = ''
                try { $ct = $el.Current.ControlType.ProgrammaticName } catch { }
                $nm = $el.Current.Name
                if ($nm -eq $null) { $nm = '' }
                [void]$rowsUia.Add([pscustomobject]@{ Ct = $ct; Name = $nm; Cls = $el.Current.ClassName })
                $child = $walker.GetFirstChild($el)
                while ($child -ne $null) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
            }
            $hist = @($rowsUia | Group-Object Ct | Sort-Object Count -Descending | Select-Object -First 6)
            Say ('  elements walked=' + $walked + ' control types: ' + (($hist | ForEach-Object { $_.Name + '=' + $_.Count }) -join ' '))
            $btns = @($rowsUia | Where-Object { $_.Ct -like '*Button*' -and $_.Name -ne '' } | Select-Object -First $MaxRows)
            Say ('  named button nodes (tray icons show up here): ' + $btns.Count)
            foreach ($b in $btns) { Say ('    "' + $b.Name + '" class=' + $b.Cls) }
            if ($walked -lt 5) { Say '  >> NO-RUN: the UIA walk barely moved, this is not a tray inventory' }
            if ($btns.Count -eq 0) {
                Say '  >> NO-RUN for this section: no named button node was found. On Win11 the visible tray'
                Say '     icons are hosted by the XAML island; the overflow flyout only exists while the ^'
                Say '     panel is open. Click the chevron (or ask the user to) and re-run - skipping that'
                Say '     click is the classic false "the icon is not in the tray" reading.'
            }
            Say '  cross-check: UIA sees an entry but Shell_NotifyIconGetRect fails => renderer/state mismatch;'
            Say '  both fail => the icon never reached the shell.'
        }
    } catch { Say ('  >> NO-RUN: UIA walk failed: ' + $_.Exception.Message) }
}

Say ('== 6. verdict ==')
if ($script:findings.Count -eq 0) {
    Say '  >> NO-RUN: no verdict reached - give -Process <name>, and make sure the app is running.'
    exit 2
}
foreach ($f in $script:findings) { Say ('  * ' + $f) }
Say '  ladder: (a) if IL-MISMATCH is listed, stop reading resources - fix integrity level, then re-probe.'
Say '          (b) else if NOT-REGISTERED, run control-icon.ps1: a passing control narrows it to this instance,'
Say '              a failing control means the shell side.'
Say '          (c) else if NO-HOST-WINDOW, the defect is in the app process, not in Windows.'
Say '          (d) REGISTERED-NO-RECT / HAS-RECT are not defects by themselves - open the ^ panel and'
Say '              look at the bar; HAS-RECT is not proof of visibility (the rect is usually the overflow anchor).'
if ($script:findings -match 'IL-MISMATCH') { exit 1 }
if ($script:findings -match 'NOT-REGISTERED') { exit 1 }
if ($script:findings -match 'NO-HOST-WINDOW') { exit 1 }
exit 0
