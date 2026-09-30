pub mod usage;
pub mod accounts;
pub mod settings;
pub mod projects;
pub mod token_source;
pub mod project_groups;
pub mod project_icons;
pub mod channels;
pub mod chat;
pub mod tokens;
pub mod drain;
pub mod auth;
pub mod audio_preview;
pub mod misc;
pub mod git;
pub mod git_diff;
pub mod git_commit_refs;
pub mod tickets;
pub mod git_sync;
pub mod ai_todos;
pub mod models;
mod models_auth;
pub mod window;
pub mod overlay_window;
pub mod update;
pub mod characters;
pub mod audio;
pub mod news;
pub mod slash;
pub mod files;
pub mod skill_usage;
pub mod storage;
pub mod machines;
pub mod remote_access;
pub mod schedule;
pub mod servers;
pub mod preview;
pub mod ask;
pub mod message_drafts;
pub mod user_todos;
pub mod worktrees;
pub mod claude_scopes;
pub mod drafts;
pub mod step_comments;
pub mod waiting_tail;
pub mod ready;
pub mod instances;
pub mod hook_registration;
pub mod external_launchers;

pub use usage::*;
pub use accounts::*;
pub use settings::*;
pub use projects::*;
pub use project_groups::*;
pub use project_icons::*;
pub use channels::*;
pub use chat::*;
pub use tokens::*;
pub use drain::*;
pub use auth::*;
pub use audio_preview::*;
pub use misc::*;
pub use git::*;
pub use git_diff::*;
pub use ai_todos::*;
pub use models::*;
pub use window::*;
pub use overlay_window::*;
pub use update::*;
pub use characters::*;
pub use audio::*;
pub use news::*;
pub use slash::*;
pub use files::*;
pub use skill_usage::*;
pub use storage::*;
pub use machines::*;
pub use remote_access::*;
pub use schedule::*;
pub use servers::*;
pub use preview::*;
pub use ask::*;
pub use message_drafts::*;
pub use user_todos::*;
pub use worktrees::*;
pub use claude_scopes::*;
pub use drafts::*;
pub use step_comments::*;
pub use waiting_tail::*;
pub use ready::*;

// Re-export test helper submodules so integration tests can reach them via
// `claude_conductor_lib::ipc::projects_test_helpers` and
// `claude_conductor_lib::ipc::legacy_import_test_helpers`.
pub use projects::projects_test_helpers;
pub use projects::legacy_import_test_helpers;

#[cfg(test)]
mod command_thread_tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// A plain sync `#[tauri::command]` runs on the UI thread in Tauri 2, so any
    /// IO in it freezes the window (todo 1005 found it in nine files after the
    /// first fix). Every command must be `async fn`, `#[tauri::command(async)]`,
    /// or carry a `// sync-command: <why>` comment directly above it.
    #[test]
    fn every_sync_tauri_command_is_justified() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        let mut checked = 0;
        let mut offenders = Vec::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                let trimmed = line.trim();
                if !trimmed.starts_with("#[tauri::command") {
                    continue;
                }
                checked += 1;
                // `#[tauri::command(async)]` forces the command onto the async
                // runtime via the macro arg even when the fn itself is written as
                // plain `fn` (see ipc/window/mod.rs's module doc) - already safe,
                // whatever other args ride alongside it.
                if trimmed.contains("async") {
                    continue;
                }
                let Some(sig) = lines[i + 1..].iter().find(|l| l.contains("fn ")) else {
                    continue;
                };
                if sig.contains("async fn") {
                    continue;
                }
                let justified = lines[..i]
                    .iter()
                    .rev()
                    .take_while(|l| l.trim_start().starts_with("//"))
                    .any(|l| l.contains("// sync-command:"));
                if !justified {
                    offenders.push(format!("{}:{}: {}", file.display(), i + 1, sig.trim()));
                }
            }
        }
        assert!(checked > 100, "expected to scan every command, only saw {checked}");
        assert!(
            offenders.is_empty(),
            "sync #[tauri::command]s with no `// sync-command:` reason (make them async, \
             or say why they cannot block):\n{}",
            offenders.join("\n")
        );
    }
}
