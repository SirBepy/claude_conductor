//! Subs whose "its process died" card already reached Joe, kept across daemon
//! restarts in `<data_dir>/subchats/death-announced[suffix].json`, and subs whose
//! conversation file is gone, in `death-unresumable[suffix].json`.
//!
//! A raised card is never persisted, so a restart loses it. Without the first
//! record a second asking rang and pushed like the first: every daemon start
//! (2026-11-07 15:32, 18:53, 2026-11-08 01:32, 2026-11-10 18:27) re-announced the
//! same dead subs, eight at once on 2026-11-10. With it, a card for a death Joe
//! was already told about comes back quiet: in the window, with no sound, push or
//! red dot.
//!
//! The second record is for a sub `--resume` can never bring back ("No
//! conversation found with session ID"): it is carded once, and after that no
//! sweep or failed resume cards it again (f99f459a, 21197fee and 6a2623ed were
//! carded after every start). Only a turn that ends, which proves the
//! conversation exists, or the sub finishing or ending clears it.
//!
//! The files are only written once [`init`] has run at daemon boot, so a unit
//! test that boots no daemon keeps the sets in memory. A test that does boot one
//! writes its own instance's files, never the live app's.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// One persisted set of sub ids.
struct Record {
    stem: &'static str,
    path: OnceLock<PathBuf>,
    set: Mutex<Option<HashSet<String>>>,
}

impl Record {
    const fn new(stem: &'static str) -> Self {
        Self { stem, path: OnceLock::new(), set: Mutex::new(None) }
    }

    fn init(&self, dir: &Path, suffix: &str) {
        if self.path.set(dir.join("subchats").join(format!("{}{suffix}.json", self.stem))).is_err() {
            return;
        }
        // Anything recorded before init joins what the file holds, so an early
        // mark is neither lost nor allowed to overwrite the file's ids.
        let mut guard = self.set.lock().unwrap();
        if let Some(early) = guard.take() {
            let path = self.path.get().expect("set above");
            let mut set = load(path);
            set.extend(early);
            save_to(path, &set);
            *guard = Some(set);
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut HashSet<String>) -> R) -> R {
        let mut guard = self.set.lock().unwrap();
        let set = guard.get_or_insert_with(|| match self.path.get() {
            Some(path) => load(path),
            None => HashSet::new(),
        });
        f(set)
    }

    fn contains(&self, id: &str) -> bool {
        self.with(|s| s.contains(id))
    }

    fn insert(&self, id: &str) {
        self.with(|s| {
            if s.insert(id.to_string()) {
                self.save(s);
            }
        });
    }

    /// Writes only when the id was in the set, since the sweep calls this for
    /// every live sub.
    fn remove(&self, id: &str) {
        self.with(|s| {
            if s.remove(id) {
                self.save(s);
            }
        });
    }

    fn save(&self, set: &HashSet<String>) {
        if let Some(path) = self.path.get() {
            save_to(path, set);
        }
    }
}

static ANNOUNCED: Record = Record::new("death-announced");
static UNRESUMABLE: Record = Record::new("death-unresumable");

/// One file per daemon instance, for the reason `held.rs` gives.
pub fn init() {
    let suffix = crate::daemon::instance::instance_suffix();
    let Ok(dir) = crate::settings::paths::data_dir() else { return };
    ANNOUNCED.init(&dir, &suffix);
    UNRESUMABLE.init(&dir, &suffix);
}

fn load(path: &Path) -> HashSet<String> {
    super::jsonfile::read_or_keep::<Vec<String>>(path).into_iter().collect()
}

fn save_to(path: &Path, set: &HashSet<String>) {
    let mut ids: Vec<&String> = set.iter().collect();
    ids.sort();
    let Ok(text) = serde_json::to_string(&ids) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, text) {
        log::warn!("subchats: could not write {}: {e}", path.display());
    }
}

/// Whether this sub's death was announced, in this daemon run or an earlier one.
pub fn was_announced(sub_id: &str) -> bool {
    ANNOUNCED.contains(sub_id)
}

/// A loud death card for this sub reached Joe.
pub fn mark(sub_id: &str) {
    ANNOUNCED.insert(sub_id);
}

/// The sub is alive again, finished or ended: a later death is news.
pub fn forget(sub_id: &str) {
    ANNOUNCED.remove(sub_id);
}

/// Whether this sub's conversation file is gone and its one card was raised.
pub fn is_unresumable(sub_id: &str) -> bool {
    UNRESUMABLE.contains(sub_id)
}

/// Its process died because `--resume` found no conversation, and Joe was told.
pub fn mark_unresumable(sub_id: &str) {
    UNRESUMABLE.insert(sub_id);
}

/// A turn ended (so the conversation exists) or the sub finished or ended.
pub fn forget_unresumable(sub_id: &str) {
    UNRESUMABLE.remove(sub_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_survives_a_round_trip_through_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subchats").join("death-announced.json");
        assert!(load(&path).is_empty(), "no file reads as nothing announced");
        let set: HashSet<String> = ["b".to_string(), "a".to_string()].into();
        save_to(&path, &set);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"["a","b"]"#);
        assert_eq!(load(&path), set);
    }

    #[test]
    fn the_two_records_are_separate() {
        mark_unresumable("ann-sep");
        assert!(is_unresumable("ann-sep"));
        forget("ann-sep");
        assert!(is_unresumable("ann-sep"), "a sub coming back to life does not prove its conversation exists");
        forget_unresumable("ann-sep");
        assert!(!is_unresumable("ann-sep"));
    }
}
