//! Persistence for the dashboard config (groups, custom cards, hidden
//! builtins) and the card result cache.
//!
//! Two single files under the data dir, instance-suffixed like
//! `scheduled-items{suffix}.json` so a dev/test daemon never clobbers the
//! production one. Config lives here, never in `settings.json`: that file is
//! full-replace and generation-checked, so a daemon-side writer would race the
//! settings UI. The cache is its own file so a refresh storm rewrites only
//! values, never the config.

use super::types::{cwd_key, CardConfig, CardResult, GroupDef, Scope, BUILTIN_CARDS};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serializes writers within this process; cross-process integrity comes from
/// the atomic rename (production has one daemon, see `scheduled_items`).
/// One lock for both files: cache writes are small and rare enough that
/// splitting it buys nothing.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DashboardStore {
    #[serde(default)]
    pub groups: Vec<GroupDef>,
    #[serde(default)]
    pub cards: Vec<CardConfig>,
    /// Scope key -> builtin card ids the dev hid for that scope.
    #[serde(default)]
    pub hidden_builtins: BTreeMap<String, Vec<String>>,
    /// Vault client slugs whose group the dev deleted; seeding never recreates them.
    #[serde(default)]
    pub deleted_vault_slugs: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CacheStore {
    /// Card id -> last fetched result.
    #[serde(default)]
    pub results: BTreeMap<String, CardResult>,
}

fn new_card_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn new_group_id() -> String {
    format!("g-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

impl DashboardStore {
    /// Inserts or replaces by id; a card with no id (or an id nobody holds)
    /// gets stored as new. Returns the id the card ended up with.
    pub fn upsert_card(&mut self, mut card: CardConfig) -> String {
        if card.id.trim().is_empty() {
            card.id = new_card_id();
            while self.cards.iter().any(|c| c.id == card.id) {
                card.id = new_card_id();
            }
        }
        let id = card.id.clone();
        match self.cards.iter_mut().find(|c| c.id == id) {
            Some(slot) => *slot = card,
            None => self.cards.push(card),
        }
        id
    }

    pub fn delete_card(&mut self, id: &str) -> bool {
        let before = self.cards.len();
        self.cards.retain(|c| c.id != id);
        self.cards.len() != before
    }

    pub fn set_card_enabled(&mut self, id: &str, enabled: bool) -> bool {
        match self.cards.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                c.enabled = enabled;
                true
            }
            None => false,
        }
    }

    /// Hides/shows one builtin card for a scope. False for an unknown builtin
    /// id so a typo never plants a dead entry.
    pub fn set_builtin_hidden(&mut self, scope_key: &str, builtin: &str, hidden: bool) -> bool {
        if !BUILTIN_CARDS.contains(&builtin) {
            return false;
        }
        let list = self.hidden_builtins.entry(scope_key.to_string()).or_default();
        let pos = list.iter().position(|b| b == builtin);
        match (hidden, pos) {
            (true, None) => list.push(builtin.to_string()),
            (false, Some(i)) => {
                list.remove(i);
            }
            _ => {}
        }
        if list.is_empty() {
            self.hidden_builtins.remove(scope_key);
        }
        true
    }

    /// Creates (id `None`, or an id nobody holds) or edits a group and returns
    /// its id. On a vault group, repos dropped by the edit are remembered in
    /// `removed_repos` (and repos added back are forgiven) so the next vault
    /// seeding does not undo the dev's edit.
    pub fn upsert_group(&mut self, id: Option<&str>, name: &str, repos: Vec<String>) -> String {
        let repos = dedup_paths(repos);
        let existing = id.and_then(|i| self.groups.iter().position(|g| g.id == i));
        let Some(pos) = existing else {
            let new_id = match id {
                Some(i) if !i.trim().is_empty() => i.to_string(),
                _ => new_group_id(),
            };
            self.groups.push(GroupDef {
                id: new_id.clone(),
                name: name.to_string(),
                repos,
                source: "manual".to_string(),
                vault_slug: None,
                removed_repos: Vec::new(),
            });
            return new_id;
        };
        let g = &mut self.groups[pos];
        if g.source == "vault" {
            let keep: Vec<String> = repos.iter().map(|r| cwd_key(r)).collect();
            for old in g.repos.iter() {
                if !keep.contains(&cwd_key(old)) && !contains_path(&g.removed_repos, old) {
                    g.removed_repos.push(old.clone());
                }
            }
            g.removed_repos.retain(|r| !keep.contains(&cwd_key(r)));
        }
        g.name = name.to_string();
        g.repos = repos;
        g.id.clone()
    }

    /// Removes a group along with its cards and hidden-builtin entry. Deleting
    /// a vault group records its slug so seeding does not resurrect it.
    pub fn delete_group(&mut self, id: &str) -> bool {
        let Some(pos) = self.groups.iter().position(|g| g.id == id) else { return false };
        let g = self.groups.remove(pos);
        if g.source == "vault" {
            if let Some(slug) = g.vault_slug {
                if !self.deleted_vault_slugs.contains(&slug) {
                    self.deleted_vault_slugs.push(slug);
                }
            }
        }
        let scope = Scope::Group { id: id.to_string() };
        self.cards.retain(|c| c.scope != scope);
        self.hidden_builtins.remove(&scope.scope_key());
        true
    }

    /// Cards for exactly this scope. Project scopes compare by normalised
    /// cwd so a card keeps matching when the path arrives with other casing.
    pub fn cards_for(&self, scope: &Scope) -> Vec<&CardConfig> {
        self.cards.iter().filter(|c| scopes_match(&c.scope, scope)).collect()
    }
}

fn scopes_match(a: &Scope, b: &Scope) -> bool {
    a.scope_key() == b.scope_key()
}

pub(crate) fn contains_path(list: &[String], path: &str) -> bool {
    let k = cwd_key(path);
    list.iter().any(|p| cwd_key(p) == k)
}

fn dedup_paths(paths: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        if !p.trim().is_empty() && !contains_path(&out, &p) {
            out.push(p);
        }
    }
    out
}

impl CacheStore {
    pub fn save_result(&mut self, card_id: &str, result: CardResult) {
        self.results.insert(card_id.to_string(), result);
    }

    pub fn result_for(&self, card_id: &str) -> Option<&CardResult> {
        self.results.get(card_id)
    }
}

// ---- file layer ----------------------------------------------------------

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

pub fn result_for_at(path: &Path, card_id: &str) -> Option<CardResult> {
    load_cache_at(path).results.remove(card_id)
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

pub fn result_for(card_id: &str) -> Option<CardResult> {
    result_for_at(&cache_path()?, card_id)
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
    use crate::project_dashboard::types::{CardDisplay, CardSource};
    use tempfile::tempdir;

    fn card(id: &str, scope: Scope) -> CardConfig {
        CardConfig { id: id.into(), scope, title: "t".into(), enabled: true, ..Default::default() }
    }

    fn proj(cwd: &str) -> Scope {
        Scope::Project { cwd: cwd.into() }
    }

    #[test]
    fn upsert_card_generates_a_short_unique_id_and_replaces_by_id() {
        let mut s = DashboardStore::default();
        let a = s.upsert_card(card("", proj("C:/x/a")));
        let b = s.upsert_card(card("", proj("C:/x/a")));
        assert_eq!(a.len(), 8);
        assert_ne!(a, b);
        let mut edited = card(&a, proj("C:/x/a"));
        edited.title = "renamed".into();
        edited.source = CardSource::Http { method: "GET".into(), url: "u".into(), headers: Default::default(), body: None };
        edited.display = CardDisplay::default();
        assert_eq!(s.upsert_card(edited), a);
        assert_eq!(s.cards.len(), 2);
        assert_eq!(s.cards.iter().find(|c| c.id == a).unwrap().title, "renamed");
    }

    #[test]
    fn delete_and_enable_report_whether_the_card_existed() {
        let mut s = DashboardStore::default();
        s.upsert_card(card("c1", proj("C:/x/a")));
        assert!(s.set_card_enabled("c1", false));
        assert!(!s.cards[0].enabled);
        assert!(!s.set_card_enabled("nope", true));
        assert!(s.delete_card("c1"));
        assert!(!s.delete_card("c1"));
    }

    #[test]
    fn cards_for_matches_project_paths_across_separator_style_and_group_ids() {
        let mut s = DashboardStore::default();
        s.upsert_card(card("p", proj("C:\\Work\\App")));
        s.upsert_card(card("g", Scope::Group { id: "g1".into() }));
        s.upsert_card(card("other", proj("C:/work/other")));
        let got: Vec<_> = s.cards_for(&proj("c:/work/app/")).iter().map(|c| c.id.clone()).collect();
        assert_eq!(got, vec!["p"]);
        let got: Vec<_> = s.cards_for(&Scope::Group { id: "g1".into() }).iter().map(|c| c.id.clone()).collect();
        assert_eq!(got, vec!["g"]);
    }

    #[test]
    fn builtin_hidden_toggles_validates_and_cleans_up_empty_entries() {
        let mut s = DashboardStore::default();
        assert!(s.set_builtin_hidden("group:g", "ship", true));
        assert!(s.set_builtin_hidden("group:g", "ship", true), "idempotent");
        assert_eq!(s.hidden_builtins["group:g"], vec!["ship"]);
        assert!(!s.set_builtin_hidden("group:g", "bogus", true));
        assert!(s.set_builtin_hidden("group:g", "ship", false));
        assert!(!s.hidden_builtins.contains_key("group:g"));
    }

    #[test]
    fn manual_group_upsert_dedups_repos_and_keeps_given_id() {
        let mut s = DashboardStore::default();
        let id = s.upsert_group(None, "Mine", vec!["C:/a".into(), "c:\\A".into(), "C:/b".into()]);
        let g = s.groups.iter().find(|g| g.id == id).unwrap();
        assert_eq!(g.source, "manual");
        assert_eq!(g.repos, vec!["C:/a", "C:/b"]);
        let same = s.upsert_group(Some(&id), "Renamed", vec!["C:/b".into()]);
        assert_eq!(same, id);
        assert_eq!(s.groups.len(), 1);
        assert_eq!(s.groups[0].name, "Renamed");
        assert!(s.groups[0].removed_repos.is_empty(), "manual groups track no removals");
    }

    fn vault_group() -> GroupDef {
        GroupDef {
            id: "vault-zirtue".into(),
            name: "Zirtue".into(),
            repos: vec!["C:/p/zng-app".into(), "C:/p/zng-api".into()],
            source: "vault".into(),
            vault_slug: Some("zirtue".into()),
            removed_repos: vec![],
        }
    }

    #[test]
    fn editing_a_vault_group_records_removed_repos_and_forgives_re_adds() {
        let mut s = DashboardStore { groups: vec![vault_group()], ..Default::default() };
        s.upsert_group(Some("vault-zirtue"), "Zirtue", vec!["c:\\p\\zng-app".into()]);
        assert_eq!(s.groups[0].removed_repos, vec!["C:/p/zng-api"]);
        s.upsert_group(Some("vault-zirtue"), "Zirtue", vec!["C:/p/zng-app".into(), "C:/p/zng-api".into()]);
        assert!(s.groups[0].removed_repos.is_empty());
    }

    #[test]
    fn deleting_a_vault_group_remembers_the_slug_and_drops_its_cards() {
        let mut s = DashboardStore { groups: vec![vault_group()], ..Default::default() };
        s.upsert_card(card("gc", Scope::Group { id: "vault-zirtue".into() }));
        s.upsert_card(card("keep", proj("C:/x")));
        s.set_builtin_hidden("group:vault-zirtue", "ship", true);
        assert!(s.delete_group("vault-zirtue"));
        assert_eq!(s.deleted_vault_slugs, vec!["zirtue"]);
        assert!(s.groups.is_empty());
        assert_eq!(s.cards.len(), 1);
        assert!(s.hidden_builtins.is_empty());
        assert!(!s.delete_group("vault-zirtue"));
    }

    #[test]
    fn deleting_a_manual_group_adds_no_slug() {
        let mut s = DashboardStore::default();
        let id = s.upsert_group(None, "m", vec![]);
        assert!(s.delete_group(&id));
        assert!(s.deleted_vault_slugs.is_empty());
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
        assert!(result_for_at(&path, "a").is_none());
        let r = CardResult { fetched_at_ms: 5, error: Some("boom".into()), ..Default::default() };
        save_result_at(&path, "a", r.clone());
        save_result_at(&path, "b", CardResult::default());
        assert_eq!(result_for_at(&path, "a"), Some(r));
        prune_cache_at(&path, &["b".to_string()]);
        assert!(result_for_at(&path, "a").is_none());
        assert!(result_for_at(&path, "b").is_some());
    }

    #[test]
    fn paths_carry_the_instance_suffix() {
        let p = store_path_for("-dev").unwrap();
        assert_eq!(p.file_name().unwrap(), "project-dashboard-dev.json");
        assert_eq!(cache_path_for("").unwrap().file_name().unwrap(), "project-dashboard-cache.json");
    }
}
