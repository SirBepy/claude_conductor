//! Which of a sub's changes are risky enough to owe a per-sub reviewer.
//!
//! Reviewers were about a quarter of the weekly cap (docs/architecture/subchats.md,
//! "Review policy"), and the push gate already reviews the whole range before
//! anything ships. So a sub that changed only ordinary code, UI, tests or docs
//! finishes on its facts alone, and a reviewer is owed only when a changed file is
//! on this list: the code where a miss costs data, a leaked secret, a stuck
//! daemon or a lost merge, and where waiting for the gate is too late to be cheap.

use super::{git, gitx};
use std::path::Path;

/// Repo-relative prefixes (forward slashes, lowercase) whose edits owe a reviewer.
/// One place: add a row here and the finish check, the refusal text and the chip
/// all follow.
pub const RISKY_PREFIXES: &[&str] = &[
    // Daemon concurrency and lifecycle: sub, hook, broker, federation and
    // transport code runs under locks and across processes.
    "src-tauri/src/daemon/subchats/",
    "src-tauri/src/daemon/hooks_server/",
    "src-tauri/src/daemon/broker/",
    "src-tauri/src/daemon/machines/",
    "src-tauri/src/daemon/lifecycle",
    "src-tauri/src/daemon/pump",
    "src-tauri/src/daemon/put_away",
    "src-tauri/src/daemon/auto_hide",
    "src-tauri/src/daemon/schedule",
    "src-tauri/src/daemon/state",
    "src-tauri/src/daemon/lockfile",
    "src-tauri/src/daemon/remote_",
    "src-tauri/src/daemon/spawn_",
    "src-tauri/src/daemon/methods/spawn_chat/",
    "src-tauri/src/daemon/session",
    // Security: tokens, credentials, billing guards, the stdio MCP proxy, the
    // browser bridge and the capability list.
    "src-tauri/src/daemon/browser/",
    "src-tauri/src/daemon/mcp_oauth/",
    "src-tauri/src/daemon/project_mcp",
    "src-tauri/src/daemon/secret_target",
    "src-tauri/src/daemon/api_credit",
    "src-tauri/src/accounts",
    "src-tauri/src/auth",
    "src-tauri/src/api_keys",
    "src-tauri/src/env_file",
    "src-tauri/src/chat/billing",
    "src-tauri/capabilities/",
    // Data loss: a settings struct that fails to load costs the whole file.
    "src-tauri/src/settings",
    "src-tauri/src/storage/",
    // `Settings` and `ProjectConfig` live here: a field added without `#[serde(default)]`
    // fails the whole settings.json (CLAUDE.md's serde(default) rule).
    "src-tauri/src/types/",
    // The Android tunnel and the release pipeline.
    "android/src-tauri/src/",
    ".github/workflows/",
    "src-tauri/tauri.conf.json",
    "src-tauri/src/daemon/rpc",
    "scripts/bootstrap-worktree",
    "scripts/safe-remove-worktree",
];

/// Name fragments that make a path risky wherever it sits in the repo.
pub const RISKY_FRAGMENTS: &[&str] = &["secret", "migration", "worktree", "credential"];

/// Whether a repo-relative path is on the risky list.
pub fn is_risky_path(rel: &str) -> bool {
    let p = rel.replace('\\', "/").to_ascii_lowercase();
    RISKY_PREFIXES.iter().any(|x| p.starts_with(x)) || RISKY_FRAGMENTS.iter().any(|x| p.contains(x))
}

/// What the finish check reads about a sub's changes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReviewScope {
    /// The sub edited a file in this repo with the Edit or Write tools.
    pub edited: bool,
    /// Its edited files that are on the risky list, repo-relative.
    pub risky: Vec<String>,
}

/// The sub's edited files (from its transcript) sorted into risky and plain.
/// A file outside the repo is not part of any diff the gate reviews and does not
/// count as risky here; an unreadable transcript reads as no edit, as `review_gap`
/// already does. Blocking: runs git.
pub fn review_scope(transcript: &Path, cwd: &Path) -> ReviewScope {
    let edited = git::edited_files(transcript, cwd);
    // Uncapped, so a risky file past the 200th is still seen; `edited` counts only files the
    // push gate can see, so an edit outside the repo never earns the "gate reviews it" text.
    let rel = gitx::repo_relative_all(cwd, &edited);
    ReviewScope { edited: !rel.is_empty(), risky: rel.into_iter().filter(|p| is_risky_path(p)).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risky_code_is_named_and_ordinary_code_is_not() {
        for p in [
            "src-tauri/src/daemon/subchats/finish.rs",
            "src-tauri/src/daemon/hooks_server/stop.rs",
            "src-tauri/src/daemon/broker/engine.rs",
            "src-tauri/src/daemon/machines/forward.rs",
            "src-tauri/src/daemon/lifecycle.rs",
            "src-tauri/src/daemon/put_away/rows.rs",
            "src-tauri/src/accounts/api_credit.rs",
            "src-tauri/src/settings/store.rs",
            "src-tauri/src/types/notifications.rs",
            "src-tauri/src/types/project.rs",
            "src-tauri/src/daemon/methods/spawn_chat/forward.rs",
            "android/src-tauri/src/iroh_tunnel.rs",
            "scripts/bootstrap-worktree.ps1",
            "src-tauri/src/people/secret_vault.rs",
            "src-tauri/tests/characters_migration.rs",
            ".github/workflows/desktop-build.yml",
        ] {
            assert!(is_risky_path(p), "{p}");
        }
        for p in [
            "src/views/sessions/chat-head.ts",
            "src/styles/sessions.css",
            "docs/architecture/subchats.md",
            "README.md",
            "src-tauri/src/voice/dictation.rs",
            "src-tauri/src/daemon/methods/people.rs",
            "src-tauri/src/mcp/tool_schemas_core.rs",
        ] {
            assert!(!is_risky_path(p), "{p}");
        }
    }

    #[test]
    fn a_windows_separator_and_upper_case_do_not_hide_a_risky_path() {
        assert!(is_risky_path("src-tauri\\src\\Daemon\\Subchats\\finish.rs"));
    }
}
