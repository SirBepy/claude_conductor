<#
.SYNOPSIS
  Unit-tests live-verify.ps1's -ExtraEnv parsing (Get-ExtraEnvRows): the rig's app and the daemon it
  spawns can be given extra KEY=VALUE environment (CC_IDLE_FREEZE_SECS for a freeze check that
  cannot wait the real delay), and an entry that could break the supervisor's newline-separated env
  list is refused instead of passed on.

.DESCRIPTION
  Refuses to run if a real live-verify state file exists: dot-sourcing `down` is a safe no-op only
  when nothing is recorded, and this test must never risk touching another session's rig.

.EXAMPLE
  powershell -NoProfile -File scripts\live-verify-extra-env.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$scriptPath = Join-Path $repoRoot 'scripts\live-verify.ps1'
$realStatePath = Join-Path $env:LOCALAPPDATA 'claude-conductor-live-verify\state.json'
if (Test-Path $realStatePath) {
    Write-Host "A real live-verify state file exists at $realStatePath - refusing to run this test so it can never touch another session's rig."
    exit 1
}

# Skip the cargo-metadata probe during dot-sourcing (this test never runs cargo).
$env:CARGO_TARGET_DIR = $env:TEMP
. $scriptPath down | Out-Null

$failures = @()

$rows = @(Get-ExtraEnvRows @('CC_IDLE_FREEZE_SECS=25', 'CC_X=a=b'))
if ($rows.Count -ne 2) { $failures += "expected 2 rows, got $($rows.Count)" }
else {
    if ($rows[0].Name -ne 'CC_IDLE_FREEZE_SECS' -or $rows[0].Value -ne '25') { $failures += "first pair was split as $($rows[0].Name)=$($rows[0].Value)" }
    if ($rows[1].Value -ne 'a=b') { $failures += "a value holding '=' must keep it whole, got '$($rows[1].Value)'" }
}

if (@(Get-ExtraEnvRows @()).Count -ne 0) { $failures += 'no pairs must give no rows' }

# Empty value: Windows PowerShell 5.1's Set-Item Env: leaves the variable unset, so the -Visible and
# supervisor paths would disagree. Rig-owned names: overriding them could aim the rig at the live app.
# A trailing newline: `$` would let it through.
$badEntries = @('NOEQUALS', '=novalue', '1BAD=x', 'BAD NAME=x', 'CC_EMPTY=', "CC_A=line1`nCC_B=smuggled", "CC_A=x`r", "CC_A=x`n",
    'CC_DAEMON_INSTANCE=live', 'cc_data_dir=C:\x', 'CC_DATA_DIR=C:\x', 'WEBVIEW2_USER_DATA_FOLDER=C:\x', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--x')
foreach ($bad in $badEntries) {
    $refused = $false
    try { Get-ExtraEnvRows @($bad) | Out-Null } catch { $refused = $true }
    if (-not $refused) { $failures += "entry '$($bad -replace "`r", '\r' -replace "`n", '\n')' was accepted" }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "FAIL: $_" }
    exit 1
}
Write-Host 'live-verify -ExtraEnv parsing: all checks passed'
