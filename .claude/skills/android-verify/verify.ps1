param(
    [switch]$NoBuild,
    [switch]$Logs
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$AndroidDir = Join-Path $RepoRoot "android"
$ApkOutputsDir = Join-Path $AndroidDir "src-tauri\gen\android\app\build\outputs\apk"
$KeystoreReadme = "C:\Users\tecno\.android-keystores\README.txt"
$Package = "com.sirbepy.conductor.mobile"

function Fail($msg) {
    Write-Host "FAIL: $msg" -ForegroundColor Red
    exit 1
}

# --- Step 1: device check, prefer real device over emulator ---
$deviceLines = & adb devices -l 2>$null | Select-Object -Skip 1 | Where-Object { $_ -match '\S' -and $_ -notmatch 'unauthorized' }
if (-not $deviceLines) {
    Fail "no adb device attached. Connect the real device (or start the emulator) and retry."
}

$real = $deviceLines | Where-Object { $_ -notmatch 'emulator-' } | Select-Object -First 1
$chosen = if ($real) { $real } else { $deviceLines | Select-Object -First 1 }
$deviceSerial = ($chosen -split '\s+')[0]
if (-not $real) {
    Write-Host "WARNING: no real device attached, using emulator ($deviceSerial). Emulator results are provisional - it gives both false positives and false negatives for this app." -ForegroundColor Yellow
} else {
    Write-Host "Using device: $deviceSerial"
}
$adbS = @("-s", $deviceSerial)

# --- Step 2: build ---
if (-not $NoBuild) {
    $sdkHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
    $ndkRoot = Join-Path $sdkHome "ndk"
    $ndkHome = if ($env:NDK_HOME) { $env:NDK_HOME } elseif (Test-Path $ndkRoot) {
        (Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
    } else { $null }
    $javaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" }

    if (-not (Test-Path $sdkHome) -or -not $ndkHome -or -not (Test-Path $javaHome)) {
        Fail "could not resolve ANDROID_HOME/NDK_HOME/JAVA_HOME (sdk=$sdkHome ndk=$ndkHome java=$javaHome). Set them and retry."
    }

    Write-Host "Building (cargo tauri android build --target aarch64 --apk)..."
    Push-Location $AndroidDir
    try {
        $env:ANDROID_HOME = $sdkHome
        $env:NDK_HOME = $ndkHome
        $env:JAVA_HOME = $javaHome
        & cargo tauri android build --target aarch64 --apk
        if ($LASTEXITCODE -ne 0) { Fail "cargo tauri android build failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

# --- Locate newest APK ---
$apk = Get-ChildItem -Path $ApkOutputsDir -Recurse -Filter "*.apk" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) {
    Fail "no APK found under $ApkOutputsDir. Run without -NoBuild first."
}
Write-Host "APK: $($apk.FullName)"

# --- Step 3: signing check BEFORE install ---
if (-not (Test-Path $KeystoreReadme)) {
    Fail "keystore README not found at $KeystoreReadme - cannot verify signing cert. Refusing to install."
}
$readmeText = [IO.File]::ReadAllText($KeystoreReadme)
if ($readmeText -notmatch 'Cert SHA-256:\s*([0-9a-fA-F]+)') {
    Fail "could not find 'Cert SHA-256:' line in $KeystoreReadme."
}
$expectedSha = $matches[1].ToLower()

$sdkHomeForTools = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$buildTools = Get-ChildItem (Join-Path $sdkHomeForTools "build-tools") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) {
    Fail "no Android build-tools found under $sdkHomeForTools\build-tools - cannot run apksigner."
}
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
if (-not (Test-Path $apksigner)) {
    Fail "apksigner.bat not found at $apksigner."
}

$verifyOut = & $apksigner verify --print-certs "$($apk.FullName)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "apksigner verify failed on $($apk.FullName):`n$verifyOut"
}
$certLine = $verifyOut | Where-Object { $_ -match 'SHA-256 digest:\s*([0-9a-fA-F]+)' } | Select-Object -First 1
if (-not $certLine -or $certLine -notmatch 'SHA-256 digest:\s*([0-9a-fA-F]+)') {
    Fail "could not parse a SHA-256 digest out of apksigner output:`n$verifyOut"
}
$actualSha = $matches[1].ToLower()

if ($actualSha -ne $expectedSha) {
    Fail "APK signing cert mismatch. Expected $expectedSha (project keystore), got $actualSha. NOT installing - installing this would throw INSTALL_FAILED_UPDATE_INCOMPATIBLE, and the only fix is 'adb uninstall', which wipes device pairing state. Rebuild with the correct keystore.properties instead."
}
Write-Host "Signing cert OK ($actualSha)"

# --- Step 4: install ---
Write-Host "Installing..."
& adb @adbS install -r "$($apk.FullName)"
if ($LASTEXITCODE -ne 0) { Fail "adb install failed (exit $LASTEXITCODE)." }

# --- Step 5: launch ---
if ($Logs) {
    & adb @adbS logcat -c
}
& adb @adbS shell am force-stop $Package
& adb @adbS shell input keyevent KEYCODE_WAKEUP
Write-Host "Launching..."
& adb @adbS shell am start -n "$Package/.MainActivity" -W
if ($LASTEXITCODE -ne 0) { Fail "am start failed (exit $LASTEXITCODE)." }

# --- Step 6: screenshot ---
$ancestorPid = $PID
$ancestorTicks = [DateTime]::Now.Ticks
$shotDir = Join-Path $RepoRoot ".for_bepy\screenshots\$ancestorPid-$ancestorTicks"
New-Item -ItemType Directory -Force $shotDir | Out-Null
$shotPath = Join-Path $shotDir "android-verify.png"

& adb @adbS shell screencap -p /sdcard/x.png
if ($LASTEXITCODE -ne 0) { Fail "screencap failed (exit $LASTEXITCODE)." }

$env:MSYS_NO_PATHCONV = "1"
& adb @adbS pull /sdcard/x.png "$shotPath"
if ($LASTEXITCODE -ne 0) { Fail "adb pull failed (exit $LASTEXITCODE)." }
& adb @adbS shell rm /sdcard/x.png

Write-Host "Screenshot: $shotPath"

# --- Step 7: logs ---
if ($Logs) {
    Write-Host "--- filtered logcat ---"
    & adb @adbS logcat -d | Select-String -Pattern "chromium|Console|conductor|tauri|WebView|AndroidRuntime|RustStdoutStderr|FATAL"
}

# --- Step 8: cleanup - kill Gradle daemons only, never a blanket java.exe kill ---
$gradleDaemons = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'org\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon' }
foreach ($p in $gradleDaemons) {
    Write-Host "Killing Gradle daemon PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Done."
