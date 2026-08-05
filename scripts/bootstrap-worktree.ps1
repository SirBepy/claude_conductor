# Bootstraps a fresh git worktree of this repo: submodule init, pnpm install,
# seeding the gitignored src/types/ipc.generated.ts, and (if android/ is present)
# regenerating its gitignored codegen output. Idempotent - safe to re-run on an
# already-bootstrapped worktree. See .claude/todos/433-worktree-bootstrap-automation.md
# and .claude/todos/504-android-build-not-reproducible.md.

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel) -replace "/", "\"
Set-Location $repoRoot

Write-Host "[1/4] git submodule update --init --recursive (vendor/tauri_kit)"
git submodule update --init --recursive

Write-Host "[2/4] pnpm install"
pnpm install

$typesDir = Join-Path $repoRoot "src\types"
$generatedFile = Join-Path $typesDir "ipc.generated.ts"

if (Test-Path $generatedFile) {
    Write-Host "[3/4] src/types/ipc.generated.ts already present, skipping"
} else {
    Write-Host "[3/4] seeding src/types/ipc.generated.ts"
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
    Write-Host "[4/4] android/ not present, skipping"
} elseif ((Test-Path $tauriSettingsGradle) -and (Test-Path $tauriActivityKt)) {
    Write-Host "[4/4] android/ codegen output already present, skipping"
} else {
    Write-Host "[4/4] android/ codegen output missing, running cargo tauri android init"

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

    if (-not (Test-Path $sdkHome) -or -not $ndkHome -or -not (Test-Path $javaHome)) {
        Write-Host "  could not auto-detect ANDROID_HOME/NDK_HOME/JAVA_HOME - skipping."
        Write-Host "  run manually from android/: cargo tauri android init (with those three set)"
    } else {
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
}

Write-Host "Bootstrap complete."
