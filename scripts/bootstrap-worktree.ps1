# Bootstraps a fresh git worktree of this repo: submodule init, pnpm install,
# and seeding the gitignored src/types/ipc.generated.ts. Idempotent - safe to
# re-run on an already-bootstrapped worktree. See .claude/todos/433-worktree-bootstrap-automation.md.

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel) -replace "/", "\"
Set-Location $repoRoot

Write-Host "[1/3] git submodule update --init --recursive (vendor/tauri_kit)"
git submodule update --init --recursive

Write-Host "[2/3] pnpm install"
pnpm install

$typesDir = Join-Path $repoRoot "src\types"
$generatedFile = Join-Path $typesDir "ipc.generated.ts"

if (Test-Path $generatedFile) {
    Write-Host "[3/3] src/types/ipc.generated.ts already present, skipping"
} else {
    Write-Host "[3/3] seeding src/types/ipc.generated.ts"
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

Write-Host "Bootstrap complete."
