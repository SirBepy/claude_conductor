<#
.SYNOPSIS
  Isolated live-verify rig: builds/launches a PRIVATE debug Conductor instance with CDP
  attached, drives it over the Chrome DevTools Protocol, and tears it down by PID - never by
  process name - so it can never touch the dev's production app. See
  .claude/todos/795-script-the-isolated-live-verify-rig.md and [[project_drive_app_via_cdp]].

.DESCRIPTION
  SECURITY: the CDP remote-debugging port is a full code-execution channel into the webview.
  It binds to LOOPBACK ONLY (Chromium's --remote-debugging-port default; this script never
  passes --remote-debugging-address) and defaults to a random HIGH EPHEMERAL port so a second
  instance never collides with it. Never pass -Port with a fixed well-known value, and never
  enable remote debugging on a production launch - this is debug-only.

  Isolation is via CC_DAEMON_INSTANCE (own daemon/lockfile/ports) plus a private
  WEBVIEW2_USER_DATA_FOLDER (required - WebView2 shares one browser process per user-data
  folder, so reusing production's folder while it runs fails webview creation outright).

.PARAMETER Command
  up | eval | shot | down

.PARAMETER Monitor
  1-based index into [System.Windows.Forms.Screen]::AllScreens. Moves the rig's OWN window
  there after launch with SWP_NOACTIVATE, so the debug instance stops landing on top of
  whatever the dev is reading. Never enumerates or touches any other process's windows.

.EXAMPLE
  scripts\live-verify.ps1 up
  scripts\live-verify.ps1 up -Monitor 2
  scripts\live-verify.ps1 up -SkipBuild
  scripts\live-verify.ps1 eval 0 "document.title"
  scripts\live-verify.ps1 eval 0 -File .for_bepy\probe.js
  scripts\live-verify.ps1 shot 0 .for_bepy\screenshots\795\window.png
  scripts\live-verify.ps1 shot 0 out.png -File .for_bepy\prep.js
  scripts\live-verify.ps1 down
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('up', 'eval', 'shot', 'down')]
    [string]$Command,

    [Parameter(Position = 1)]
    [string]$Arg1,

    [Parameter(Position = 2)]
    [string]$Arg2,

    [int]$Port = 0,
    [string]$InstanceLabel = 'live-verify',
    [string]$File,

    # 1-based index into [System.Windows.Forms.Screen]::AllScreens, or 0 to
    # leave placement alone. Only ever applied to the PID this script started.
    [int]$Monitor = 0,

    # Launch the existing debug exe even if Rust sources are newer. The webview
    # loads the frontend from vite, so a frontend-only check never needs the
    # rebuild - useful when another session holds the exe and blocks one.
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$stateDir = Join-Path $env:LOCALAPPDATA 'claude-conductor-live-verify'
$statePath = Join-Path $stateDir 'state.json'
# `cargo metadata` is the only source that honours ~/.cargo/config.toml's
# target-dir, which no env var reflects (todo 795). The try/catch is
# load-bearing: EAP=Stop turns an unresolvable `cargo` into a TERMINATING
# error that `2>$null` does not suppress, which would break `down`'s teardown.
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
$vitePort = 1420

# Moves ONLY $procId's own top-level window. SWP_NOACTIVATE keeps focus where
# it is; the dev's windows are never enumerated, moved or activated. Best
# effort by design - a placement failure must never fail an `up`.
function Move-RigWindowToMonitor([int]$procId, [int]$monitorIndex) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $screens = [System.Windows.Forms.Screen]::AllScreens
        if ($monitorIndex -lt 1 -or $monitorIndex -gt $screens.Count) {
            Write-Warning "monitor $monitorIndex out of range (1..$($screens.Count)), leaving window where it is"
            return
        }
        Add-Type -Namespace LiveVerify -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(
    IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@
        $bounds = $screens[$monitorIndex - 1].WorkingArea
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            $h = (Get-Process -Id $procId -ErrorAction SilentlyContinue).MainWindowHandle
            if ($h -and $h -ne [IntPtr]::Zero) {
                $w = [Math]::Min(1400, $bounds.Width)
                $hgt = [Math]::Min(900, $bounds.Height)
                $x = $bounds.X + [int](($bounds.Width - $w) / 2)
                $y = $bounds.Y + [int](($bounds.Height - $hgt) / 2)
                # SWP_NOACTIVATE(0x0010) | SWP_NOZORDER(0x0004)
                [LiveVerify.Win32]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hgt, 0x0014) | Out-Null
                Write-Host "placed window on monitor $monitorIndex at ${x},${y} (${w}x${hgt})"
                return
            }
            Start-Sleep -Milliseconds 250
        }
        Write-Warning "window handle for pid $procId never appeared; placement skipped"
    } catch {
        Write-Warning "monitor placement failed (non-fatal): $_"
    }
}

function Get-RigState {
    if (Test-Path $statePath) {
        return Get-Content $statePath -Raw | ConvertFrom-Json
    }
    return $null
}

function Save-RigState($state) {
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir | Out-Null
    }
    $state | ConvertTo-Json | Set-Content -Path $statePath -Encoding utf8
}

function Test-ProcAlive($procId) {
    if (-not $procId) { return $false }
    return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# Best-effort identity snapshot for a just-started process, saved alongside its PID so `down`
# can tell "still ours" from "PID got reused" (todo 1047). Null fields are expected when the
# CIM lookup races a process that exits immediately after Start-Process.
function Get-ProcIdentity([int]$procId) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $cim) { return $null }
    return [PSCustomObject]@{
        CreationTime = $cim.CreationDate.ToString('o')
        ExePath      = $cim.ExecutablePath
    }
}

# Compares a live PID against the identity recorded at `up`. 'gone' = no such process anymore
# (nothing to kill). 'unverifiable' = state predates this field (old state file) - never kill
# blindly. 'mismatch' = PID is alive but is not the process we started (reused PID). 'match' =
# safe to kill. Exe path is a secondary check: only enforced when BOTH sides have it, since a
# locked-down live process can legitimately report a null ExecutablePath.
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

# Single choke point for every teardown kill: resolves identity first, taskkills only on
# 'match', and prints a clear reason on every other outcome instead of killing blindly.
function Stop-RigTrackedProcess {
    param(
        [string]$Role,
        [int]$ProcId,
        [string]$RecordedCreationTime,
        [string]$RecordedExePath
    )
    if (-not $ProcId) { return }
    $identity = Test-ProcIdentity -ProcId $ProcId -RecordedCreationTime $RecordedCreationTime -RecordedExePath $RecordedExePath
    switch ($identity) {
        'gone' { return }
        'unverifiable' {
            Write-Warning "stale state for $Role pid ${ProcId}: old-format state file has no recorded creation time, unverifiable, skipped"
        }
        'mismatch' {
            Write-Warning "stale state for $Role pid ${ProcId}: not ours, skipped"
        }
        'match' {
            taskkill /F /T /PID $ProcId | Out-Null
        }
    }
}

# Every session shares one cargo target dir, so a debug instance launched straight from it (a
# peer's `cargo tauri dev`, a wdio run, a daemon spawned by either) holds the exe open, and
# cargo's relink then dies with a bare "Access is denied" that names nobody.
function Get-ExeHolders([string]$path) {
    $target = [System.IO.Path]::GetFullPath($path)
    return (Get-CimInstance Win32_Process -Filter "Name='claude-conductor.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) })
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
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $what at $url"
}

# Dependency-free CDP driver (Node 22's global fetch + WebSocket, no npm package). Written to
# a temp file per invocation - it is glue for this script, not a committed source file.
$cdpDriverSrc = @'
const [, , port, cmd, indexStr, ...rest] = process.argv;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const index = Number(indexStr);
const target = targets[index];
if (!target) {
  console.error(`No CDP target at index ${index}. Available targets:`);
  targets.forEach((t, i) => console.error(`  [${i}] ${t.type} ${t.title} ${t.url}`));
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', (e) => reject(new Error(String(e.message || e))));
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const fs = await import('node:fs');

// '--file <path>' reads the JS from disk instead of the command line, sidestepping
// PowerShell's own quote tokenization on expressions containing embedded quotes.
try {
  if (cmd === 'eval') {
    const expr = rest[0] === '--file' ? fs.readFileSync(rest[1], 'utf8') : rest[0];
    const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'shot') {
    let outPath = rest[0];
    if (rest[0] === '--file') {
      const prepExpr = fs.readFileSync(rest[1], 'utf8');
      // awaitPromise so an async prep step finishes BEFORE the capture, not after.
      await send('Runtime.evaluate', { expression: prepExpr, returnByValue: true, awaitPromise: true });
      outPath = rest[2];
    }
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.log(`Saved screenshot to ${outPath}`);
  } else {
    console.error(`Unknown CDP driver command: ${cmd}`);
    process.exit(1);
  }
} finally {
  ws.close();
}
'@

function Invoke-CdpDriver($driverCmd, $targetPort, $index, [string[]]$rest) {
    $tmpFile = Join-Path $env:TEMP "live-verify-cdp-$([guid]::NewGuid().ToString('N')).mjs"
    [System.IO.File]::WriteAllText($tmpFile, $cdpDriverSrc)
    try {
        & node $tmpFile $targetPort $driverCmd $index @rest
        if ($LASTEXITCODE -ne 0) {
            throw "CDP driver ($driverCmd) exited with code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -Path $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

switch ($Command) {
    'up' {
        $existing = Get-RigState
        if ($existing -and (Test-ProcAlive $existing.AppPid)) {
            Write-Host "live-verify already up: port=$($existing.Port) label=$($existing.InstanceLabel) appPid=$($existing.AppPid)"
            return
        }

        # Build if stale: compare the debug exe's mtime against the newest source file.
        # Capability files are compiled into the binary's ACL at build time (todo 965) - an
        # edit there alone must count as staleness too, same LastWriteTime comparison as
        # the .rs/Cargo.* files below.
        $srcFiles = @(Get-ChildItem -Path (Join-Path $repoRoot 'src-tauri\src') -Filter '*.rs' -Recurse)
        $srcFiles += Get-ChildItem -Path (Join-Path $repoRoot 'src-tauri\capabilities') -Filter '*.json' -Recurse
        $srcFiles += Get-Item (Join-Path $repoRoot 'src-tauri\Cargo.toml')
        $srcFiles += Get-Item (Join-Path $repoRoot 'src-tauri\Cargo.lock')
        $newestSrc = ($srcFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime

        if (-not (Test-Path $exePath)) {
            $exeStale = $true
        } elseif ($SkipBuild) {
            $exeStale = $false
        } else {
            $exeStale = (Get-Item $exePath).LastWriteTime -lt $newestSrc
        }
        if ($exeStale) {
            # @() at the call site: PowerShell unrolls a one-element return, and a lone
            # CimInstance reports no .Count.
            $holders = @(Get-ExeHolders $exePath)
            if ($holders.Count -gt 0) {
                $list = ($holders | ForEach-Object { "  pid $($_.ProcessId): $($_.CommandLine)" }) -join "`n"
                throw "Debug exe needs a rebuild but is held open by another process, so cargo cannot relink it:`n$list`nThese belong to another session; this script never stops them. Wait for them to exit, ask their owner, pass -SkipBuild for a frontend-only check, or set CARGO_TARGET_DIR to a private dir for this rig (a cold build)."
            }
            Write-Host 'Debug exe stale or missing, building...'
            cargo build --manifest-path (Join-Path $repoRoot 'src-tauri\Cargo.toml')
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
        } else {
            Write-Host 'Debug exe up to date, skipping build.'
        }
        if (-not (Test-Path $exePath)) { throw "Debug exe still missing at $exePath after build" }

        # The rig runs a private copy so it never holds the shared exe itself: the next rebuild,
        # by any session, can always relink it. A fresh dir per launch because the rig's detached
        # daemon can outlive `down` and keep its own copy locked; the sweep skips those.
        $binRoot = Join-Path $stateDir 'bin'
        if (Test-Path $binRoot) {
            foreach ($old in Get-ChildItem -Path $binRoot -Directory) {
                try { Remove-Item -Path $old.FullName -Recurse -Force -ErrorAction Stop } catch { }
            }
        }
        $runDir = Join-Path $binRoot ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $runDir -Force | Out-Null
        $runExe = Join-Path $runDir 'claude-conductor.exe'
        Copy-Item -Path $exePath -Destination $runExe

        if ($Port -eq 0) {
            $Port = Get-Random -Minimum 49200 -Maximum 65500
        }

        $webview2Folder = Join-Path $stateDir "webview2-$InstanceLabel"
        if (-not (Test-Path $webview2Folder)) {
            New-Item -ItemType Directory -Path $webview2Folder | Out-Null
        }
        $logDir = Join-Path $stateDir 'logs'
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir | Out-Null
        }

        # A debug build loads from localhost:1420, so vite must be running separately. Reuse
        # an already-serving instance rather than stacking a second one.
        $vitePid = $null
        if (Test-HttpUp "http://localhost:$vitePort") {
            Write-Host "vite already serving on $vitePort, reusing it."
        } else {
            Write-Host "Starting vite on $vitePort..."
            $viteOutLog = Join-Path $logDir 'vite.out.log'
            $viteErrLog = Join-Path $logDir 'vite.err.log'
            # pnpm resolves to a .cmd/.ps1 shim, not a PE exe, so Start-Process -FilePath 'pnpm'
            # fails with "not a valid Win32 application"; cmd.exe's own PATHEXT lookup finds the
            # .cmd shim directly.
            $viteProc = Start-Process -FilePath 'cmd.exe' `
                -ArgumentList @('/c', 'pnpm', 'exec', 'vite', '--port', "$vitePort", '--strictPort') `
                -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $viteOutLog -RedirectStandardError $viteErrLog
            $vitePid = $viteProc.Id
            Wait-Http "http://localhost:$vitePort" 30 'vite dev server'
        }

        Write-Host "Launching isolated debug instance (label=$InstanceLabel, CDP port=$Port)..."
        $env:CC_DAEMON_INSTANCE = $InstanceLabel
        $env:WEBVIEW2_USER_DATA_FOLDER = $webview2Folder
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
        $appOutLog = Join-Path $logDir 'app.out.log'
        $appErrLog = Join-Path $logDir 'app.err.log'
        $appProc = Start-Process -FilePath $runExe -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $appOutLog -RedirectStandardError $appErrLog
        Remove-Item Env:\CC_DAEMON_INSTANCE, Env:\WEBVIEW2_USER_DATA_FOLDER, Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue

        Wait-Http "http://127.0.0.1:$Port/json/list" 30 'CDP endpoint'

        if ($Monitor -gt 0) { Move-RigWindowToMonitor $appProc.Id $Monitor }

        $appIdentity = Get-ProcIdentity $appProc.Id
        $viteIdentity = $null
        if ($vitePid) { $viteIdentity = Get-ProcIdentity $vitePid }

        Save-RigState @{
            Port             = $Port
            InstanceLabel    = $InstanceLabel
            WebView2Folder   = $webview2Folder
            ExePath          = $runExe
            AppPid           = $appProc.Id
            AppCreationTime  = $(if ($appIdentity) { $appIdentity.CreationTime } else { $null })
            AppExePath       = $(if ($appIdentity) { $appIdentity.ExePath } else { $null })
            VitePid          = $vitePid
            ViteCreationTime = $(if ($viteIdentity) { $viteIdentity.CreationTime } else { $null })
            ViteExePath      = $(if ($viteIdentity) { $viteIdentity.ExePath } else { $null })
            StartedAt        = (Get-Date).ToString('o')
        }

        Write-Host "up: CDP port $Port"
    }

    'eval' {
        if (-not $Arg1 -or (-not $Arg2 -and -not $File)) {
            throw 'usage: live-verify.ps1 eval <index> <expr>  OR  eval <index> -File <jsPath>'
        }
        $state = Get-RigState
        if (-not $state -or -not (Test-ProcAlive $state.AppPid)) {
            throw "No live-verify instance running. Run 'up' first."
        }
        if ($File) {
            Invoke-CdpDriver 'eval' $state.Port $Arg1 @('--file', (Resolve-Path $File).Path)
        } else {
            Invoke-CdpDriver 'eval' $state.Port $Arg1 @($Arg2)
        }
    }

    'shot' {
        if (-not $Arg1 -or -not $Arg2) { throw 'usage: live-verify.ps1 shot <index> <path> [-File <jsPath>]' }
        $state = Get-RigState
        if (-not $state -or -not (Test-ProcAlive $state.AppPid)) {
            throw "No live-verify instance running. Run 'up' first."
        }
        $shotDir = Split-Path -Parent $Arg2
        if ($shotDir -and -not (Test-Path $shotDir)) {
            New-Item -ItemType Directory -Path $shotDir -Force | Out-Null
        }
        if ($File) {
            # -File JS runs via Runtime.evaluate right before the capture, e.g. to scroll an
            # element into view or dismiss an overlay - the expression never touches argv.
            Invoke-CdpDriver 'shot' $state.Port $Arg1 @('--file', (Resolve-Path $File).Path, $Arg2)
        } else {
            Invoke-CdpDriver 'shot' $state.Port $Arg1 @($Arg2)
        }
    }

    'down' {
        $state = Get-RigState
        if (-not $state) {
            Write-Host 'No live-verify instance recorded. Nothing to do.'
            return
        }

        Write-Host "Tearing down live-verify instance (label=$($state.InstanceLabel), appPid=$($state.AppPid))..."
        Stop-RigTrackedProcess -Role 'app' -ProcId $state.AppPid -RecordedCreationTime $state.AppCreationTime -RecordedExePath $state.AppExePath
        Stop-RigTrackedProcess -Role 'vite' -ProcId $state.VitePid -RecordedCreationTime $state.ViteCreationTime -RecordedExePath $state.ViteExePath
        Remove-Item -Path $statePath -Force -ErrorAction SilentlyContinue

        # Proof of teardown: only OUR PID should be gone; any other claude-conductor.exe
        # process (the dev's production app) is untouched and still listed here.
        Write-Host 'Post-teardown process check (claude-conductor.exe):'
        $remaining = Get-CimInstance Win32_Process -Filter "Name='claude-conductor.exe'" |
            Select-Object ProcessId, CommandLine
        if ($remaining) {
            $remaining | Format-Table -AutoSize | Out-String | Write-Host
        } else {
            Write-Host '  (none running)'
        }
        Write-Host "Our debug instance (pid $($state.AppPid)) gone: $(-not (Test-ProcAlive $state.AppPid))"
    }
}
