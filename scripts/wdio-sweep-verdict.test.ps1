<#
.SYNOPSIS
  Unit-tests wdio-sweep.ps1's verdict/status logic without running wdio.

.DESCRIPTION
  Proves a RED baseline against HEAD's own formula first: a spec that exits 0 and never printed
  mocha's "N passing"/"N failing" summary parsed to Passing=0/Failing=0, and
  `$exitCode -eq 0 -and $verdict.Failing -eq 0` read that as OK - a false pass on a spec that ran
  nothing. Then dot-sources the fixed script (main body guarded off, see wdio-sweep.ps1's
  InvocationName check) and verifies Get-WdioStatus now reads that same case as NO SUMMARY, while
  a real passing run still reads OK and a real failing run still reads FAIL.

.EXAMPLE
  powershell -NoProfile -File scripts\wdio-sweep-verdict.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$scriptPath = Join-Path $repoRoot 'scripts\wdio-sweep.ps1'

# --- RED baseline: reproduce HEAD's (pre-fix) status formula verbatim and show it goes OK. ---
$headContent = (git show HEAD:scripts/wdio-sweep.ps1) -join "`n"
$needle = '$exitCode -eq 0 -and $verdict.Failing -eq 0'
if ($headContent -notmatch [regex]::Escape($needle)) {
    throw "RED baseline assumption no longer holds: HEAD's status formula text changed from '$needle' - re-derive the baseline before trusting this test."
}
# Empty log parses to Passing=0, Failing=0 under HEAD's own Get-WdioVerdict (unchanged shape for
# these two fields); exit 0 is what a spec that silently ran nothing but didn't crash reports.
$baselineExitCode = 0
$baselineFailing = 0
$baselineStatus = if ($baselineExitCode -eq 0 -and $baselineFailing -eq 0) { 'OK' } else { 'FAIL' }
if ($baselineStatus -ne 'OK') {
    throw "RED baseline did not reproduce the bug - expected HEAD's formula to call an empty (no-summary) log OK, got '$baselineStatus'."
}
Write-Host "RED baseline confirmed: HEAD's formula marks an exit-0, no-summary log as OK (the bug being fixed)."

# --- Load the fixed script's functions without running its sweep body. ---
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
    if ($status -eq 'OK') { $failures += "empty log: GREEN check failed - status came back OK, bug not fixed" }
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
    Write-Host "`nRESULT: PASS - NO SUMMARY, OK, and FAIL cases all verified against the fixed Get-WdioStatus."
    exit 0
}
