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

.EXAMPLE
  scripts\live-verify.ps1 up
  scripts\live-verify.ps1 eval 0 "document.title"
  scripts\live-verify.ps1 shot 0 .for_bepy\screenshots\795\window.png
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
    [string]$InstanceLabel = 'live-verify'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
$stateDir = Join-Path $env:LOCALAPPDATA 'claude-conductor-live-verify'
$statePath = Join-Path $stateDir 'state.json'
$exePath = 'D:\cargo-target\debug\claude-conductor.exe'
$vitePort = 1420

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

try {
  if (cmd === 'eval') {
    const expr = rest.join(' ');
    const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'shot') {
    const outPath = rest[0];
    const result = await send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
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
        $srcFiles = @(Get-ChildItem -Path (Join-Path $repoRoot 'src-tauri\src') -Filter '*.rs' -Recurse)
        $srcFiles += Get-Item (Join-Path $repoRoot 'src-tauri\Cargo.toml')
        $srcFiles += Get-Item (Join-Path $repoRoot 'src-tauri\Cargo.lock')
        $newestSrc = ($srcFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime

        if (-not (Test-Path $exePath)) {
            $exeStale = $true
        } else {
            $exeStale = (Get-Item $exePath).LastWriteTime -lt $newestSrc
        }
        if ($exeStale) {
            Write-Host 'Debug exe stale or missing, building...'
            cargo build --manifest-path (Join-Path $repoRoot 'src-tauri\Cargo.toml')
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
        } else {
            Write-Host 'Debug exe up to date, skipping build.'
        }
        if (-not (Test-Path $exePath)) { throw "Debug exe still missing at $exePath after build" }

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
            $viteProc = Start-Process -FilePath 'pnpm' `
                -ArgumentList @('exec', 'vite', '--port', "$vitePort", '--strictPort') `
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
        $appProc = Start-Process -FilePath $exePath -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $appOutLog -RedirectStandardError $appErrLog
        Remove-Item Env:\CC_DAEMON_INSTANCE, Env:\WEBVIEW2_USER_DATA_FOLDER, Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue

        Wait-Http "http://127.0.0.1:$Port/json/list" 30 'CDP endpoint'

        Save-RigState @{
            Port           = $Port
            InstanceLabel  = $InstanceLabel
            WebView2Folder = $webview2Folder
            ExePath        = $exePath
            AppPid         = $appProc.Id
            VitePid        = $vitePid
            StartedAt      = (Get-Date).ToString('o')
        }

        Write-Host "up: CDP port $Port"
    }

    'eval' {
        if (-not $Arg1 -or -not $Arg2) { throw 'usage: live-verify.ps1 eval <index> <expr>' }
        $state = Get-RigState
        if (-not $state -or -not (Test-ProcAlive $state.AppPid)) {
            throw "No live-verify instance running. Run 'up' first."
        }
        Invoke-CdpDriver 'eval' $state.Port $Arg1 @($Arg2)
    }

    'shot' {
        if (-not $Arg1 -or -not $Arg2) { throw 'usage: live-verify.ps1 shot <index> <path>' }
        $state = Get-RigState
        if (-not $state -or -not (Test-ProcAlive $state.AppPid)) {
            throw "No live-verify instance running. Run 'up' first."
        }
        $shotDir = Split-Path -Parent $Arg2
        if ($shotDir -and -not (Test-Path $shotDir)) {
            New-Item -ItemType Directory -Path $shotDir -Force | Out-Null
        }
        Invoke-CdpDriver 'shot' $state.Port $Arg1 @($Arg2)
    }

    'down' {
        $state = Get-RigState
        if (-not $state) {
            Write-Host 'No live-verify instance recorded. Nothing to do.'
            return
        }

        Write-Host "Tearing down live-verify instance (label=$($state.InstanceLabel), appPid=$($state.AppPid))..."
        if (Test-ProcAlive $state.AppPid) {
            taskkill /F /T /PID $state.AppPid | Out-Null
        }
        if ($state.VitePid -and (Test-ProcAlive $state.VitePid)) {
            taskkill /F /T /PID $state.VitePid | Out-Null
        }
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
