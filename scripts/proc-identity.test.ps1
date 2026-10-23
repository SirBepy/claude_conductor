<#
.SYNOPSIS
  Unit-tests proc-identity.ps1's PID-reuse guard against the real JSON round trip the rigs do.

.DESCRIPTION
  live-verify.ps1 and phone-verify.ps1 save Get-ProcIdentity's snapshot with ConvertTo-Json and
  read it back with ConvertFrom-Json at `down`. Under PowerShell 7 that round trip turned the
  recorded creation time into a [DateTime], and the rig's own process read back as "reused".
  Run it under both shells:

.EXAMPLE
  powershell -NoProfile -File scripts\proc-identity.test.ps1
  pwsh -NoProfile -File scripts\proc-identity.test.ps1
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'proc-identity.ps1')

$failures = @()
function Assert-Identity([string]$name, [string]$expected, [string]$actual) {
    if ($actual -ne $expected) { $script:failures += "${name}: expected '$expected', got '$actual'" }
}

$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$identity = Get-ProcIdentity $PID
$state = @{ AppPid = $PID; AppCreationTime = $identity.CreationTime; AppExePath = $identity.ExePath } |
    ConvertTo-Json | ConvertFrom-Json

Assert-Identity 'own process after a JSON round trip' 'match' `
    (Test-ProcIdentity -ProcId $state.AppPid -RecordedCreationTime $state.AppCreationTime -RecordedExePath $state.AppExePath)

# State files written before ticks: an 'o' string, which PowerShell 7 reads back as a DateTime.
$legacy = @{ T = $cim.CreationDate.ToString('o') } | ConvertTo-Json | ConvertFrom-Json
Assert-Identity 'legacy ISO-string state file' 'match' `
    (Test-ProcIdentity -ProcId $PID -RecordedCreationTime $legacy.T -RecordedExePath $cim.ExecutablePath)

$reusedTicks = $cim.CreationDate.AddMinutes(-5).ToUniversalTime().Ticks
Assert-Identity 'pid recorded for an older process' 'mismatch' `
    (Test-ProcIdentity -ProcId $PID -RecordedCreationTime $reusedTicks -RecordedExePath $cim.ExecutablePath)

Assert-Identity 'same creation time, different exe' 'mismatch' `
    (Test-ProcIdentity -ProcId $PID -RecordedCreationTime $identity.CreationTime -RecordedExePath 'C:\nowhere\other.exe')

Assert-Identity 'exe path differs only in case' 'match' `
    (Test-ProcIdentity -ProcId $PID -RecordedCreationTime $identity.CreationTime -RecordedExePath $identity.ExePath.ToUpperInvariant())

Assert-Identity 'no recorded creation time' 'unverifiable' `
    (Test-ProcIdentity -ProcId $PID -RecordedCreationTime $null -RecordedExePath $identity.ExePath)

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "FAIL: $_" }
    exit 1
}
Write-Host "PASS: proc-identity ($($PSVersionTable.PSVersion))"
