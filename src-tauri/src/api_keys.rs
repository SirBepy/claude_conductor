//! Registry of API keys the app can read, plus a line-preserving `.env`
//! rewriter. Keys live in `~/.claude/.env`, the one place every tool already
//! reads them from. The line READ itself is shared with `tickets.rs`'s
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

// Names confirmed against the actual readers: `tickets.rs::token_for`
// (SHORTCUT_API_TOKEN / LINEAR_API_KEY) and `~/.claude/skills/ticket/shortcut.md`'s
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
];

pub fn entry(name: &str) -> Option<&'static ApiKeyEntry> {
    REGISTRY.iter().find(|e| e.env_name == name)
}

/// The one file every key lives in, `~/.claude/.env`.
pub fn env_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join(".env"))
}

/// Whether `name` has a non-empty value in `text`. The line parse itself
/// (BOM, surrounding quotes, first match wins) is shared with
/// `tickets.rs::parse_env_value` via `crate::env_file::read_value` (todo
/// 1049) - this module still owns key storage, `env_file` just owns the read.
pub fn is_key_set(text: &str, name: &str) -> bool {
    crate::env_file::read_value(text, name).is_some()
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
    let updated = rewrite_env(&existing, name, value)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, updated).map_err(|e| e.to_string())
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
