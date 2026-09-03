//! Durable per-chat model/effort record.
//!
//! The interactive-session snapshot (`persistence.rs`) drops a chat the moment
//! it ends, so a CLOSED chat loses the effort it ran with (effort is only a
//! `--effort` launch flag, never echoed into the transcript). This store keeps
//! a small, never-pruned map keyed by `session_id` so the chat-detail view can
//! still show the effort (and model) of a finished chat.
//!
//! File: `<app-data>/chat-config.json` -> `{ "<session_id>": { model, effort } }`.
//! Sole writer is the daemon (start_session / takeover / set_session_effort);
//! the main app only reads. Writes are atomic (tmp + rename) so a concurrent
//! reader never sees a torn file.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ChatConfig {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// Per-chat "auto-accept permissions" toggle. Persisted so the choice
    /// survives an app/daemon restart (the frontend gate hydrates from
    /// `list_auto_accept` on launch). Written only via `set_auto_accept`.
    #[serde(default)]
    pub auto_accept: bool,
    /// The registry account this chat was spawned under. Mirrors model/effort:
    /// recorded alongside them at spawn time so a CLOSED chat's history view
    /// can still show which account ran it. Empty for chats that predate
    /// milestone 02. Written only via `set_account`.
    #[serde(default)]
    pub account_id: String,
    /// Which optional Todos-panel columns this chat has switched on
    /// (`project`/`done`/`archived`; `here` is always shown and never stored).
    /// Per-CHAT, not per-project, by Joe's call: "if i opened up 2 columns, i
    /// wanna see them whenever i come back to this specific chat".
    #[serde(default)]
    pub todo_columns: Vec<String>,
    /// The chat this one took over from via `/respawn`. Mirrors the registry's
    /// `successor_of`, but here because the registry snapshot drops a chat the
    /// moment it ends and the transcript chain must still resolve years later.
    /// Empty for a chat that started fresh. Written only via `set_predecessor`.
    #[serde(default)]
    pub predecessor: String,
}

/// Serialize read-modify-write within a process. Cross-process integrity comes
/// from the atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn config_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("chat-config.json"))
}

fn load_map(path: &Path) -> HashMap<String, ChatConfig> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, map: &HashMap<String, ChatConfig>) {
    let json = match serde_json::to_string_pretty(map) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("chat-config: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("chat-config: write failed: {e}");
    }
}

/// Record (or update) a chat's model/effort. Empty `model`/`effort` are left
/// untouched so an effort-only update keeps the existing model. Best-effort,
/// never panics.
pub fn record(session_id: &str, model: &str, effort: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    record_at(&path, session_id, model, effort);
}

/// Look up a chat's recorded model/effort, or None if it was never recorded
/// (e.g. a chat that closed before this store existed).
pub fn get(session_id: &str) -> Option<ChatConfig> {
    let path = config_path()?;
    get_at(&path, session_id)
}

fn record_at(path: &Path, session_id: &str, model: &str, effort: &str) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    let entry = map.entry(session_id.to_string()).or_default();
    if !model.is_empty() {
        entry.model = model.to_string();
    }
    if !effort.is_empty() {
        entry.effort = effort.to_string();
    }
    write_atomic(path, &map);
}

fn get_at(path: &Path, session_id: &str) -> Option<ChatConfig> {
    load_map(path).remove(session_id)
}

/// Set (or clear) a chat's auto-accept-permissions flag. Preserves any
/// recorded model/effort on the same entry. Best-effort, never panics.
pub fn set_auto_accept(session_id: &str, value: bool) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_auto_accept_at(&path, session_id, value);
}

/// Session ids that currently have auto-accept enabled. The frontend gate
/// seeds its in-memory set from this on launch.
pub fn list_auto_accept() -> Vec<String> {
    let Some(path) = config_path() else { return Vec::new() };
    list_auto_accept_at(&path)
}

fn set_auto_accept_at(path: &Path, session_id: &str, value: bool) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().auto_accept = value;
    write_atomic(path, &map);
}

/// Record a chat's account attribution. Preserves any recorded model/effort
/// on the same entry. Best-effort, never panics.
pub fn set_account(session_id: &str, account_id: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_account_at(&path, session_id, account_id);
}

/// Set a chat's visible Todos columns. Preserves everything else on the entry.
pub fn set_todo_columns(session_id: &str, columns: Vec<String>) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_todo_columns_at(&path, session_id, columns);
}

/// Record which chat `session_id` took over from. Preserves everything else
/// on the entry. Best-effort, never panics.
pub fn set_predecessor(session_id: &str, predecessor: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_predecessor_at(&path, session_id, predecessor);
}

/// The chat `session_id` took over from, or None if it started fresh.
pub fn predecessor_of(session_id: &str) -> Option<String> {
    get(session_id).map(|c| c.predecessor).filter(|p| !p.is_empty())
}

fn set_predecessor_at(path: &Path, session_id: &str, predecessor: &str) {
    if session_id.is_empty() || predecessor.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().predecessor = predecessor.to_string();
    write_atomic(path, &map);
}

fn set_todo_columns_at(path: &Path, session_id: &str, columns: Vec<String>) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().todo_columns = columns;
    write_atomic(path, &map);
}

fn set_account_at(path: &Path, session_id: &str, account_id: &str) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().account_id = account_id.to_string();
    write_atomic(path, &map);
}

fn list_auto_accept_at(path: &Path) -> Vec<String> {
    load_map(path)
        .into_iter()
        .filter(|(_, c)| c.auto_accept)
        .map(|(id, _)| id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_model_and_effort() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        let got = get_at(&path, "sess-1").expect("recorded");
        assert_eq!(got.model, "opus");
        assert_eq!(got.effort, "high");
        assert!(get_at(&path, "missing").is_none());
    }

    #[test]
    fn effort_only_update_keeps_existing_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        // set_session_effort path: model is empty, must not clobber "opus".
        record_at(&path, "sess-1", "", "max");
        let got = get_at(&path, "sess-1").unwrap();
        assert_eq!(got.model, "opus", "model preserved on effort-only update");
        assert_eq!(got.effort, "max");
    }

    #[test]
    fn auto_accept_round_trips_and_preserves_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        set_auto_accept_at(&path, "sess-1", true);
        let got = get_at(&path, "sess-1").unwrap();
        assert!(got.auto_accept, "auto_accept set");
        assert_eq!(got.model, "opus", "model preserved across auto-accept write");
        assert_eq!(list_auto_accept_at(&path), vec!["sess-1".to_string()]);
        // Clearing drops it from the list but keeps the entry's model/effort.
        set_auto_accept_at(&path, "sess-1", false);
        assert!(list_auto_accept_at(&path).is_empty());
        assert_eq!(get_at(&path, "sess-1").unwrap().model, "opus");
    }

    #[test]
    fn set_auto_accept_empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        set_auto_accept_at(&path, "", true);
        assert!(!path.exists(), "no file written for empty session id");
    }

    #[test]
    fn predecessor_round_trips_and_preserves_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "successor", "opus", "high");
        set_predecessor_at(&path, "successor", "predecessor");
        let got = get_at(&path, "successor").unwrap();
        assert_eq!(got.predecessor, "predecessor");
        assert_eq!(got.model, "opus", "model preserved across predecessor write");
        assert!(get_at(&path, "predecessor").is_none(), "link is one-way, on the successor only");
    }

    /// A chat that started fresh must not report a chain, and an empty write
    /// must not create a phantom entry the transcript reader would follow.
    #[test]
    fn set_predecessor_empty_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        set_predecessor_at(&path, "sess-1", "");
        set_predecessor_at(&path, "", "sess-0");
        assert!(!path.exists(), "no file written for an empty id on either side");
    }

    #[test]
    fn set_account_round_trips_and_preserves_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        set_account_at(&path, "sess-1", "acct-work");
        let got = get_at(&path, "sess-1").unwrap();
        assert_eq!(got.account_id, "acct-work");
        assert_eq!(got.model, "opus", "model preserved across account write");
    }

    #[test]
    fn todo_columns_round_trip_and_preserve_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        set_todo_columns_at(&path, "sess-1", vec!["project".into(), "done".into()]);
        let got = get_at(&path, "sess-1").unwrap();
        assert_eq!(got.todo_columns, vec!["project".to_string(), "done".to_string()]);
        assert_eq!(got.model, "opus", "model preserved across a columns write");
        // Per-chat, not shared: a sibling chat starts with nothing switched on.
        assert!(get_at(&path, "sess-2").is_none());
        // Closing every column persists as an empty list, not a missing entry.
        set_todo_columns_at(&path, "sess-1", Vec::new());
        assert!(get_at(&path, "sess-1").unwrap().todo_columns.is_empty());
    }

    #[test]
    fn set_account_empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        set_account_at(&path, "", "acct-work");
        assert!(!path.exists(), "no file written for empty session id");
    }

    #[test]
    fn empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "", "opus", "high");
        assert!(!path.exists(), "no file written for empty session id");
    }
}
