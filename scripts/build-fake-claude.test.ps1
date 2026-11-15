<#
.SYNOPSIS
  Tests that the fake claude built by build-fake-claude.ps1 starts with an argument longer than
  cmd.exe allows.

.DESCRIPTION
  claude.cmd runs through cmd.exe, which refuses a command line over 8191 characters ("The
  command line is too long"); a chat with Use subchats on passes a system prompt longer than
  that, so the chat never started under the fake. This builds claude.exe, starts it with a
  20000-character argument and with quotes and backslashes, and checks the arguments reach
  fake.cjs unchanged (FAKE_CLAUDE_LOG records them). The same call through claude.cmd is checked
  to fail, so the test cannot pass for a reason other than the shim.

.EXAMPLE
  powershell -NoProfile -File scripts\build-fake-claude.test.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
. (Join-Path $repoRoot 'scripts\build-fake-claude.ps1')

$failures = @()
$exe = Build-FakeClaudeExe -RepoRoot $repoRoot
$cmd = Join-Path $repoRoot 'e2e\fixtures\fake-claude\claude.cmd'
$scratch = Join-Path $env:TEMP "build-fake-claude-test-$PID"
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$log = Join-Path $scratch 'spawns.log'
$env:FAKE_CLAUDE_LOG = $log
$env:CLAUDE_CONFIG_DIR = Join-Path $scratch 'config'
try {
    $long = 'x' * 20000
    '' | & $exe --session-id 11111111-2222-3333-4444-555555555555 --append-system-prompt $long 'say "hi" now\' 'trail\\' | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures += "claude.exe exited $LASTEXITCODE" }
    $line = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    # The log keeps the first 300 characters of the arguments, which is past the long one's
    # start but not its end, so the check is on what the shim passed before it and that the
    # process started at all.
    if ($line -notmatch 'sid=11111111-2222-3333-4444-555555555555') { $failures += "fake.cjs never ran under claude.exe (log: $line)" }
    if ($line -notmatch '--append-system-prompt') { $failures += "the long argument's flag did not arrive (log: $line)" }

    Remove-Item $log -ErrorAction SilentlyContinue
    # Windows PowerShell 5.1 mangles an embedded double quote before the shim sees it, so the
    # arguments here are the ones it passes on unchanged: spaces and backslashes.
    '' | & $exe --session-id 11111111-2222-3333-4444-555555555556 'two words' 'trail\\' 'C:\a b\c' | Out-Null
    $short = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    $want = '["--session-id","11111111-2222-3333-4444-555555555556","two words","trail\\\\","C:\\a b\\c"]'
    if (-not $short.Contains($want)) { $failures += "spaces and backslashes did not round-trip. wanted $want in: $short" }

    # The thing the shim exists for: the same long argument through claude.cmd is refused.
    $ErrorActionPreference = 'Continue'
    $viaCmd = cmd /c "`"$cmd`" --append-system-prompt $long" 2>&1
    $ErrorActionPreference = 'Stop'
    if (($viaCmd | Out-String) -notmatch 'too long') { $failures += "claude.cmd was expected to refuse a 20000-character command line, so this test would prove nothing" }
} finally {
    Remove-Item Env:\FAKE_CLAUDE_LOG, Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    Write-Host "`nRESULT: FAIL ($($failures.Count) check(s))"
    exit 1
}
Write-Host "`nRESULT: PASS - claude.exe takes a 20000-character argument and passes spaces and backslashes through; claude.cmd refuses it."
exit 0
