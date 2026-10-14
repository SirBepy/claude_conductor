<#
.SYNOPSIS
  Unit-tests wdio-sweep.ps1's headless hop (the command it hands server_supervisor and the verdict
  it reads back) without starting the supervisor or wdio.

.EXAMPLE
  powershell -NoProfile -File scripts\wdio-sweep-headless.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$scriptPath = Join-Path $repoRoot 'scripts\wdio-sweep.ps1'

# Skip the cargo-metadata probe during dot-sourcing (this test never runs cargo).
$env:CARGO_TARGET_DIR = $env:TEMP
. $scriptPath -WhatIf

$failures = @()

# The copy must run the sweep itself, never hop again, and carry the caller's switches across.
$cmd = Get-InSupervisorCommand -ScriptPath 'C:\repo\scripts\wdio-sweep.ps1'
if ($cmd -ne 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\repo\scripts\wdio-sweep.ps1 -InSupervisor') {
    $failures += "plain command: got '$cmd'"
}
$cmd = Get-InSupervisorCommand -ScriptPath 'C:\repo\scripts\wdio-sweep.ps1' -VerdictFile 'C:\tmp\v.txt' -Billed -RealClaude -FakeClaudeBin 'C:\tmp\fake\claude.cmd'
# The verdict file is what survives the supervisor deleting the finished command and its log.
foreach ($want in '-InSupervisor', '-VerdictFile C:\tmp\v.txt', '-Billed', '-RealClaude', '-FakeClaudeBin C:\tmp\fake\claude.cmd') {
    if (-not $cmd.Contains($want)) { $failures += "switches: '$want' missing from '$cmd'" }
}

# A space would reach cmd /c mangled; refusing is the only safe answer.
$threw = $false
try { Get-InSupervisorCommand -ScriptPath 'C:\My Repo\scripts\wdio-sweep.ps1' | Out-Null } catch { $threw = $true }
if (-not $threw) { $failures += 'space in script path: expected a throw' }

# Verdict: only the copy's own PASSED line counts; a missing summary (killed or crashed copy) fails.
if ((Get-InSupervisorExitCode -Lines @('=== Summary ===', '', 'SWEEP PASSED (or dry run via -WhatIf)')) -ne 0) {
    $failures += 'passed output: expected exit 0'
}
if ((Get-InSupervisorExitCode -Lines @('SWEEP FAILED (1 spec(s))')) -ne 1) { $failures += 'failed output: expected exit 1' }
if ((Get-InSupervisorExitCode -Lines @('=== Running smoke ===')) -ne 1) { $failures += 'truncated output: expected exit 1' }
if ((Get-InSupervisorExitCode -Lines @()) -ne 1) { $failures += 'no output: expected exit 1' }

# Get-SupervisorProcs must yield one proc per item: PowerShell 5.1 emits a parsed JSON array as one
# object, which once let a filter for one proc id pass every proc through.
. (Join-Path $repoRoot 'scripts\supervisor-api.ps1')
function Invoke-Supervisor { '[{"id":"p:a","status":"running"},{"id":"p:b","status":"stopped"}]' | ConvertFrom-Json }
$match = @(Get-SupervisorProcs $null | Where-Object { $_.id -eq 'p:b' })
if ($match.Count -ne 1 -or [string]$match[0].id -ne 'p:b' -or [string]$match[0].status -ne 'stopped') {
    $failures += "Get-SupervisorProcs filter: expected only p:b, got '$([string]$match[0].id)'"
}

# The race: the copy finishes, the supervisor reaps its ephemeral command, and the launcher's next
# log read 404s. The verdict must still come from the copy's summary, not read as a failure.
function Get-SupervisorApi { [pscustomobject]@{ Token = 't'; BaseUrl = 'http://127.0.0.1:1' } }
function Get-SupervisorProcs { }
function Invoke-Supervisor { throw 'unknown process id: p:wdio-sweep' }
function Remove-SupervisorRig { }
function Start-Sleep { }
function Start-SupervisorHeadless($api, $Root, $Cmd, $Name, $EnvBlock) {
    $path = [regex]::Match($Cmd, '-VerdictFile (\S+)').Groups[1].Value
    if ($script:copyWritesSummary) { [System.IO.File]::WriteAllText($path, "=== Summary ===`r`nSWEEP PASSED (or dry run via -WhatIf)") }
    [pscustomobject]@{ id = 'p:wdio-sweep' }
}
$script:copyWritesSummary = $true
$code = Invoke-SweepInSupervisor 6> $null
if ($code -ne 0) { $failures += "reaped command with a PASSED summary: expected exit 0, got '$code'" }
# A copy that died before its summary must never read as a pass.
$script:copyWritesSummary = $false
$code = Invoke-SweepInSupervisor 6> $null
if ($code -ne 1) { $failures += "copy died without a summary: expected exit 1, got '$code'" }

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    Write-Host "`nRESULT: FAIL ($($failures.Count) check(s))"
    exit 1
}
Write-Host 'RESULT: PASS - headless command and verdict checks all hold.'
exit 0
