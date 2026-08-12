# Bootstraps a fresh git worktree: submodule init, pnpm install, seeds the
# gitignored src/types/ipc.generated.ts, and (if android/ is present) regenerates
# its gitignored codegen output plus android/.cargo/config.toml (NDK env vars).
# Idempotent. See .claude/todos/{433,504,562}-*.md.

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel) -replace "/", "\"
Set-Location $repoRoot

Write-Host "[1/5] git submodule update --init --recursive (vendor/tauri_kit)"
git submodule update --init --recursive

Write-Host "[2/5] pnpm install"
pnpm install

$typesDir = Join-Path $repoRoot "src\types"
$generatedFile = Join-Path $typesDir "ipc.generated.ts"

if (Test-Path $generatedFile) {
    Write-Host "[3/5] src/types/ipc.generated.ts already present, skipping"
} else {
    Write-Host "[3/5] seeding src/types/ipc.generated.ts"
    if (-not (Test-Path $typesDir)) {
        New-Item -ItemType Directory -Path $typesDir | Out-Null
    }

    # Main worktree is always the first line of `git worktree list --porcelain`.
    $porcelain = git worktree list --porcelain
    $mainLine = $porcelain | Where-Object { $_ -like "worktree *" } | Select-Object -First 1
    $mainWorktree = ($mainLine -replace "^worktree ", "") -replace "/", "\"
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
    Write-Host "[4/5] android/ not present, skipping"
    Write-Host "[5/5] android/ not present, skipping"
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
    $javaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" }

    if ((Test-Path $tauriSettingsGradle) -and (Test-Path $tauriActivityKt)) {
        Write-Host "[4/5] android/ codegen output already present, skipping"
    } elseif (-not (Test-Path $sdkHome) -or -not $ndkHome -or -not (Test-Path $javaHome)) {
        Write-Host "[4/5] could not auto-detect ANDROID_HOME/NDK_HOME/JAVA_HOME - skipping."
        Write-Host "  run manually from android/: cargo tauri android init (with those three set)"
    } else {
        Write-Host "[4/5] android/ codegen output missing, running cargo tauri android init"
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
        Write-Host "[5/5] could not auto-detect NDK_HOME - skipping android/.cargo/config.toml"
    } else {
        $clangBin = Join-Path $ndkHome "toolchains\llvm\prebuilt\windows-x86_64\bin"
        $tauriConfPath = Join-Path $androidDir "src-tauri\tauri.conf.json"
        # 28 tracks minSdkVersion in tauri.conf.json - read it, don't duplicate the magic number.
        $minSdk = (Get-Content $tauriConfPath -Raw | ConvertFrom-Json).bundle.android.minSdkVersion
        $clang = Join-Path $clangBin "aarch64-linux-android$minSdk-clang.cmd"
        $ar = Join-Path $clangBin "llvm-ar.exe"

        if (-not (Test-Path $clang) -or -not (Test-Path $ar)) {
            Write-Host "[5/5] NDK clang/llvm-ar not found under $clangBin - skipping android/.cargo/config.toml"
        } else {
            Write-Host "[5/5] writing android/.cargo/config.toml (NDK cross-compile env)"
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

Write-Host "Bootstrap complete."
