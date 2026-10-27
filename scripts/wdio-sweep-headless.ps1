<#
.SYNOPSIS
  wdio-sweep.ps1's headless hop: builds the command that re-launches the sweep itself under
  server_supervisor headless, and reads back its verdict. Dot-sourced, not run directly.

.DESCRIPTION
  Split out of wdio-sweep.ps1 (flagged by /code-check as mixing the spec-sweep logic with this
  hop). Dot-sourced from wdio-sweep.ps1 at SCRIPT scope, right after its own
  supervisor-api.ps1 dot-source - never from inside a function - so:

  - These functions can see Get-SupervisorApi / Start-SupervisorHeadless / Get-SupervisorProcs /
    Invoke-Supervisor / Remove-SupervisorRig (supervisor-api.ps1, dot-sourced first) and
    wdio-sweep.ps1's own script-scope variables ($repoRoot, $Billed, $RealClaude, $FakeClaudeBin,
    $fakeClaudeBinGiven) without either file passing them around explicitly.
  - scripts/wdio-sweep-headless.test.ps1 can dot-source wdio-sweep.ps1 and then redefine
    Get-SupervisorApi/Invoke-Supervisor/etc at its own script scope to override the real ones:
    dot-sourcing merges into the caller's scope, so a later same-name function definition in that
    same scope replaces the earlier one. Sourcing these helpers inside a function instead would
    give them their own child scope, and the test's overrides would never be seen.

  Get-InSupervisorCommand stays here rather than in the generic supervisor-api.ps1: it builds
  wdio-sweep's own argument list (-Billed, -RealClaude, -FakeClaudeBin, -VerdictFile), which is
  specific to that script, not a general supervisor helper.
#>

# The command line the supervisor runs for the headless copy. Bare paths only: the supervisor's
# cmd /c turns a quoted one into a literal "\"...\"" (see live-verify.ps1), so a path with a space
# is refused here rather than mangled there.
function Get-InSupervisorCommand {
    param([string]$ScriptPath, [string]$VerdictFile, [switch]$Billed, [switch]$RealClaude, [string]$FakeClaudeBin, [string[]]$Spec)
    foreach ($p in @($ScriptPath, $VerdictFile, $FakeClaudeBin)) {
        if ($p -and $p.Contains(' ')) { throw "Cannot run headless with a space in '$p'; pass -Visible, or use a path without spaces." }
    }
    $parts = @('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, '-InSupervisor')
    if ($VerdictFile) { $parts += @('-VerdictFile', $VerdictFile) }
    if ($Billed) { $parts += '-Billed' }
    if ($RealClaude) { $parts += '-RealClaude' }
    if ($FakeClaudeBin) { $parts += @('-FakeClaudeBin', $FakeClaudeBin) }
    # -File binds one argument per name, so the list travels comma-joined and is split back there.
    if ($Spec) { $parts += @('-Spec', ($Spec -join ',')) }
    return ($parts -join ' ')
}

# The headless copy's verdict, read from its summary: the supervisor reports a status, not the exit
# code, so the sweep's own final line is the only pass/fail signal that survives the hop.
function Get-InSupervisorExitCode {
    param([string[]]$Lines)
    if (@($Lines | Where-Object { $_ -match '^SWEEP PASSED' }).Count -gt 0) { return 0 }
    return 1
}

# Re-launches this script under server_supervisor with its whole process tree headless, streams
# its output as it runs, and returns its verdict as an exit code.
#
# -ScriptPath must come from the caller, not an automatic variable read in here: $PSCommandPath/
# $PSScriptRoot inside a function resolve to the FILE THAT DEFINES the function (this file, now
# that the function lives here), not the script that dot-sourced it - reading it directly here
# would relaunch wdio-sweep-headless.ps1 itself instead of wdio-sweep.ps1. wdio-sweep.ps1's own
# main body passes its own $PSCommandPath explicitly; the default below only covers callers (the
# existing unit test) that don't care which path ends up in the built command.
function Invoke-SweepInSupervisor {
    param([string]$ScriptPath = $PSCommandPath)
    $api = Get-SupervisorApi
    if (-not $api) { throw 'server_supervisor is not running, so the sweep has nothing to run headless in. Start it, or pass -Visible to let the app windows open on the desktop.' }
    # Forward -FakeClaudeBin only when the caller gave one; the copy derives the same default itself.
    $fake = if ($fakeClaudeBinGiven) { $FakeClaudeBin } else { $null }
    $verdictPath = Join-Path $env:TEMP "wdio-sweep-verdict-$([guid]::NewGuid().ToString('N')).txt"
    $cmd = Get-InSupervisorCommand -ScriptPath $ScriptPath -VerdictFile $verdictPath -Billed:$Billed -RealClaude:$RealClaude -FakeClaudeBin $fake -Spec $Spec
    $started = Start-SupervisorHeadless $api $repoRoot $cmd 'wdio-sweep' $null
    Write-Host "Running headless under server_supervisor ($($started.id)); its dashboard previews the app window."
    $streamed = 0
    try {
        do {
            Start-Sleep -Seconds 3
            # The supervisor deletes an ephemeral command once it exits, so its log can 404 between
            # these two reads; the verdict file below is what carries the summary across that.
            try {
                $proc = Get-SupervisorProcs $api | Where-Object { $_.id -eq $started.id } | Select-Object -First 1
                $fresh = @(Invoke-Supervisor $api 'GET' "/procs/$($started.id)/logs" | ForEach-Object { $_.text })
            } catch { break }
            $fresh | Select-Object -Skip $streamed | ForEach-Object { Write-Host $_ }
            $streamed = $fresh.Count
        } while ($proc -and $proc.status -in 'running', 'starting')
    } finally {
        # Also what stops the headless copy, and every wdio/app process under it, on Ctrl+C.
        Remove-SupervisorRig $api $started.id
    }
    if (-not (Test-Path $verdictPath)) {
        Write-Host "`nThe headless copy wrote no summary: it died or was stopped before finishing."
        return 1
    }
    $summary = @(Get-Content -Path $verdictPath)
    Remove-Item -Path $verdictPath -ErrorAction SilentlyContinue
    $summary | ForEach-Object { Write-Host $_ }
    return (Get-InSupervisorExitCode -Lines $summary)
}
