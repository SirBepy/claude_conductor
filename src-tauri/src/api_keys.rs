//! Registry of API keys the app can read, plus a line-preserving `.env`
//! rewriter. Keys live in `~/.claude/.env`, the one place every tool already
//! reads them from. The line READ itself is shared with `tickets/mod.rs`'s
//! tracker token lookup via `crate::env_file` (todo 1049); this module still
//! owns key storage (the registry + the writer), not tracker lookups.
//!
//! A value never round-trips through this module's public API: callers get
//! an `is_set` bool, never the string itself.

use std::path::{Path, PathBuf};

pub struct ApiKeyEntry {
    /// The exact `.env` variable name, e.g. `SHORTCUT_API_TOKEN`.
    pub env_name: &'static str,
    pub label: &'static str,
    pub purpose: &'static str,
    pub used_by: &'static str,
    pub create_url: &'static str,
}

// Names confirmed against the actual readers: `tickets/mod.rs::token_for`
// (SHORTCUT_API_TOKEN / LINEAR_API_KEY / TRELLO_API_KEY), `tickets/trello.rs::trello_token`
// (TRELLO_TOKEN) and `~/.claude/skills/ticket/shortcut.md`'s
// `grep -a SHORTCUT_API_TOKEN ~/.claude/.env`.
pub const REGISTRY: &[ApiKeyEntry] = &[
    ApiKeyEntry {
        env_name: "SHORTCUT_API_TOKEN",
        label: "Shortcut API token",
        purpose: "Lets ticket hover cards and the /ticket skill read and file Shortcut stories.",
        used_by: "Ticket hover cards, /ticket skill (zirtue-corp repos)",
        create_url: "https://app.shortcut.com/zirtue/settings/account/api-tokens",
    },
    ApiKeyEntry {
        env_name: "LINEAR_API_KEY",
        label: "Linear API key",
        purpose: "Lets ticket hover cards and the /ticket skill read and file Linear issues.",
        used_by: "Ticket hover cards, /ticket skill (revaire repos)",
        create_url: "https://linear.app/settings/api",
    },
    // Trello needs both: the key identifies the Power-Up, the token is the user's grant.
    ApiKeyEntry {
        env_name: "TRELLO_API_KEY",
        label: "Trello API key",
        purpose: "Lets ticket hover cards read Trello cards. Pair it with the Trello token.",
        used_by: "Ticket hover cards (projects set to Trello)",
        create_url: "https://trello.com/power-ups/admin",
    },
    ApiKeyEntry {
        env_name: "TRELLO_TOKEN",
        label: "Trello token",
        purpose: "Read access to your Trello boards. On the API key page, use the Token link beside the key.",
        used_by: "Ticket hover cards (projects set to Trello)",
        create_url: "https://trello.com/power-ups/admin",
    },
    // Figma, Clockify and Hubstaff are read only by the API token broker
    // (`daemon::broker`); names match what the `~/.claude` skills read today.
    ApiKeyEntry {
        env_name: "FIGMA_TOKEN",
        label: "Figma personal access token",
        purpose: "Lets chats read Figma files and comments through the API broker.",
        used_by: "API broker (Figma)",
        create_url: "https://www.figma.com/settings",
    },
    ApiKeyEntry {
        env_name: "CLOCKIFY_API_KEY",
        label: "Clockify API key",
        purpose: "Lets chats read and log Clockify time entries through the API broker.",
        used_by: "API broker (Clockify)",
        create_url: "https://app.clockify.me/user/preferences#advanced",
    },
    // Rotating: every refresh returns a new refresh token that replaces this
    // one, so the broker writes it back to wherever it read it from.
    ApiKeyEntry {
        env_name: "HUBSTAFF_REFRESH_TOKEN",
        label: "Hubstaff refresh token",
        purpose: "Lets chats read Hubstaff time through the API broker. Rotates on every use; PC only.",
        used_by: "API broker (Hubstaff)",
        create_url: "https://developer.hubstaff.com/personal_access_tokens",
    },
];

pub fn entry(name: &str) -> Option<&'static ApiKeyEntry> {
    REGISTRY.iter().find(|e| e.env_name == name)
}

/// Every `.env` line name a registry key can be stored under, canonical name
/// first. The Trello API key is `TRELLO_API_KEY` in this registry but
/// `TRELLO_KEY` in the `.env` the `~/.claude` tooling wrote, so a read tries both.
pub fn env_names(name: &str) -> &'static [&'static str] {
    match name {
        "TRELLO_API_KEY" => &["TRELLO_API_KEY", "TRELLO_KEY"],
        _ => &[],
    }
}

/// Reads `name` out of `.env` text, falling back to its aliases (`env_names`).
/// A present-but-empty canonical line does not shadow a filled alias.
pub fn read_env_value(text: &str, name: &str) -> Option<String> {
    let aliases = env_names(name);
    if aliases.is_empty() {
        return crate::env_file::read_value(text, name);
    }
    aliases.iter().find_map(|n| crate::env_file::read_value(text, n))
}

/// The one file every key lives in, `~/.claude/.env`.
pub fn env_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join(".env"))
}

/// Whether `name` has a non-empty value in `text`. The line parse itself
/// (BOM, surrounding quotes, first match wins) is shared with
/// `tickets/mod.rs::parse_env_value` via `crate::env_file::read_value` (todo
/// 1049) - this module still owns key storage, `env_file` just owns the read.
pub fn is_key_set(text: &str, name: &str) -> bool {
    read_env_value(text, name).is_some()
}

/// Rewrites `text` so `name=value` is set, touching only that one line (or
/// appending it if absent). Every other line, including comments, blanks and
/// ordering, comes back unchanged; the file's own CRLF-vs-LF convention is
/// kept, and any leading BOM on the input is dropped rather than carried
/// forward (this file must never be written with one).
pub fn rewrite_env(text: &str, name: &str, value: &str) -> Result<String, String> {
    if value.contains('\n') || value.contains('\r') {
        return Err("value cannot contain a newline".into());
    }
    let text = text.trim_start_matches('\u{feff}');
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let had_trailing_newline = text.ends_with('\n') || text.ends_with('\r');
    // `"".split('\n')` yields `[""]`, a phantom blank line that doesn't exist
    // in an empty/missing file - special-case it so an append starts clean.
    let mut lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()
    };
    if had_trailing_newline {
        // `split('\n')` on a string ending in '\n' yields a trailing "" entry;
        // drop it, the trailing newline gets re-added below instead.
        lines.pop();
    }

    let target = format!("{name}={value}");
    let mut found = false;
    for line in lines.iter_mut() {
        let key = line.trim().split_once('=').map(|(k, _)| k.trim());
        if key == Some(name) {
            *line = target.clone();
            found = true;
            break;
        }
    }
    if !found {
        lines.push(target);
    }

    let mut out = lines.join(eol);
    if had_trailing_newline || !found {
        out.push_str(eol);
    }
    Ok(out)
}

/// Thin file wrapper over `rewrite_env`: validates `name` against the
/// registry, reads the current file (treating "missing" as empty), creates
/// the parent dir if absent, and writes the result back with no BOM.
pub fn set_key(path: &Path, name: &str, value: &str) -> Result<(), String> {
    if entry(name).is_none() {
        return Err(format!("{name} is not a known API key"));
    }
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    // A key that already lives under an alias is replaced there, never
    // duplicated under the canonical name.
    let target = env_names(name)
        .iter()
        .find(|n| crate::env_file::read_value(&existing, n).is_some())
        .copied()
        .unwrap_or(name);
    let updated = rewrite_env(&existing, target, value)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, updated).map_err(|e| e.to_string())
}

// ---- Broker store (API token broker) -----------------------------------------
//
// `.env` keeps the plaintext path (`set_key`). The broker's own store is a JSON
// file of `name -> protected form` (`util::secret_store::protect_strict`: DPAPI
// on Windows, Keychain reference on macOS, an error elsewhere), so a copied
// data folder holds no usable token. The two read functions below hand a value
// to `daemon::broker` and nothing else: they are `pub(crate)` and the engine is
// the only caller that may put the result anywhere but a request.

use crate::util::secret_store::{protect_strict_with, unprotect_strict_with, Backend, CommandRunner};
use std::collections::BTreeMap;

/// File inside the data dir that holds the broker store.
pub const BROKER_STORE_FILE: &str = "broker-secrets.json";

pub fn broker_store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BROKER_STORE_FILE)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct BrokerFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

/// A missing file is an empty store; an unreadable or corrupt one is an error,
/// never read as empty (the next write would destroy every other secret).
fn load_broker_file(path: &Path) -> Result<BrokerFile, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| format!("{} is not valid JSON", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BrokerFile::default()),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Whether the broker store holds an entry for `name`. Never decrypts.
pub fn broker_has(path: &Path, name: &str) -> bool {
    load_broker_file(path).map(|f| f.secrets.contains_key(name)).unwrap_or(false)
}

/// Reads one secret from the broker store. `Ok(None)` when no entry exists.
pub(crate) fn read_broker_secret(
    path: &Path,
    backend: Backend,
    runner: &dyn CommandRunner,
    name: &str,
) -> Result<Option<String>, String> {
    let file = load_broker_file(path)?;
    let Some(stored) = file.secrets.get(name) else { return Ok(None) };
    unprotect_strict_with(backend, runner, stored).map(Some).map_err(|e| format!("{name}: {e}"))
}

/// Protects `value` and stores it under `name` (a registry name), keeping every
/// other entry. Written through a temp file and a rename so a crash never
/// leaves half a store.
pub(crate) fn set_broker_secret(
    path: &Path,
    backend: Backend,
    runner: &dyn CommandRunner,
    name: &str,
    value: &str,
) -> Result<(), String> {
    if entry(name).is_none() {
        return Err(format!("{name} is not a known API key"));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err("value cannot contain a newline".into());
    }
    let mut file = load_broker_file(path)?;
    let stored = protect_strict_with(backend, runner, name, value).map_err(|e| e.to_string())?;
    file.secrets.insert(name.to_string(), stored);
    file.version = 1;
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Where a resolved secret was read from, so a rotated value goes back to the
/// same place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretOrigin {
    BrokerStore,
    EnvFile,
}

/// Broker store first, then `.env` (with Trello's alias). `Ok(None)` when
/// neither has it; a store entry that exists but will not decrypt is an
/// error, not a silent fall-through to a stale `.env` copy.
pub(crate) fn resolve_secret(
    store_path: &Path,
    env_file: Option<&Path>,
    backend: Backend,
    runner: &dyn CommandRunner,
    name: &str,
) -> Result<Option<(String, SecretOrigin)>, String> {
    if let Some(v) = read_broker_secret(store_path, backend, runner, name)? {
        return Ok(Some((v, SecretOrigin::BrokerStore)));
    }
    let Some(env_file) = env_file else { return Ok(None) };
    let text = std::fs::read_to_string(env_file).unwrap_or_default();
    Ok(read_env_value(&text, name).map(|v| (v, SecretOrigin::EnvFile)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_key_leaving_other_lines_byte_identical() {
        let text = "# header\nFOO=1\nSHORTCUT_API_TOKEN=old\nBAR=2\n";
        let out = rewrite_env(text, "SHORTCUT_API_TOKEN", "new").unwrap();
        assert_eq!(out, "# header\nFOO=1\nSHORTCUT_API_TOKEN=new\nBAR=2\n");
    }

    #[test]
    fn appends_a_missing_key_after_the_last_line() {
        let text = "FOO=1\n# a comment\n";
        let out = rewrite_env(text, "LINEAR_API_KEY", "abc").unwrap();
        assert_eq!(out, "FOO=1\n# a comment\nLINEAR_API_KEY=abc\n");
    }

    #[test]
    fn appends_into_an_empty_or_missing_file() {
        assert_eq!(rewrite_env("", "FOO", "1").unwrap(), "FOO=1\n");
    }

    #[test]
    fn preserves_crlf_when_the_file_already_uses_it() {
        let text = "FOO=1\r\nSHORTCUT_API_TOKEN=old\r\n";
        let out = rewrite_env(text, "SHORTCUT_API_TOKEN", "new").unwrap();
        assert_eq!(out, "FOO=1\r\nSHORTCUT_API_TOKEN=new\r\n");
    }

    #[test]
    fn preserves_lf_and_a_missing_trailing_newline_gets_one_after_append() {
        let text = "FOO=1\nBAR=2";
        let out = rewrite_env(text, "BAR", "3").unwrap();
        // BAR existed (no trailing newline originally) - the edited line is
        // rewritten in place, so the file-level "no trailing newline" shape
        // is preserved for a pure replace.
        assert_eq!(out, "FOO=1\nBAR=3");
    }

    #[test]
    fn strips_an_input_bom_and_never_writes_one() {
        let text = "\u{feff}FOO=1\n";
        let out = rewrite_env(text, "FOO", "2").unwrap();
        assert!(!out.starts_with('\u{feff}'));
        assert_eq!(out, "FOO=2\n");
    }

    #[test]
    fn rejects_a_newline_in_the_value() {
        assert!(rewrite_env("", "FOO", "bad\nvalue").is_err());
        assert!(rewrite_env("", "FOO", "bad\rvalue").is_err());
    }

    #[test]
    fn is_key_set_reads_bom_quotes_and_treats_empty_as_unset() {
        let text = "\u{feff}SHORTCUT_API_TOKEN=\"abc\"\r\nLINEAR_API_KEY=\r\n";
        assert!(is_key_set(text, "SHORTCUT_API_TOKEN"));
        assert!(!is_key_set(text, "LINEAR_API_KEY"));
        assert!(!is_key_set(text, "MISSING"));
    }

    #[test]
    fn registry_names_are_unique_and_cover_every_broker_service() {
        for n in ["SHORTCUT_API_TOKEN", "LINEAR_API_KEY", "TRELLO_API_KEY", "TRELLO_TOKEN", "FIGMA_TOKEN", "CLOCKIFY_API_KEY", "HUBSTAFF_REFRESH_TOKEN"] {
            assert!(entry(n).is_some(), "{n} missing from the registry");
        }
        let mut names: Vec<_> = REGISTRY.iter().map(|e| e.env_name).collect();
        names.sort();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len());
    }

    #[test]
    fn trello_key_resolves_under_either_env_name() {
        assert_eq!(read_env_value("TRELLO_KEY=abc\n", "TRELLO_API_KEY").as_deref(), Some("abc"));
        assert_eq!(read_env_value("TRELLO_API_KEY=def\nTRELLO_KEY=abc\n", "TRELLO_API_KEY").as_deref(), Some("def"));
        // An empty canonical line must not hide the filled alias.
        assert_eq!(read_env_value("TRELLO_API_KEY=\nTRELLO_KEY=abc\n", "TRELLO_API_KEY").as_deref(), Some("abc"));
        assert!(is_key_set("TRELLO_KEY=abc\n", "TRELLO_API_KEY"));
        // The alias does not leak the other way or to other keys.
        assert_eq!(read_env_value("TRELLO_API_KEY=def\n", "TRELLO_TOKEN"), None);
    }

    #[test]
    fn set_key_replaces_an_aliased_line_instead_of_duplicating_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env");
        std::fs::write(&path, "TRELLO_KEY=old\nOTHER=1\n").unwrap();
        set_key(&path, "TRELLO_API_KEY", "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "TRELLO_KEY=new\nOTHER=1\n");
    }

    /// In-memory stand-in for `/usr/bin/security`: `add-generic-password` on stdin, `find-generic-password` in argv.
    #[derive(Default)]
    struct FakeKeychain {
        items: std::sync::Mutex<std::collections::HashMap<String, String>>,
    }

    impl CommandRunner for FakeKeychain {
        fn run(&self, _program: &str, args: &[&str], stdin: &str) -> anyhow::Result<(bool, String)> {
            if args.first() == Some(&"-i") {
                let parts: Vec<&str> = stdin.split_whitespace().collect();
                let account = parts.iter().position(|p| *p == "-a").map(|i| parts[i + 1].to_string());
                let hex = parts.iter().position(|p| *p == "-w").map(|i| parts[i + 1].to_string());
                if let (Some(a), Some(h)) = (account, hex) {
                    self.items.lock().unwrap().insert(a, h);
                }
                return Ok((true, String::new()));
            }
            let account = args.iter().position(|p| *p == "-a").map(|i| args[i + 1]).unwrap_or_default();
            Ok(match self.items.lock().unwrap().get(account) {
                Some(h) => (true, format!("{h}\n")),
                None => (false, String::new()),
            })
        }
    }

    #[test]
    fn broker_store_round_trips_and_keeps_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = broker_store_path(dir.path());
        let kc = FakeKeychain::default();
        set_broker_secret(&path, Backend::Keychain, &kc, "FIGMA_TOKEN", "canary-figma-1").unwrap();
        set_broker_secret(&path, Backend::Keychain, &kc, "CLOCKIFY_API_KEY", "canary-clock-2").unwrap();
        assert_eq!(read_broker_secret(&path, Backend::Keychain, &kc, "FIGMA_TOKEN").unwrap().as_deref(), Some("canary-figma-1"));
        assert_eq!(read_broker_secret(&path, Backend::Keychain, &kc, "LINEAR_API_KEY").unwrap(), None);
        assert!(broker_has(&path, "CLOCKIFY_API_KEY"));
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("canary-figma-1") && !on_disk.contains("canary-clock-2"), "the store file must hold no plaintext");
    }

    #[test]
    fn broker_store_refuses_plaintext_backends_and_unknown_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = broker_store_path(dir.path());
        let kc = FakeKeychain::default();
        assert!(set_broker_secret(&path, Backend::Unavailable, &kc, "FIGMA_TOKEN", "canary-x").is_err());
        assert!(!path.exists(), "a refused write must not create the store");
        assert!(set_broker_secret(&path, Backend::Keychain, &kc, "NOT_A_KEY", "canary-x").is_err());
        assert!(set_broker_secret(&path, Backend::Keychain, &kc, "FIGMA_TOKEN", "a\nb").is_err());
    }

    #[test]
    fn a_corrupt_store_is_an_error_never_read_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = broker_store_path(dir.path());
        std::fs::write(&path, "{ not json").unwrap();
        let kc = FakeKeychain::default();
        assert!(read_broker_secret(&path, Backend::Keychain, &kc, "FIGMA_TOKEN").is_err());
        assert!(set_broker_secret(&path, Backend::Keychain, &kc, "FIGMA_TOKEN", "canary-y").is_err(), "a write must not overwrite a corrupt store");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn resolve_prefers_the_store_then_falls_back_to_env_with_the_alias() {
        let dir = tempfile::tempdir().unwrap();
        let store = broker_store_path(dir.path());
        let env = dir.path().join(".env");
        std::fs::write(&env, "TRELLO_KEY=canary-env-key\nFIGMA_TOKEN=canary-env-figma\n").unwrap();
        let kc = FakeKeychain::default();
        set_broker_secret(&store, Backend::Keychain, &kc, "FIGMA_TOKEN", "canary-store-figma").unwrap();
        let figma = resolve_secret(&store, Some(&env), Backend::Keychain, &kc, "FIGMA_TOKEN").unwrap().unwrap();
        assert_eq!(figma, ("canary-store-figma".to_string(), SecretOrigin::BrokerStore));
        let trello = resolve_secret(&store, Some(&env), Backend::Keychain, &kc, "TRELLO_API_KEY").unwrap().unwrap();
        assert_eq!(trello, ("canary-env-key".to_string(), SecretOrigin::EnvFile));
        assert!(resolve_secret(&store, Some(&env), Backend::Keychain, &kc, "LINEAR_API_KEY").unwrap().is_none());
    }

    #[test]
    fn set_key_rejects_an_unknown_name() {
        let dir = std::env::temp_dir().join(format!("api_keys_test_{}", std::process::id()));
        let path = dir.join(".env");
        let err = set_key(&path, "NOT_A_REAL_KEY", "x").unwrap_err();
        assert!(err.contains("not a known"));
        assert!(!path.exists(), "an unknown key must not touch the file at all");
    }

    #[test]
    fn set_key_creates_the_file_and_parent_dir_when_absent() {
        let dir = std::env::temp_dir().join(format!("api_keys_test_create_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join(".env");
        set_key(&path, "SHORTCUT_API_TOKEN", "tok-123").unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "SHORTCUT_API_TOKEN=tok-123\n");
        assert!(!written.as_bytes().starts_with(&[0xEF, 0xBB, 0xBF]), "must not write a BOM");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_key_replaces_in_place_on_a_real_file_preserving_siblings() {
        let dir = std::env::temp_dir().join(format!("api_keys_test_replace_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(".env");
        std::fs::write(&path, "# keep me\r\nOTHER=1\r\nLINEAR_API_KEY=old\r\n").unwrap();
        set_key(&path, "LINEAR_API_KEY", "new-key").unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "# keep me\r\nOTHER=1\r\nLINEAR_API_KEY=new-key\r\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
