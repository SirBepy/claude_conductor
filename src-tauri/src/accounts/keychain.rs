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
/// identity's token silently. Only hits are cached, so a login that lands
/// mid-poll is seen on the next read.
#[cfg(target_os = "macos")]
pub fn read_secret(config_dir: &Path) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);

    let home = dirs::home_dir()?;
    let service = service_name(config_dir, &home);
    if let Some((at, secret)) = cache.lock().ok()?.get(&service) {
        if at.elapsed() < CACHE_TTL {
            return Some(secret.clone());
        }
    }
    let secret = read_secret_for_service(&service)?;
    if let Ok(mut map) = cache.lock() {
        map.insert(service, (Instant::now(), secret.clone()));
    }
    Some(secret)
}

/// One spawn runs the drift and credential guards back to back, and the
/// wizard polls every few seconds.
#[cfg(target_os = "macos")]
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(20);

/// Shells out to `/usr/bin/security` rather than the Security framework: a
/// prompt is then keyed to Apple's signed binary, not to this app's ad-hoc
/// signature, which changes every build and re-prompts after each update.
#[cfg(target_os = "macos")]
fn read_secret_for_service(service: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-w"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    decode_secret(&String::from_utf8(out.stdout).ok()?)
}

/// `security -w` prints a secret it deems non-printable as bare hex.
#[cfg(target_os = "macos")]
fn decode_secret(printed: &str) -> Option<String> {
    let text = printed.trim_end_matches('\n');
    let looks_hex = !text.is_empty()
        && text.len() % 2 == 0
        && text.bytes().all(|b| b.is_ascii_hexdigit());
    if !looks_hex {
        return Some(text.to_string());
    }
    let bytes: Option<Vec<u8>> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
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
    fn json_passes_through_and_hex_is_decoded() {
        assert_eq!(decode_secret("{\"a\":1}\n").as_deref(), Some("{\"a\":1}"));
        assert_eq!(decode_secret("7b2261223a317d\n").as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn distinct_profiles_never_share_a_service() {
        let a = service_name(&home().join(".claude-work"), &home());
        let b = service_name(&home().join(".claude-personal"), &home());
        assert_ne!(a, b);
    }
}
