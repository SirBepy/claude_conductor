# Run: powershell -NoProfile -File scripts/release-report.test.ps1   (exit 0 = all pass)
# Drives release-report.ps1 against a throwaway data dir and log dir.

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'release-report.ps1'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("release-report-test-" + [guid]::NewGuid().ToString('N'))
$data = Join-Path $root 'data'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $data, $logs | Out-Null
$failures = 0

function Check([bool]$ok, [string]$label) {
  if ($ok) { Write-Output "PASS $label" } else { Write-Output "FAIL $label"; $script:failures++ }
}

try {
  $rejected = @(
    '{"at":"2026-11-06T12:00:00Z","route":"/messages/send","session_id":"a","kind":"report","error":"text is 250 chars, over report''s 200"}',
    '{"at":"2026-11-06T12:01:00Z","route":"/messages/send","session_id":"a","kind":"report","error":"text is 261 chars, over report''s 200"}',
    '{"at":"2026-10-01T12:00:00Z","route":"/messages/send","session_id":"a","kind":"answer","error":"before the cutoff"}',
    'not json'
  )
  [System.IO.File]::WriteAllLines((Join-Path $data 'rejected-sends.jsonl'), $rejected)

  $log = @(
    '[2026-11-06][12:00:00][daemon::x][ERROR] boom 12345 for 0a1b2c3d-1111-2222-3333-444455556666',
    '[2026-11-06][12:00:01][daemon::x][ERROR] boom 99 for 9f8e7d6c-1111-2222-3333-444455556666',
    '[2026-11-06][12:00:02][webview_perf][WARN] slow took 349ms',
    '[2026-11-06][12:00:03][webview_perf][INFO] fine',
    '[2026-09-01][12:00:00][daemon::old][ERROR] before the cutoff'
  )
  # Held open for writing the way the running app holds its own log.
  $fs = [System.IO.File]::Open((Join-Path $logs 'app.log'), 'Create', 'Write', 'ReadWrite')
  $w = New-Object System.IO.StreamWriter($fs)
  foreach ($l in $log) { $w.WriteLine($l) }
  $w.Flush()

  $out = & powershell -NoProfile -File $script -Since '2026-11-01' -Data $data -Logs $logs 2>&1 | Out-String
  $w.Dispose()

  Check ($out -match 'Rejected relay calls \(2\)') 'two rejections inside the window, the older one and the junk line left out'
  Check ($out -match '2\s+/messages/send \| report \| text is N chars') 'the same mistake groups into one shape with its count'
  Check ($out -match 'App log ERROR lines \(2\)') 'two ERRORs in the window, the pre-cutoff one left out'
  Check ($out -match '2\s+daemon::x \| boom N for <id>') 'numbers and ids fold so the two ERRORs share one shape'
  Check ($out -match 'App log WARN lines \(1\)') 'a WARN is counted and an INFO is not'
  Check ($out -notmatch 'before the cutoff') 'nothing older than the cutoff appears'

  $none = & powershell -NoProfile -File $script -Since '2027-01-01' -Data $data -Logs $logs 2>&1 | Out-String
  Check ($none -match 'Rejected relay calls \(0\)' -and $none -match 'none') 'a window with nothing in it says none'
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($failures) { Write-Output "FAIL: $failures check(s) failed"; exit 1 }
Write-Output 'OK: all checks passed'
