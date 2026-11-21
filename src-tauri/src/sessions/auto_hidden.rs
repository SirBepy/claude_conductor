//! Which hidden chats the idle rule hid (`daemon::auto_hide`), as opposed to the ones Joe hid by
//! hand. File `<app-data>/auto-hidden-chats.json`, daemon is sole writer.
//!
//! The chat's id is also in `hidden-chats.json` (`sessions::hidden_chats`), the one list every
//! client draws the hidden window from; this file only says which of those entries the rule owns,
//! so the rule can bring back its own and never one Joe hid. Named `auto_hidden` and kept apart
//! from the hand-hide list on purpose: a durable `hidden` flag on the chat itself (the put-away
//! chain) is a different thing and must not read this.
//!
//! Both maps hold the chat's `last_event_at` at the time ("" when it had none), the stamp that
//! moves whenever a turn starts or ends. A change of it is how the rule knows the chat's state
//! changed since it hid the chat, or since Joe overruled it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE_NAME: &str = "auto-hidden-chats.json";

/// Both maps only grow by one entry per chat that is ever hidden or shown by hand; past this the
/// smallest ids go. A dropped `shown` entry only lets the rule hide that chat once more.
const MAX_ENTRIES: usize = 500;

/// Serializes the daemon's own read-modify-write; cross-process integrity comes from the atomic
/// rename (same rationale as `hidden_chats::WRITE_LOCK`).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub struct AutoHidden {
    /// Chats the rule hid, each with the `last_event_at` it had then.
    #[serde(default)]
    pub hidden: BTreeMap<String, String>,
    /// Chats Joe brought back by hand, each with the `last_event_at` it had then: the rule
    /// leaves the chat alone until that stamp moves.
    #[serde(default)]
    pub shown: BTreeMap<String, String>,
}

fn store_path() -> Option<PathBuf> {
    // A test's rows are made up; with no `CC_DATA_DIR` this is the live data folder.
    #[cfg(test)]
    if !crate::daemon::names_own_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref()) {
        return None;
    }
    crate::settings::paths::data_dir().ok().map(|d| d.join(FILE_NAME))
}

fn load(path: &Path) -> AutoHidden {
    let Ok(text) = std::fs::read_to_string(path) else { return AutoHidden::default() };
    match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            // Kept aside, not read as empty and overwritten: the chats it names would lose
            // their owner and stay hidden for good.
            let bad = path.with_extension("json.bad");
            log::warn!("auto_hidden: {} is unreadable ({e}), kept as {}", path.display(), bad.display());
            let _ = std::fs::rename(path, bad);
            AutoHidden::default()
        }
    }
}

fn cap(map: &mut BTreeMap<String, String>) {
    while map.len() > MAX_ENTRIES {
        let Some(first) = map.keys().next().cloned() else { break };
        map.remove(&first);
    }
}

fn edit(path: &Path, f: impl FnOnce(&mut AutoHidden)) -> bool {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = load(path);
    let mut after = before.clone();
    f(&mut after);
    cap(&mut after.hidden);
    cap(&mut after.shown);
    if after == before {
        return false;
    }
    match serde_json::to_string_pretty(&after) {
        Ok(json) => {
            if let Err(e) = crate::util::write_json_atomic(path, &json) {
                log::warn!("auto_hidden: write failed: {e}");
            }
        }
        Err(e) => log::warn!("auto_hidden: serialize failed: {e}"),
    }
    true
}

pub fn list() -> AutoHidden {
    store_path().map(|p| load(&p)).unwrap_or_default()
}

/// The rule hid `id` while its stamp read `at`.
pub fn hide(id: &str, at: &str) -> bool {
    store_path().is_some_and(|p| hide_at(&p, id, at))
}

/// The rule (not Joe) brings `id` back, or Joe hid it by hand over the rule's hide: it is no
/// longer the rule's.
pub fn forget_hidden(id: &str) -> bool {
    store_path().is_some_and(|p| forget_hidden_at(&p, id))
}

/// Joe showed `id` by hand while its stamp read `at`.
pub fn shown_by_hand(id: &str, at: &str) -> bool {
    store_path().is_some_and(|p| shown_by_hand_at(&p, id, at))
}

/// The stamp moved since Joe showed `id`: his choice is spent.
pub fn clear_shown(id: &str) -> bool {
    store_path().is_some_and(|p| clear_shown_at(&p, id))
}

pub(crate) fn hide_at(path: &Path, id: &str, at: &str) -> bool {
    !id.is_empty()
        && edit(path, |s| {
            s.hidden.insert(id.to_string(), at.to_string());
            s.shown.remove(id);
        })
}

pub(crate) fn forget_hidden_at(path: &Path, id: &str) -> bool {
    edit(path, |s| {
        s.hidden.remove(id);
    })
}

pub(crate) fn shown_by_hand_at(path: &Path, id: &str, at: &str) -> bool {
    !id.is_empty()
        && edit(path, |s| {
            s.hidden.remove(id);
            s.shown.insert(id.to_string(), at.to_string());
        })
}

pub(crate) fn clear_shown_at(path: &Path, id: &str) -> bool {
    edit(path, |s| {
        s.shown.remove(id);
    })
}

pub(crate) fn load_at(path: &Path) -> AutoHidden {
    load(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let p = dir.path().join(FILE_NAME);
        (dir, p)
    }

    #[test]
    fn a_hide_is_stored_with_its_stamp_and_replaces_a_hand_show() {
        let (_d, p) = path();
        shown_by_hand_at(&p, "a", "t0");
        assert!(hide_at(&p, "a", "t1"));
        let s = load_at(&p);
        assert_eq!(s.hidden.get("a").map(String::as_str), Some("t1"));
        assert!(s.shown.is_empty(), "a fresh hide ends Joe's earlier choice");
    }

    #[test]
    fn a_hand_show_moves_the_chat_from_the_rules_list_to_the_overruled_list() {
        let (_d, p) = path();
        hide_at(&p, "a", "t1");
        assert!(shown_by_hand_at(&p, "a", "t1"));
        let s = load_at(&p);
        assert!(s.hidden.is_empty());
        assert_eq!(s.shown.get("a").map(String::as_str), Some("t1"));
    }

    #[test]
    fn a_change_that_changes_nothing_writes_nothing() {
        let (_d, p) = path();
        assert!(!forget_hidden_at(&p, "nobody"));
        assert!(!p.exists());
        assert!(!hide_at(&p, "", "t"), "an empty id is ignored");
        hide_at(&p, "a", "t");
        assert!(!hide_at(&p, "a", "t"), "the same hide again changes nothing");
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_not_read_as_empty() {
        let (_d, p) = path();
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(load_at(&p), AutoHidden::default());
        assert!(p.with_extension("json.bad").exists());
    }

    #[test]
    fn a_file_without_the_shown_map_loads() {
        let (_d, p) = path();
        std::fs::write(&p, r#"{"hidden":{"a":"t"}}"#).unwrap();
        assert_eq!(load_at(&p).hidden.len(), 1);
    }

    #[test]
    fn the_cap_drops_the_smallest_ids() {
        let (_d, p) = path();
        for i in 0..MAX_ENTRIES + 3 {
            hide_at(&p, &format!("s{i:04}"), "t");
        }
        let s = load_at(&p);
        assert_eq!(s.hidden.len(), MAX_ENTRIES);
        assert!(!s.hidden.contains_key("s0000"));
    }
}
