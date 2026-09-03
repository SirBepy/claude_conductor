<#
.SYNOPSIS
  Pushes an existing PNG into Conductor's in-app preview panel (todo 864) -
  the delivery half of scripts/harness-shot.ps1's producer half (todo 848).

.DESCRIPTION
  Base64-encodes the PNG into a minimal dark HTML page and POSTs it to
  http://127.0.0.1:27182/hooks/preview, the same endpoint /preview uses.
  The slug defaults from the filename so re-running on the same PNG
  refreshes that panel entry instead of stacking a new one.

.PARAMETER Path
  Path to the PNG file to show.

.PARAMETER Title
  Panel entry title. Defaults to the filename.

.PARAMETER Slug
  Panel entry slug. Defaults to the lowercased filename with non-alphanumerics
  turned into "-", so reruns on the same PNG refresh in place.

.EXAMPLE
  scripts\show-shot.ps1 -Path .\shot.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [string]$Title,
    [string]$Slug
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
    throw "PNG not found: $Path"
}

$resolvedPath = (Resolve-Path $Path).Path
$fileName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPath)

if (-not $Title) { $Title = $fileName }
if (-not $Slug) {
    $Slug = ($fileName.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
}

$sessionId = $env:CLAUDE_CODE_SESSION_ID
if ([string]::IsNullOrWhiteSpace($sessionId)) {
    Write-Warning "CLAUDE_CODE_SESSION_ID is empty - this push will be invisible in every chat."
}

$bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
$base64 = [Convert]::ToBase64String($bytes)

$html = @"
<!DOCTYPE html>
<html>
<head>
<meta name="color-scheme" content="dark">
<meta name="darkreader-lock">
<title>$Title</title>
<style>
  body { margin: 0; background: #1e1e1e; display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: sans-serif; color: #ddd; }
  img { max-width: 100%; }
</style>
</head>
<body>
<h3>$Title</h3>
<img src="data:image/png;base64,$base64">
</body>
</html>
"@

$body = @{
    title      = $Title
    slug       = $Slug
    html       = $html
    source     = "terminal"
    session_id = $sessionId
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:27182/hooks/preview" -Method Post -Body $body -ContentType "application/json"
    Write-Output "preview id: $($response.id)"
}
catch {
    $webEx = $_.Exception
    if ($webEx.Response -and [int]$webEx.Response.StatusCode -eq 413) {
        Write-Warning "413: preview body exceeds the ~2MB cap. Base64 inflates the PNG by about 33%, so keep the PNG itself under about 1.5MB."
    }
    elseif ($webEx -is [System.Net.WebException] -or $webEx.Message -match 'refused|actively refused') {
        Write-Output "Conductor is not reachable"
        Start-Process $resolvedPath
    }
    else {
        throw
    }
}
