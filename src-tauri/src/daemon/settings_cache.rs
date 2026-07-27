//! Daemon-side Settings cache. The app process is authoritative for
//! `settings.json` on disk; the daemon holds an in-memory snapshot used by
//! the hook server for project_id resolution. App pushes the snapshot via
//! the `set_settings` RPC at handshake time and on every change.

use crate::characters::whitelist;
use crate::characters::Character;
use crate::settings;
use crate::types::{CharacterWhitelist, Settings};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct SettingsCache {
    inner: Arc<Mutex<Settings>>,
}

impl SettingsCache {
    pub fn new(initial: Settings) -> Self {
        Self { inner: Arc::new(Mutex::new(initial)) }
    }

    pub fn replace(&self, new: Settings) {
        let mut g = self.inner.lock().unwrap();
        *g = new;
    }

    pub fn snapshot(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    /// Mirror of `settings::upsert_project_for_cwd` but operating on the cache.
    /// Returns `(project_id, created_new)`. When `created_new` is true, the
    /// caller should emit a `project_created` notification so the app process
    /// can persist the matching mutation to `settings.json`.
    pub fn upsert_project_for_cwd(&self, cwd: &Path, now: &str) -> (String, bool) {
        let mut g = self.inner.lock().unwrap();
        settings::upsert_project_for_cwd(&mut g, cwd, now)
    }

    /// Mirror of `ipc::characters::ensure_session_character` but operating on
    /// the cache directly, so the daemon can assign an avatar to a
    /// remote-started session without a Tauri app process in the loop.
    ///
    /// `live_ids` is the full set of currently-live session ids (used both to
    /// prune dead sessions from `session_characters` and, minus `session_id`
    /// itself, to determine which characters are already taken by siblings).
    /// `all` is the character catalogue (`characters::list()`).
    ///
    /// Returns the existing assignment if the session already has one, or a
    /// freshly-picked character id, or `None` if the whitelist resolves empty.
    /// The caller is responsible for publishing a notification when a FRESH
    /// pick is made (this fn can't distinguish "already assigned" from
    /// "freshly assigned" from the return value alone, so it also returns
    /// whether the pick was new).
    pub fn ensure_session_character(
        &self,
        session_id: &str,
        project_id: &str,
        all: &[Character],
        live_ids: &HashSet<String>,
    ) -> (Option<String>, bool) {
        let mut g = self.inner.lock().unwrap();
        g.session_characters.retain(|sid, _| live_ids.contains(sid));

        if let Some(existing) = g.session_characters.get(session_id).cloned() {
            return (Some(existing), false);
        }

        let proj_wl = g
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.whitelist.clone())
            .unwrap_or(CharacterWhitelist::Default);
        let resolved = whitelist::resolve(&proj_wl, &g.default_character_whitelist, all);

        let live_taken: HashSet<String> = live_ids
            .iter()
            .filter(|sid| sid.as_str() != session_id)
            .filter_map(|sid| g.session_characters.get(sid).cloned())
            .collect();

        let pick = whitelist::pick_deterministic(&resolved, &live_taken, session_id);
        if let Some(ref id) = pick {
            g.session_characters.insert(session_id.to_string(), id.clone());
        }
        let is_new = pick.is_some();
        (pick, is_new)
    }

    /// Directly assign `character_id` to `session_id`, bypassing the
    /// whitelist/pick logic. Used by `move_session_to_account` to carry an
    /// already-assigned avatar onto the forked session id instead of letting
    /// the next `ensure_session_character` call roll a fresh random one. The
    /// caller is responsible for publishing `session_character_assigned` so
    /// the app process persists the same assignment to settings.json.
    pub fn set_session_character(&self, session_id: &str, character_id: &str) {
        let mut g = self.inner.lock().unwrap();
        g.session_characters.insert(session_id.to_string(), character_id.to_string());
    }

    /// Directly assign `session_id` as the singleton Jarvis pointer (todo
    /// 272), for an instant in-memory read right after `ensure_jarvis_session`
    /// spawns it. Mirrors `set_session_character`: the caller is responsible
    /// for publishing a notification (`jarvis_session_created`) so the app
    /// process merges the same value into its own `AppState.settings` and
    /// persists it to `settings.json` - the daemon has no direct write access
    /// to that file (see this module's header comment).
    pub fn set_jarvis_session_id(&self, session_id: &str) {
        let mut g = self.inner.lock().unwrap();
        g.jarvis_session_id = Some(session_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn ch(id: &str) -> Character {
        Character {
            id: id.to_string(),
            label: id.to_string(),
            version: 1,
            icon: String::new(),
            game: None,
            game_label: None,
            shared: false,
            dir: PathBuf::new(),
            slots: HashMap::new(),
        }
    }

    #[test]
    fn upsert_new_cwd_creates_project() {
        let cache = SettingsCache::new(Settings::default());
        let (id1, created) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p1"), "2026-05-20T00:00:00Z");
        assert!(created);
        assert!(!id1.is_empty());
    }

    #[test]
    fn upsert_existing_cwd_returns_same_id() {
        let cache = SettingsCache::new(Settings::default());
        let (id1, c1) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p2"), "2026-05-20T00:00:00Z");
        let (id2, c2) = cache.upsert_project_for_cwd(&PathBuf::from("/tmp/p2"), "2026-05-20T00:00:01Z");
        assert!(c1);
        assert!(!c2);
        assert_eq!(id1, id2);
    }

    #[test]
    fn replace_swaps_snapshot() {
        let cache = SettingsCache::new(Settings::default());
        let mut s2 = Settings::default();
        s2.hook_port = Some(65000);
        cache.replace(s2.clone());
        assert_eq!(cache.snapshot().hook_port, Some(65000));
    }

    #[test]
    fn ensure_session_character_assigns_fresh_pick() {
        let cache = SettingsCache::new(Settings::default());
        let all = vec![ch("peon")];
        let live: HashSet<String> = ["sess-1".to_string()].into();
        let (pick, is_new) = cache.ensure_session_character("sess-1", "proj-1", &all, &live);
        assert_eq!(pick, Some("peon".to_string()));
        assert!(is_new);
        assert_eq!(cache.snapshot().session_characters.get("sess-1"), Some(&"peon".to_string()));
    }

    #[test]
    fn ensure_session_character_returns_existing_without_reassigning() {
        let cache = SettingsCache::new(Settings::default());
        let all = vec![ch("peon"), ch("footman")];
        let live: HashSet<String> = ["sess-1".to_string()].into();
        let (first, _) = cache.ensure_session_character("sess-1", "proj-1", &all, &live);
        let (second, is_new) = cache.ensure_session_character("sess-1", "proj-1", &all, &live);
        assert_eq!(first, second);
        assert!(!is_new);
    }

    #[test]
    fn ensure_session_character_prunes_dead_sessions_first() {
        let cache = SettingsCache::new(Settings::default());
        let all = vec![ch("peon")];
        let live_with_stale: HashSet<String> = ["sess-1".to_string(), "sess-stale".to_string()].into();
        cache.ensure_session_character("sess-stale", "proj-1", &all, &live_with_stale);
        // sess-stale is now dead (no longer in live_ids); it should be pruned
        // away instead of counting toward live_taken.
        let live_now: HashSet<String> = ["sess-1".to_string()].into();
        let (pick, _) = cache.ensure_session_character("sess-1", "proj-1", &all, &live_now);
        assert_eq!(pick, Some("peon".to_string()));
        assert!(!cache.snapshot().session_characters.contains_key("sess-stale"));
    }
}
