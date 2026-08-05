<#
.SYNOPSIS
    Screenshot helper for a native Win32/WebView2 window by process name/id or title.

.DESCRIPTION
    Replaces the trial-and-error from the 2026-07-16 wedged-app session: a bad
    Add-Type member-definition that misleadingly "worked" by capturing whatever
    was on top, then SetForegroundWindow silently no-op'd under Windows'
    foreground-lock protection (brought forward an unrelated window instead of
    the target), then Process.MainWindowHandle resolved to a 16x16 placeholder
    HWND instead of the real content window.

    Enumerates ALL top-level windows owned by the target process (not
    MainWindowHandle) and picks the one with the largest client area - the
    heuristic for "the real content window" vs. a helper/placeholder window.
    Captures via PrintWindow with PW_RENDERFULLCONTENT (flag 2), which reads
    the HWND directly and needs no foreground/focus/z-order. Falls back to a
    full-screen CopyFromScreen + prints the window's screen bounds (for manual
    crop) if the PrintWindow result comes back blank, a known WebView2
    GPU-surface quirk with some flag combos.

.PARAMETER ProcessName
    Process name (no .exe) to match. Default 'claude-conductor' (this app).

.PARAMETER WindowTitle
    Window title substring to match instead of/in addition to -ProcessName.
    If both are given, candidates must match both.

.PARAMETER ProcessId
    Exact process id to match, overrides -ProcessName.

.PARAMETER OutPath
    Where to write the PNG. Defaults to a timestamped file under
    .for_bepy/screenshots/<pid>-<start-ticks>/ (this session's disposable
    screenshot scratch subfolder, scoped so /close can purge it by ownership).

.EXAMPLE
    powershell -NoProfile -File scripts/window-screenshot.ps1
    # Captures Claude Conductor's largest window, prints the saved path.

.EXAMPLE
    powershell -NoProfile -File scripts/window-screenshot.ps1 -WindowTitle "Spotify"
#>
param(
    [string]$ProcessName = 'claude-conductor',
    [string]$WindowTitle,
    [int]$ProcessId = 0,
    [string]$OutPath
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    Write-Error "window-screenshot.ps1 is Windows-only."
    exit 1
}

Add-Type -AssemblyName System.Drawing

Add-Type -Namespace WindowScreenshot -Name Native -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

[DllImport("user32.dll")]
public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll")]
public static extern int GetWindowTextLength(IntPtr hWnd);

[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

[DllImport("user32.dll")]
public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Get-WindowTitle([IntPtr]$Hwnd) {
    $len = [WindowScreenshot.Native]::GetWindowTextLength($Hwnd)
    if ($len -eq 0) { return '' }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [WindowScreenshot.Native]::GetWindowText($Hwnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

$titleOnlyMatch = $PSBoundParameters.ContainsKey('WindowTitle') -and -not $PSBoundParameters.ContainsKey('ProcessName')

$targetPids = $null
if ($ProcessId -gt 0) {
    $targetPids = @($ProcessId)
} elseif (-not $titleOnlyMatch) {
    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($procs) { $targetPids = $procs.Id }
}

# Enumerate every top-level window, not Process.MainWindowHandle (proven
# unreliable for this app - resolves to a placeholder HWND, not real content).
$candidates = New-Object System.Collections.Generic.List[object]
$callback = {
    param($hwnd, $lparam)
    if (-not [WindowScreenshot.Native]::IsWindowVisible($hwnd)) { return $true }

    $procId = 0
    [WindowScreenshot.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null

    if ($targetPids -and ($targetPids -notcontains $procId)) { return $true }

    $title = Get-WindowTitle $hwnd
    if ($WindowTitle -and ($title -notmatch [regex]::Escape($WindowTitle))) { return $true }
    if (-not $targetPids -and -not $WindowTitle) { return $true }

    $rect = New-Object WindowScreenshot.Native+RECT
    [WindowScreenshot.Native]::GetClientRect($hwnd, [ref]$rect) | Out-Null
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -le 0) { return $true }

    $candidates.Add([PSCustomObject]@{ Hwnd = $hwnd; Title = $title; Area = $area }) | Out-Null
    return $true
}
$delegate = [WindowScreenshot.Native+EnumWindowsProc]$callback
[WindowScreenshot.Native]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null

if ($candidates.Count -eq 0) {
    Write-Error "No visible window found matching ProcessName='$ProcessName' WindowTitle='$WindowTitle' ProcessId=$ProcessId."
    exit 1
}

# Largest client area = the real content window, not a helper/placeholder.
$target = $candidates | Sort-Object -Property Area -Descending | Select-Object -First 1
$hwnd = $target.Hwnd

$winRect = New-Object WindowScreenshot.Native+RECT
[WindowScreenshot.Native]::GetWindowRect($hwnd, [ref]$winRect) | Out-Null
$width = $winRect.Right - $winRect.Left
$height = $winRect.Bottom - $winRect.Top

if (-not $OutPath) {
    . (Join-Path $PSScriptRoot 'screenshot-session-dir.ps1')
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $screenshotDir = Resolve-SessionScreenshotDir $projectRoot
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutPath = Join-Path $screenshotDir "window-$timestamp.png"
}

$PW_RENDERFULLCONTENT = 2
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = [WindowScreenshot.Native]::PrintWindow($hwnd, $hdc, $PW_RENDERFULLCONTENT)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

# WebView2's GPU surface sometimes returns an all-black/blank frame from
# PrintWindow regardless of flag combo - detect via a sparse pixel sample.
$isBlank = $true
if ($ok) {
    $first = $bitmap.GetPixel(0, 0)
    for ($y = 0; $y -lt $height -and $isBlank; $y += [Math]::Max(1, [int]($height / 20))) {
        for ($x = 0; $x -lt $width -and $isBlank; $x += [Math]::Max(1, [int]($width / 20))) {
            if ($bitmap.GetPixel($x, $y) -ne $first) { $isBlank = $false }
        }
    }
}

if (-not $ok -or $isBlank) {
    $bitmap.Dispose()
    Write-Warning "PrintWindow returned blank/failed for '$($target.Title)'. Falling back to full-screen capture + window bounds."
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($winRect.Left, $winRect.Top, 0, 0, $bitmap.Size)
    $graphics.Dispose()
    Write-Output "Window bounds: X=$($winRect.Left) Y=$($winRect.Top) Width=$width Height=$height"
}

$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output "Target window: '$($target.Title)' ($width x $height)"
Write-Output "Saved: $OutPath"
