<#
.SYNOPSIS
  Builds e2e\fixtures\fake-claude\claude.exe, the fake claude CLI as a real executable.

.DESCRIPTION
  The committed claude.cmd runs through cmd.exe, which refuses a command line over 8191
  characters, so a chat with Use subchats on (its main-chat system prompt is longer than
  that) never started under the fake. claude.exe is a small C# shim
  (claude-shim.cs) that starts `node fake.cjs` with the same arguments through
  CreateProcess, whose limit is 32767. It is compiled with the .NET Framework's csc.exe
  that ships with Windows; the result is gitignored and rebuilt only when the source is
  newer.

  Prints the path of the executable. Exits 1 when csc.exe is missing or the compile
  fails, so a caller can fall back to claude.cmd.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Build-FakeClaudeExe {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $dir = Join-Path $RepoRoot 'e2e\fixtures\fake-claude'
    $src = Join-Path $dir 'claude-shim.cs'
    $exe = Join-Path $dir 'claude.exe'
    if ((Test-Path $exe) -and ((Get-Item $exe).LastWriteTimeUtc -ge (Get-Item $src).LastWriteTimeUtc)) { return $exe }
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc, so claude.exe cannot be built" }
    $out = & $csc /nologo /target:exe /optimize "/out:$exe" $src 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) { throw "compiling claude-shim.cs failed: $out" }
    return $exe
}

if ($MyInvocation.InvocationName -ne '.') {
    $repoRoot = (git rev-parse --show-toplevel) -replace '/', '\'
    try {
        Build-FakeClaudeExe -RepoRoot $repoRoot
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
