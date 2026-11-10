//! Subs whose "its process died" card already reached Joe, kept across daemon
//! restarts in `<data_dir>/subchats/death-announced[suffix].json`.
//!
//! A raised card is never persisted, so a restart loses it and the dead sweep
//! asks again, which is by design. Without this record the second asking rang
//! and pushed like the first: every daemon start (2026-11-07 15:32, 18:53,
//! 2026-11-08 01:32, 2026-11-10 18:27) re-announced the same dead subs, eight at
//! once on 2026-11-10. With it, the card for a death Joe was already told about
//! comes back quiet: in the window, with no sound, push or red dot.
//!
//! The file is only written once [`init`] has run at daemon boot, so a unit test
//! that boots no daemon keeps the set in memory. A test that does boot one
//! writes its own instance's file, never the live app's.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static PATH: OnceLock<PathBuf> = OnceLock::new();
static SET: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// One file per daemon instance, for the reason `held.rs` gives.
pub fn init() {
    let suffix = crate::daemon::instance::instance_suffix();
    let Ok(dir) = crate::settings::paths::data_dir() else { return };
    if PATH.set(dir.join("subchats").join(format!("death-announced{suffix}.json"))).is_err() {
        return;
    }
    // Anything recorded before init joins what the file holds, so an early
    // mark is neither lost nor allowed to overwrite the file's ids.
    let mut guard = SET.lock().unwrap();
    if let Some(early) = guard.take() {
        let mut set = load(PATH.get().expect("set above"));
        set.extend(early);
        save(&set);
        *guard = Some(set);
    }
}

fn with_set<R>(f: impl FnOnce(&mut HashSet<String>) -> R) -> R {
    let mut guard = SET.lock().unwrap();
    let set = guard.get_or_insert_with(|| match PATH.get() {
        Some(path) => load(path),
        None => HashSet::new(),
    });
    f(set)
}

fn load(path: &Path) -> HashSet<String> {
    super::jsonfile::read_or_keep::<Vec<String>>(path).into_iter().collect()
}

fn save(set: &HashSet<String>) {
    if let Some(path) = PATH.get() {
        save_to(path, set);
    }
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
    with_set(|s| s.contains(sub_id))
}

/// A loud death card for this sub reached Joe.
pub fn mark(sub_id: &str) {
    with_set(|s| {
        if s.insert(sub_id.to_string()) {
            save(s);
        }
    });
}

/// The sub is alive again, finished or ended: a later death is news. Writes only
/// when the sub was in the set, since the sweep calls it for every live sub.
pub fn forget(sub_id: &str) {
    with_set(|s| {
        if s.remove(sub_id) {
            save(s);
        }
    });
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
}
