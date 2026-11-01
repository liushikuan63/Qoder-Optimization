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

  Safety: copy -> verify relative file paths and streaming SHA256 -> rename original aside
  (*.bak-migrating) -> create junction -> read a file through the new path.
  Failed verification keeps both copies. After a cutover failure, retain the
  backup and receipt and inspect the log before attempting recovery.
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
function Receipt-Path($u) { (Bak-Path $u) + '.receipt.json' }
function Dst-Path($u, $drive) { "{0}:\qoder-data\{1}\{2}" -f $drive, $u.Side, $u.Dir }

function Test-Reparse($p) {
  if (-not (Test-Path -LiteralPath $p)) { return $false }
  ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}
function Get-Stats($p) {
  $f = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)
  [pscustomobject]@{ Count = $f.Count; Bytes = (($f | Measure-Object -Property Length -Sum).Sum | ForEach-Object { [int64]$_ }) }
}
function Canonical-Path([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { throw 'empty path' }
  if ($p.StartsWith('\\?\') -or $p.StartsWith('\??\')) { $p = $p.Substring(4) }
  [IO.Path]::GetFullPath($p).TrimEnd([char[]]'\/')
}
function Same-Path($a, $b) { [StringComparer]::OrdinalIgnoreCase.Equals((Canonical-Path $a), (Canonical-Path $b)) }
function Assert-ClientStopped {
  try { $running = @(Get-Process -ErrorAction Stop | Where-Object { $_.Name -like 'Qoder*' }) }
  catch { Fail "cannot verify that Qoder is closed: $($_.Exception.Message)" }
  if ($running.Count -gt 0) { Fail ("Qoder client still running: " + (($running | Select-Object -ExpandProperty Name -Unique) -join ', ') + '; close every window and tray process first.') }
}
function Get-TreeProof($p) {
  $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "not an ordinary directory: $p" }
  $prefix = (Canonical-Path $p) + '\'
  $pending = New-Object 'System.Collections.Generic.Queue[string]'
  $rows = New-Object 'System.Collections.Generic.List[string]'
  $pending.Enqueue($p); $bytes = [int64]0
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force -ErrorAction Stop) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "reparse point in verification tree: $($entry.FullName)" }
      if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName); continue }
      # Hash streams directly so verification also works when optional PowerShell
      # modules are unavailable in an isolated or minimal child environment.
      $fileStream = [IO.File]::OpenRead($entry.FullName)
      $fileHash = [Security.Cryptography.SHA256]::Create()
      try { $digest = [BitConverter]::ToString($fileHash.ComputeHash($fileStream)).Replace('-', '').ToLowerInvariant() }
      finally { $fileHash.Dispose(); $fileStream.Dispose() }
      $relative = $entry.FullName.Substring($prefix.Length)
      $rows.Add($relative + "`t" + $entry.Length + "`t" + $digest)
      $bytes += $entry.Length
    }
  }
  $ordered = $rows.ToArray(); [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($ordered -join "`n")))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  [pscustomobject]@{ Count = $rows.Count; Bytes = $bytes; SHA256 = $digest; CreatedUtc = $item.CreationTimeUtc.ToString('o') }
}
function Same-Tree($a, $b) { $a.Count -eq $b.Count -and $a.Bytes -eq $b.Bytes -and $a.SHA256 -eq $b.SHA256 }
function Test-CopyDestination($src, $dst) {
  # Validate ancestors before inspecting a leaf: a normal-looking leaf may be
  # reached through a junction. robocopy /XJ does not protect destination links.
  $paths = New-Object 'System.Collections.Generic.List[string]'
  $cursor = Canonical-Path $dst
  while ($cursor) { $paths.Add($cursor); $cursor = [IO.Path]::GetDirectoryName($cursor) }
  $ancestors = $paths.ToArray(); [Array]::Reverse($ancestors)
  foreach ($ancestor in $ancestors) {
    if (-not (Test-Path -LiteralPath $ancestor)) { continue }
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "copy destination or ancestor is not an ordinary directory: $ancestor" }
  }
  if (Test-Path -LiteralPath $dst) {
    $contents = @(Get-ChildItem -LiteralPath $dst -Force -ErrorAction Stop)
    if ($contents.Count -gt 0) {
      # Never overwrite unrelated or partially copied destination data. A fully
      # matching tree needs no copy, and any nested reparse point is rejected.
      $sourceProof = Get-TreeProof $src; $targetProof = Get-TreeProof $dst
      if (-not (Same-Tree $sourceProof $targetProof)) { throw 'existing destination conflicts with source (relative file paths or SHA256 differ); no files copied' }
      return $true
    }
  }
  return $false
}
function Assert-JunctionTarget($src, $dst) {
  $link = Get-Item -LiteralPath $src -Force -ErrorAction Stop
  $targets = @($link.Target)
  if ($link.LinkType -ne 'Junction' -or $targets.Count -ne 1 -or -not (Same-Path $targets[0] $dst)) { throw "junction target does not match migration destination: $src" }
}

# ---------------- rollback ----------------
if ($Undo) {
  if ($Apply) { Assert-ClientStopped }
  Say "=== rollback: remove junctions, restore *.bak-migrating ==="
  $undoBad = 0
  foreach ($d in $allowedDrives) {
    foreach ($u in $units) {
      $dst = Dst-Path $u $d
      if (-not (Test-Path -LiteralPath $dst)) { continue }
      $src = Src-Path $u; $bak = Bak-Path $u
      if (-not (Test-Reparse $src)) { continue }
      try {
        Assert-JunctionTarget $src $dst
        $receipt = Receipt-Path $u
        if (-not (Test-Path -LiteralPath $receipt -PathType Leaf) -or (Test-Reparse $receipt)) { throw "trusted migration receipt missing: $receipt; legacy backups require manual review" }
        $record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        if ($record.Schema -ne 1 -or -not (Same-Path $record.Source $src) -or -not (Same-Path $record.Destination $dst) -or -not (Same-Path $record.Backup $bak)) { throw 'migration receipt paths do not match this rollback' }
        $proof = Get-TreeProof $bak
        if (-not (Same-Tree $proof $record.BackupProof) -or $proof.CreatedUtc -ne $record.BackupProof.CreatedUtc) { throw 'backup identity or contents changed; keeping link and data' }
        $destinationProof = Get-TreeProof $dst
        if (-not (Same-Tree $destinationProof $record.BackupProof)) { throw 'destination contains changes since migration; keep the junction and reconcile current data before rollback' }
        Say "  verified junction and backup: $src -> $dst"
        if (-not $Apply) { Say "    (dry run; add -Apply to really roll back)"; continue }
        Assert-JunctionTarget $src $dst
        # The target is bound above. Delete only this junction, without shell or recursion.
        [IO.Directory]::Delete($src)
        try { Rename-Item -LiteralPath $bak -NewName (Split-Path -Leaf $src) -ErrorAction Stop }
        catch {
          if (-not (Test-Path -LiteralPath $src)) { New-Item -ItemType Junction -Path $src -Value $dst | Out-Null }
          throw
        }
        $restored = Get-TreeProof $src
        if (-not (Same-Tree $restored $record.BackupProof) -or $restored.CreatedUtc -ne $record.BackupProof.CreatedUtc) { throw 'restored directory did not pass read-back verification; all data and receipt retained' }
        Move-Item -LiteralPath $receipt -Destination ($receipt + '.rolled-back-' + [Guid]::NewGuid().ToString('N'))
        Say "    restored and SHA256 verified: $src"
      } catch { $undoBad++; Say "  [FAIL] rollback refused or incomplete: $($_.Exception.Message)" }
    }
  }
  Say "done. log: $log"
  if ($undoBad -gt 0) { exit 1 }
  exit 0
}

# ---------------- preflight ----------------
if (-not $To) { Fail "missing -To <drive letter>, e.g. -To D" }
$drive = ($To -replace '[:\\]', '').ToUpper()
if ($drive -notin $allowedDrives) { Fail "refusing target drive '$drive' (A/B/C are system or removable)" }
$vol = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
if (-not $vol) { Fail "drive ${drive}: not found" }

if ($Apply) { Assert-ClientStopped }

Say "=== Qoder data migration: C: -> ${drive}: ==="
Say ("free space on ${drive}: {0:N1} GB" -f ($vol.Free / 1GB))
Say ""

$plan = @()
foreach ($u in $units) {
  $src = Src-Path $u
  if (-not (Test-Path -LiteralPath $src)) { continue }
  if (Test-Reparse $src) { Say ("  [skip] {0}  already a junction" -f $src); continue }
  if ((Test-Path -LiteralPath (Bak-Path $u)) -or (Test-Path -LiteralPath (Receipt-Path $u))) { Fail ("pending migration backup or receipt for {0}; resolve it first" -f $u.Dir) }
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
  try { $alreadyCopied = Test-CopyDestination $p.Src $p.Dst }
  catch { Say "  [FAIL] unsafe copy destination: $($_.Exception.Message) -- source and destination retained"; $bad++; continue }
  New-Item -ItemType Directory -Force -Path $p.Dst | Out-Null
  if ($alreadyCopied) { Say '  destination already matches; no existing files overwritten' }
  else {
    Say "  copying into a checked empty destination (robocopy /XJ)..."
    & robocopy $p.Src $p.Dst /E /COPY:DAT /XJ /R:1 /W:1 /NP /NFL /NDL /XD "*.bak-migrating" | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) { Say "  [FAIL] robocopy exit $rc -- source untouched"; $bad++; continue }
  }
  try {
    $a = Get-TreeProof $p.Src; $b = Get-TreeProof $p.Dst
    if (-not (Same-Tree $a $b)) { throw 'relative file paths or SHA256 differ' }
  } catch { Say "  [FAIL] full verification failed: $($_.Exception.Message) -- source and destination retained"; $bad++; continue }
  Say ("  SHA256 verified: {0} files, {1} bytes" -f $b.Count, $b.Bytes)
  try { Rename-Item -LiteralPath $p.Src -NewName ((Split-Path -Leaf $p.Src) + '.bak-migrating') }
  catch { Say "  [FAIL] rename blocked (something still holds it): $($_.Exception.Message)"; $bad++; continue }
  try {
    $backupProof = Get-TreeProof (Bak-Path $p.Unit)
    if (-not (Same-Tree $a $backupProof)) { throw 'source changed before rename; refusing switch' }
    $record = [ordered]@{ Schema = 1; Source = (Canonical-Path $p.Src); Destination = (Canonical-Path $p.Dst); Backup = (Canonical-Path (Bak-Path $p.Unit)); BackupProof = $backupProof }
    $receipt = Receipt-Path $p.Unit
    $stream = [IO.File]::Open($receipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $data = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 5)); $stream.Write($data, 0, $data.Length) } finally { $stream.Dispose() }
    New-Item -ItemType Junction -Path $p.Src -Value $p.Dst | Out-Null
    Assert-JunctionTarget $p.Src $p.Dst
  }
  catch {
    Say "  [FAIL] junction failed: $($_.Exception.Message) -- restoring name"
    Rename-Item -LiteralPath (Bak-Path $p.Unit) -NewName (Split-Path -Leaf $p.Src); $bad++; continue
  }
  $probe = @(Get-ChildItem -LiteralPath $p.Src -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($probe.Count -eq 0) {
    if ($b.Count -eq 0) { Say '  ok: verified empty directory junction'; $done++ }
    else { Say '  [FAIL] no file readable through the new link; backup and receipt retained'; $bad++ }
  }
  else {
    try { [IO.File]::OpenRead($probe[0].FullName).Close(); Say ("  ok: readable through {0} -> {1}" -f (Split-Path -Leaf $p.Src), 'link'); $done++ }
    catch { Say "  [FAIL] read probe failed: $($_.Exception.Message); backup and receipt retained"; $bad++ }
  }
}

Say ""
Say ("=== finished: {0} migrated, {1} skipped/failed ===" -f $done, $bad)
Say "Next: start Qoder and confirm history/logs look normal; after a few good days, manually delete the *.bak-migrating copies (verify them first)."
Say "Rollback any time:      ... -File `"$PSCommandPath`" -Undo -Apply"
Say "log: $log"
# Preserve the per-directory result for callers; a printed failure is not success.
if ($bad -gt 0) { exit 1 }
exit 0
