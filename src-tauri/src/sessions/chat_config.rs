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
    /// Per-chat "Use subchats" mode: this chat hands jobs Joe names to hidden
    /// child chats. Read at spawn (argv system prompt, `lifecycle::spawn`) and
    /// on every send, which appends a note to the first message after a
    /// mid-chat flip. Written only via `set_subchats_on`.
    #[serde(default)]
    pub subchats_on: bool,
    /// What the chat's model was last told about `subchats_on`. Persisted so a
    /// child that dies after the toggle went OFF still retracts the ON prompt
    /// its resumed history holds; an in-memory flag would reset to the config
    /// value and skip the retraction.
    #[serde(default)]
    pub subchats_told: bool,
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
    /// The paired machine that started this chat here (`start_session` or
    /// `spawn_chat` arriving over `Transport::PeerMachine`). Empty for a chat
    /// started on this machine or by the phone. A peer whose "can drive this
    /// PC's chats" switch is off may still drive the chats it started, so
    /// this outlives a daemon restart. Written only via `set_started_by_machine`.
    #[serde(default)]
    pub started_by_machine: String,
    /// The chat whose `spawn_chat` call started this one (not a respawn: that
    /// is `predecessor`). Empty for a chat started any other way. When-done
    /// reads it to let a child of an armed chat join the armed set. Written
    /// only via `set_spawned_by`.
    #[serde(default)]
    pub spawned_by: String,
    /// The brief this chat was spawned with as a hidden sub of a main chat.
    /// Present for as long as the chat is a sub, including after it ended,
    /// which the registry (it drops an ended chat) cannot say. Written only via
    /// `set_subchat`.
    #[serde(default)]
    pub subchat: Option<crate::daemon::subchats::SubchatBrief>,
    /// When Joe last had this chat on screen on any of his devices (epoch ms, the
    /// host's clock; 0 = never). The chat heads clear a chat's purple unread and green
    /// finished-sub badge for everything up to this mark, so a view on the PC clears
    /// the badge on the phone and the Mac. Never moves backwards. Written only via
    /// `set_viewed_at`.
    #[serde(default)]
    pub viewed_at_ms: i64,
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

impl ChatConfig {
    /// The told-state a freshly spawned child starts from: the toggle's current
    /// value (baked into argv) or an earlier told ON that was never retracted.
    pub fn subchats_told_at_spawn(&self) -> bool {
        self.subchats_on || self.subchats_told
    }
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

/// Record which paired machine started `session_id`. Preserves everything
/// else on the entry. Best-effort, never panics.
pub fn set_started_by_machine(session_id: &str, machine_id: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if session_id.is_empty() || machine_id.is_empty() {
        return;
    }
    let mut map = load_map(&path);
    map.entry(session_id.to_string()).or_default().started_by_machine = machine_id.to_string();
    write_atomic(&path, &map);
}

/// The chat `session_id` took over from, or None if it started fresh.
pub fn predecessor_of(session_id: &str) -> Option<String> {
    get(session_id).map(|c| c.predecessor).filter(|p| !p.is_empty())
}

/// Record which chat's `spawn_chat` started `session_id`. Preserves
/// everything else on the entry. Best-effort, never panics.
pub fn set_spawned_by(session_id: &str, parent: &str) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_spawned_by_at(&path, session_id, parent);
}

/// The chat that started `session_id`, by `spawn_chat` or by respawn, or
/// None for a chat started by hand or by a schedule.
pub fn parent_of(session_id: &str) -> Option<String> {
    get(session_id).and_then(parent_in)
}

fn parent_in(c: ChatConfig) -> Option<String> {
    [c.predecessor, c.spawned_by].into_iter().find(|p| !p.is_empty())
}

/// Record (or clear) the brief that makes `session_id` a hidden sub. Preserves
/// everything else on the entry. Best-effort, never panics.
pub fn set_subchat(session_id: &str, brief: Option<crate::daemon::subchats::SubchatBrief>) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_subchat_at(&path, session_id, brief);
}

/// Ids of every chat that is a sub, live or ended. History lists read this to
/// keep subs out of the past-chats list, since their transcripts exist on disk
/// like any other chat's.
pub fn sub_session_ids() -> std::collections::HashSet<String> {
    let Some(path) = config_path() else { return Default::default() };
    sub_session_ids_at(&path)
}

/// Every stored sub brief with its session id, live or ended. The host's
/// start-up sweep reads the repos visiting subs work in from these.
pub fn sub_briefs() -> Vec<(String, crate::daemon::subchats::SubchatBrief)> {
    let Some(path) = config_path() else { return Vec::new() };
    sub_briefs_at(&path)
}

/// Record that Joe has viewed `session_id` as of `at_ms`, and return the mark now stored. The
/// mark only moves forward: a late write from a device whose view ended earlier must not
/// bring a cleared badge back. Preserves everything else on the entry. It holds `WRITE_LOCK`
/// like every other writer: a mark goes out every couple of seconds while a chat is open, and
/// an unlocked load-modify-write here could overwrite a sub brief another writer just stored.
pub(crate) fn set_viewed_at(path: &Path, session_id: &str, at_ms: i64) -> i64 {
    if session_id.is_empty() {
        return 0;
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_map(path);
    let entry = map.entry(session_id.to_string()).or_default();
    if at_ms > entry.viewed_at_ms {
        entry.viewed_at_ms = at_ms;
        let stored = entry.viewed_at_ms;
        write_atomic(path, &map);
        return stored;
    }
    entry.viewed_at_ms
}

pub(crate) fn viewed_marks_at(path: &Path, ids: &[String]) -> std::collections::BTreeMap<String, i64> {
    let map = load_map(path);
    ids.iter()
        .filter_map(|id| map.get(id).map(|c| (id.clone(), c.viewed_at_ms)))
        .filter(|(_, at)| *at > 0)
        .collect()
}

fn sub_briefs_at(path: &Path) -> Vec<(String, crate::daemon::subchats::SubchatBrief)> {
    load_map(path).into_iter().filter_map(|(id, c)| c.subchat.map(|b| (id, b))).collect()
}

fn set_subchat_at(path: &Path, session_id: &str, brief: Option<crate::daemon::subchats::SubchatBrief>) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().subchat = brief;
    write_atomic(path, &map);
}

fn sub_session_ids_at(path: &Path) -> std::collections::HashSet<String> {
    load_map(path)
        .into_iter()
        .filter(|(_, c)| c.subchat.is_some())
        .map(|(id, _)| id)
        .collect()
}

fn set_spawned_by_at(path: &Path, session_id: &str, parent: &str) {
    if session_id.is_empty() || parent.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().spawned_by = parent.to_string();
    write_atomic(path, &map);
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

/// Set (or clear) a chat's "Use subchats" flag. Preserves everything else on
/// the entry. Best-effort, never panics.
pub fn set_subchats_on(session_id: &str, value: bool) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_subchats_on_at(&path, session_id, value);
}

/// Record what the chat's model was last told about the subchats mode.
pub fn set_subchats_told(session_id: &str, value: bool) {
    let Some(path) = config_path() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_subchats_told_at(&path, session_id, value);
}

/// Session ids that currently have the subchats mode on. The frontend menu
/// toggle seeds its in-memory set from this on launch.
pub fn list_subchats_on() -> Vec<String> {
    let Some(path) = config_path() else { return Vec::new() };
    list_subchats_on_at(&path)
}

fn set_subchats_on_at(path: &Path, session_id: &str, value: bool) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    map.entry(session_id.to_string()).or_default().subchats_on = value;
    write_atomic(path, &map);
}

fn set_subchats_told_at(path: &Path, session_id: &str, value: bool) {
    if session_id.is_empty() {
        return;
    }
    let mut map = load_map(path);
    let entry = map.entry(session_id.to_string()).or_default();
    if entry.subchats_told == value {
        return;
    }
    entry.subchats_told = value;
    write_atomic(path, &map);
}

fn list_subchats_on_at(path: &Path) -> Vec<String> {
    load_map(path)
        .into_iter()
        .filter(|(_, c)| c.subchats_on)
        .map(|(id, _)| id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief(parent: &str) -> crate::daemon::subchats::SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"{parent}","task":"t","goal":"g","done_when":"d"}}"#)).unwrap()
    }

    #[test]
    fn a_sub_brief_round_trips_survives_other_writes_and_marks_the_chat_as_a_sub() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sub-1", "sonnet", "high");
        set_subchat_at(&path, "sub-1", Some(brief("main-1")));
        set_spawned_by_at(&path, "sub-1", "main-1");
        record_at(&path, "plain", "opus", "high");
        assert_eq!(get_at(&path, "sub-1").unwrap().subchat.unwrap().parent, "main-1");
        assert_eq!(get_at(&path, "sub-1").unwrap().model, "sonnet", "brief write keeps the model");
        assert_eq!(sub_session_ids_at(&path), ["sub-1".to_string()].into_iter().collect());
        set_subchat_at(&path, "sub-1", None);
        assert!(sub_session_ids_at(&path).is_empty(), "clearing the brief makes it an ordinary chat again");
    }

    #[test]
    fn the_viewed_mark_only_moves_forward_and_keeps_the_rest_of_the_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "c1", "opus", "high");
        assert_eq!(set_viewed_at(&path, "c1", 500), 500);
        assert_eq!(set_viewed_at(&path, "c1", 200), 500, "an earlier view never lowers the mark");
        assert_eq!(set_viewed_at(&path, "c1", 900), 900);
        assert_eq!(get_at(&path, "c1").unwrap().model, "opus", "the mark write keeps the model");
        record_at(&path, "c1", "sonnet", "");
        assert_eq!(get_at(&path, "c1").unwrap().viewed_at_ms, 900, "a model write keeps the mark");
        assert_eq!(set_viewed_at(&path, "", 5), 0, "an empty id stores nothing");
    }

    #[test]
    fn marks_written_at_the_same_time_from_several_threads_all_land() {
        let tmp = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(tmp.path().join("chat-config.json"));
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..10 {
                        set_viewed_at(&path, &format!("c{t}-{i}"), 1_000 + i);
                    }
                })
            })
            .collect();
        for h in threads {
            h.join().unwrap();
        }
        let ids: Vec<String> = (0..8).flat_map(|t| (0..10).map(move |i| format!("c{t}-{i}"))).collect();
        assert_eq!(viewed_marks_at(&path, &ids).len(), 80, "an unlocked load-modify-write loses entries");
    }

    #[test]
    fn viewed_marks_lists_only_viewed_chats_and_an_old_file_reads_as_never_viewed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        std::fs::write(&path, r#"{"old":{"model":"opus","effort":"high"}}"#).unwrap();
        assert_eq!(get_at(&path, "old").unwrap().viewed_at_ms, 0, "a file from before the mark loads without it");
        set_viewed_at(&path, "seen", 700);
        let ids = ["old".to_string(), "seen".to_string(), "missing".to_string()];
        let marks = viewed_marks_at(&path, &ids);
        assert_eq!(marks.len(), 1);
        assert_eq!(marks["seen"], 700);
    }

    #[test]
    fn an_old_config_file_without_the_subchat_key_loads_as_no_sub() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        std::fs::write(&path, r#"{"old":{"model":"opus","effort":"high"}}"#).unwrap();
        assert!(get_at(&path, "old").unwrap().subchat.is_none());
    }

    #[test]
    fn subchats_on_round_trips_and_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        record_at(&path, "sess-1", "opus", "high");
        set_auto_accept_at(&path, "sess-1", true);
        set_subchats_on_at(&path, "sess-1", true);
        let got = get_at(&path, "sess-1").unwrap();
        assert!(got.subchats_on && got.auto_accept);
        assert_eq!(got.model, "opus", "model preserved across a subchats write");
        assert_eq!(list_subchats_on_at(&path), vec!["sess-1".to_string()]);
        set_subchats_on_at(&path, "sess-1", false);
        assert!(list_subchats_on_at(&path).is_empty());
        assert!(get_at(&path, "sess-1").unwrap().auto_accept, "clearing subchats must not clear auto-accept");
    }

    #[test]
    fn subchats_told_persists_and_old_files_default_to_false() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        std::fs::write(&path, r#"{"sess-1":{"model":"opus"}}"#).unwrap();
        let old = get_at(&path, "sess-1").unwrap();
        assert!(!old.subchats_on && !old.subchats_told, "missing fields default to false");
        set_subchats_told_at(&path, "sess-1", true);
        let got = get_at(&path, "sess-1").unwrap();
        assert!(got.subchats_told && got.subchats_told_at_spawn());
        assert!(!got.subchats_on, "told is separate from the toggle itself");
    }

    #[test]
    fn set_subchats_on_empty_session_id_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        set_subchats_on_at(&path, "", true);
        assert!(!path.exists(), "no file written for empty session id");
    }

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

    /// Files written while "Wrap up when done" existed still carry its keys;
    /// serde must skip them (no `deny_unknown_fields`) or every old chat's
    /// config, model and subchat brief included, would stop loading.
    #[test]
    fn an_old_file_with_the_removed_wrap_up_keys_still_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        std::fs::write(
            &path,
            r#"{"sess-1":{"model":"opus","effort":"high","wrap_up_on_done":true,"wrap_up_told":true,"subchats_on":true}}"#,
        )
        .unwrap();
        let got = get_at(&path, "sess-1").expect("old keys must not fail the load");
        assert_eq!(got.model, "opus");
        assert!(got.subchats_on);
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

    #[test]
    fn parent_is_the_respawn_predecessor_or_the_spawn_chat_caller() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        set_spawned_by_at(&path, "child", "armed");
        set_predecessor_at(&path, "successor", "armed");
        record_at(&path, "by-hand", "opus", "high");
        let parent = |sid: &str| get_at(&path, sid).and_then(parent_in);
        assert_eq!(parent("child").as_deref(), Some("armed"));
        assert_eq!(parent("successor").as_deref(), Some("armed"));
        assert_eq!(parent("by-hand"), None);
        assert_eq!(parent("unknown"), None);
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
