<#
.SYNOPSIS
  Runs the whole wdio release-gate sweep in one call: the 7 free specs (daemon-lifecycle last),
  then chat-flow and reload-dup, with every spec's full output kept on disk and a one-line verdict
  printed per spec. See .claude/todos/1121-wdio-sweep-script.md.

.DESCRIPTION
  `pnpm test:e2e` only runs 2 of the specs (smoke, daemon-lifecycle) - see
  [[project_wdio_suite_traps]]. Earlier release sessions hand-typed the same loop of
  `pnpm exec wdio run e2e/wdio.conf.js --spec e2e/specs/<name>.e2e.js` calls and grep-filtered the
  output down to the passing/failing lines, throwing away the full log (todo 1055). This script
  encodes the gate rules instead of re-deriving them under time pressure each release:

  - Free specs (no quota): smoke, held-messages, multi-account, news-redesign, question-card,
    schedule-view, daemon-lifecycle. probe.e2e.js is a debugging harness, not a suite member, and
    is never included.
  - daemon-lifecycle runs LAST: a seeding spec run right after it can fail its own `before all`
    with a false 15s row timeout ([[project_wdio_daemon_lifecycle_poisons_next_spec]], todo 957).
  - chat-flow and reload-dup are billed specs that run for FREE by default against a fake `claude`
    stream-json stub via CC_CLAUDE_BIN ([[project_wdio_billed_specs_free_via_fake_claude]]). Pass
    -RealClaude to bill real turns for them instead.
  - question-card-live genuinely needs a real model (it must call the MCP ask tool) and only runs
    behind an explicit -Billed switch.
  - Never runs two wdio invocations at once: refuses to start (and refuses each spec) while port
    1420 (vite) or 4444 (tauri-driver) is already listening, naming the owning pid - and never
    kills it ([[project_wdio_suite_traps]] #2 and #4; a leftover live-verify.ps1 rig or another
    session's wdio run are both real, observed causes).
  - Archives %APPDATA%\claude-conductor\interactive-sessions-wdio.json before the sweep: that
    registry accumulates real chats across billed runs and rots chat-flow's sidebar-lookup
    assertions after ~30 ([[project_wdio_suite_traps]] #3).
  - Warns (does not build, and does not block) if the debug exe is older than the last src-tauri
    commit - a stale binary makes the whole sweep a silent false green
    ([[project_wdio_gate_passes_against_stale_binary]]). This script never runs cargo; run
    `cargo build --manifest-path src-tauri/Cargo.toml` yourself first.

  Every spec's full stdout+stderr lands at .for_bepy/wdio-logs/<timestamp>/<spec>.log. Exits
  non-zero if any spec failed (by mocha's own passing/failing count, or a non-zero wdio exit code).

.PARAMETER Billed
  Adds question-card-live to the sweep (real model, ~2 haiku turns per run per
  [[project_wdio_billed_specs_cannot_pass_mcp_permission]]). Off by default.

.PARAMETER RealClaude
  Runs chat-flow and reload-dup against the real `claude` CLI (bills real turns) instead of the
  default fake stub. Off by default.

.PARAMETER FakeClaudeBin
  Path to a stream-json stub CLI used for chat-flow/reload-dup unless -RealClaude is passed.
  Defaults to the committed e2e\fixtures\fake-claude\claude.cmd.

.EXAMPLE
  scripts\wdio-sweep.ps1
  scripts\wdio-sweep.ps1 -Billed
  scripts\wdio-sweep.ps1 -RealClaude
  scripts\wdio-sweep.ps1 -WhatIf
  scripts\wdio-sweep.ps1 -FakeClaudeBin C:\tmp\my-fake-claude\claude.cmd
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Billed,

    [switch]$RealClaude,

    [string]$FakeClaudeBin
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
if (-not $FakeClaudeBin) { $FakeClaudeBin = Join-Path $repoRoot 'e2e\fixtures\fake-claude\claude.cmd' }

# cargo's target dir is not repo-local here (the global ~/.cargo/config.toml redirects it to
# D:/cargo-target) - only `cargo metadata` honours that, same resolution as live-verify.ps1.
$cargoTargetDir = if ($env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR
} else {
    $fallbackTargetDir = Join-Path $repoRoot 'src-tauri\target'
    try {
        $manifest = Join-Path $repoRoot 'src-tauri\Cargo.toml'
        $meta = & cargo metadata --format-version 1 --no-deps --manifest-path $manifest 2>$null | ConvertFrom-Json
        if ($meta -and $meta.target_directory) { $meta.target_directory } else { $fallbackTargetDir }
    } catch { $fallbackTargetDir }
}
$exePath = Join-Path $cargoTargetDir 'debug\claude-conductor.exe'

# Gate order per todo 1121 / project_wdio_suite_traps: smoke through question-card-view free,
# daemon-lifecycle LAST among them (project_wdio_daemon_lifecycle_poisons_next_spec).
$freeSpecs = @(
    'smoke',
    'held-messages',
    'multi-account',
    'news-redesign',
    'question-card',
    'schedule-view',
    'daemon-lifecycle'
)
$chatSpecs = @('chat-flow', 'reload-dup')
$billedOnlySpec = 'question-card-live'

function Write-Verdict {
    param([string]$Spec, [string]$Tag)
    Write-Host "${Spec}: $Tag"
}

# Single choke point for "never run two wdio invocations at once": a second run on the same
# ports silently attaches to the first run's driver and then dies with ECONNREFUSED the moment
# that one tears down, reading exactly like a mid-suite app crash (project_wdio_suite_traps #2).
# Also catches a leftover live-verify.ps1 rig holding :1420 (#7) or another peer's dev server
# (#4). Never kills what it finds - only names the owning pid and refuses to start.
function Assert-PortsFree {
    foreach ($port in 1420, 4444) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            foreach ($ownerPid in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
                $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
                $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
                Write-Host "Port $port is held by pid $ownerPid ($name)."
            }
            throw "Port $port is already listening - refusing to start/continue the wdio sweep. This script never kills what it finds; find out whose it is first (another wdio run, or a leftover live-verify.ps1 rig)."
        }
    }
}

# Non-blocking: a stale binary makes the whole sweep a silent false green
# (project_wdio_gate_passes_against_stale_binary). This script never runs cargo itself.
function Test-DebugExeFreshness {
    if (-not (Test-Path $exePath)) {
        Write-Warning "Debug exe not found at $exePath - wdio.conf.js builds dist/ but never builds the Rust binary. Run 'cargo build --manifest-path src-tauri/Cargo.toml' first; this script will not do it for you."
        return
    }
    $exeTime = (Get-Item $exePath).LastWriteTime
    $commitTimeRaw = $null
    try { $commitTimeRaw = (git -C $repoRoot log -1 --format=%cI -- src-tauri/) 2>$null } catch {}
    if (-not $commitTimeRaw) {
        Write-Warning "Could not resolve the last src-tauri commit time; skipping the stale-binary check."
        return
    }
    $commitTime = [DateTimeOffset]::Parse($commitTimeRaw).LocalDateTime
    if ($exeTime -lt $commitTime) {
        Write-Warning "Debug exe at $exePath (built $exeTime) is OLDER than the last src-tauri commit ($commitTime). The sweep would run against stale code and prove nothing about that commit. Rebuild with 'cargo build --manifest-path src-tauri/Cargo.toml' first; this script never runs cargo itself."
    } else {
        Write-Host "Debug exe ($exeTime) is newer than the last src-tauri commit ($commitTime)."
    }
}

# The wdio daemon's session registry accumulates real chats across billed runs and rots
# chat-flow's sidebar-lookup assertions after ~30 (project_wdio_suite_traps #3).
function Backup-WdioSessionRegistry {
    $path = Join-Path $env:APPDATA 'claude-conductor\interactive-sessions-wdio.json'
    if (-not (Test-Path $path)) {
        Write-Host "No existing $path to archive."
        return
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$path.$stamp.bak"
    if ($PSCmdlet.ShouldProcess($path, "archive to $backupPath")) {
        Move-Item -Path $path -Destination $backupPath
        Write-Host "Archived $path -> $backupPath"
    } else {
        Write-Host "[WhatIf] would archive $path -> $backupPath"
    }
}

# Parses mocha's own "N passing" / "N failing" summary lines (what the old hand-typed loop
# grep-filtered down to) plus the first numbered failure header, so a verdict survives without
# needing the full log open.
function Get-WdioVerdict {
    param([string]$LogPath)
    $content = @(Get-Content -Path $LogPath -ErrorAction SilentlyContinue)
    $passing = 0
    $failing = 0
    foreach ($line in $content) {
        if ($line -match '(\d+)\s+passing') { $passing = [int]$matches[1] }
        if ($line -match '(\d+)\s+failing') { $failing = [int]$matches[1] }
    }
    $firstError = $null
    if ($failing -gt 0) {
        foreach ($line in $content) {
            if ($line -match '^\s*\d+\)\s+\S') { $firstError = $line.Trim(); break }
        }
        if (-not $firstError) {
            foreach ($line in $content) {
                if ($line -match 'Error') { $firstError = $line.Trim(); break }
            }
        }
    }
    [PSCustomObject]@{ Passing = $passing; Failing = $failing; FirstError = $firstError }
}

# One spec per call, sequential by construction (the caller loops), which is itself how this
# script satisfies "never run two wdio invocations at once" for its own runs. Re-checks ports
# immediately before spawning in case a previous spec in the same sweep left something behind.
function Invoke-WdioSpec {
    param(
        [string]$SpecName,
        [string]$LogDir,
        [hashtable]$ExtraEnv
    )
    $specPath = "e2e/specs/$SpecName.e2e.js"
    $logPath = Join-Path $LogDir "$SpecName.log"

    if (-not $PSCmdlet.ShouldProcess($SpecName, 'run wdio spec')) {
        Write-Host "[WhatIf] would run: pnpm exec wdio run e2e/wdio.conf.js --spec $specPath"
        Write-Host "[WhatIf]   log -> $logPath"
        foreach ($k in $ExtraEnv.Keys) { Write-Host "[WhatIf]   env $k=$($ExtraEnv[$k])" }
        return [PSCustomObject]@{ Spec = $SpecName; Passing = 0; Failing = 0; FirstError = $null; ExitCode = $null; LogPath = $logPath; Skipped = $true }
    }

    Assert-PortsFree

    $previousEnv = @{}
    foreach ($k in $ExtraEnv.Keys) {
        $previousEnv[$k] = [System.Environment]::GetEnvironmentVariable($k)
        Set-Item -Path "Env:\$k" -Value $ExtraEnv[$k]
    }
    try {
        Write-Host "=== Running $SpecName ==="
        # cmd.exe redirection, not PowerShell's `2>&1`: PowerShell 5.1 wraps a native command's
        # stderr lines in a NativeCommandError and flips $? to false even on a clean exit, which
        # would make every spec look like it errored before the verdict parse even runs. pnpm
        # also resolves to a .cmd shim, not a PE exe, so it needs cmd.exe to launch it anyway
        # (same reasoning as live-verify.ps1's vite spawn).
        $cmdLine = "pnpm exec wdio run e2e/wdio.conf.js --spec $specPath > `"$logPath`" 2>&1"
        $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) -WorkingDirectory $repoRoot -NoNewWindow -PassThru -Wait
        $exitCode = $proc.ExitCode
    } finally {
        foreach ($k in $ExtraEnv.Keys) {
            if ($null -eq $previousEnv[$k]) {
                Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue
            } else {
                Set-Item -Path "Env:\$k" -Value $previousEnv[$k]
            }
        }
    }

    $verdict = Get-WdioVerdict -LogPath $logPath
    $status = if ($exitCode -eq 0 -and $verdict.Failing -eq 0) { 'OK' } else { 'FAIL' }
    Write-Verdict -Spec $SpecName -Tag "$($verdict.Passing) passing, $($verdict.Failing) failing [$status] (exit $exitCode)"
    if ($verdict.FirstError) { Write-Host "  first error: $($verdict.FirstError)" }

    [PSCustomObject]@{ Spec = $SpecName; Passing = $verdict.Passing; Failing = $verdict.Failing; FirstError = $verdict.FirstError; ExitCode = $exitCode; LogPath = $logPath; Skipped = $false }
}

# --- main ---

Test-DebugExeFreshness
Assert-PortsFree
Backup-WdioSessionRegistry

$useFakeForChat = -not $RealClaude
if ($useFakeForChat -and -not (Test-Path $FakeClaudeBin)) {
    throw "Fake claude binary not found at $FakeClaudeBin. Pass -FakeClaudeBin <path> to a stream-json stub (see [[project_wdio_billed_specs_free_via_fake_claude]] for what it needs to emit), or pass -RealClaude to bill real turns for chat-flow/reload-dup instead."
}
if ($RealClaude) {
    Write-Warning "chat-flow and reload-dup will bill real claude turns (-RealClaude)."
}
if ($Billed) {
    Write-Warning "question-card-live will bill real claude turns (~2 haiku turns per run) (-Billed)."
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $repoRoot ".for_bepy\wdio-logs\$timestamp"
if ($PSCmdlet.ShouldProcess($logDir, 'create log directory')) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
} else {
    Write-Host "[WhatIf] would create log directory $logDir"
}

$plan = @()
foreach ($s in $freeSpecs) {
    $plan += [PSCustomObject]@{ Spec = $s; Env = @{} }
}
foreach ($s in $chatSpecs) {
    $env = if ($useFakeForChat) { @{ CC_CLAUDE_BIN = $FakeClaudeBin } } else { @{} }
    $plan += [PSCustomObject]@{ Spec = $s; Env = $env }
}
if ($Billed) {
    $plan += [PSCustomObject]@{ Spec = $billedOnlySpec; Env = @{} }
}

$results = @()
foreach ($item in $plan) {
    $results += Invoke-WdioSpec -SpecName $item.Spec -LogDir $logDir -ExtraEnv $item.Env
}

Write-Host "`n=== Summary ==="
foreach ($r in $results) {
    $tag = if ($r.Skipped) { '[WhatIf - not run]' } else { "$($r.Passing)p/$($r.Failing)f exit=$($r.ExitCode)" }
    Write-Host "  $($r.Spec): $tag  log: $($r.LogPath)"
}

$anyFailed = @($results | Where-Object { -not $_.Skipped -and ($_.Failing -gt 0 -or $_.ExitCode -ne 0) })
if ($anyFailed.Count -gt 0) {
    Write-Host "`nSWEEP FAILED ($($anyFailed.Count) spec(s))"
    exit 1
} else {
    Write-Host "`nSWEEP PASSED (or dry run via -WhatIf)"
    exit 0
}
