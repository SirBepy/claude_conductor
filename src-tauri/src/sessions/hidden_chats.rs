//! Which chats the user hid into the sidebar's "Hidden (N)" section, and which
//! projects (by cwd) the project-rail filter hides from the sidebar entirely.
//! File `<app-data>/hidden-chats.json`, daemon is sole writer, so the desktop
//! app and the phone (both clients of this one daemon) show the same chats
//! hidden.
//!
//! Neither list is pruned against the live session list: a client's list can
//! be partial (a peer machine's mirrored rows not linked yet, an external
//! session not discovered yet), and pruning against that would silently
//! unhide chats or projects on every device. The cap below bounds growth
//! instead.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A hidden id outlives its chat, so the list only ever grows by one per hide.
/// Oldest ids go first once past this; they belong to long-ended chats.
const MAX_HIDDEN: usize = 500;

/// Same rationale as `user_todos::WRITE_LOCK` - serializes the daemon's own
/// read-modify-write; cross-process integrity comes from the atomic rename.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub struct HiddenLists {
    #[serde(default)]
    pub sessions: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
}

/// One hide/unhide change. A delta rather than a whole set, so two devices
/// acting at once each keep their own change instead of the later write
/// reverting the earlier one.
#[derive(serde::Deserialize, Default)]
pub struct HiddenDelta {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub add_projects: Vec<String>,
    #[serde(default)]
    pub remove_projects: Vec<String>,
}

fn store_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("hidden-chats.json"))
}

fn load(path: &Path) -> HiddenLists {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<HiddenLists>(&s).ok())
        .unwrap_or_default()
}

fn save(path: &Path, lists: &HiddenLists) {
    match serde_json::to_string_pretty(lists) {
        Ok(json) => {
            if let Err(e) = crate::util::write_json_atomic(path, &json) {
                log::warn!("hidden_chats: write failed: {e}");
            }
        }
        Err(e) => log::warn!("hidden_chats: serialize failed: {e}"),
    }
}

fn apply_list(current: Vec<String>, add: &[String], remove: &[String]) -> Vec<String> {
    let mut next: Vec<String> = current.into_iter().filter(|id| !remove.contains(id)).collect();
    for id in add {
        if !id.is_empty() && !remove.contains(id) && !next.contains(id) {
            next.push(id.clone());
        }
    }
    if next.len() > MAX_HIDDEN {
        next.drain(..next.len() - MAX_HIDDEN);
    }
    next
}

/// Returns the new lists and whether either changed.
fn apply(current: HiddenLists, delta: &HiddenDelta) -> (HiddenLists, bool) {
    let next = HiddenLists {
        sessions: apply_list(current.sessions.clone(), &delta.add, &delta.remove),
        projects: apply_list(current.projects.clone(), &delta.add_projects, &delta.remove_projects),
    };
    let changed = next != current;
    (next, changed)
}

/// Every hidden session id and project cwd, oldest first. Empty (never an
/// error) before the first hide.
pub fn list() -> HiddenLists {
    store_path().map(|p| load(&p)).unwrap_or_default()
}

pub fn update(delta: &HiddenDelta) -> (HiddenLists, bool) {
    match store_path() {
        Some(path) => update_at(&path, delta),
        None => apply(HiddenLists::default(), delta),
    }
}

fn update_at(path: &Path, delta: &HiddenDelta) -> (HiddenLists, bool) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (next, changed) = apply(load(path), delta);
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

    fn sessions(add: &[&str], remove: &[&str]) -> HiddenDelta {
        HiddenDelta { add: ids(add), remove: ids(remove), ..Default::default() }
    }

    fn lists(sessions: &[&str], projects: &[&str]) -> HiddenLists {
        HiddenLists { sessions: ids(sessions), projects: ids(projects) }
    }

    #[test]
    fn add_and_remove_are_independent_deltas() {
        let (next, changed) = apply(lists(&["a", "b"], &[]), &sessions(&["c"], &["a"]));
        assert_eq!(next.sessions, ids(&["b", "c"]));
        assert!(changed);
    }

    #[test]
    fn a_delta_that_changes_nothing_reports_no_change() {
        let (next, changed) = apply(lists(&["a"], &[]), &sessions(&["a"], &["zzz"]));
        assert_eq!(next.sessions, ids(&["a"]));
        assert!(!changed, "re-hiding an already hidden id must not broadcast");
    }

    #[test]
    fn the_cap_drops_the_oldest_ids() {
        let current = HiddenLists {
            sessions: (0..MAX_HIDDEN).map(|i| format!("s{i}")).collect(),
            projects: Vec::new(),
        };
        let (next, _) = apply(current, &sessions(&["new"], &[]));
        assert_eq!(next.sessions.len(), MAX_HIDDEN);
        assert_eq!(next.sessions.first().map(String::as_str), Some("s1"));
        assert_eq!(next.sessions.last().map(String::as_str), Some("new"));
    }

    #[test]
    fn empty_ids_are_ignored() {
        let (next, changed) = apply(HiddenLists::default(), &sessions(&[""], &[]));
        assert!(next.sessions.is_empty());
        assert!(!changed);
    }

    #[test]
    fn a_project_delta_leaves_the_session_list_alone() {
        let delta = HiddenDelta {
            add_projects: ids(&["C:/p/beta"]),
            remove_projects: ids(&["C:/p/alpha"]),
            ..Default::default()
        };
        let (next, changed) = apply(lists(&["s1"], &["C:/p/alpha"]), &delta);
        assert_eq!(next, lists(&["s1"], &["C:/p/beta"]));
        assert!(changed);
    }

    #[test]
    fn a_pre_projects_file_reads_with_no_hidden_projects() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("hidden-chats.json");
        std::fs::write(&path, r#"{"sessions":["a"]}"#).unwrap();
        assert_eq!(load(&path), lists(&["a"], &[]));
    }

    #[test]
    fn update_round_trips_through_the_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("hidden-chats.json");
        assert_eq!(load(&path), HiddenLists::default(), "no file yet reads as nothing hidden");
        update_at(&path, &sessions(&["a", "b"], &[]));
        update_at(&path, &sessions(&[], &["a"]));
        update_at(&path, &HiddenDelta { add_projects: ids(&["C:/p"]), ..Default::default() });
        assert_eq!(load(&path), lists(&["b"], &["C:/p"]));
    }
}
