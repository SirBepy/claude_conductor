//! Finding things in a vault: which vault, and which notes are clients.

use super::{Client, Frontmatter};
use super::vault_detector::{self, Vault};
use std::fs;
use std::path::{Path, PathBuf};

/// Every root-level note with a `repos:` list. Subfolders are not scanned:
/// journals and research notes never name repos, and the root is where
/// client notes live.
pub fn clients_at(vault: &Path) -> Vec<Client> {
    let Ok(entries) = fs::read_dir(vault) else { return Vec::new() };
    let mut clients: Vec<Client> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let text = fs::read_to_string(&path).ok()?;
            let repos = Frontmatter::parse(&text).list("repos");
            if repos.is_empty() {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_string();
            Some(Client { slug: name.to_lowercase(), name, repos })
        })
        .collect();
    clients.sort_by(|a, b| a.slug.cmp(&b.slug));
    clients
}

/// The client whose `repos` names any of `repo_names` (a Conductor project's
/// name, its folder name), case-insensitively.
pub fn client_for<'a>(clients: &'a [Client], repo_names: &[&str]) -> Option<&'a Client> {
    clients.iter().find(|c| {
        c.repos.iter().any(|r| repo_names.iter().any(|n| !n.trim().is_empty() && r.trim().eq_ignore_ascii_case(n.trim())))
    })
}

/// `CC_VAULT_DIR` wins; otherwise the vault Obsidian itself last had open,
/// read through the same registry reader the channel vault picker uses.
/// `None` means drafts run without people.
pub fn vault_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CC_VAULT_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    registered_vault_in(&dirs::config_dir()?)
}

fn registered_vault_in(config_dir: &Path) -> Option<PathBuf> {
    pick_vault(&vault_detector::detect_entries_in(config_dir).ok()?)
}

/// The open vault first, then the most recently used one.
fn pick_vault(vaults: &[Vault]) -> Option<PathBuf> {
    vaults.iter().max_by_key(|v| (v.open, v.ts)).map(|v| v.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::people::test_support::vault_with;

    #[test]
    fn clients_come_from_root_notes_that_list_repos() {
        let vault = vault_with(&[]);
        fs::write(vault.path().join("Zirtue.md"), "---\ntitle: Zirtue\nrepos: [zng-app, zng-api]\n---\n# Zirtue").unwrap();
        fs::write(vault.path().join("Revaire.md"), "---\nrepos:\n  - revaire-mobile\n---\n").unwrap();
        fs::write(vault.path().join("Rust.md"), "---\ntags: [lang]\n---\n").unwrap();
        let clients = clients_at(vault.path());
        assert_eq!(clients.iter().map(|c| c.slug.as_str()).collect::<Vec<_>>(), vec!["revaire", "zirtue"]);
        assert_eq!(client_for(&clients, &["ZNG-API"]).map(|c| c.slug.as_str()), Some("zirtue"));
        assert_eq!(client_for(&clients, &["claude_usage_in_taskbar", "revaire-mobile"]).map(|c| c.slug.as_str()), Some("revaire"));
        assert_eq!(client_for(&clients, &["fibo", ""]), None);
    }

    #[test]
    fn obsidian_json_prefers_the_open_vault() {
        let json = r#"{"vaults":{"a":{"path":"C:\\old","ts":9,"open":false},"b":{"path":"C:\\Vault","ts":1,"open":true}}}"#;
        let vaults = vault_detector::parse_entries(json).unwrap();
        assert_eq!(pick_vault(&vaults), Some(PathBuf::from("C:\\Vault")));
    }

    #[test]
    fn with_no_open_vault_the_most_recent_wins() {
        let json = r#"{"vaults":{"a":{"path":"/old","ts":1},"b":{"path":"/new","ts":9}}}"#;
        let vaults = vault_detector::parse_entries(json).unwrap();
        assert_eq!(pick_vault(&vaults), Some(PathBuf::from("/new")));
        assert_eq!(pick_vault(&[]), None);
    }

    #[test]
    fn a_vault_registered_under_the_capitalized_obsidian_folder_resolves() {
        let cfg = tempfile::tempdir().unwrap();
        fs::create_dir_all(cfg.path().join("Obsidian")).unwrap();
        fs::write(cfg.path().join("Obsidian").join("obsidian.json"), r#"{"vaults":{"a":{"path":"/vault","open":true}}}"#).unwrap();
        assert_eq!(registered_vault_in(cfg.path()), Some(PathBuf::from("/vault")));
    }
}
