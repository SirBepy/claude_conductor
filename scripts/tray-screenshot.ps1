<#
.SYNOPSIS
    Screenshot + zoom helper for the Windows system tray, scoped to this project.

.DESCRIPTION
    Replaces the old ad-hoc loop (full-screen capture, guess-crop, Read, recrop,
    zoom) that took 3+ attempts to land on the actual tray icon during the
    tray-icon-graphics-removal session (2026-07-08/09).

    Captures the whole primary (or -ScreenIndex'th) screen, derives the taskbar
    strip's exact bounds from Screen.Bounds vs Screen.WorkingArea (robust across
    resolution/DPI, no hardcoded coordinates), crops the rightmost -TrayWidth
    pixels of that strip (where the tray icon cluster lives), and upscales with
    nearest-neighbor interpolation so 32x32 icons are inspectable pixel-by-pixel.

    Optionally clicks an icon in the tray by approximate index counted from the
    right (0 = rightmost, which is usually the "show hidden icons" chevron or
    the clock depending on Windows version/config) using SendInput-style
    SetCursorPos + mouse_event, which works without needing foreground/focus on
    any window (SetForegroundWindow is unreliable from a tool-invoked process on
    this machine; clicking via cursor position + mouse_event does not need it).

.PARAMETER OutPath
    Where to write the cropped+zoomed PNG. Defaults to a timestamped file under
    .for_bepy/screenshots/ (project's disposable screenshot scratch dir).

.PARAMETER TrayWidth
    Width in pixels of the crop, measured from the right edge of the taskbar
    strip. Default 320 covers the icon cluster + clock on most setups; widen it
    if more icons are pinned.

.PARAMETER ZoomFactor
    Nearest-neighbor upscale multiplier applied to the crop before saving.
    Default 4.

.PARAMETER ScreenIndex
    Index into [System.Windows.Forms.Screen]::AllScreens for which monitor's
    taskbar to capture. Default 0 (primary screen's own taskbar via
    PrimaryScreen).

.PARAMETER ClickIndex
    If provided, clicks the Nth icon slot counted from the right edge of the
    tray crop (0 = rightmost slot) using a fixed -IconSlotWidth per slot. This
    is inherently approximate (icon spacing/DPI varies) - verify with a
    follow-up screenshot rather than trusting it blindly.

.PARAMETER IconSlotWidth
    Assumed width in pixels of one tray icon's clickable slot, used only when
    -ClickIndex is given. Default 36 (standard Windows tray icon slot at
    100% scaling).

.EXAMPLE
    powershell -NoProfile -File scripts/tray-screenshot.ps1
    # Captures + zooms the tray, prints the saved path.

.EXAMPLE
    powershell -NoProfile -File scripts/tray-screenshot.ps1 -TrayWidth 400 -ZoomFactor 6

.EXAMPLE
    powershell -NoProfile -File scripts/tray-screenshot.ps1 -ClickIndex 2
    # Clicks the 3rd icon slot from the right, then still saves a screenshot
    # (taken before the click) so you can confirm what was targeted.
#>
param(
    [string]$OutPath,
    [int]$TrayWidth = 320,
    [int]$ZoomFactor = 4,
    [int]$ScreenIndex = 0,
    [int]$ClickIndex = -1,
    [int]$IconSlotWidth = 36
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    Write-Error "tray-screenshot.ps1 is Windows-only."
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# P/Invoke for cursor placement + click that doesn't require foreground/focus.
Add-Type -Namespace TrayScreenshot -Name Native -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);

[DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
'@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

$screens = [System.Windows.Forms.Screen]::AllScreens
if ($ScreenIndex -lt 0 -or $ScreenIndex -ge $screens.Length) {
    Write-Error "ScreenIndex $ScreenIndex out of range (0..$($screens.Length - 1))."
    exit 1
}
$screen = $screens[$ScreenIndex]
$bounds = $screen.Bounds
$workingArea = $screen.WorkingArea

# Derive the taskbar strip from the gap between the full screen bounds and the
# working area (the area apps are allowed to occupy). Assumes a bottom-anchored
# taskbar (the Windows default); falls back to a fixed 48px guess if the
# taskbar is docked elsewhere (working area == bounds, e.g. auto-hide taskbar).
$taskbarHeight = $bounds.Bottom - $workingArea.Bottom
if ($taskbarHeight -le 0) {
    Write-Warning "Could not derive taskbar height from WorkingArea (auto-hide taskbar or non-bottom docking?). Falling back to 48px."
    $taskbarHeight = 48
}

$cropWidth = [Math]::Min($TrayWidth, $bounds.Width)
$cropRect = New-Object System.Drawing.Rectangle(
    ($bounds.Right - $cropWidth),
    ($bounds.Bottom - $taskbarHeight),
    $cropWidth,
    $taskbarHeight
)

# Full-screen capture, then crop in-memory. (Capturing the crop region
# directly via CopyFromScreen would be equivalent, but capturing full-screen
# first makes it trivial to widen TrayWidth after the fact without a re-shot,
# and matches the "full-screen capture + crop" technique that's known to work
# reliably on this machine, vs. window-handle-targeted capture which doesn't.)
$fullBitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($fullBitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $fullBitmap.Size)
$graphics.Dispose()

$crop = New-Object System.Drawing.Bitmap($cropRect.Width, $cropRect.Height)
$cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
$cropGraphics.DrawImage(
    $fullBitmap,
    (New-Object System.Drawing.Rectangle(0, 0, $cropRect.Width, $cropRect.Height)),
    $cropRect,
    [System.Drawing.GraphicsUnit]::Pixel
)
$cropGraphics.Dispose()
$fullBitmap.Dispose()

$zoomedWidth = $crop.Width * $ZoomFactor
$zoomedHeight = $crop.Height * $ZoomFactor
$zoomed = New-Object System.Drawing.Bitmap($zoomedWidth, $zoomedHeight)
$zoomGraphics = [System.Drawing.Graphics]::FromImage($zoomed)
$zoomGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$zoomGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$zoomGraphics.DrawImage($crop, 0, 0, $zoomedWidth, $zoomedHeight)
$zoomGraphics.Dispose()
$crop.Dispose()

if (-not $OutPath) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $screenshotDir = Join-Path $projectRoot '.for_bepy\screenshots'
    if (-not (Test-Path $screenshotDir)) {
        New-Item -ItemType Directory -Path $screenshotDir -Force | Out-Null
    }
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutPath = Join-Path $screenshotDir "tray-$timestamp.png"
}

$zoomed.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$zoomed.Dispose()

Write-Output "Saved: $OutPath"
Write-Output "Taskbar strip: X=$($cropRect.X) Y=$($cropRect.Y) Width=$($cropRect.Width) Height=$($cropRect.Height) (zoom x$ZoomFactor -> $($zoomedWidth)x$($zoomedHeight))"

if ($ClickIndex -ge 0) {
    $slotCenterFromRight = ($ClickIndex * $IconSlotWidth) + [Math]::Floor($IconSlotWidth / 2)
    $clickX = $bounds.Right - $slotCenterFromRight
    $clickY = $cropRect.Y + [Math]::Floor($taskbarHeight / 2)

    if ($clickX -lt $cropRect.X) {
        Write-Warning "ClickIndex $ClickIndex falls outside the captured TrayWidth ($TrayWidth px) - widen -TrayWidth or reduce -ClickIndex. Skipping click."
    } else {
        [TrayScreenshot.Native]::SetCursorPos($clickX, $clickY) | Out-Null
        Start-Sleep -Milliseconds 100
        [TrayScreenshot.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [TrayScreenshot.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        Write-Output "Clicked tray slot index $ClickIndex (approx) at ($clickX, $clickY). Verify with another screenshot - slot spacing is a fixed-width approximation, not derived from actual icon boundaries."
    }
}
