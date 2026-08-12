# Regenerates the Android launcher icon: pads/scales assets/icon/icon-master-1024.png,
# runs `cargo tauri icon` into a SCRATCH dir (never the real icons dir - a known CLI bug
# silently no-ops mipmap writes there, see assets/icon/README.md trap 3), then copies the
# mipmaps into both tracked locations. See .claude/todos/593-android-icon-regen-script.md.
[CmdletBinding()]
param(
    [double]$Scale = 0.60,
    [double]$MarginRatio = 1.4,
    [string]$BackgroundColor,
    [switch]$Confirm
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = (git rev-parse --show-toplevel) -replace "/", "\"
$master = Join-Path $repoRoot "assets\icon\icon-master-1024.png"
if (-not (Test-Path $master)) {
    throw "Master icon not found: $master"
}

$canvasSize = 1024
$fgSize = [int][math]::Round($canvasSize * $Scale)
$totalPad = $canvasSize - $fgSize
# Asymmetric margin, top/left weighted (dev-approved ratio from 568bf63f: 1.4).
$leftTop = [int][math]::Round($totalPad * $MarginRatio / (1 + $MarginRatio))
$rightBottom = $totalPad - $leftTop
Write-Host "Scale $Scale -> fg ${fgSize}px, margin ${leftTop}px top/left, ${rightBottom}px bottom/right"

$scratch = Join-Path $env:TEMP ("android-icon-regen-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null
$outDir = Join-Path $scratch "out"

try {
    $paddedSource = Join-Path $scratch "padded-source.png"
    $src = [System.Drawing.Image]::FromFile($master)
    $canvas = New-Object System.Drawing.Bitmap($canvasSize, $canvasSize)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($src, $leftTop, $leftTop, $fgSize, $fgSize)
    $graphics.Dispose()
    $canvas.Save($paddedSource, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
    $src.Dispose()

    $manifest = @{ default = $paddedSource; android_fg = $paddedSource } | ConvertTo-Json
    $manifestPath = Join-Path $scratch "manifest.json"
    [System.IO.File]::WriteAllText($manifestPath, $manifest)

    Write-Host "Running cargo tauri icon into scratch dir: $outDir"
    cargo tauri icon $manifestPath -o $outDir
    if ($LASTEXITCODE -ne 0) {
        throw "cargo tauri icon failed with exit code $LASTEXITCODE"
    }

    $fgPreview = Join-Path $outDir "android\mipmap-xxxhdpi\ic_launcher_foreground.png"
    Write-Host "Preview before copying: $fgPreview"

    if ($Confirm) {
        $answer = Read-Host "Copy into tracked Android icon dirs? [y/N]"
        if ($answer -ne "y") {
            Write-Host "Aborted, scratch output left at $scratch for inspection"
            return
        }
    }

    $densities = "hdpi", "mdpi", "xhdpi", "xxhdpi", "xxxhdpi"
    $files = "ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"
    $targets = @(
        (Join-Path $repoRoot "android\src-tauri\icons\android"),
        (Join-Path $repoRoot "android\src-tauri\gen\android\app\src\main\res")
    )

    foreach ($density in $densities) {
        $srcDir = Join-Path $outDir "android\mipmap-$density"
        foreach ($file in $files) {
            $srcFile = Join-Path $srcDir $file
            if (-not (Test-Path $srcFile)) {
                Write-Warning "Missing $srcFile, skipping"
                continue
            }
            foreach ($target in $targets) {
                $destDir = Join-Path $target "mipmap-$density"
                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir | Out-Null
                }
                Copy-Item -Path $srcFile -Destination (Join-Path $destDir $file) -Force
            }
        }
    }

    if ($BackgroundColor) {
        $xmlTargets = @(
            (Join-Path $repoRoot "android\src-tauri\icons\android\values\ic_launcher_background.xml"),
            (Join-Path $repoRoot "android\src-tauri\gen\android\app\src\main\res\values\ic_launcher_background.xml")
        )
        foreach ($xmlPath in $xmlTargets) {
            if (-not (Test-Path $xmlPath)) {
                Write-Warning "Missing $xmlPath, skipping background patch"
                continue
            }
            $xml = Get-Content $xmlPath -Raw
            $xml = $xml -replace '(<color name="ic_launcher_background">)[^<]*(</color>)', ('$1' + $BackgroundColor + '$2')
            [System.IO.File]::WriteAllText($xmlPath, $xml)
        }
        Write-Host "Patched background color to $BackgroundColor"
    }

    Write-Host "Done: copied mipmaps for $($densities.Count) densities into both tracked dirs."
} finally {
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}
