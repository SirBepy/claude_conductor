//! Seeds dashboard groups from Obsidian vault client notes (`repos:` frontmatter).
//!
//! Pure on purpose: the caller reads the vault (`people::vault::clients_at`)
//! and the project list (`Settings.projects`) and passes both in, so this
//! never touches disk or settings and every rule is unit-testable.

use super::store::{contains_path, DashboardStore};
use super::types::{cwd_key, GroupDef};
use crate::people::Client;

/// Last path component, tolerant of both separator styles and a trailing one.
fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("")
}

/// Maps vault repo names to known project paths by folder basename,
/// case-insensitively. A name with no matching project is skipped; with
/// several matches the first known path wins.
fn resolve_repos(repo_names: &[String], known_project_paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in repo_names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let hit = known_project_paths.iter().find(|p| basename(p).eq_ignore_ascii_case(name));
        if let Some(path) = hit {
            if !contains_path(&out, path) {
                out.push(path.clone());
            }
        }
    }
    out
}

/// Applies the vault clients to the store. Returns whether anything changed.
///
/// A client becomes a group only once at least one of its repos resolves to a
/// known project (an all-unknown group would be an empty dashboard). Slugs in
/// `deleted_vault_slugs` are never recreated, and repos in a group's
/// `removed_repos` are never re-added, so the dev's manual edits stick.
pub fn seed_groups(store: &mut DashboardStore, clients: &[Client], known_project_paths: &[String]) -> bool {
    let mut changed = false;
    for client in clients {
        if client.repos.is_empty() || store.deleted_vault_slugs.contains(&client.slug) {
            continue;
        }
        let resolved = resolve_repos(&client.repos, known_project_paths);
        let existing = store
            .groups
            .iter_mut()
            .find(|g| g.source == "vault" && g.vault_slug.as_deref() == Some(client.slug.as_str()));
        match existing {
            Some(group) => {
                for path in resolved {
                    let skip = contains_path(&group.repos, &path)
                        || group.removed_repos.iter().any(|r| cwd_key(r) == cwd_key(&path));
                    if !skip {
                        group.repos.push(path);
                        changed = true;
                    }
                }
            }
            None if !resolved.is_empty() => {
                store.groups.push(GroupDef {
                    id: format!("vault-{}", client.slug),
                    name: client.name.clone(),
                    repos: resolved,
                    source: "vault".to_string(),
                    vault_slug: Some(client.slug.clone()),
                    removed_repos: Vec::new(),
                });
                changed = true;
            }
            None => {}
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(name: &str, repos: &[&str]) -> Client {
        Client { slug: name.to_lowercase(), name: name.into(), repos: repos.iter().map(|s| s.to_string()).collect() }
    }

    fn paths(p: &[&str]) -> Vec<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn creates_a_group_from_resolvable_repos_matching_basename_case_insensitively() {
        let mut s = DashboardStore::default();
        let known = paths(&["C:/Work/ZNG-App", "C:\\Work\\zng-admin\\", "C:/Work/unrelated"]);
        let changed = seed_groups(&mut s, &[client("Zirtue", &["zng-app", "zng-admin", "zng-api"])], &known);
        assert!(changed);
        assert_eq!(s.groups.len(), 1);
        let g = &s.groups[0];
        assert_eq!(g.id, "vault-zirtue");
        assert_eq!(g.name, "Zirtue");
        assert_eq!(g.source, "vault");
        assert_eq!(g.vault_slug.as_deref(), Some("zirtue"));
        assert_eq!(g.repos, vec!["C:/Work/ZNG-App", "C:\\Work\\zng-admin\\"], "unknown zng-api is skipped");
    }

    #[test]
    fn seeding_twice_is_a_no_op() {
        let mut s = DashboardStore::default();
        let c = [client("Revaire", &["be", "fe"])];
        let known = paths(&["C:/p/BE", "C:/p/FE"]);
        assert!(seed_groups(&mut s, &c, &known));
        assert!(!seed_groups(&mut s, &c, &known));
        assert_eq!(s.groups.len(), 1);
    }

    #[test]
    fn a_client_with_no_resolvable_repo_makes_no_group() {
        let mut s = DashboardStore::default();
        assert!(!seed_groups(&mut s, &[client("Ghost", &["nope"])], &paths(&["C:/p/other"])));
        assert!(s.groups.is_empty());
        assert!(!seed_groups(&mut s, &[client("Empty", &[])], &paths(&["C:/p/other"])));
    }

    #[test]
    fn deleted_vault_slugs_are_never_recreated() {
        let mut s = DashboardStore { deleted_vault_slugs: vec!["zirtue".into()], ..Default::default() };
        assert!(!seed_groups(&mut s, &[client("Zirtue", &["a"])], &paths(&["C:/p/a"])));
        assert!(s.groups.is_empty());
    }

    #[test]
    fn existing_vault_group_gains_newly_resolvable_repos_but_not_removed_ones() {
        let mut s = DashboardStore::default();
        let c = [client("Zirtue", &["a", "b", "c"])];
        seed_groups(&mut s, &c, &paths(&["C:/p/a"]));
        s.groups[0].removed_repos.push("C:/p/b".into());
        let changed = seed_groups(&mut s, &c, &paths(&["C:/p/a", "c:\\P\\B", "C:/p/c"]));
        assert!(changed);
        assert_eq!(s.groups[0].repos, vec!["C:/p/a", "C:/p/c"], "b was removed by hand and stays out");
    }

    #[test]
    fn a_manual_group_with_the_same_name_does_not_block_or_absorb_the_vault_group() {
        let mut s = DashboardStore::default();
        s.upsert_group(None, "Zirtue", vec!["C:/p/x".into()]);
        assert!(seed_groups(&mut s, &[client("Zirtue", &["a"])], &paths(&["C:/p/a"])));
        assert_eq!(s.groups.len(), 2);
        assert_eq!(s.groups[0].repos, vec!["C:/p/x"]);
    }

    #[test]
    fn basename_handles_both_separators_and_trailing_slash() {
        assert_eq!(basename("C:\\a\\b\\"), "b");
        assert_eq!(basename("C:/a/b"), "b");
        assert_eq!(basename("b"), "b");
    }
}
