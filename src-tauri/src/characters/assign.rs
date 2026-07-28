//! Auto-assignment of Heroes of the Storm characters to projects.
//!
//! Every project gets a HotS hero as its `Avatar::Character`. Two entry points:
//!
//! * [`pick_hero`] — called when a project is first created (see
//!   `settings::store::upsert_project_*`). Picks a hero not already taken by
//!   another project, matching the project name's first letter when possible.
//! * [`backfill_all_projects`] — one-time startup migration that (re)assigns a
//!   hero to *every* project, so existing installs get the feature in bulk.
//!
//! The selection core ([`pick_from`] / [`backfill_with_pool`]) is pure over an
//! injected hero pool + taken-set, so it is unit-tested without touching the
//! character cache or disk.

use std::collections::HashSet;

use crate::types::{Avatar, Settings};

/// `game` slug (from `character.json`) identifying a Heroes of the Storm hero.
pub const HOTS_GAME: &str = "heroes-of-the-storm";

/// Bumped when the backfill logic changes in a way that should re-run for
/// existing users. Stored in `Settings.extra["characterBackfillVersion"]`.
pub const CURRENT_BACKFILL_VERSION: u32 = 2;

/// All Heroes of the Storm hero ids currently on disk, sorted alphabetically.
/// Excludes `_shared` bundles and any non-HotS game. Hits the character cache.
pub fn hots_pool() -> Vec<String> {
    let mut ids: Vec<String> = crate::characters::list()
        .into_iter()
        .filter(|c| !c.shared && c.game.as_deref() == Some(HOTS_GAME))
        .map(|c| c.id)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Hero ids already assigned to some project's `Avatar::Character`.
fn taken_ids(settings: &Settings) -> HashSet<String> {
    settings
        .projects
        .iter()
        .filter_map(|p| match &p.avatar {
            Avatar::Character(id) => Some(id.clone()),
            _ => None,
        })
        .collect()
}

/// First ascii-alphabetic char of `name`, lowercased. `None` if the name has
/// no letters (e.g. a path that is all digits/symbols).
fn first_letter(name: &str) -> Option<char> {
    name.chars()
        .find(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_lowercase())
}

/// Pick a hero from `pool` for `project_name`, preferring one whose id starts
/// with the project's first letter, then any free hero, all in alphabetical
/// order (the caller passes a sorted pool). `taken` heroes are skipped while
/// any free hero remains; once the pool is exhausted a duplicate is allowed so
/// this only returns `None` for a genuinely empty pool.
fn pick_from(project_name: &str, pool: &[String], taken: &HashSet<String>) -> Option<String> {
    if pool.is_empty() {
        return None;
    }
    let letter = first_letter(project_name);
    let free: Vec<&String> = pool.iter().filter(|id| !taken.contains(*id)).collect();
    if !free.is_empty() {
        if let Some(l) = letter {
            if let Some(hit) = free.iter().find(|id| id.starts_with(l)) {
                return Some((*hit).clone());
            }
        }
        return Some(free[0].clone());
    }
    // Pool fully taken: allow a duplicate, same letter preference.
    if let Some(l) = letter {
        if let Some(hit) = pool.iter().find(|id| id.starts_with(l)) {
            return Some(hit.clone());
        }
    }
    pool.first().cloned()
}

/// Pick a HotS hero for a newly-created project, avoiding heroes already taken
/// by other projects. Returns `None` only when no HotS characters are on disk.
pub fn pick_hero(project_name: &str, settings: &Settings) -> Option<String> {
    pick_from(project_name, &hots_pool(), &taken_ids(settings))
}

/// Re-roll *every* project to a fresh, unique HotS hero. Projects are processed
/// in case-insensitive name order (then id) so collisions resolve
/// deterministically. Returns the number of projects assigned.
pub fn backfill_all_projects(settings: &mut Settings) -> usize {
    backfill_with_pool(settings, &hots_pool())
}

fn backfill_with_pool(settings: &mut Settings, pool: &[String]) -> usize {
    if pool.is_empty() {
        return 0;
    }
    let mut order: Vec<usize> = (0..settings.projects.len()).collect();
    order.sort_by(|&a, &b| {
        let na = settings.projects[a].name.to_lowercase();
        let nb = settings.projects[b].name.to_lowercase();
        na.cmp(&nb)
            .then_with(|| settings.projects[a].id.cmp(&settings.projects[b].id))
    });
    let mut taken: HashSet<String> = HashSet::new();
    let mut count = 0;
    for idx in order {
        let name = settings.projects[idx].name.clone();
        if let Some(hero) = pick_from(&name, pool, &taken) {
            taken.insert(hero.clone());
            settings.projects[idx].avatar = Avatar::Character(hero);
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProjectConfig;

    fn pool(ids: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    fn taken(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn project(name: &str, avatar: Avatar) -> ProjectConfig {
        ProjectConfig {
            id: format!("id-{name}"),
            path: std::path::PathBuf::from(format!("C:/{name}")),
            name: name.into(),
            avatar,
            automation: None,
            created_at: "2026-06-13T00:00:00Z".into(),
            last_active_at: None,
            whitelist: crate::types::CharacterWhitelist::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
        }
    }

    #[test]
    fn empty_pool_yields_none() {
        assert_eq!(pick_from("claude", &[], &HashSet::new()), None);
    }

    #[test]
    fn matches_first_letter_alphabetically() {
        let p = pool(&["abathur", "cassia", "chen", "cho", "chromie", "samuro"]);
        // claude -> 'c' -> first free c alphabetically = cassia
        assert_eq!(pick_from("claude_usage", &p, &HashSet::new()).as_deref(), Some("cassia"));
        // server -> 's' -> samuro
        assert_eq!(pick_from("server_supervisor", &p, &HashSet::new()).as_deref(), Some("samuro"));
    }

    #[test]
    fn skips_taken_within_letter() {
        let p = pool(&["cassia", "chen", "cho", "chromie"]);
        let t = taken(&["cassia", "chen"]);
        assert_eq!(pick_from("claude", &p, &t).as_deref(), Some("cho"));
    }

    #[test]
    fn falls_back_to_first_free_when_letter_exhausted() {
        let p = pool(&["cassia", "chen", "samuro", "sonya"]);
        // 'c' heroes all taken -> first free overall = samuro
        let t = taken(&["cassia", "chen"]);
        assert_eq!(pick_from("claude", &p, &t).as_deref(), Some("samuro"));
    }

    #[test]
    fn falls_back_when_no_hero_starts_with_letter() {
        let p = pool(&["abathur", "samuro"]);
        // 'z' matches nothing -> first free overall
        assert_eq!(pick_from("zephyr", &p, &HashSet::new()).as_deref(), Some("abathur"));
    }

    #[test]
    fn name_without_letters_takes_first_free() {
        let p = pool(&["abathur", "samuro"]);
        assert_eq!(pick_from("123-456", &p, &HashSet::new()).as_deref(), Some("abathur"));
    }

    #[test]
    fn allows_duplicate_when_pool_exhausted() {
        let p = pool(&["cassia", "samuro"]);
        let t = taken(&["cassia", "samuro"]);
        // everything taken: still returns (letter pref) rather than None
        assert_eq!(pick_from("claude", &p, &t).as_deref(), Some("cassia"));
        assert_eq!(pick_from("server", &p, &t).as_deref(), Some("samuro"));
    }

    #[test]
    fn backfill_assigns_distinct_heroes_and_reroll_overwrites() {
        let p = pool(&["abathur", "cassia", "chen", "orphea", "samuro"]);
        let mut s = Settings::default();
        // Existing manual pick (warcraft 'acolyte') must be overwritten.
        s.projects.push(project("claude_usage", Avatar::Character("acolyte".into())));
        s.projects.push(project("ObsidianVault", Avatar::None));
        s.projects.push(project("server_supervisor", Avatar::Emoji("x".into())));

        let n = backfill_with_pool(&mut s, &p);
        assert_eq!(n, 3);

        let hero = |name: &str| -> String {
            let pc = s.projects.iter().find(|x| x.name == name).unwrap();
            match &pc.avatar {
                Avatar::Character(id) => id.clone(),
                other => panic!("expected character, got {other:?}"),
            }
        };
        // Processed in name order: ObsidianVault, claude_usage, server_supervisor.
        assert_eq!(hero("claude_usage"), "cassia"); // 'c'
        assert_eq!(hero("ObsidianVault"), "orphea"); // 'o'
        assert_eq!(hero("server_supervisor"), "samuro"); // 's'

        // All distinct.
        let ids: HashSet<_> = s
            .projects
            .iter()
            .filter_map(|p| match &p.avatar {
                Avatar::Character(id) => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(!ids.contains("acolyte"), "re-roll must drop the old manual pick");
    }

    #[test]
    fn backfill_is_deterministic_across_runs() {
        let p = pool(&["abathur", "cassia", "chen", "samuro"]);
        let build = || {
            let mut s = Settings::default();
            s.projects.push(project("cat", Avatar::None));
            s.projects.push(project("car", Avatar::None));
            backfill_with_pool(&mut s, &p);
            s.projects
                .iter()
                .map(|x| (x.name.clone(), match &x.avatar {
                    Avatar::Character(id) => id.clone(),
                    _ => String::new(),
                }))
                .collect::<Vec<_>>()
        };
        assert_eq!(build(), build());
        // car sorts before cat -> car gets cassia, cat gets chen.
        let out = build();
        let get = |n: &str| out.iter().find(|(name, _)| name == n).unwrap().1.clone();
        assert_eq!(get("car"), "cassia");
        assert_eq!(get("cat"), "chen");
    }

    #[test]
    fn backfill_empty_pool_assigns_nothing() {
        let mut s = Settings::default();
        s.projects.push(project("claude", Avatar::None));
        assert_eq!(backfill_with_pool(&mut s, &[]), 0);
        assert_eq!(s.projects[0].avatar, Avatar::None);
    }
}
