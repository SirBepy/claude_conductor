//! Which chats the user hid into the sidebar's "Hidden (N)" section. File
//! `<app-data>/hidden-chats.json`, daemon is sole writer, so the desktop app
//! and the phone (both clients of this one daemon) show the same chats hidden.
//!
//! Ids are never pruned against the live session list: a client's list can be
//! partial (a peer machine's mirrored rows not linked yet, an external session
//! not discovered yet), and pruning against that would silently unhide chats
//! on every device. The cap below bounds growth instead.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A hidden id outlives its chat, so the list only ever grows by one per hide.
/// Oldest ids go first once past this; they belong to long-ended chats.
const MAX_HIDDEN: usize = 500;

/// Same rationale as `user_todos::WRITE_LOCK` - serializes the daemon's own
/// read-modify-write; cross-process integrity comes from the atomic rename.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct HiddenChatsFile {
    #[serde(default)]
    sessions: Vec<String>,
}

fn store_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("hidden-chats.json"))
}

fn load(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<HiddenChatsFile>(&s).ok())
        .map(|f| f.sessions)
        .unwrap_or_default()
}

fn save(path: &Path, sessions: &[String]) {
    let file = HiddenChatsFile { sessions: sessions.to_vec() };
    match serde_json::to_string_pretty(&file) {
        Ok(json) => {
            if let Err(e) = crate::util::write_json_atomic(path, &json) {
                log::warn!("hidden_chats: write failed: {e}");
            }
        }
        Err(e) => log::warn!("hidden_chats: serialize failed: {e}"),
    }
}

/// Applies a hide/unhide delta. A delta rather than a whole set, so two
/// devices acting at once each keep their own change instead of the later
/// write reverting the earlier one. Returns the new list and whether it
/// changed.
fn apply(current: Vec<String>, add: &[String], remove: &[String]) -> (Vec<String>, bool) {
    let before = current.clone();
    let mut next: Vec<String> = current.into_iter().filter(|id| !remove.contains(id)).collect();
    for id in add {
        if !id.is_empty() && !remove.contains(id) && !next.contains(id) {
            next.push(id.clone());
        }
    }
    if next.len() > MAX_HIDDEN {
        next.drain(..next.len() - MAX_HIDDEN);
    }
    let changed = next != before;
    (next, changed)
}

/// Every hidden session id, oldest first. Empty (never an error) before the
/// first hide.
pub fn list() -> Vec<String> {
    store_path().map(|p| load(&p)).unwrap_or_default()
}

pub fn update(add: &[String], remove: &[String]) -> (Vec<String>, bool) {
    match store_path() {
        Some(path) => update_at(&path, add, remove),
        None => apply(Vec::new(), add, remove),
    }
}

fn update_at(path: &Path, add: &[String], remove: &[String]) -> (Vec<String>, bool) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (next, changed) = apply(load(path), add, remove);
    if changed {
        save(path, &next);
    }
    (next, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn add_and_remove_are_independent_deltas() {
        let (next, changed) = apply(ids(&["a", "b"]), &ids(&["c"]), &ids(&["a"]));
        assert_eq!(next, ids(&["b", "c"]));
        assert!(changed);
    }

    #[test]
    fn a_delta_that_changes_nothing_reports_no_change() {
        let (next, changed) = apply(ids(&["a"]), &ids(&["a"]), &ids(&["zzz"]));
        assert_eq!(next, ids(&["a"]));
        assert!(!changed, "re-hiding an already hidden id must not broadcast");
    }

    #[test]
    fn the_cap_drops_the_oldest_ids() {
        let current: Vec<String> = (0..MAX_HIDDEN).map(|i| format!("s{i}")).collect();
        let (next, _) = apply(current, &ids(&["new"]), &[]);
        assert_eq!(next.len(), MAX_HIDDEN);
        assert_eq!(next.first().map(String::as_str), Some("s1"));
        assert_eq!(next.last().map(String::as_str), Some("new"));
    }

    #[test]
    fn empty_ids_are_ignored() {
        let (next, changed) = apply(Vec::new(), &ids(&[""]), &[]);
        assert!(next.is_empty());
        assert!(!changed);
    }

    #[test]
    fn update_round_trips_through_the_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("hidden-chats.json");
        assert!(load(&path).is_empty(), "no file yet reads as nothing hidden");
        update_at(&path, &ids(&["a", "b"]), &[]);
        update_at(&path, &[], &ids(&["a"]));
        assert_eq!(load(&path), ids(&["b"]));
    }
}
