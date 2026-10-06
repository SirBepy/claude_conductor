<#
.SYNOPSIS
  Isolated phone-path verify rig: brings up a PRIVATE daemon instance (own data dir, port,
  instance label) seeded with a dummy account and a git-initialised scratch project, so
  `isRemote()` true UI (the phone cockpit) can be driven by Playwright in one command instead
  of a hand-built setup.

.DESCRIPTION
  Mirrors scripts/live-verify.ps1's isolation and teardown-by-PID-only safety rules, but for the
  DAEMON (not the Tauri app window): CC_DATA_DIR/CC_DAEMON_INSTANCE/CC_REMOTE_PORT keep this run's
  settings, accounts and project registry fully separate from the real %APPDATA%\claude-conductor
  tree, and the daemon runs from a private copy of the exe so a later `cargo build` of the shared
  debug exe is never blocked by this rig holding it open (same reason live-verify copies its exe).

  `isRemote()` is just `!window.__TAURI__` (src/shared/transport.ts) - a plain Playwright page
  loading the daemon's served SPA over HTTP runs the exact phone code path with no device or
  emulator needed.

  This script never builds or rebuilds the daemon exe. It only copies the existing
  D:\cargo-target\debug\cc-conductor-daemon.exe. If that is missing or stale, build it yourself
  first (outside this rig) - this script has no cargo lane of its own, by design, so it never
  contends for the shared target-dir lock.

.PARAMETER Command
  up | down | status

.EXAMPLE
  scripts\phone-verify.ps1 up
  scripts\phone-verify.ps1 status
  scripts\phone-verify.ps1 down
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('up', 'down', 'status')]
    [string]$Command
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
# Small state POINTER lives in LOCALAPPDATA (cheap to find for `down`/`status`, same spot
# live-verify.ps1 uses for its own state file) - the bulk data (data dir, scratch project, the
# copied exe) lives under the scratch root recorded inside it, on D: per this dispatch's disk
# rule (never %TEMP% or an in-repo path, never a bare drive-root child).
$stateDir = Join-Path $env:LOCALAPPDATA 'claude-conductor-phone-verify'
$statePath = Join-Path $stateDir 'state.json'
$sourceExe = 'D:\cargo-target\debug\cc-conductor-daemon.exe'

function Get-RigState {
    if (Test-Path $statePath) {
        return Get-Content $statePath -Raw | ConvertFrom-Json
    }
    return $null
}

# WriteAllText only - never Set-Content/Out-File for file CONTENT (Windows PowerShell 5.1's
# Set-Content prepends a UTF-8 BOM even with -Encoding utf8, which most JSON parsers reject).
function Save-RigState($state) {
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir | Out-Null
    }
    $json = $state | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($statePath, $json)
}

function Test-ProcAlive($procId) {
    if (-not $procId) { return $false }
    return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# Same identity-snapshot approach as live-verify.ps1 (todo 1047): records PID + creation time +
# exe path at `up` so `down` can tell "still ours" from "PID got reused by something else".
function Get-ProcIdentity([int]$procId) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $cim) { return $null }
    return [PSCustomObject]@{
        CreationTime = $cim.CreationDate.ToString('o')
        ExePath      = $cim.ExecutablePath
    }
}

function Test-ProcIdentity {
    param(
        [Parameter(Mandatory = $true)][int]$ProcId,
        [string]$RecordedCreationTime,
        [string]$RecordedExePath
    )
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
    if (-not $cim) { return 'gone' }
    if (-not $RecordedCreationTime) { return 'unverifiable' }
    $liveCreationTime = $cim.CreationDate.ToString('o')
    if ($liveCreationTime -ne $RecordedCreationTime) { return 'mismatch' }
    if ($RecordedExePath -and $cim.ExecutablePath -and ($RecordedExePath -ne $cim.ExecutablePath)) {
        return 'mismatch'
    }
    return 'match'
}

# Binds loopback port 0 to let the OS assign a free ephemeral port, then releases it
# immediately. A small TOCTOU window exists (same as any "pick a free port" trick) but this rig
# only ever shares the box with itself and the dev's own tooling, never a hostile peer.
function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Test-HttpUp([string]$url) {
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Wait-Http([string]$url, [int]$timeoutSec, [string]$what) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpUp $url) { return }
        Start-Sleep -Milliseconds 300
    }
    throw "Timed out waiting for $what at $url"
}

function Wait-FileNonEmpty([string]$path, [int]$timeoutSec, [string]$what) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $path) -and (Get-Item $path).Length -gt 0) { return }
        Start-Sleep -Milliseconds 300
    }
    throw "Timed out waiting for $what at $path"
}

switch ($Command) {
    'up' {
        $existing = Get-RigState
        if ($existing -and (Test-ProcAlive $existing.AppPid)) {
            Write-Host "phone-verify already up: port=$($existing.Port) label=$($existing.InstanceLabel) appPid=$($existing.AppPid)"
            Write-Host "url: $($existing.Url)"
            return
        }

        if (-not (Test-Path $sourceExe)) {
            throw "Daemon exe not found at $sourceExe. This rig never builds it - build the debug daemon yourself first (cargo build --manifest-path src-tauri\Cargo.toml --bin cc-conductor-daemon), then re-run 'up'."
        }

        $guid = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $scratchRoot = Join-Path 'D:\cargo-target' "phone-verify-$guid"
        $dataDir = Join-Path $scratchRoot 'data'
        $projectsRoot = Join-Path $scratchRoot 'projects'
        $projectDir = Join-Path $projectsRoot 'scratch-proj'
        $binDir = Join-Path $scratchRoot 'bin'
        $logDir = Join-Path $scratchRoot 'logs'
        New-Item -ItemType Directory -Path $dataDir, $projectDir, $binDir, $logDir -Force | Out-Null

        # Private copy: this rig's daemon never holds the SHARED debug exe open, so the next
        # `cargo build` by any session (this rig, or a peer's) can always relink it.
        $runExe = Join-Path $binDir 'cc-conductor-daemon.exe'
        Copy-Item -Path $sourceExe -Destination $runExe

        # Scratch project: a real git repo so the @ composer popup's `git ls-files -co` has
        # something to list (an empty/non-git dir renders an empty popup - todo 1037 gotcha).
        New-Item -ItemType Directory -Path (Join-Path $projectDir 'src') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $projectDir 'README.md'), "# scratch-proj`n")
        [System.IO.File]::WriteAllText((Join-Path $projectDir 'src\main.ts'), "export {};`n")
        & git -C $projectDir init -q
        & git -C $projectDir add -A
        & git -C $projectDir -c user.email='phone-verify@local' -c user.name='phone-verify' commit -q -m 'seed'

        $acctId = [guid]::NewGuid().ToString()
        $projId = [guid]::NewGuid().ToString()
        $nowIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

        # Dummy account: without one, "Start session" stays disabled ("No Claude accounts yet") -
        # todo 1037 gotcha. config_dir/chrome_profile_dir point inside the scratch tree so nothing
        # here can resolve against a real account's credentials.
        $accounts = @(
            @{
                id                 = $acctId
                label               = 'phone-verify'
                colour              = ''
                icon                = ''
                config_dir          = (Join-Path $dataDir 'claude-config')
                chrome_profile_dir  = (Join-Path $dataDir 'chrome-profile')
                email               = 'phone-verify@example.com'
                org_uuid            = [guid]::NewGuid().ToString()
                subscription_tier   = ''
                created_at          = $nowIso
                fleet_eligible      = $false
            }
        )
        # -InputObject, never a pipe: piping a ONE-element array into ConvertTo-Json unrolls it
        # and serializes the single hashtable as a bare JSON object, not a 1-element array -
        # accounts::store::load then fails to parse `Vec<Account>` and silently treats the
        # whole file as corrupt (renamed aside to accounts.json.broken-<ts>), so the UI still
        # says "No Claude accounts yet" even though this step appeared to succeed.
        [System.IO.File]::WriteAllText((Join-Path $dataDir 'accounts.json'), (ConvertTo-Json -InputObject $accounts -Depth 5))

        # Registering the project directly (rather than driving the picker's "Create" flow)
        # sidesteps the create_project RPC race noted in project memory (clicking Create before
        # the folder exists, or vice versa, both 500). `newProjectLastParent` still seeded so any
        # future Create click in this rig resolves to the same scratch projects root.
        $settings = @{
            projects              = @(
                @{
                    id         = $projId
                    path       = $projectDir
                    name       = 'scratch-proj'
                    created_at = $nowIso
                }
            )
            default_account_id    = $acctId
            newProjectLastParent  = $projectsRoot
        }
        [System.IO.File]::WriteAllText((Join-Path $dataDir 'settings.json'), ($settings | ConvertTo-Json -Depth 5))

        $port = Get-FreePort
        $label = "phone-verify-$guid"

        Write-Host "Launching isolated phone-verify daemon (label=$label, port=$port)..."
        $env:CC_DATA_DIR = $dataDir
        $env:CC_DAEMON_INSTANCE = $label
        $env:CC_REMOTE_PORT = "$port"
        $env:CC_DAEMON_NO_AUTOSTART = '1'
        $outLog = Join-Path $logDir 'daemon.out.log'
        $errLog = Join-Path $logDir 'daemon.err.log'
        $appProc = Start-Process -FilePath $runExe -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        Remove-Item Env:\CC_DATA_DIR, Env:\CC_DAEMON_INSTANCE, Env:\CC_REMOTE_PORT, Env:\CC_DAEMON_NO_AUTOSTART -ErrorAction SilentlyContinue

        $tokenPath = Join-Path $dataDir 'remote-access.json'
        try {
            Wait-FileNonEmpty $tokenPath 30 'daemon-minted remote-access token'
            Wait-Http "http://127.0.0.1:$port/" 30 'remote-access server'
        } catch {
            Write-Warning "up failed waiting for readiness; daemon logs:"
            if (Test-Path $outLog) { Get-Content $outLog -Tail 40 | Write-Host }
            if (Test-Path $errLog) { Get-Content $errLog -Tail 40 | Write-Host }
            throw
        }
        $token = (Get-Content $tokenPath -Raw | ConvertFrom-Json).token
        if (-not $token) { throw "remote-access.json at $tokenPath has no plaintext token field" }
        $url = "http://127.0.0.1:$port/?token=$token"

        $appIdentity = Get-ProcIdentity $appProc.Id
        Save-RigState @{
            Port            = $port
            InstanceLabel   = $label
            ScratchRoot     = $scratchRoot
            DataDir         = $dataDir
            ProjectDir      = $projectDir
            ExePath         = $runExe
            AppPid          = $appProc.Id
            AppCreationTime = $(if ($appIdentity) { $appIdentity.CreationTime } else { $null })
            AppExePath      = $(if ($appIdentity) { $appIdentity.ExePath } else { $null })
            Token           = $token
            Url             = $url
            StartedAt       = (Get-Date).ToString('o')
        }

        Write-Host "up: $url"
    }

    'status' {
        $state = Get-RigState
        if (-not $state) {
            Write-Host 'No phone-verify instance recorded.'
            return
        }
        $alive = Test-ProcAlive $state.AppPid
        $httpUp = if ($alive) { Test-HttpUp "http://127.0.0.1:$($state.Port)/" } else { $false }
        Write-Host "label=$($state.InstanceLabel) appPid=$($state.AppPid) alive=$alive httpUp=$httpUp url=$($state.Url)"
    }

    'down' {
        $state = Get-RigState
        if (-not $state) {
            Write-Host 'No phone-verify instance recorded. Nothing to do.'
            return
        }

        Write-Host "Tearing down phone-verify instance (label=$($state.InstanceLabel), appPid=$($state.AppPid))..."
        $identity = Test-ProcIdentity -ProcId $state.AppPid -RecordedCreationTime $state.AppCreationTime -RecordedExePath $state.AppExePath
        switch ($identity) {
            'gone' { Write-Host "pid $($state.AppPid) already gone." }
            'unverifiable' { Write-Warning "stale state: no recorded creation time, unverifiable, skipped kill." }
            'mismatch' { Write-Warning "stale state: pid $($state.AppPid) is not ours (reused), skipped kill." }
            'match' {
                taskkill /F /T /PID $state.AppPid | Out-Null
            }
        }

        if ($state.ScratchRoot -and (Test-Path $state.ScratchRoot)) {
            # taskkill returns before Windows has actually released the exe's file handle, so an
            # immediate Remove-Item can leave the copied .exe (and its containing dirs) behind -
            # bounded retry rather than a single best-effort attempt.
            $deadline = (Get-Date).AddSeconds(10)
            while ((Get-Date) -lt $deadline -and (Test-Path $state.ScratchRoot)) {
                Remove-Item -Path $state.ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
                if (-not (Test-Path $state.ScratchRoot)) { break }
                Start-Sleep -Milliseconds 400
            }
        }
        Remove-Item -Path $statePath -Force -ErrorAction SilentlyContinue

        Write-Host "Our instance (pid $($state.AppPid)) gone: $(-not (Test-ProcAlive $state.AppPid))"
        Write-Host "Scratch root gone: $(-not (Test-Path $state.ScratchRoot))"
    }
}
