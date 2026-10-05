//! Auto-continue for chats a daemon restart cut off mid-turn.
//!
//! An app update (or a crash) kills the daemon and every `claude` child with
//! it, and nothing runs at exit (see shutdown_guard.rs's note on the detached
//! daemon). What survives is `chat-state.json`, written at every turn start and
//! end, plus the snapshot's last reported status. A chat whose last write there
//! was "busy", or whose last status was "working" (background subagents), was
//! still going when the daemon died; restored as-is it would read Done. Each
//! gets a silent "continue", the same resend `unfreeze_session` uses.

use std::sync::Arc;

use crate::daemon::state::DaemonState;
use crate::sessions::chat_state::ChatState;
use crate::sessions::persistence::PersistedInteractive;

/// Older than this, a cut-off turn is someone else's forgotten work, not
/// something to restart unannounced.
const MAX_INTERRUPT_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// Gap between resends, so a restart that cut off several chats doesn't spawn
/// every `claude` process in the same instant.
const STAGGER: std::time::Duration = std::time::Duration::from_millis(500);

/// Session ids from `snapshot` that were mid-turn when the daemon last died.
/// Frozen chats are skipped: unfreeze owns their resume (`frozen_needs_continue`),
/// and an auto-frozen one already has a rate-limit resume queued.
pub fn interrupted_sessions(
    snapshot: &[PersistedInteractive],
    chat_state: impl Fn(&str) -> Option<ChatState>,
    now_ms: i64,
) -> Vec<String> {
    snapshot
        .iter()
        .filter(|s| !s.frozen && !s.auto_frozen)
        .filter(|s| {
            let Some(cs) = chat_state(&s.session_id) else { return false };
            if now_ms - cs.last_reconciled_ms > MAX_INTERRUPT_AGE_MS {
                return false;
            }
            cs.busy || s.awaiting.as_deref() == Some("working")
        })
        .map(|s| s.session_id.clone())
        .collect()
}

/// Resends "continue" to each of `session_ids`, respawning its `claude`
/// process. The pump flips the chat back to busy on the turn's first event.
pub fn spawn_resumes(state: Arc<DaemonState>, session_ids: Vec<String>) {
    if session_ids.is_empty() {
        return;
    }
    // Test daemons (wdio, daemon_client tests) must never spend a real turn.
    if std::env::var_os("CC_DAEMON_NO_AUTOSTART").is_some() {
        log::info!(
            "CC_DAEMON_NO_AUTOSTART set: not auto-continuing {} interrupted chat(s)",
            session_ids.len()
        );
        return;
    }
    tokio::spawn(async move {
        for sid in session_ids {
            log::info!("resume_interrupted: auto-continuing {sid}, cut off mid-turn by the last daemon exit");
            if let Err(e) = crate::daemon::lifecycle::send_message_with_respawn(&state, &sid, "continue", false).await {
                log::warn!("resume_interrupted: auto-continue failed for {sid}: {e}");
            }
            tokio::time::sleep(STAGGER).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    const NOW: i64 = 1_800_000_000_000;

    fn entry(id: &str, awaiting: Option<&str>) -> PersistedInteractive {
        let mut e: PersistedInteractive = serde_json::from_value(serde_json::json!({
            "session_id": id,
            "cwd": PathBuf::from("."),
            "project_id": "p",
            "name": null,
            "model": "opus",
            "effort": "high",
            "started_at": "2026-10-05T00:00:00Z",
        }))
        .unwrap();
        e.awaiting = awaiting.map(str::to_string);
        e
    }

    fn states(rows: &[(&str, bool, i64)]) -> HashMap<String, ChatState> {
        rows.iter()
            .map(|(id, busy, at)| (id.to_string(), ChatState { busy: *busy, last_reconciled_ms: *at }))
            .collect()
    }

    fn pick(snapshot: &[PersistedInteractive], cs: &HashMap<String, ChatState>) -> Vec<String> {
        interrupted_sessions(snapshot, |id| cs.get(id).copied(), NOW)
    }

    #[test]
    fn a_chat_killed_mid_turn_is_resumed_and_an_idle_one_is_not() {
        let snapshot = [entry("mid-turn", Some("done")), entry("idle", Some("done"))];
        let cs = states(&[("mid-turn", true, NOW - 60_000), ("idle", false, NOW - 60_000)]);
        assert_eq!(pick(&snapshot, &cs), vec!["mid-turn"]);
    }

    #[test]
    fn a_chat_waiting_on_its_background_subagents_is_resumed() {
        let snapshot = [entry("bg", Some("working"))];
        let cs = states(&[("bg", false, NOW - 60_000)]);
        assert_eq!(pick(&snapshot, &cs), vec!["bg"]);
    }

    #[test]
    fn a_turn_cut_off_more_than_a_day_ago_is_left_alone() {
        let snapshot = [entry("old", None), entry("old-bg", Some("working"))];
        let stale = NOW - MAX_INTERRUPT_AGE_MS - 1;
        let cs = states(&[("old", true, stale), ("old-bg", false, stale)]);
        assert!(pick(&snapshot, &cs).is_empty());
    }

    #[test]
    fn frozen_chats_and_chats_with_no_turn_record_are_skipped() {
        let mut frozen = entry("frozen", None);
        frozen.frozen = true;
        let mut auto_frozen = entry("auto-frozen", None);
        auto_frozen.auto_frozen = true;
        let snapshot = [frozen, auto_frozen, entry("never-ran", Some("working"))];
        let cs = states(&[("frozen", true, NOW), ("auto-frozen", true, NOW)]);
        assert!(pick(&snapshot, &cs).is_empty());
    }
}
