//! Refused merges that have not landed yet. A finished worktree sub whose commits
//! change a file that is dirty in the main checkout is refused (`worktree::land_with`),
//! and that refusal is nobody's to fix: another chat is mid-edit. So it raises
//! nothing; the sub is kept here as [`Cause::DirtyFiles`] and `merge_followup` lands
//! it from the 60 second tick once none of those files is dirty. Every other refusal
//! is kept here too, as [`Cause::Refused`], until it lands or the main chat drops it:
//! the tick leaves those alone.
//!
//! Kept in `<data_dir>/subchats/pending-merges.json` (`pending-merges-<instance>.json`
//! for a test or dev daemon, like `held.json`), so a restart neither forgets the
//! merge nor lets a sub waiting on it with `after` start on a base that did not
//! land. Read entry by entry: only `sub_id` is required, and anything unreadable
//! is kept aside as `.bad` before the next write (see [`super::jsonfile`]).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Why a merge has not landed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// Another chat's uncommitted changes in the same files: the tick lands it.
    #[default]
    DirtyFiles,
    /// Anything else: the sub or the main chat has to act.
    Refused,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PendingMerge {
    pub sub_id: String,
    #[serde(default)]
    pub cause: Cause,
    /// The files git named: for [`Cause::DirtyFiles`], those dirty in the main
    /// checkout and changed by the sub.
    #[serde(default)]
    pub files: Vec<String>,
    /// When the merge was first refused, RFC 3339.
    #[serde(default)]
    pub since: String,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn file_path() -> Option<PathBuf> {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::data_dir().ok().map(|d| d.join("subchats").join(format!("pending-merges{suffix}.json")))
}

fn read_unlocked() -> Vec<PendingMerge> {
    let Some(path) = file_path() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return Vec::new() };
    let entries: Vec<serde_json::Value> = match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            super::jsonfile::keep_bad_copy(&path, &raw, &e.to_string());
            return Vec::new();
        }
    };
    let total = entries.len();
    let all: Vec<PendingMerge> = entries.into_iter().filter_map(|e| serde_json::from_value(e).ok()).collect();
    if all.len() < total {
        super::jsonfile::keep_bad_copy(&path, &raw, &format!("{} of its entries did not decode", total - all.len()));
    }
    all
}

fn write_unlocked(all: &[PendingMerge]) {
    let Some(path) = file_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let written = serde_json::to_string(all).map_err(std::io::Error::other).and_then(|body| crate::util::write_json_atomic(&path, &body));
    if let Err(e) = written {
        log::warn!("subchats: could not store the pending merges: {e}");
    }
}

/// Every pending merge, oldest first.
pub fn all() -> Vec<PendingMerge> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_unlocked()
}

pub fn contains(sub_id: &str) -> bool {
    all().iter().any(|p| p.sub_id == sub_id)
}

pub fn get(sub_id: &str) -> Option<PendingMerge> {
    all().into_iter().find(|p| p.sub_id == sub_id)
}

/// Keeps `sub_id`'s merge pending for `cause` on `files`. A second refusal
/// updates both and keeps the first `since`.
pub fn store(sub_id: &str, cause: Cause, files: Vec<String>) {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_unlocked();
    match all.iter_mut().find(|p| p.sub_id == sub_id) {
        Some(p) => {
            p.cause = cause;
            p.files = files;
        }
        None => all.push(PendingMerge { sub_id: sub_id.to_string(), cause, files, since: chrono::Utc::now().to_rfc3339() }),
    }
    write_unlocked(&all);
}

/// Drops `sub_id`'s pending merge. Returns whether there was one.
pub fn remove(sub_id: &str) -> bool {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_unlocked();
    let before = all.len();
    all.retain(|p| p.sub_id != sub_id);
    if all.len() == before {
        return false;
    }
    write_unlocked(&all);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::subchats::TempDataDir;

    fn bad_copies() -> usize {
        let dir = file_path().unwrap().parent().unwrap().to_path_buf();
        std::fs::read_dir(dir).map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().contains(".json.bad")).count()).unwrap_or(0)
    }

    #[test]
    fn a_pending_merge_is_stored_updated_and_removed() {
        let _d = TempDataDir::new();
        store("pm-a", Cause::DirtyFiles, vec!["a.txt".into()]);
        let since = get("pm-a").unwrap().since;
        store("pm-a", Cause::Refused, vec!["b.txt".into()]);
        let again = get("pm-a").unwrap();
        assert_eq!((again.cause, again.files, again.since), (Cause::Refused, vec!["b.txt".to_string()], since), "one entry, first refusal kept");
        assert!(contains("pm-a") && !contains("pm-b"));
        assert!(remove("pm-a") && !remove("pm-a"));
        assert!(all().is_empty());
    }

    #[test]
    fn an_unreadable_entry_costs_only_itself_and_is_kept_aside() {
        let _d = TempDataDir::new();
        let path = file_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"[{"sub_id":"pm-ok"},{"files":["x"]},{"sub_id":"pm-full","files":["a"],"since":"t","later_field":1}]"#).unwrap();
        let ids: Vec<String> = all().into_iter().map(|p| p.sub_id).collect();
        assert_eq!(ids, ["pm-ok", "pm-full"], "an entry missing optional fields still loads");
        assert_eq!(get("pm-ok").unwrap().cause, Cause::DirtyFiles, "an entry from before the cause field is a dirty-files wait");
        assert_eq!(bad_copies(), 1);
    }

    #[test]
    fn a_file_that_is_not_json_is_kept_aside_before_the_next_write() {
        let _d = TempDataDir::new();
        let path = file_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(all().is_empty());
        store("pm-new", Cause::Refused, vec![]);
        assert_eq!(bad_copies(), 1);
        assert!(contains("pm-new"));
    }
}
