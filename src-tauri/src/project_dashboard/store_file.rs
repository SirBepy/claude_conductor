//! File layer under `store`: where the two dashboard files live, plus the
//! locked read-modify-write and corrupt-file handling both share. The data
//! types (`DashboardStore`, `CacheStore`) stay in `store`.

use super::store::{CacheStore, DashboardStore};
use super::types::CardResult;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serializes writers within this process; cross-process integrity comes from
/// the atomic rename (production has one daemon, see `scheduled_items`).
/// One lock for both files: cache writes are small and rare enough that
/// splitting it buys nothing.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn store_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("project-dashboard{suffix}.json")))
}

pub fn cache_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("project-dashboard-cache{suffix}.json")))
}

fn store_path() -> Option<PathBuf> {
    store_path_for(&crate::daemon::instance::instance_suffix())
}

fn cache_path() -> Option<PathBuf> {
    cache_path_for(&crate::daemon::instance::instance_suffix())
}

enum Loaded<T> {
    Ok(T),
    Missing,
    Corrupt,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Loaded<T> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Loaded::Missing,
        Err(e) => {
            log::warn!("project_dashboard: cannot read {}: {e}", path.display());
            Loaded::Corrupt
        }
        Ok(text) => match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
            Ok(v) => Loaded::Ok(v),
            Err(e) => {
                log::warn!("project_dashboard: {} does not parse: {e}", path.display());
                Loaded::Corrupt
            }
        },
    }
}

/// Copies an unparseable file aside before the first write replaces it, so a
/// parse bug or a hand-edit typo never silently costs the dev their config.
/// An existing `.bak` is kept (it may hold the older, better copy), and the
/// new one gets a timestamp.
fn back_up_corrupt(path: &Path) {
    let bak = path.with_extension("json.bak");
    let target = if bak.exists() {
        path.with_extension(format!("json.bak-{}", chrono::Utc::now().timestamp_millis()))
    } else {
        bak
    };
    match std::fs::copy(path, &target) {
        Ok(_) => log::warn!("project_dashboard: backed up unreadable {} to {}", path.display(), target.display()),
        Err(e) => log::warn!("project_dashboard: could not back up {}: {e}", path.display()),
    }
}

fn load_or_default<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match read_json::<T>(path) {
        Loaded::Ok(v) => v,
        Loaded::Missing | Loaded::Corrupt => T::default(),
    }
}

fn write_atomic<T: Serialize>(path: &Path, value: &T) {
    let json = match serde_json::to_string_pretty(value) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("project_dashboard: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("project_dashboard: write failed for {}: {e}", path.display());
    }
}

/// Read-modify-write under the lock; writes only when `f` actually changed
/// something, so a no-op call (e.g. a seeding pass with nothing new) costs no
/// disk write.
fn update_file<T, R>(path: &Path, f: impl FnOnce(&mut T) -> R) -> R
where
    T: serde::de::DeserializeOwned + Serialize + Default + Clone + PartialEq,
{
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (mut value, corrupt) = match read_json::<T>(path) {
        Loaded::Ok(v) => (v, false),
        Loaded::Missing => (T::default(), false),
        Loaded::Corrupt => (T::default(), true),
    };
    let before = value.clone();
    let out = f(&mut value);
    if value != before {
        // Backed up only when a write is about to replace it, so a no-op call
        // on a corrupt file leaves it alone instead of piling up copies.
        if corrupt {
            back_up_corrupt(path);
        }
        write_atomic(path, &value);
    }
    out
}

pub fn load_at(path: &Path) -> DashboardStore {
    load_or_default(path)
}

pub fn update_at<R>(path: &Path, f: impl FnOnce(&mut DashboardStore) -> R) -> R {
    update_file(path, f)
}

pub fn load_cache_at(path: &Path) -> CacheStore {
    load_or_default(path)
}

pub fn save_result_at(path: &Path, card_id: &str, result: CardResult) {
    update_file(path, |c: &mut CacheStore| c.save_result(card_id, result));
}

/// Drops cache entries whose card no longer exists.
pub fn prune_cache_at(path: &Path, live_card_ids: &[String]) {
    update_file(path, |c: &mut CacheStore| c.results.retain(|id, _| live_card_ids.contains(id)));
}

/// Whole stored config; empty if the data dir is unavailable or the file is missing.
pub fn load() -> DashboardStore {
    store_path().map(|p| load_at(&p)).unwrap_or_default()
}

/// Mutates the stored config and persists it if it changed. `None` when the
/// data dir cannot be resolved.
pub fn update<R>(f: impl FnOnce(&mut DashboardStore) -> R) -> Option<R> {
    store_path().map(|p| update_at(&p, f))
}

pub fn save_result(card_id: &str, result: CardResult) {
    if let Some(p) = cache_path() {
        save_result_at(&p, card_id, result);
    }
}

/// Every cached result, for painting a whole snapshot with one file read.
pub fn all_results() -> BTreeMap<String, CardResult> {
    cache_path().map(|p| load_cache_at(&p).results).unwrap_or_default()
}

pub fn prune_cache(live_card_ids: &[String]) {
    if let Some(p) = cache_path() {
        prune_cache_at(&p, live_card_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::types::{CardConfig, Scope};
    use tempfile::tempdir;

    fn card(id: &str, scope: Scope) -> CardConfig {
        CardConfig { id: id.into(), scope, title: "t".into(), enabled: true, ..Default::default() }
    }

    fn proj(cwd: &str) -> Scope {
        Scope::Project { cwd: cwd.into() }
    }

    fn cached(path: &Path, card_id: &str) -> Option<CardResult> {
        load_cache_at(path).results.remove(card_id)
    }

    #[test]
    fn store_round_trips_through_disk_and_skips_no_op_writes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project-dashboard-test.json");
        let id = update_at(&path, |s| s.upsert_card(card("", proj("C:/x"))));
        assert_eq!(load_at(&path).cards[0].id, id);
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        update_at(&path, |s| s.set_card_enabled("missing", true));
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn missing_file_loads_default_and_a_no_op_update_creates_nothing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("none.json");
        assert_eq!(load_at(&path), DashboardStore::default());
        update_at(&path, |s| s.delete_card("x"));
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_file_loads_default_then_is_backed_up_before_the_first_write() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project-dashboard.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_at(&path), DashboardStore::default());
        assert!(!dir.path().join("project-dashboard.json.bak").exists(), "a read alone never backs up");
        update_at(&path, |s| s.upsert_card(card("c1", proj("C:/x"))));
        let bak = std::fs::read_to_string(dir.path().join("project-dashboard.json.bak")).unwrap();
        assert_eq!(bak, "{ not json");
        assert_eq!(load_at(&path).cards.len(), 1);
    }

    #[test]
    fn a_second_corruption_does_not_clobber_the_first_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project-dashboard.json");
        std::fs::write(&path, "first").unwrap();
        update_at(&path, |s| s.upsert_card(card("a", proj("C:/x"))));
        std::fs::write(&path, "second").unwrap();
        update_at(&path, |s| s.upsert_card(card("b", proj("C:/x"))));
        assert_eq!(std::fs::read_to_string(dir.path().join("project-dashboard.json.bak")).unwrap(), "first");
        let backups = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| {
            e.file_name().to_string_lossy().starts_with("project-dashboard.json.bak-")
        });
        assert_eq!(backups.count(), 1);
    }

    #[test]
    fn partial_file_with_missing_fields_still_loads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.json");
        std::fs::write(&path, r#"{"cards":[{"id":"x"}],"hidden_builtins":{"group:g":["ship"]}}"#).unwrap();
        let s = load_at(&path);
        assert_eq!(s.cards[0].id, "x");
        assert!(s.groups.is_empty() && s.deleted_vault_slugs.is_empty());
    }

    #[test]
    fn cache_saves_reads_and_prunes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project-dashboard-cache.json");
        assert!(cached(&path, "a").is_none());
        let r = CardResult { fetched_at_ms: 5, error: Some("boom".into()), ..Default::default() };
        save_result_at(&path, "a", r.clone());
        save_result_at(&path, "b", CardResult::default());
        assert_eq!(cached(&path, "a"), Some(r));
        prune_cache_at(&path, &["b".to_string()]);
        assert!(cached(&path, "a").is_none());
        assert!(cached(&path, "b").is_some());
    }

    #[test]
    fn paths_carry_the_instance_suffix() {
        let p = store_path_for("-dev").unwrap();
        assert_eq!(p.file_name().unwrap(), "project-dashboard-dev.json");
        assert_eq!(cache_path_for("").unwrap().file_name().unwrap(), "project-dashboard-cache.json");
    }
}
