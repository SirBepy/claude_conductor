//! macOS credential store. Claude Code keeps the OAuth record in the login
//! Keychain and never writes `.credentials.json`, so a file-only read finds
//! nothing and the add-account wizard polls forever. Proved 2026-09-01 on
//! `~/.claude-personal`. Read-only: the app writes neither store.

#[cfg(target_os = "macos")]
use std::path::Path;

/// Service the CLI uses when `CLAUDE_CONFIG_DIR` is unset.
#[cfg(target_os = "macos")]
const DEFAULT_SERVICE: &str = "Claude Code-credentials";

/// Keychain service for `config_dir`. A custom `CLAUDE_CONFIG_DIR` appends
/// the first 8 hex of its path's sha256, so profiles never share an item.
/// Verified live: `sha256("/Users/josipmuzic/.claude-personal")[..8]` is
/// `4ebae129`, the item `/login` created for that profile.
#[cfg(target_os = "macos")]
pub fn service_name(config_dir: &Path, home_dir: &Path) -> String {
    if config_dir == home_dir.join(".claude") {
        return DEFAULT_SERVICE.to_string();
    }
    format!("{DEFAULT_SERVICE}-{}", path_digest(config_dir))
}

#[cfg(target_os = "macos")]
fn path_digest(config_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(config_dir.to_string_lossy().as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// The raw secret for `config_dir`, or `None` when no item exists. Matched
/// on service alone, since the account attribute is the unix username. Never
/// falls back to another profile's item - that would hand back the wrong
/// identity's token silently.
#[cfg(target_os = "macos")]
pub fn read_secret(config_dir: &Path) -> Option<String> {
    let home = dirs::home_dir()?;
    read_secret_for_service(&service_name(config_dir, &home))
}

#[cfg(target_os = "macos")]
fn read_secret_for_service(service: &str) -> Option<String> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};

    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .load_data(true)
        .limit(Limit::Max(1))
        .search()
        .ok()?;

    results.into_iter().find_map(|r| match r {
        SearchResult::Data(bytes) => String::from_utf8(bytes).ok(),
        _ => None,
    })
}

/// Non-macOS builds have no keychain; the file read is the only path.
#[cfg(not(target_os = "macos"))]
pub fn read_secret(_config_dir: &std::path::Path) -> Option<String> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        PathBuf::from("/Users/joe")
    }

    #[test]
    fn default_profile_uses_unsuffixed_service() {
        assert_eq!(service_name(&home().join(".claude"), &home()), "Claude Code-credentials");
    }

    #[test]
    fn custom_profile_is_suffixed_with_its_path_digest() {
        let name = service_name(&home().join(".claude-work"), &home());
        assert!(name.starts_with("Claude Code-credentials-"));
        assert_eq!(name.len(), "Claude Code-credentials-".len() + 8);
    }

    #[test]
    fn digest_matches_the_live_keychain_item() {
        // The item `/login` actually created for this profile on 2026-09-01.
        assert_eq!(path_digest(Path::new("/Users/josipmuzic/.claude-personal")), "4ebae129");
    }

    #[test]
    fn distinct_profiles_never_share_a_service() {
        let a = service_name(&home().join(".claude-work"), &home());
        let b = service_name(&home().join(".claude-personal"), &home());
        assert_ne!(a, b);
    }
}
