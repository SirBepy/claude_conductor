//! Manual -> Interactive takeover. Kills the external manual claude (so it
//! stops mutating the JSONL), resolves the session_id, registers an
//! Interactive entry with the same id. Future `send_message` calls then
//! pick it up via `--resume <session_id>`. No process is spawned here.

use crate::hooks::session_files;
use crate::sessions::registry::Registry;
use crate::types::{EndReason, Settings};
use chrono::Utc;
use std::sync::Mutex;

#[derive(thiserror::Error, Debug)]
pub enum TakeoverError {
    #[error("manual session not found in registry for pid {0}")]
    NotFound(u32),
    #[error("could not resolve session_id from pid {0} (no ~/.claude/sessions/<pid>.json file)")]
    NoSessionFile(u32),
}

/// Returns the resolved session_id on success. Caller's frontend then
/// switches the chat pane to bind to this id; the next `send_message`
/// call will issue `claude -p --resume <session_id>`.
pub fn takeover(
    manual_pid: u32,
    model: &str,
    effort: &str,
    account_id: &str,
    registry: &Registry,
    settings: &Mutex<Settings>,
) -> Result<String, TakeoverError> {
    // 1. Find the manual entry by pid. The registry doesn't expose
    //    find_by_pid yet, so iterate list().
    let entry = registry
        .list()
        .into_iter()
        .find(|i| i.pid == manual_pid)
        .ok_or(TakeoverError::NotFound(manual_pid))?;
    let cwd = entry.cwd.clone();
    let session_id_from_registry = entry.session_id.clone();

    // 2. Cross-check session_id via the on-disk session file. If the
    //    on-disk file disagrees with the registry, prefer the file -
    //    the registry can carry stale session_id from a prior taskbar
    //    session that read it once and never updated.
    let session_id = if let Some(file_path) = session_files::session_file_for_pid(manual_pid) {
        session_files::parse_session_file(&file_path)
            .map(|s| s.session_id)
            .unwrap_or_else(|| session_id_from_registry.clone())
    } else {
        session_id_from_registry.clone()
    };

    if session_id.is_empty() {
        return Err(TakeoverError::NoSessionFile(manual_pid));
    }

    // 3. Kill the external claude tree. Best-effort: if the process is
    //    already dead, kill_tree silently returns. Path C doesn't need
    //    the kill to succeed for correctness - the next user message
    //    will spawn a fresh `--resume` regardless. Killing prevents the
    //    external claude from continuing to write into the same JSONL.
    crate::channels::kill::kill_tree(manual_pid);
    // kill_tree on Windows + macOS returns before the OS has finished
    // tearing down the child's pipes; brief grace prevents a JSONL race
    // if the user immediately fires send_message. 250ms is enough on
    // typical hardware without making the takeover UX feel laggy.
    std::thread::sleep(std::time::Duration::from_millis(250));

    // 4. Promote registry entry to Interactive. record_interactive_session
    //    is upsert-with-takeover semantics: existing entry's project_id
    //    and pid are preserved while kind, busy, ended_at, end_reason
    //    are reset. If the on-disk file (step 2) disagreed with the
    //    registry, this upserts under a NEW key instead of updating the
    //    entry found by pid - retire that old entry now (same EndReason
    //    the account-move path uses for its pre-move stub) so it doesn't
    //    linger as a live-looking zombie until the 5s detector poll
    //    reconciles the now-dead pid.
    let now = Utc::now().to_rfc3339();
    if session_id != session_id_from_registry {
        registry.mark_ended(&session_id_from_registry, EndReason::Moved, &now);
    }
    registry.record_interactive_session(&session_id, &cwd, settings, &now);
    registry.set_model_effort(&session_id, model, effort);
    crate::sessions::chat_config::record(&session_id, model, effort);
    // The manual session was spawned outside this app, so there is no
    // resolved account on record for it. Without this, the next respawn
    // (send_message_daemon's NotFound path) would silently fall back to
    // Settings.default_account_id instead of the account the user just
    // picked in the takeover confirmation.
    registry.set_account(&session_id, account_id);
    crate::sessions::chat_config::set_account(&session_id, account_id);

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::RegisterInput;
    use std::path::PathBuf;

    fn fresh_settings() -> Mutex<Settings> {
        Mutex::new(Settings::default())
    }

    #[test]
    fn takeover_returns_not_found_for_unknown_pid() {
        let registry = Registry::new();
        let settings = fresh_settings();
        let r = takeover(99999, "opus", "high", "acct-a", &registry, &settings);
        assert!(matches!(r, Err(TakeoverError::NotFound(99999))));
    }

    #[test]
    fn takeover_promotes_external_to_interactive() {
        let registry = Registry::new();
        let settings = fresh_settings();
        // Pre-register as External (Manual session).
        let manual_pid = 12345u32;
        registry.register(
            RegisterInput {
                session_id: "abc-session-1".into(),
                cwd: PathBuf::from("/tmp/proj"),
                pid: manual_pid,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-08T09:00:00Z".into(),
            },
            &settings,
            "2026-05-08T09:00:00Z",
        );
        assert_eq!(registry.get("abc-session-1").unwrap().kind, InstanceKind::External);

        // Takeover. (kill_tree on a non-existent pid is a no-op silent
        // failure - safe for tests.)
        let result = takeover(manual_pid, "opus", "high", "acct-work", &registry, &settings);
        assert!(result.is_ok());
        let new_id = result.unwrap();
        assert_eq!(new_id, "abc-session-1");

        let entry = registry.get("abc-session-1").unwrap();
        assert_eq!(entry.kind, InstanceKind::Interactive);
        assert_eq!(entry.busy, false);
        assert_eq!(entry.account_id.as_deref(), Some("acct-work"));
    }
}
