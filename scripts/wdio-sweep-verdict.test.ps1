<#
.SYNOPSIS
  Unit-tests wdio-sweep.ps1's verdict/status logic without running wdio.

.DESCRIPTION
  A spec that exits 0 and never printed mocha's "N passing"/"N failing" summary parses to
  Passing=0/Failing=0, which an exit-code-and-failing-count check reads as OK - a false pass on a
  spec that ran nothing. Dot-sources the script (main body guarded off, see wdio-sweep.ps1's
  InvocationName check) and verifies Get-WdioStatus reads that case as NO SUMMARY, while a real
  passing run still reads OK and a real failing run still reads FAIL.

.EXAMPLE
  powershell -NoProfile -File scripts\wdio-sweep-verdict.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$scriptPath = Join-Path $repoRoot 'scripts\wdio-sweep.ps1'

# --- Load the script's functions without running its sweep body. ---
# Skip the cargo-metadata probe during dot-sourcing (this test never runs cargo).
$env:CARGO_TARGET_DIR = $env:TEMP
. $scriptPath -WhatIf

$stamp = "$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$emptyLog = Join-Path $env:TEMP "wdio-sweep-test-empty-$stamp.log"
$passingLog = Join-Path $env:TEMP "wdio-sweep-test-passing-$stamp.log"
$failingLog = Join-Path $env:TEMP "wdio-sweep-test-failing-$stamp.log"

[System.IO.File]::WriteAllText($emptyLog, "startup noise only`nno mocha summary ever printed`n")
[System.IO.File]::WriteAllText($passingLog, "  7 passing (3s)`n")
[System.IO.File]::WriteAllText($failingLog, "  5 passing (3s)`n  2 failing`n`n  1) some test:`n     Error: boom`n")

$failures = @()

try {
    # Case 1 (the bug): exit 0, no summary line at all -> must NOT read as OK.
    $v = Get-WdioVerdict -LogPath $emptyLog
    if ($v.SawSummary) { $failures += "empty log: expected SawSummary=false, got true" }
    if ($v.Passing -ne 0 -or $v.Failing -ne 0) { $failures += "empty log: expected Passing=0/Failing=0, got Passing=$($v.Passing)/Failing=$($v.Failing)" }
    $status = Get-WdioStatus -ExitCode 0 -Failing $v.Failing -SawSummary $v.SawSummary
    if ($status -eq 'OK') { $failures += "empty log: status came back OK, a no-summary run reads as a pass" }
    if ($status -ne 'NO SUMMARY') { $failures += "empty log: expected status 'NO SUMMARY', got '$status'" }

    # Case 2: exit 0, "N passing" present, no failures -> OK.
    $v = Get-WdioVerdict -LogPath $passingLog
    if (-not $v.SawSummary) { $failures += "passing log: expected SawSummary=true, got false" }
    if ($v.Passing -ne 7) { $failures += "passing log: expected Passing=7, got $($v.Passing)" }
    $status = Get-WdioStatus -ExitCode 0 -Failing $v.Failing -SawSummary $v.SawSummary
    if ($status -ne 'OK') { $failures += "passing log: expected OK, got '$status'" }

    # Case 3: exit 0, "N failing" present -> FAIL.
    $v = Get-WdioVerdict -LogPath $failingLog
    $status = Get-WdioStatus -ExitCode 0 -Failing $v.Failing -SawSummary $v.SawSummary
    if ($status -ne 'FAIL') { $failures += "failing log: expected FAIL, got '$status'" }
} finally {
    Remove-Item -Path $emptyLog, $passingLog, $failingLog -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    Write-Host "`nRESULT: FAIL ($($failures.Count) check(s))"
    exit 1
} else {
    Write-Host "`nRESULT: PASS - NO SUMMARY, OK, and FAIL cases all verified against Get-WdioStatus."
    exit 0
}
