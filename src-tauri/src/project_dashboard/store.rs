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

// The file layer lives in `store_file`; callers keep reaching it as `store::load` etc.
pub use super::store_file::{
    all_results, cache_path_for, load, load_at, load_cache_at, prune_cache, prune_cache_at, save_result,
    save_result_at, store_path_for, update, update_at,
};

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
    /// Scope key -> quick-action commands pinned for that target, in order.
    #[serde(default)]
    pub pinned_actions: BTreeMap<String, Vec<String>>,
    /// Target key -> when the dev closed it (epoch ms). Absent = open; see `open_state`.
    #[serde(default)]
    pub closed_targets: BTreeMap<String, i64>,
    /// Set once the first-run "close what has been idle a week" pass has run.
    #[serde(default)]
    pub open_seeded: bool,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::types::{CardDisplay, CardSource};

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
    fn a_pre_existing_store_file_loads_with_the_new_fields_defaulted() {
        let s: DashboardStore = serde_json::from_str(r#"{"cards":[{"id":"x"}],"closed_targets":{"project:a":5}}"#).unwrap();
        assert!(!s.open_seeded && s.pinned_actions.is_empty());
        assert_eq!(s.closed_targets["project:a"], 5);
    }
}
