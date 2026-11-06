<#
Summarises the daemon's rejected-sends log (`<data_dir>/rejected-sends.jsonl`,
written by src-tauri/src/daemon/hooks_server/rejected_sends.rs): every relay
call (send_message, update_message, report_turn_status, ...) the daemon turned
down with ok:false. The chat draws nothing for these, so this is where a
pattern shows up: the same field wrong again and again means the tool schema or
its error text is steering callers badly.

Usage: powershell -File scripts/rejected-sends-report.ps1 [-SinceDays 14] [-Data <dir>]
Exit code is always 0; read the table, it is advice, not a gate.
#>
param(
  [int]$SinceDays = 14,
  [string]$Data = $(if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:APPDATA 'claude-conductor' })
)

$cutoff = (Get-Date).ToUniversalTime().AddDays(-$SinceDays)
$files = @('rejected-sends.jsonl.old', 'rejected-sends.jsonl') | ForEach-Object { Join-Path $Data $_ } | Where-Object { Test-Path $_ }
if (-not $files) { Write-Output "No rejected-sends log under $Data (nothing was rejected, or the daemon has not run a build with the log)."; exit 0 }

$rows = foreach ($f in $files) {
  foreach ($line in [System.IO.File]::ReadAllLines($f)) {
    try { $r = $line | ConvertFrom-Json } catch { continue }
    if ([datetime]$r.at -ge $cutoff) { $r }
  }
}
if (-not $rows) { Write-Output "No rejections in the last $SinceDays days."; exit 0 }

# Digits and quoted words differ per call (lengths, field names, ordinals), so
# the same mistake groups together once they are folded to placeholders.
function Shape([string]$e) { ($e -replace '\d+', 'N' -replace '"[^"]*"', '"_"' -replace '\s+', ' ').Trim() }

Write-Output "Rejected relay calls, last $SinceDays days: $($rows.Count) total, $(@($rows | Select-Object -ExpandProperty session_id -Unique).Count) sessions"
Write-Output ''
$rows | Group-Object { "$($_.route) | $($_.kind) | $(Shape $_.error)" } |
  Sort-Object Count -Descending |
  Select-Object -First 15 @{ n = 'count'; e = { $_.Count } }, @{ n = 'route | kind | error shape'; e = { $_.Name } } |
  Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Output
Write-Output 'Read: a shape with a high count is a tool the schema or error text teaches badly. Fix the schema/error, or file a todo.'
