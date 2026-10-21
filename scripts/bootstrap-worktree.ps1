# Bootstraps a fresh git worktree: submodule init, pnpm install, seeds the
# gitignored src/types/ipc.generated.ts, and (if android/ is present) regenerates
# its gitignored codegen output plus android/.cargo/config.toml (NDK env vars).
# Idempotent. See .claude/todos/{433,504,562}-*.md.

$ErrorActionPreference = "Stop"

# Resolved from the script's own location, never the caller's cwd: run as
# `powershell -File <wt>\scripts\bootstrap-worktree.ps1` from the main checkout,
# a cwd-based lookup bootstraps the main checkout instead and reports success
# while the worktree stays empty.
$repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel) -replace "/", "\"
Set-Location $repoRoot

. (Join-Path $PSScriptRoot "resolve-android-java-home.ps1")

# A native command that exits non-zero does not trip $ErrorActionPreference, so a
# failed submodule init or pnpm install used to fall through to "Bootstrap complete"
# and surface later as an unrelated "'vite' is not recognized" or rollup resolve error.
function Assert-Exit0([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# Main worktree is always the first line of `git worktree list --porcelain`.
$mainLine = git worktree list --porcelain | Where-Object { $_ -like "worktree *" } | Select-Object -First 1
$mainWorktree = ($mainLine -replace "^worktree ", "") -replace "/", "\"

Write-Host "[1/6] git submodule update --init --recursive (vendor/tauri_kit)"
git submodule update --init --recursive
Assert-Exit0 "git submodule update"
if (-not (Test-Path (Join-Path $repoRoot "vendor\tauri_kit\frontend"))) {
    throw "vendor/tauri_kit/frontend is missing after submodule init; the vite build cannot resolve ../vendor/tauri_kit/..."
}

Write-Host "[2/6] pnpm install"
pnpm install
Assert-Exit0 "pnpm install"
if (-not (Test-Path (Join-Path $repoRoot "node_modules\.bin\vite.CMD"))) {
    throw "node_modules/.bin/vite.CMD is missing after pnpm install"
}

$typesDir = Join-Path $repoRoot "src\types"
$generatedFile = Join-Path $typesDir "ipc.generated.ts"

if (Test-Path $generatedFile) {
    Write-Host "[3/6] src/types/ipc.generated.ts already present, skipping"
} else {
    Write-Host "[3/6] seeding src/types/ipc.generated.ts"
    if (-not (Test-Path $typesDir)) {
        New-Item -ItemType Directory -Path $typesDir | Out-Null
    }

    $sourceFile = Join-Path $mainWorktree "src\types\ipc.generated.ts"

    if (($mainWorktree -ne $repoRoot) -and (Test-Path $sourceFile)) {
        Write-Host "  copying from main worktree: $sourceFile"
        Copy-Item -Path $sourceFile -Destination $generatedFile
    } else {
        # No sibling worktree to copy from - only real generator that works.
        Write-Host "  no source to copy from, regenerating via cargo test --test export_types"
        cargo test --manifest-path src-tauri/Cargo.toml --test export_types
    }
}

$androidDir = Join-Path $repoRoot "android"
$tauriSettingsGradle = Join-Path $androidDir "src-tauri\gen\android\tauri.settings.gradle"
$tauriActivityKt = Join-Path $androidDir "src-tauri\gen\android\app\src\main\java\com\sirbepy\conductor\mobile\generated\TauriActivity.kt"

if (-not (Test-Path $androidDir)) {
    Write-Host "[4/6] android/ not present, skipping"
    Write-Host "[5/6] android/ not present, skipping"
} else {
    # These three are never persistent env vars on this machine (confirmed 2026-08-05) -
    # every android command sets them ad hoc. Auto-detect the standard install locations
    # rather than hardcoding a version that will go stale on the next SDK/NDK update.
    $sdkHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
    $ndkParent = Join-Path $sdkHome "ndk"
    $ndkHome = if ($env:NDK_HOME) {
        $env:NDK_HOME
    } elseif (Test-Path $ndkParent) {
        (Get-ChildItem $ndkParent | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
    } else { $null }
    $javaHome = Resolve-AndroidJavaHome

    if ((Test-Path $tauriSettingsGradle) -and (Test-Path $tauriActivityKt)) {
        Write-Host "[4/6] android/ codegen output already present, skipping"
    } elseif (-not (Test-Path $sdkHome) -or -not $ndkHome -or -not $javaHome -or -not (Test-Path $javaHome)) {
        Write-Host "[4/6] could not auto-detect ANDROID_HOME/NDK_HOME/JAVA_HOME - skipping."
        Write-Host "  run manually from android/: cargo tauri android init (with those three set)"
    } else {
        Write-Host "[4/6] android/ codegen output missing, running cargo tauri android init"
        Push-Location $androidDir
        try {
            $env:ANDROID_HOME = $sdkHome
            $env:NDK_HOME = $ndkHome
            $env:JAVA_HOME = $javaHome
            cargo tauri android init
        } finally {
            Pop-Location
        }
    }

    # cargo re-reads .cargo/config.toml on every invocation, so this is the only place
    # that gives per-build inheritance to `cargo tauri android build` without a wrapper
    # script. Gitignored: the NDK path is machine-specific (see the release target-dir trap).
    if (-not $ndkHome) {
        Write-Host "[5/6] could not auto-detect NDK_HOME - skipping android/.cargo/config.toml"
    } else {
        $clangBin = Join-Path $ndkHome "toolchains\llvm\prebuilt\windows-x86_64\bin"
        $tauriConfPath = Join-Path $androidDir "src-tauri\tauri.conf.json"
        # 28 tracks minSdkVersion in tauri.conf.json - read it, don't duplicate the magic number.
        $minSdk = (Get-Content $tauriConfPath -Raw | ConvertFrom-Json).bundle.android.minSdkVersion
        $clang = Join-Path $clangBin "aarch64-linux-android$minSdk-clang.cmd"
        $ar = Join-Path $clangBin "llvm-ar.exe"

        if (-not (Test-Path $clang) -or -not (Test-Path $ar)) {
            Write-Host "[5/6] NDK clang/llvm-ar not found under $clangBin - skipping android/.cargo/config.toml"
        } else {
            Write-Host "[5/6] writing android/.cargo/config.toml (NDK cross-compile env)"
            $cargoDir = Join-Path $androidDir ".cargo"
            if (-not (Test-Path $cargoDir)) {
                New-Item -ItemType Directory -Path $cargoDir | Out-Null
            }
            $clangToml = $clang -replace "\\", "\\\\"
            $arToml = $ar -replace "\\", "\\\\"
            $configToml = @"
# Generated by scripts/bootstrap-worktree.ps1 - machine-specific, gitignored.
# Do not edit by hand; re-run the bootstrap script instead.
[env]
CC_aarch64_linux_android = "$clangToml"
CXX_aarch64_linux_android = "$clangToml"
AR_aarch64_linux_android = "$arToml"
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$clangToml"
"@
            [System.IO.File]::WriteAllText((Join-Path $cargoDir "config.toml"), $configToml)
        }
    }
}

# e2e/drivers/ is gitignored and per-machine, so a fresh worktree has no msedgedriver and
# every wdio spec dies with "Unable to connect to localhost:4444". Copy from the main checkout.
$driversDir = Join-Path $repoRoot "e2e\drivers"
$mainDriversDir = Join-Path $mainWorktree "e2e\drivers"
if (Test-Path (Join-Path $driversDir "msedgedriver.exe")) {
    Write-Host "[6/6] e2e/drivers/msedgedriver.exe already present, skipping"
} elseif (($mainWorktree -ne $repoRoot) -and (Test-Path (Join-Path $mainDriversDir "msedgedriver.exe"))) {
    Write-Host "[6/6] copying e2e/drivers from main worktree: $mainDriversDir"
    New-Item -ItemType Directory -Path $driversDir -Force | Out-Null
    Copy-Item -Path (Join-Path $mainDriversDir "*") -Destination $driversDir -Recurse -Force
} else {
    Write-Host "[6/6] no msedgedriver.exe in $driversDir and none to copy from the main worktree - wdio specs will fail until it is placed there (see e2e/wdio.conf.js)"
}

Write-Host "Bootstrap complete."
