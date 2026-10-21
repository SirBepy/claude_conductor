<#
.SYNOPSIS
  Pins that bootstrap-worktree.ps1 resolves the repo root from its own location, not the caller's cwd.

.DESCRIPTION
  Running `powershell -File <wt>\scripts\bootstrap-worktree.ps1` from the main checkout used to
  bootstrap the main checkout (a cwd-based `git rev-parse --show-toplevel`) and print
  "Bootstrap complete" while the worktree kept no node_modules and no vendor/tauri_kit. Running
  the real script needs pnpm and a submodule fetch, so this checks the root lookup itself:
  the same expression, evaluated from an unrelated cwd, must name the repo the script sits in.

.EXAMPLE
  powershell -NoProfile -File scripts\bootstrap-worktree-root.test.ps1
#>
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'bootstrap-worktree.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
$assign = $ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -eq '$repoRoot'
}, $false) | Select-Object -First 1
if (-not $assign) { throw 'bootstrap-worktree.ps1 no longer assigns $repoRoot at top level' }

$expected = (git -C $PSScriptRoot rev-parse --show-toplevel) -replace '/', '\'
# Invoke-Expression has no $PSScriptRoot of its own, so hand it the scripts\ dir the real
# script runs from under another name.
$scriptsDir = $PSScriptRoot
$expr = $assign.Right.Extent.Text.Replace('$PSScriptRoot', '$scriptsDir')
$elsewhere = Join-Path $env:TEMP "bootstrap-root-test-$PID"
New-Item -ItemType Directory -Force $elsewhere | Out-Null
Push-Location $elsewhere
try {
    $got = Invoke-Expression $expr
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $elsewhere
}

if ($got -ne $expected) {
    throw "repoRoot resolved to '$got' from an unrelated cwd, expected '$expected'"
}
Write-Host "PASS: repoRoot resolves to the script's own repo from any cwd"
