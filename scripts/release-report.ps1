<#
What the app recorded since the last release that a person should look at,
shown by /release step 1d (`.claude/release-reports.txt`). Three sources:

1. `<data_dir>/rejected-sends.jsonl` (src-tauri/src/daemon/hooks_server/rejected_sends.rs):
   send_message / update_message validation failures, undecodable request
   bodies, and the ok:false reply of the other relay routes (turn status,
   plan, schedule, drafts, people, jarvis, channel, todos, dashboard card,
   subchat tool, shared mockup). The chat draws nothing for them, so the same
   shape many times means a tool schema or its error text steers callers wrong.
2. `<data_dir>/shown-badly.jsonl` (src-tauri/src/daemon/hooks_server/shown_badly.rs):
   cards that showed Joe data badly, flagged by Joe from a card's menu
   (source joe, with his note) or by the chat itself through send_message's
   `unsure_how_to_show` (source claude, with its reason). Every row is listed:
   they are meant to be fixed in a batch.
3. The app log (`%LOCALAPPDATA%\com.sirbepy.claudeconductor\logs\*.log`, UTC):
   ERROR lines and WARN lines, grouped by target and message shape.

The window starts at the last `VERSION:` commit, so every row shows in exactly
one release's report. `-SinceDays` is the fallback when the repo has no such
commit, and `-Since` overrides both.

Usage: powershell -File scripts/release-report.ps1 [-Since <datetime>] [-SinceDays 14] [-Data <dir>] [-Logs <dir>]
Exit code is always 0; the output is advice, not a gate.
#>
param(
  [string]$Since = '',
  [int]$SinceDays = 14,
  [string]$Data = $(if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:APPDATA 'claude-conductor' }),
  [string]$Logs = (Join-Path $env:LOCALAPPDATA 'com.sirbepy.claudeconductor\logs')
)

$repo = Split-Path -Parent $PSScriptRoot
if ($Since) {
  $cutoff = ([datetime]$Since).ToUniversalTime(); $basis = "since $Since"
} else {
  $stamp = (& git -C $repo log --grep='^VERSION:' -1 --format=%cI 2>$null)
  if ($stamp) { $cutoff = ([datetimeoffset]$stamp).UtcDateTime; $basis = "since the last release ($stamp)" }
  else { $cutoff = (Get-Date).ToUniversalTime().AddDays(-$SinceDays); $basis = "last $SinceDays days (no VERSION commit found)" }
}

# Digits, quoted words and paths differ per occurrence, so the same mistake
# groups together once they fold to placeholders.
function Shape([string]$e) {
  $e = $e -replace '[A-Za-z]:\\[^\s:"]+', '<path>' -replace '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>' -replace '\d+', 'N' -replace '"[^"]*"', '"_"' -replace '\s+', ' '
  if ($e.Length -gt 140) { $e = $e.Substring(0, 140) + '...' }
  $e.Trim()
}

# The running app holds its log open for writing, so a plain ReadAllLines throws.
function ReadLinesShared([string]$path) {
  $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  $sr = New-Object System.IO.StreamReader($fs)
  try { while ($null -ne ($l = $sr.ReadLine())) { $l } } finally { $sr.Dispose() }
}

function Show([string]$title, $rows, [string]$keyName, [scriptblock]$key, [int]$top) {
  Write-Output ''
  Write-Output "$title ($(@($rows).Count))"
  if (-not $rows) { Write-Output '  none'; return }
  $rows | Group-Object $key | Sort-Object Count -Descending | Select-Object -First $top |
    Select-Object @{ n = 'count'; e = { $_.Count } }, @{ n = $keyName; e = { $_.Name } } |
    Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Output
}

Write-Output "Release report, $basis"

# One daemon jsonl log and its rotated `.old`, rows since the cutoff, oldest first.
function ReadJsonl([string]$base) {
  foreach ($name in "$base.old", $base) {
    $f = Join-Path $Data $name
    if (-not (Test-Path $f)) { continue }
    foreach ($line in @(ReadLinesShared $f)) {
      try { $r = $line | ConvertFrom-Json } catch { continue }
      if (([datetimeoffset]$r.at).UtcDateTime -ge $cutoff) { $r }
    }
  }
}

# 1. Rejected relay calls
$rejected = @(ReadJsonl 'rejected-sends.jsonl')
Show 'Rejected relay calls' $rejected 'route | kind | error shape' { "$($_.route) | $($_.kind) | $(Shape $_.error)" } 12

# 2. Cards shown badly: a count per source and kind, then every row, since each
# names one card to look at.
$badly = @(ReadJsonl 'shown-badly.jsonl')
Show 'Cards shown badly' $badly 'source | kind' { "$($_.source) | $($_.kind)" } 12
if ($badly) {
  $badly | Select-Object @{ n = 'at'; e = { ([datetimeoffset]$_.at).UtcDateTime.ToString('MM-dd HH:mm') } },
    source, kind,
    @{ n = 'chat'; e = { if ($_.chat_title) { $_.chat_title } else { $_.session_id.Substring(0, [Math]::Min(8, $_.session_id.Length)) } } },
    @{ n = 'verdict'; e = { $_.message.verdict } },
    @{ n = 'note'; e = { $_.note } } |
    Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Output
}

# 3. App log. Line shape: [2026-11-06][03:34:19][target][LEVEL] message (UTC).
$pattern = '^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[([^\]]+)\]\[(ERROR|WARN)\] (.*)$'
$entries = @()
if (Test-Path $Logs) {
  foreach ($f in Get-ChildItem $Logs -Filter '*.log*' -File) {
    foreach ($line in @(ReadLinesShared $f.FullName)) {
      $m = [regex]::Match($line, $pattern)
      if (-not $m.Success) { continue }
      $at = [datetime]::SpecifyKind([datetime]"$($m.Groups[1].Value) $($m.Groups[2].Value)", 'Utc')
      if ($at -lt $cutoff) { continue }
      $entries += [pscustomobject]@{ level = $m.Groups[4].Value; target = $m.Groups[3].Value; msg = $m.Groups[5].Value }
    }
  }
} else {
  Write-Output ''
  Write-Output "App log: no folder at $Logs"
}
Show 'App log ERROR lines' @($entries | Where-Object level -eq 'ERROR') 'target | message shape' { "$($_.target) | $(Shape $_.msg)" } 15
Show 'App log WARN lines' @($entries | Where-Object level -eq 'WARN') 'target | message shape' { "$($_.target) | $(Shape $_.msg)" } 10

Write-Output ''
Write-Output 'Read: an ERROR, or a shape with a high count, is worth a look: fix the cause, the schema or error text, or file a todo. Known noise (e.g. perf WARNs) is expected.'
