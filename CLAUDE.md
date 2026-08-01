@~/.claude/snippets/full-auto.md

# Claude Conductor

Cross-platform Tauri 2 app (Rust + vanilla JS webview). Usage monitoring via cookie-authenticated HTTPS polling of the claude.ai usage API (Chrome/CDP runs only during the one-time login flow to capture the sessionKey), interactive Claude chat sessions (daemon-hosted persistent `claude` per session), hooks/MCP permission relay, and channel management.

## Project

Type: other (Tauri 2 / Rust + vanilla JS webview)
Deploy: GitHub Releases (NSIS / DMG / DEB + AppImage via CI)

## Structure

`src-tauri/src/` Rust backend, `src/` frontend SPA, `src-tauri/tauri.conf.json` Tauri config

## Commands

- Dev: `cargo tauri dev` (runs from anywhere in the repo; the Tauri CLI auto-locates `src-tauri/tauri.conf.json`)
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml`
- Worktree bootstrap: `powershell -File scripts/bootstrap-worktree.ps1` (run once right after `git worktree add`/`EnterWorktree`, before any build/verify - inits the `vendor/tauri_kit` submodule, runs `pnpm install`, and seeds the gitignored `src/types/ipc.generated.ts`; idempotent, cwd-independent). Not `pwsh`: PowerShell 7 is not installed here. Takes ~9s when it can copy `ipc.generated.ts` from an existing worktree, but several minutes on a fresh clone with no sibling to copy from, since it falls back to `cargo test --test export_types`.

## Rules

- Keep `README.md` in sync when auth flow, tray behavior, scraping approach, or project structure changes. README is user-facing; CLAUDE.md is developer rules only.
- Chat hub is subscription-only. `check_metered_billing` in `chat/billing.rs` refuses to spawn if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex env vars are set.
- No auto-restart on channel exit - would register a fresh bridge with Claude desktop each time, creating duplicate entries in the Code sidebar. Spawn once, stay dead until manual Restart.
- Linux: chat hub works but channel automation (Plan C) unavailable (`SpawnError::NonWindows`).
- Custom IPC commands need only `generate_handler!` registration - no `capabilities/default.json` entry. Capabilities entries ARE required for plugin permissions and new window labels (window labels must match `src-tauri/capabilities/default.json`, e.g. the `session-*` pattern).
