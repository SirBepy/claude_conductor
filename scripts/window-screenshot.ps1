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
    the HWND directly and needs no foreground/focus/z-order - this also works
    on a minimized window unrestored, sized via GetWindowPlacement (or the
    monitor work area if it was maximized before minimizing), since
    GetClientRect/GetWindowRect only return the off-screen icon placeholder
    while minimized. Falls back to a full-screen CopyFromScreen + prints the
    window's screen bounds (for manual crop) if the PrintWindow result comes
    back blank, a known WebView2 GPU-surface quirk with some flag combos - not
    attempted for a minimized window, since the screen doesn't show it.

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

.PARAMETER AllowRestoreMinimized
    Opt-in. If an unrestored PrintWindow of a minimized window comes back
    blank (WebView2 suspends rendering some time after minimizing - not
    guaranteed to reproduce right away), briefly restore it, capture, then
    re-minimize it. Off by default: this is a visible flash on the dev's
    screen, not something to do without asking.

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
    [string]$OutPath,
    [switch]$AllowRestoreMinimized
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

[DllImport("user32.dll")]
public static extern bool IsIconic(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

[DllImport("user32.dll")]
public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

[DllImport("user32.dll")]
public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);

[DllImport("user32.dll")]
public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct POINT { public int X; public int Y; }
public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
}
public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
}
'@

function Get-WindowTitle([IntPtr]$Hwnd) {
    $len = [WindowScreenshot.Native]::GetWindowTextLength($Hwnd)
    if ($len -eq 0) { return '' }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [WindowScreenshot.Native]::GetWindowText($Hwnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

# GetClientRect/GetWindowRect return an off-screen icon placeholder while minimized;
# rcNormalPosition is stale pre-maximize size, so use the monitor work area instead.
$SW_SHOWMAXIMIZED = 3
$SW_MINIMIZE = 6
$SW_RESTORE = 9
$MONITOR_DEFAULTTONEAREST = 2
function Get-RestoredRect([IntPtr]$Hwnd) {
    $wp = New-Object WindowScreenshot.Native+WINDOWPLACEMENT
    $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
    [WindowScreenshot.Native]::GetWindowPlacement($Hwnd, [ref]$wp) | Out-Null
    if ($wp.showCmd -ne $SW_SHOWMAXIMIZED) { return $wp.rcNormalPosition }

    $mi = New-Object WindowScreenshot.Native+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    $hMonitor = [WindowScreenshot.Native]::MonitorFromWindow($Hwnd, $MONITOR_DEFAULTTONEAREST)
    [WindowScreenshot.Native]::GetMonitorInfo($hMonitor, [ref]$mi) | Out-Null
    return $mi.rcWork
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
# $seen keeps every window that passed the proc/title filters, including
# zero-area rejects, so a failed match can report what it actually found.
$seen = New-Object System.Collections.Generic.List[object]
$callback = {
    param($hwnd, $lparam)
    if (-not [WindowScreenshot.Native]::IsWindowVisible($hwnd)) { return $true }

    $procId = 0
    [WindowScreenshot.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null

    if ($targetPids -and ($targetPids -notcontains $procId)) { return $true }

    $title = Get-WindowTitle $hwnd
    if ($WindowTitle -and ($title -notmatch [regex]::Escape($WindowTitle))) { return $true }
    if (-not $targetPids -and -not $WindowTitle) { return $true }

    $iconic = [WindowScreenshot.Native]::IsIconic($hwnd)
    if ($iconic) {
        $rect = Get-RestoredRect $hwnd
    } else {
        $rect = New-Object WindowScreenshot.Native+RECT
        [WindowScreenshot.Native]::GetClientRect($hwnd, [ref]$rect) | Out-Null
    }
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)

    $seen.Add([PSCustomObject]@{ Hwnd = $hwnd; Title = $title; ProcId = $procId; Iconic = $iconic; Area = $area }) | Out-Null
    return $true
}
$delegate = [WindowScreenshot.Native+EnumWindowsProc]$callback
[WindowScreenshot.Native]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null

$candidates = $seen | Where-Object { $_.Area -gt 0 }

if (-not $candidates -or @($candidates).Count -eq 0) {
    if ($seen.Count -gt 0) {
        Write-Output 'Matched windows with no capturable area:'
        $seen | ForEach-Object { Write-Output "  pid=$($_.ProcId) title='$($_.Title)' visible=true iconic=$($_.Iconic) area=$($_.Area)" }
    }
    Write-Error "No visible window found matching ProcessName='$ProcessName' WindowTitle='$WindowTitle' ProcessId=$ProcessId."
    exit 1
}

# Largest client area = the real content window, not a helper/placeholder.
$target = $candidates | Sort-Object -Property Area -Descending | Select-Object -First 1
$hwnd = $target.Hwnd

if ($target.Iconic) {
    $winRect = Get-RestoredRect $hwnd
} else {
    $winRect = New-Object WindowScreenshot.Native+RECT
    [WindowScreenshot.Native]::GetWindowRect($hwnd, [ref]$winRect) | Out-Null
}
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
# PrintWindow regardless of flag combo - detect via a sparse pixel sample,
# skipping the title bar row so its own chrome-vs-body contrast (present
# even on a genuinely blank client area) doesn't read as "not blank".
$isBlank = $true
if ($ok) {
    # 40px covers a scaled-up title bar too - percentage alone undershoots
    # on short windows like the 145px-tall tray flyout tested here.
    $bodyStartY = [Math]::Min($height - 1, [Math]::Max([int]($height * 0.15), 40))
    $first = $bitmap.GetPixel([int]($width / 2), $bodyStartY)
    for ($y = $bodyStartY; $y -lt $height -and $isBlank; $y += [Math]::Max(1, [int]($height / 20))) {
        for ($x = 0; $x -lt $width -and $isBlank; $x += [Math]::Max(1, [int]($width / 20))) {
            if ($bitmap.GetPixel($x, $y) -ne $first) { $isBlank = $false }
        }
    }
}

$restoredForCapture = $false
if (-not $ok -or $isBlank) {
    $bitmap.Dispose()
    if ($target.Iconic -and -not $AllowRestoreMinimized) {
        # CopyFromScreen would grab whatever's behind the taskbar icon, not
        # the window - no silent fallback for a minimized window here.
        Write-Error "PrintWindow returned blank for minimized window '$($target.Title)'. Pass -AllowRestoreMinimized to briefly restore, capture, and re-minimize it."
        exit 1
    }
    if ($target.Iconic) {
        # WebView2 had already suspended the minimized surface - restoring
        # is the only way left to force a real frame. Put it right back.
        [WindowScreenshot.Native]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null
        Start-Sleep -Milliseconds 400
        $winRect = New-Object WindowScreenshot.Native+RECT
        [WindowScreenshot.Native]::GetWindowRect($hwnd, [ref]$winRect) | Out-Null
        $width = $winRect.Right - $winRect.Left
        $height = $winRect.Bottom - $winRect.Top
        $bitmap = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        $ok = [WindowScreenshot.Native]::PrintWindow($hwnd, $hdc, $PW_RENDERFULLCONTENT)
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
        [WindowScreenshot.Native]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null
        $restoredForCapture = $true
        if (-not $ok) {
            $bitmap.Dispose()
            Write-Error "PrintWindow failed for '$($target.Title)' even after restoring."
            exit 1
        }
    } else {
        Write-Warning "PrintWindow returned blank/failed for '$($target.Title)'. Falling back to full-screen capture + window bounds."
        $bitmap = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($winRect.Left, $winRect.Top, 0, 0, $bitmap.Size)
        $graphics.Dispose()
        Write-Output "Window bounds: X=$($winRect.Left) Y=$($winRect.Top) Width=$width Height=$height"
    }
}

$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

if ($restoredForCapture) {
    $minimizedNote = ' [restored to capture, re-minimized]'
} elseif ($target.Iconic) {
    $minimizedNote = ' [captured while minimized]'
} else {
    $minimizedNote = ''
}
Write-Output "Target window: '$($target.Title)' ($width x $height)$minimizedNote"
Write-Output "Saved: $OutPath"
