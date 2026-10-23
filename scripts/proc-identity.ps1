<#
.SYNOPSIS
  PID-reuse guard shared by live-verify.ps1 and phone-verify.ps1: snapshot a just-started
  process at `up`, then tell "still ours" from "PID got reused" at `down`.

.DESCRIPTION
  The creation time is recorded as UTC ticks (an integer), never as a date string. PowerShell 7's
  ConvertFrom-Json turns an ISO date string back into a [DateTime], and binding that to a
  [string] parameter renders it as "10/23/2026 17:47:43", which never equals the original
  'o'-format string - so every rig's own process read back as "reused" and `down` left it running.
  Test-ProcIdentity still accepts the older string/DateTime forms so a state file written before
  this change tears down correctly.
#>

function Get-ProcIdentity([int]$procId) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $cim) { return $null }
    return [PSCustomObject]@{
        CreationTime = $cim.CreationDate.ToUniversalTime().Ticks
        ExePath      = $cim.ExecutablePath
    }
}

# Normalises every shape a recorded creation time can arrive in (ticks, an ISO string from
# Windows PowerShell 5.1's ConvertFrom-Json, a [DateTime] from PowerShell 7's) to UTC ticks.
function ConvertTo-UtcTicks($value) {
    if ($null -eq $value -or $value -eq '') { return $null }
    if ($value -is [DateTime]) { return $value.ToUniversalTime().Ticks }
    if ($value -is [long] -or $value -is [int] -or $value -is [double] -or $value -is [decimal]) { return [long]$value }
    $ticks = 0L
    if ([long]::TryParse([string]$value, [ref]$ticks)) { return $ticks }
    $parsed = [DateTime]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::RoundtripKind
    if ([DateTime]::TryParse([string]$value, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed.ToUniversalTime().Ticks
    }
    return $null
}

# 'gone' = no such process anymore (nothing to kill). 'unverifiable' = no usable recorded creation
# time - never kill blindly. 'mismatch' = PID is alive but is not the process we started (reused
# PID). 'match' = safe to kill. The comparison allows under one second of drift, because an older
# state file may have lost the sub-second part in a DateTime round trip; a reused PID is a new
# process, created long after ours. Exe path is a secondary check, enforced only when BOTH sides
# have it, since a locked-down live process can legitimately report a null ExecutablePath.
function Test-ProcIdentity {
    param(
        [Parameter(Mandatory = $true)][int]$ProcId,
        $RecordedCreationTime,
        [string]$RecordedExePath
    )
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
    if (-not $cim) { return 'gone' }
    $recordedTicks = ConvertTo-UtcTicks $RecordedCreationTime
    if ($null -eq $recordedTicks) { return 'unverifiable' }
    $liveTicks = $cim.CreationDate.ToUniversalTime().Ticks
    if ([Math]::Abs($liveTicks - $recordedTicks) -ge [TimeSpan]::TicksPerSecond) { return 'mismatch' }
    if ($RecordedExePath -and $cim.ExecutablePath -and ($RecordedExePath -ne $cim.ExecutablePath)) {
        return 'mismatch'
    }
    return 'match'
}
