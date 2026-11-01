#requires -Version 5.1
<#
  migrate-qoder-data.ps1 -- move Qoder runtime data off C: to another drive via junctions.

  What it moves (only the big, append-only data dirs):
      %USERPROFILE%\.qoder\logs          %USERPROFILE%\.qoder\projects
      %USERPROFILE%\.qoder-cn\logs       %USERPROFILE%\.qoder-cn\projects
  It never moves skills / scripts / memory / rules / commands (small, and read-path
  compatibility through a junction is not proven -- do not gamble on it).

  Usage:
      migrate-qoder-data.ps1 -To D              # plan only (dry run, changes nothing)
      migrate-qoder-data.ps1 -To D -Apply       # do it (all Qoder windows must be closed)
      migrate-qoder-data.ps1 -Undo              # roll back every junction it created

  Safety: copy -> verify file count AND total bytes -> rename original aside
  (*.bak-migrating) -> create junction -> read a file through the new path.
  Any step that fails stops that directory and leaves the source untouched.
  Rollback never uses recursive delete on a link (that would follow into the real data).
#>
[CmdletBinding()]
param(
  [string]$To = '',
  [switch]$Apply,
  [switch]$Undo
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("qoder-migrate-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
function Say($m) { Write-Host $m; $m | Out-File -FilePath $log -Append -Encoding utf8 }
function Fail($m) { Say "[ABORT] $m"; Say "log: $log"; exit 2 }

$units = @(
  @{ Side = 'qoder';    Dir = 'logs'     },
  @{ Side = 'qoder';    Dir = 'projects' },
  @{ Side = 'qoder-cn'; Dir = 'logs'     },
  @{ Side = 'qoder-cn'; Dir = 'projects' }
)
$allowedDrives = @('D', 'E', 'F', 'G', 'H', 'I')
function Src-Path($u) { Join-Path $env:USERPROFILE (".{0}\{1}" -f $u.Side, $u.Dir) }
function Bak-Path($u) { (Src-Path $u) + '.bak-migrating' }
function Dst-Path($u, $drive) { "{0}:\qoder-data\{1}\{2}" -f $drive, $u.Side, $u.Dir }

function Test-Reparse($p) {
  if (-not (Test-Path -LiteralPath $p)) { return $false }
  ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}
function Get-Stats($p) {
  $f = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)
  [pscustomobject]@{ Count = $f.Count; Bytes = (($f | Measure-Object -Property Length -Sum).Sum | ForEach-Object { [int64]$_ }) }
}

# ---------------- rollback ----------------
if ($Undo) {
  Say "=== rollback: remove junctions, restore *.bak-migrating ==="
  foreach ($d in $allowedDrives) {
    foreach ($u in $units) {
      $dst = Dst-Path $u $d
      if (-not (Test-Path -LiteralPath $dst)) { continue }
      $src = Src-Path $u; $bak = Bak-Path $u
      if (-not (Test-Reparse $src)) { continue }
      Say "  junction found at $src -> $dst"
      if (-not $Apply) { Say "    (dry run; add -Apply to really roll back)"; continue }
      # rmdir on a link removes ONLY the link; never use /S here.
      cmd /c "rmdir `"$src`"" | Out-Null
      if (Test-Path -LiteralPath $src) { Fail "could not remove the link at $src" }
      if (Test-Path -LiteralPath $bak) { Rename-Item -LiteralPath $bak -NewName (Split-Path -Leaf $src) }
      Say "    restored: $src"
    }
  }
  Say "done. log: $log"
  exit 0
}

# ---------------- preflight ----------------
if (-not $To) { Fail "missing -To <drive letter>, e.g. -To D" }
$drive = ($To -replace '[:\\]', '').ToUpper()
if ($drive -notin $allowedDrives) { Fail "refusing target drive '$drive' (A/B/C are system or removable)" }
$vol = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
if (-not $vol) { Fail "drive ${drive}: not found" }

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Qoder*' })
if ($running.Count -gt 0) {
  Fail ("Qoder client still running: " + (($running | Select-Object -ExpandProperty Name -Unique) -join ', ') + "`n" +
        "  Close EVERY Qoder / Qoder CN window (including tray), then re-run." + "`n" +
        "  Why: a live process keeps handles on the old paths; renaming under it splits writes across two locations.")
}

Say "=== Qoder data migration: C: -> ${drive}: ==="
Say ("free space on ${drive}: {0:N1} GB" -f ($vol.Free / 1GB))
Say ""

$plan = @()
foreach ($u in $units) {
  $src = Src-Path $u
  if (-not (Test-Path -LiteralPath $src)) { continue }
  if (Test-Reparse $src) { Say ("  [skip] {0}  already a junction" -f $src); continue }
  if (Test-Path -LiteralPath (Bak-Path $u)) { Say ("  [skip] {0}  a previous *.bak-migrating is pending -- resolve it first" -f $u.Dir); continue }
  $st = Get-Stats $src
  $plan += [pscustomobject]@{ Unit = $u; Src = $src; Dst = (Dst-Path $u $drive); Count = $st.Count; Bytes = $st.Bytes }
  Say ("  {0,-46} {1,6} files  {2,7:N2} GB" -f $src, $st.Count, ($st.Bytes / 1GB))
}
if ($plan.Count -eq 0) { Say "nothing to move."; exit 0 }
$totalGB = ($plan | Measure-Object -Property Bytes -Sum).Sum / 1GB
Say ""
Say ("  total to move: {0:N2} GB" -f $totalGB)
if ($vol.Free -lt ($totalGB * 1GB * 1.15)) { Fail "${drive}: free space is below the needed size +15% headroom" }

if (-not $Apply) {
  Say ""
  Say "PLAN ONLY (no -Apply given). Nothing was copied, renamed or linked."
  Say "Re-run with -Apply after closing every Qoder window."
  exit 0
}

# ---------------- migrate ----------------
$done = 0; $bad = 0
foreach ($p in $plan) {
  Say ""
  Say ("------ {0} ------" -f $p.Src)
  New-Item -ItemType Directory -Force -Path $p.Dst | Out-Null
  Say "  copying (robocopy /XJ so nested links are never followed)..."
  & robocopy $p.Src $p.Dst /E /COPY:DAT /XJ /R:1 /W:1 /NP /NFL /NDL /XD "*.bak-migrating" | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) { Say "  [FAIL] robocopy exit $rc -- source untouched"; $bad++; continue }
  $a = Get-Stats $p.Src; $b = Get-Stats $p.Dst
  if ($a.Count -ne $b.Count -or $a.Bytes -ne $b.Bytes) {
    Say ("  [FAIL] verify mismatch: src {0} files/{1} B  vs  dst {2} files/{3} B -- source untouched" -f $a.Count, $a.Bytes, $b.Count, $b.Bytes)
    $bad++; continue
  }
  Say ("  verified: {0} files, {1} bytes" -f $b.Count, $b.Bytes)
  try { Rename-Item -LiteralPath $p.Src -NewName ((Split-Path -Leaf $p.Src) + '.bak-migrating') }
  catch { Say "  [FAIL] rename blocked (something still holds it): $($_.Exception.Message)"; $bad++; continue }
  try { New-Item -ItemType Junction -Path $p.Src -Value $p.Dst | Out-Null }
  catch {
    Say "  [FAIL] junction failed: $($_.Exception.Message) -- restoring name"
    Rename-Item -LiteralPath (Bak-Path $p.Unit) -NewName (Split-Path -Leaf $p.Src); $bad++; continue
  }
  $probe = @(Get-ChildItem -LiteralPath $p.Src -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($probe.Count -eq 0) { Say "  [WARN] nothing readable through the new link -- check manually" }
  else {
    try { [IO.File]::OpenRead($probe[0].FullName).Close(); Say ("  ok: readable through {0} -> {1}" -f (Split-Path -Leaf $p.Src), 'link'); $done++ }
    catch { Say "  [WARN] read probe failed: $($_.Exception.Message)" }
  }
}

Say ""
Say ("=== finished: {0} migrated, {1} skipped/failed ===" -f $done, $bad)
Say "Next: start Qoder and confirm history/logs look normal; after a few good days, manually delete the *.bak-migrating copies (verify them first)."
Say "Rollback any time:      ... -File `"$PSCommandPath`" -Undo -Apply"
Say "log: $log"
