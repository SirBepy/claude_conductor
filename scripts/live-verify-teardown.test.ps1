<#
.SYNOPSIS
  Unit-tests live-verify.ps1's self-restart teardown fix: `down` must also kill any process whose exe path
  matches the rig's private copy, even one not tracked by PID (a self-restarted app, or the
  daemon's own `current_exe() --daemon` child), and must never touch a process at any other path.

.DESCRIPTION
  Exercises Stop-RigExeOrphans directly against a real spawned process rather than mocking
  Get-CimInstance: the whole point of the fix is matching Win32_Process's real ExecutablePath
  field, which a mock would have to fabricate anyway. A copy of powershell.exe is renamed to
  claude-conductor.exe in a scratch dir so Win32_Process.Name (derived from the file name) matches
  the filter Get-ExeHolders/Stop-RigExeOrphans use, standing in for the rig's own private copy
  without needing a real build.

  Before dot-sourcing, refuses to run if a real live-verify state file exists: this test's
  dot-source of `down` with no state is a safe no-op only when there is nothing recorded, and it
  must never risk touching another session's live rig.

.EXAMPLE
  powershell -NoProfile -File scripts\live-verify-teardown.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$scriptPath = Join-Path $repoRoot 'scripts\live-verify.ps1'
$realStatePath = Join-Path $env:LOCALAPPDATA 'claude-conductor-live-verify\state.json'
if (Test-Path $realStatePath) {
    Write-Host "A real live-verify state file exists at $realStatePath - refusing to run this test so it can never touch another session's rig."
    exit 1
}

# Skip the cargo-metadata probe during dot-sourcing (this test never runs cargo), same as
# wdio-sweep-headless.test.ps1.
$env:CARGO_TARGET_DIR = $env:TEMP

# 'down' with no state file is a safe no-op (checked above); dot-sourcing loads the script's
# functions (Stop-RigExeOrphans among them) without launching or tearing down anything real.
. $scriptPath down | Out-Null

$failures = @()
$scratchDir = Join-Path $env:TEMP "live-verify-test-$([guid]::NewGuid().ToString('N'))"
$otherDir = Join-Path $env:TEMP "live-verify-test-other-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $scratchDir -Force | Out-Null
New-Item -ItemType Directory -Path $otherDir -Force | Out-Null
$scratchExe = Join-Path $scratchDir 'claude-conductor.exe'
Copy-Item -Path (Get-Command powershell.exe).Source -Destination $scratchExe

$proc = $null
try {
    # Stands in for either case this fix covers: a self-restarted app or the daemon's own
    # `current_exe() --daemon` child - both are just a process running from the rig's exe path,
    # un-tracked by the PID recorded in state.json.
    $proc = Start-Process -FilePath $scratchExe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(10)
    $seen = @()
    while ((Get-Date) -lt $deadline) {
        $seen = @(Get-ExeHolders $scratchExe)
        if ($seen.Count -gt 0) { break }
        Start-Sleep -Milliseconds 300
    }
    if ($seen.Count -ne 1 -or $seen[0].ProcessId -ne $proc.Id) {
        $failures += "setup: expected Get-ExeHolders to see the spawned pid $($proc.Id) before teardown, got $(@($seen | ForEach-Object { $_.ProcessId }) -join ',')"
    }

    # The actual fix: kill it by exe path even though nothing tracked its PID.
    $killed = @(Stop-RigExeOrphans -ExePath $scratchExe)
    if ($killed.Count -ne 1 -or $killed[0].ProcessId -ne $proc.Id) {
        $failures += "Stop-RigExeOrphans: expected to report killing pid $($proc.Id), got $(@($killed | ForEach-Object { $_.ProcessId }) -join ',')"
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        Start-Sleep -Milliseconds 300
        $proc.Refresh()
    }
    if (-not $proc.HasExited) {
        $failures += "Stop-RigExeOrphans: pid $($proc.Id) is still running after teardown"
    }

    # Scoping proof: a path nobody runs from, even one that also ends in claude-conductor.exe,
    # must never report a match - this is what keeps teardown from ever reaching Joe's installed
    # app or the production daemon, which run from a different exe path entirely.
    $otherExe = Join-Path $otherDir 'claude-conductor.exe'
    $unrelated = @(Stop-RigExeOrphans -ExePath $otherExe)
    if ($unrelated.Count -ne 0) {
        $failures += "scoping: an unrelated path matched $($unrelated.Count) process(es)"
    }
} finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path $scratchDir, $otherDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    Write-Host "`nRESULT: FAIL ($($failures.Count) check(s))"
    exit 1
}
Write-Host 'RESULT: PASS - Stop-RigExeOrphans kills a process matched by exe path and only that path.'
exit 0
