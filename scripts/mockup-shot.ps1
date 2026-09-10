<#
.SYNOPSIS
  Renders a standalone mockup HTML file (one with no app imports, e.g.
  .for_bepy/mockups/*.html) to a full-page PNG - the render-verify step
  [[feedback_verify_mockup_render_before_showing]] asks for, without
  hand-writing a throwaway CDP driver each time (todo 909).

.DESCRIPTION
  `chrome --headless --screenshot=<path>` never completes on this machine
  (confirmed 2026-09-04, [[project_headless_chrome_screenshot_flag_hangs]]),
  so this drives Playwright's own bundled Chromium binary over raw CDP
  instead: launch headless with an ephemeral --remote-debugging-port and a
  throwaway --user-data-dir, navigate to the file, read
  document.documentElement.scrollHeight, override the device metrics to that
  full height, then Page.captureScreenshot. Node 22's global WebSocket means
  no `ws` package is needed - same pattern as live-verify.ps1's CDP driver.

  `playwright` is not require()-able from a bare script here (pnpm hides it
  under node_modules/.pnpm), so this drives the chrome.exe binary directly at
  $env:LOCALAPPDATA/ms-playwright/chromium-<rev>/chrome-win64/chrome.exe,
  picking the highest-numbered revision when more than one is installed.

.PARAMETER Path
  Path to the standalone mockup HTML file to render.

.PARAMETER Out
  Desired PNG path. Defaults to
  .for_bepy/screenshots/<session-id>/<html-stem>.png, id resolved via
  close/rename-session.ps1 -GetId like the rest of the repo's screenshot
  tooling.

.PARAMETER Width
  Viewport width in CSS px for the render. Height is computed from the
  page's own scrollHeight so the shot is always full-page. Default 1240.

.EXAMPLE
  scripts\mockup-shot.ps1 -Path .for_bepy\mockups\auq-footer-stack.html
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [string]$Out,
    [int]$Width = 1240
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
    throw "Mockup HTML not found: $Path"
}
$resolvedHtml = (Resolve-Path $Path).Path
$htmlStem = [System.IO.Path]::GetFileNameWithoutExtension($resolvedHtml)

$repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel) -replace '/', '\'

if (-not $Out) {
    $renameSessionScript = Join-Path $env:USERPROFILE '.claude\skills\close\rename-session.ps1'
    $sessionId = & $renameSessionScript -GetId
    if ($LASTEXITCODE -ne 0 -or -not $sessionId) {
        throw 'Could not resolve a session id via rename-session.ps1 -GetId, and no -Out was given.'
    }
    $sessionId = $sessionId.Trim()
    $Out = Join-Path $repoRoot ".for_bepy\screenshots\$sessionId\$htmlStem.png"
}
$outResolved = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
$outDir = Split-Path -Parent $outResolved
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

# Pick the highest-numbered installed Chromium revision - this machine has several
# (chromium-1208, -1228, -1234, -1243, ...) left behind by playwright's own upgrades.
$playwrightDir = Join-Path $env:LOCALAPPDATA 'ms-playwright'
$chromiumDir = Get-ChildItem -Path $playwrightDir -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^chromium-\d+$' } |
    Sort-Object { [int]($_.Name -replace '^chromium-', '') } -Descending |
    Select-Object -First 1
if (-not $chromiumDir) {
    throw "No chromium-* install found under $playwrightDir. Run 'pnpm exec playwright install chromium' first."
}
$chromeExe = Join-Path $chromiumDir.FullName 'chrome-win64\chrome.exe'
if (-not (Test-Path $chromeExe)) {
    throw "chrome.exe not found at $chromeExe"
}

$profileDir = Join-Path $env:TEMP "mockup-shot-profile-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$port = Get-Random -Minimum 49200 -Maximum 65500

# Dependency-free CDP driver (Node 22's global fetch + WebSocket) - glue for this script, not a
# committed source file. Waits for the page's own load event before measuring scrollHeight, so a
# slow Phosphor CDN fetch cannot race the screenshot.
$cdpDriverSrc = @'
const [, , port, fileUrl, widthStr, outPath] = process.argv;
const width = Number(widthStr);

let targets = [];
for (let i = 0; i < 20; i++) {
  targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  if (targets.some((t) => t.type === 'page')) break;
  await new Promise((r) => setTimeout(r, 250));
}
const target = targets.find((t) => t.type === 'page');
if (!target) {
  console.error('No page target found at the CDP endpoint.');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', (e) => reject(new Error(String(e.message || e))));
});

let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg.method);
  }
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitForEvent(method, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (events.includes(method)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${method}`));
      setTimeout(check, 100);
    };
    check();
  });
}

try {
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('Page.navigate', { url: fileUrl });
  await waitForEvent('Page.loadEventFired', 20000);

  // document.fonts.ready alone is not enough: the Phosphor CDN <script> injects its own
  // @font-face rule asynchronously, so a font can still be mid-fetch after the page's load
  // event AND after fonts.ready resolves once with nothing pending yet. Poll check() briefly
  // instead of trusting a single read.
  const measured = await send('Runtime.evaluate', {
    expression: `(async () => {
      await document.fonts.ready;
      let phosphorLoaded = document.fonts.check('1rem Phosphor');
      for (let i = 0; i < 20 && !phosphorLoaded; i++) {
        await new Promise((r) => setTimeout(r, 150));
        phosphorLoaded = document.fonts.check('1rem Phosphor');
      }
      return { height: document.documentElement.scrollHeight, phosphorLoaded };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const { height, phosphorLoaded } = measured.result.value;

  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));

  console.log(`SHOT_OK height=${height} phosphorLoaded=${phosphorLoaded} out=${outPath}`);
} finally {
  ws.close();
}
'@

$tmpDriver = Join-Path $env:TEMP "mockup-shot-cdp-$([guid]::NewGuid().ToString('N')).mjs"
[System.IO.File]::WriteAllText($tmpDriver, $cdpDriverSrc)

$appProc = $null
try {
    $fileUrl = "file:///$($resolvedHtml -replace '\\', '/')"
    $chromeArgs = @(
        '--headless=new',
        "--remote-debugging-port=$port",
        "--user-data-dir=$profileDir",
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    )
    $appProc = Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(20)
    $cdpUp = $false
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $cdpUp = $true
            break
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $cdpUp) {
        throw "CDP endpoint on port $port never came up."
    }

    $driverOutput = & node $tmpDriver $port $fileUrl $Width $outResolved
    $driverExit = $LASTEXITCODE
    $driverOutput | ForEach-Object { Write-Output $_ }
    if ($driverExit -ne 0) {
        throw "mockup-shot: CDP driver exited $driverExit"
    }
    if (-not (Test-Path $outResolved)) {
        throw "mockup-shot: driver reported success but $outResolved was not written"
    }

    $size = (Get-Item $outResolved).Length
    Write-Output "mockup-shot: wrote $outResolved ($size bytes)"
} finally {
    Remove-Item -Path $tmpDriver -Force -ErrorAction SilentlyContinue
    if ($appProc -and -not $appProc.HasExited) {
        taskkill /F /T /PID $appProc.Id | Out-Null
    }
    Remove-Item -Path $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
