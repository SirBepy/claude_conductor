<#
.SYNOPSIS
  Renders one frontend component through the view harness and writes a PNG -
  no more hand-rolling a throwaway e2e/view-harness/*.view.spec.ts per shot
  (todo 848).

.DESCRIPTION
  Wraps a driver file's body in a temp e2e/view-harness/zz-tmp-*.view.spec.ts,
  runs it via `pnpm exec playwright test`, then deletes the temp spec even on
  failure. The driver gets `page` and the `harness` namespace (mountView,
  capture, ...) in scope and must mount the view itself; it may reassign
  `target` (a Page or Locator) to shoot one element instead of the full page.
  The wrapper adds a settle wait and the final `capture(target, label)` call,
  so the shot directory stays resolved by harness.ts's own capture() (todo
  848: reuse it, do not add a third implementation next to it and
  rename-session.ps1's).

.PARAMETER Driver
  Path to a .ts file holding the test body - a FILE, never inline JS.
  scripts/live-verify.ps1's eval/shot already showed PowerShell arg
  marshalling mangles JS containing double quotes.

.PARAMETER Out
  Desired PNG path. The canonical file lands under capture()'s own
  .for_bepy/screenshots/<id>/ dir; this path receives a copy of it.

.EXAMPLE
  scripts\harness-shot.ps1 -Driver .\my-driver.ts -Out .\shot.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Driver,
    [Parameter(Mandatory = $true)] [string]$Out
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel) -replace '/', '\'
$harnessDir = Join-Path $repoRoot 'e2e\view-harness'
$callerLocation = (Get-Location).Path

if (-not (Test-Path $Driver)) {
    throw "Driver file not found: $Driver"
}
$driverBody = [System.IO.File]::ReadAllText((Resolve-Path $Driver).Path)

$label = [System.IO.Path]::GetFileNameWithoutExtension($Out)
if ([string]::IsNullOrWhiteSpace($label)) { $label = 'harness-shot' }
$labelJson = $label | ConvertTo-Json

$template = @'
import { test, type Locator, type Page } from "@playwright/test";
import * as harness from "./harness";

test("harness-shot", async ({ page }) => {
  let target: Page | Locator = page;

__DRIVER_BODY__

  // Settle wait: the AUQ .prompt-track transition has been caught mid-slide
  // twice by a capture taken right after mount.
  await page.waitForTimeout(300);
  await harness.capture(target, __LABEL__);
});
'@

$specContent = $template.Replace('__LABEL__', $labelJson).Replace('__DRIVER_BODY__', $driverBody)

$tempName = "zz-tmp-harness-shot-$([guid]::NewGuid().ToString('N')).view.spec.ts"
$tempPath = Join-Path $harnessDir $tempName
[System.IO.File]::WriteAllText($tempPath, $specContent)

try {
    Push-Location $repoRoot
    $specArg = "e2e/view-harness/$tempName"
    $output = & pnpm exec playwright test $specArg
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
}

$output | ForEach-Object { Write-Output $_ }

$capturedLine = $output | Select-String -Pattern '^\[capture\] (.+)$' | Select-Object -Last 1
if (-not $capturedLine) {
    throw "harness-shot: no [capture] line in playwright output (exit code $exitCode) - the driver never reached harness.capture(), or the run failed before it."
}
$capturedPath = $capturedLine.Matches[0].Groups[1].Value

$outResolved = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $callerLocation $Out }
$outDir = Split-Path -Parent $outResolved
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if ([System.IO.Path]::GetFullPath($capturedPath) -ne [System.IO.Path]::GetFullPath($outResolved)) {
    Copy-Item -Path $capturedPath -Destination $outResolved -Force
}

Write-Output "harness-shot: canonical=$capturedPath out=$outResolved"

if ($exitCode -ne 0) {
    throw "harness-shot: playwright test exited $exitCode"
}
