# cua-wait.ps1 - poll until a desktop condition holds, inside ONE call.
# Why: "wait for the window / the text to appear" otherwise costs one tool round-trip per peek.
# This loops locally and returns one structured line, so the caller spends a single call.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File cua-wait.ps1 -TitleRegex "Untitled - Notepad"
#   powershell ... -File cua-wait.ps1 -Hwnd 12345 -Text "Text Editor"
#   powershell ... -File cua-wait.ps1 -ProcessName notepad -TimeoutSec 15
# Output (stdout, one line):
#   FOUND|what=title|attempts=4|elapsed_ms=1620|hwnd=12345|detail=Untitled - Notepad
#   TIMEOUT|what=text|attempts=38|elapsed_ms=20110
# Exit: 0 = found, 1 = timeout, 2 = bad arguments.
# No foreground, no cursor movement, no click - read-only UIA / window enumeration.
param(
    [string]$TitleRegex,
    [string]$ProcessName,
    [int]$Hwnd = 0,
    [string]$Text,
    [int]$TimeoutSec = 20,
    [int]$IntervalMs = 400,
    [int]$MaxNodes = 4000,
    [switch]$Tree
)

# UIA names are frequently Chinese; PS 5.1 writes stdout in the OEM codepage, so the
# detail field arrives mojibake when the caller is bash / node. Force UTF-8 on both sides.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Wn {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

if (-not $TitleRegex -and -not $Text -and -not $ProcessName) {
    Write-Error 'need at least one predicate: -TitleRegex / -Text (+-Hwnd) / -ProcessName'; exit 2
}
if ($TimeoutSec -lt 1) { Write-Error 'TimeoutSec must be >= 1'; exit 2 }

function Get-TopWindows {
    $list = New-Object System.Collections.ArrayList
    $cb = [Wn+EnumProc] {
        param($h, $l)
        if ([Wn]::IsWindowVisible($h)) {
            $len = [Wn]::GetWindowTextLength($h)
            if ($len -gt 0) {
                $sb = New-Object System.Text.StringBuilder ($len + 2)
                [void][Wn]::GetWindowText($h, $sb, $sb.Capacity)
                $procId = 0
                [void][Wn]::GetWindowThreadProcessId($h, [ref]$procId)
                [void]$list.Add([pscustomobject]@{ Hwnd = [int64]$h; Title = $sb.ToString(); Pid = $procId })
            }
        }
        return $true
    }
    [void][Wn]::EnumWindows($cb, [IntPtr]::Zero)
    return $list
}

function Find-UiText([int64]$hwnd, [string]$needle, [int]$cap) {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if (-not $el) { return $null }
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $n = [Math]::Min($all.Count, $cap)
    for ($i = 0; $i -lt $n; $i++) {
        $e = $all.Item($i)
        $name = ''
        try { $name = $e.Current.Name } catch { continue }
        if ($name -and $name.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $val = ''
            try {
                $vp = $null
                if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
                    $val = $vp.Current.Value
                    if ($val.Length -gt 60) { $val = $val.Substring(0, 60) }
                }
            } catch { }
            $label = $name
            if ($label.Length -gt 60) { $label = $label.Substring(0, 60) }
            return "$($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')|$label|val=$val"
        }
    }
    return $null
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$attempts = 0
$deadline = $TimeoutSec * 1000
$what = if ($Text) { 'text' } elseif ($TitleRegex) { 'title' } else { 'process' }

while ($sw.ElapsedMilliseconds -lt $deadline) {
    $attempts++
    $wins = Get-TopWindows

    if ($ProcessName) {
        $hit = $wins | Where-Object {
            try { (Get-Process -Id ([int]$_.Pid) -ErrorAction Stop).ProcessName -ieq $ProcessName } catch { $false }
        } | Select-Object -First 1
        if ($hit) {
            Write-Output ("FOUND|what=process|attempts={0}|elapsed_ms={1}|hwnd={2}|detail={3}" -f $attempts, $sw.ElapsedMilliseconds, $hit.Hwnd, $hit.Title)
            exit 0
        }
    }
    if ($TitleRegex) {
        $hit = $wins | Where-Object { $_.Title -match $TitleRegex } | Select-Object -First 1
        if ($hit) {
            Write-Output ("FOUND|what=title|attempts={0}|elapsed_ms={1}|hwnd={2}|detail={3}" -f $attempts, $sw.ElapsedMilliseconds, $hit.Hwnd, $hit.Title)
            exit 0
        }
    }
    if ($Text) {
        $targets = @()
        if ($Hwnd -gt 0) { $targets = @([int64]$Hwnd) }
        else { $targets = @($wins | ForEach-Object { $_.Hwnd }) }
        foreach ($t in $targets) {
            $m = $null
            try { $m = Find-UiText $t $Text $MaxNodes } catch { continue }
            if ($m) {
                if ($Tree) { Write-Output ("  node: $m") }
                Write-Output ("FOUND|what=text|attempts={0}|elapsed_ms={1}|hwnd={2}|detail={3}" -f $attempts, $sw.ElapsedMilliseconds, $t, $m)
                exit 0
            }
        }
    }
    if ($sw.ElapsedMilliseconds -ge $deadline) { break }
    Start-Sleep -Milliseconds $IntervalMs
}

Write-Output ("TIMEOUT|what=$what|attempts=$attempts|elapsed_ms=$($sw.ElapsedMilliseconds)|timeout_sec=$TimeoutSec")
exit 1
