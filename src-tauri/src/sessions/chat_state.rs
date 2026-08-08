//! Durable per-chat `busy` + last-reconciled marker at `<app-data>/chat-state.json`.
//! Same shape and daemon-sole-writer ownership as `chat_config.rs`; no message
//! bodies. Never restored into the registry on startup - a restarted daemon has
//! no `claude -p` child, so a resurrected `busy: true` would be a lie.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct ChatState {
    #[serde(default)]
    pub busy: bool,
    /// Wall-clock ms of the last time `busy` changed for this session -
    /// the cheapest available "something happened" timestamp, without
    /// tracking every individual event.
    #[serde(default)]
    pub last_reconciled_ms: i64,
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn state_path() -> Option<PathBuf> {
    crate::settings::paths::chat_state_file().ok()
}

fn load_map(path: &Path) -> HashMap<String, ChatState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, map: &HashMap<String, ChatState>) {
    let json = match serde_json::to_string_pretty(map) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("chat-state: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("chat-state: write failed: {e}");
    }
}

/// Record a session's `busy` transition and stamp `last_reconciled_ms` with
/// now. Best-effort, never panics. No-op for an empty session id.
pub fn set_busy(session_id: &str, busy: bool) {
    let Some(path) = state_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().timestamp_millis();
    set_busy_at(&path, session_id, busy, now);
}

fn set_busy_at(path: &Path, session_id: &str, busy: bool, now_ms: i64) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    let entry = map.entry(session_id.to_string()).or_default();
    entry.busy = busy;
    entry.last_reconciled_ms = now_ms;
    write_atomic(path, &map);
}

/// Look up a chat's last-known busy/reconciled marker, or None if never
/// recorded (e.g. a chat that never had a turn since this store existed).
pub fn get(session_id: &str) -> Option<ChatState> {
    let path = state_path()?;
    load_map(&path).remove(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_busy_round_trips_and_stamps_reconciled() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-state.json");
        set_busy_at(&path, "sess-1", true, 1000);
        let got = get_at(&path, "sess-1").expect("recorded");
        assert!(got.busy);
        assert_eq!(got.last_reconciled_ms, 1000);
    }

    #[test]
    fn later_transition_overwrites_earlier_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-state.json");
        set_busy_at(&path, "sess-1", true, 1000);
        set_busy_at(&path, "sess-1", false, 2000);
        let got = get_at(&path, "sess-1").unwrap();
        assert!(!got.busy);
        assert_eq!(got.last_reconciled_ms, 2000);
    }

    #[test]
    fn empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-state.json");
        set_busy_at(&path, "", true, 1000);
        assert!(!path.exists(), "no file written for empty session id");
    }

    #[test]
    fn unknown_session_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-state.json");
        set_busy_at(&path, "sess-1", true, 1000);
        assert!(get_at(&path, "missing").is_none());
    }

    fn get_at(path: &Path, session_id: &str) -> Option<ChatState> {
        load_map(path).remove(session_id)
    }
}
