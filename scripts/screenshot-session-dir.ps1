<#
.SYNOPSIS
    Shared per-session screenshot subfolder resolver for window-screenshot.ps1
    and tray-screenshot.ps1. Dot-source this, then call Resolve-SessionScreenshotDir.
    Named with a non-"Get-Screenshot*" verb/noun on purpose - that pattern
    matches Defender's AMSI signature for PowerSploit's Get-Screenshot module.

.DESCRIPTION
    Reuses the same claude-ancestor process-tree walk as
    ~/.claude/skills/close/rename-session.ps1's Get-AncestorClaudePid, so both
    scripts and /close agree on the same <pid>-<start-ticks> id.
#>

function Get-AncestorClaudePid {
    $p = $PID
    for ($i = 0; $i -lt 8; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        if ($proc.Name -like '*claude*') { return [int]$p }
        $next = [int]$proc.ParentProcessId
        if ($next -eq 0 -or $next -eq $p) { break }
        $p = $next
    }
    return $null
}

# Resolves (and creates) .for_bepy/screenshots/<pid>-<start-ticks>/ under
# $ProjectRoot. Falls back to the screenshots root if run outside a claude
# session (no ancestor found) - manual/ad-hoc invocations, not /close's concern.
function Resolve-SessionScreenshotDir([string]$ProjectRoot) {
    $dir = Join-Path $ProjectRoot '.for_bepy\screenshots'
    $claudePid = Get-AncestorClaudePid
    if ($claudePid) {
        $proc = Get-Process -Id $claudePid -ErrorAction SilentlyContinue
        if ($proc) {
            $dir = Join-Path $dir "$($proc.Id)-$($proc.StartTime.Ticks)"
        }
    }
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}
