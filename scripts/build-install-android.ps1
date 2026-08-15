# Builds the Android APK (aarch64) and installs it on the one connected device.
# Auto-detect logic duplicated from scripts/bootstrap-worktree.ps1 per
# .claude/todos/594-android-build-install-script.md (kept inline, not extracted, to
# avoid a shared-helper file neither todo asked for).
[CmdletBinding()]
param(
    [switch]$Fresh
)

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel) -replace "/", "\"
$androidDir = Join-Path $repoRoot "android"

$sdkHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$ndkParent = Join-Path $sdkHome "ndk"
$ndkHome = if ($env:NDK_HOME) {
    $env:NDK_HOME
} elseif (Test-Path $ndkParent) {
    (Get-ChildItem $ndkParent | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
} else { $null }
$javaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" }

if (-not (Test-Path $sdkHome) -or -not $ndkHome -or -not (Test-Path $javaHome)) {
    throw "Could not auto-detect ANDROID_HOME/NDK_HOME/JAVA_HOME. Set them explicitly and re-run."
}

$tauriConfPath = Join-Path $androidDir "src-tauri\tauri.conf.json"
$conf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$minSdk = $conf.bundle.android.minSdkVersion
$packageId = $conf.identifier

$clangBin = Join-Path $ndkHome "toolchains\llvm\prebuilt\windows-x86_64\bin"
$clang = Join-Path $clangBin "aarch64-linux-android$minSdk-clang.cmd"
$ar = Join-Path $clangBin "llvm-ar.exe"
if (-not (Test-Path $clang) -or -not (Test-Path $ar)) {
    throw "NDK clang/llvm-ar not found under $clangBin"
}

$env:ANDROID_HOME = $sdkHome
$env:NDK_HOME = $ndkHome
$env:JAVA_HOME = $javaHome
$env:CC_aarch64_linux_android = $clang
$env:CXX_aarch64_linux_android = $clang
$env:AR_aarch64_linux_android = $ar
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $clang

Push-Location $androidDir
try {
    # Stream directly - piping through tail/select-object buffers until EOF and hides
    # a stuck Gradle daemon for up to an hour (see project_android_verify_gotchas.md).
    cargo tauri android build --target aarch64 --apk
    if ($LASTEXITCODE -ne 0) {
        throw "cargo tauri android build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$outputsDir = Join-Path $androidDir "src-tauri\gen\android\app\build\outputs"
$apk = Get-ChildItem -Path $outputsDir -Filter "*.apk" -Recurse |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) {
    throw "No .apk found under $outputsDir after a successful build"
}
Write-Host "Built: $($apk.FullName)"

# @() is load-bearing: with exactly one device the pipeline yields a bare string,
# and $deviceLines[0] then indexes a CHARACTER ("e" of "emulator-5554"), not a line.
$deviceLines = @(adb devices -l | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne "" })
if ($deviceLines.Count -eq 0) {
    throw "No adb device attached. Connect exactly one device and re-run."
}
if ($deviceLines.Count -gt 1) {
    throw "Multiple adb devices attached, pick one with 'adb -s <serial>' by hand: `n$($deviceLines -join "`n")"
}
$deviceSerial = ($deviceLines[0] -split "\s+")[0]
Write-Host "Installing to device: $deviceSerial"

if ($Fresh) {
    Write-Host "Fresh install requested: uninstalling $packageId first"
    adb -s $deviceSerial uninstall $packageId
    adb -s $deviceSerial install $apk.FullName
} else {
    adb -s $deviceSerial install -r $apk.FullName
}
if ($LASTEXITCODE -ne 0) {
    throw "adb install failed with exit code $LASTEXITCODE"
}
Write-Host "Installed."
