//! Plaintext token storage for the QR/pairing flow (mirrors
//! `daemon::remote_server`'s hash storage, plaintext added so the app can
//! show the QR without asking the daemon).

use std::path::{Path, PathBuf};

use crate::settings::paths;

pub(super) fn token_file() -> Result<PathBuf, String> {
    Ok(paths::data_dir().map_err(|e| e.to_string())?.join("remote-access.json"))
}

/// Read the current plaintext token for the QR.
///
/// Two writers provision the token and they disagree on format: the APP
/// (`write_token`) stores `{ hash, token }` in `remote-access.json`, while the
/// DAEMON's `ensure_token` writes a hash-only `remote-access.json` plus the
/// plaintext in a sibling `remote-access-token.txt`. When the daemon minted the
/// live token (e.g. after a fresh install, or the json was deleted to force a
/// re-pair), the json has no `"token"` field, so reading only the json returned
/// None and the QR/re-pair flow broke even though the plaintext existed on disk.
/// So: prefer the json `"token"`, then fall back to the daemon's sibling
/// `remote-access-token.txt`. Returns None only when neither carries a token.
pub(super) fn read_plaintext_token(path: &Path) -> Option<String> {
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(tok) = v.get("token").and_then(|t| t.as_str()) {
                let tok = tok.trim();
                if !tok.is_empty() {
                    return Some(tok.to_string());
                }
            }
        }
    }
    // Fall back to the daemon-written plaintext handoff file (hash-only json case).
    let handoff = path.with_file_name("remote-access-token.txt");
    let tok = std::fs::read_to_string(handoff).ok()?;
    let tok = tok.trim();
    if tok.is_empty() {
        None
    } else {
        Some(tok.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::sha256_hex;
    use tempfile::tempdir;

    #[test]
    fn read_plaintext_token_none_for_hash_only_legacy_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        // A daemon-written file from before plaintext persistence: hash only,
        // and no sibling handoff file -> nothing to read.
        std::fs::write(&path, r#"{"hash":"deadbeef"}"#).unwrap();
        assert!(read_plaintext_token(&path).is_none());
    }

    #[test]
    fn read_plaintext_token_falls_back_to_daemon_handoff_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        // Daemon-written: hash-only json + plaintext in the sibling .txt. The QR
        // must still recover the token from the handoff file.
        std::fs::write(&path, r#"{"hash":"deadbeef"}"#).unwrap();
        std::fs::write(dir.path().join("remote-access-token.txt"), "cafebabe\n").unwrap();
        assert_eq!(read_plaintext_token(&path).as_deref(), Some("cafebabe"));
    }

    #[test]
    fn read_plaintext_token_prefers_json_token_over_handoff() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        let body = serde_json::json!({ "hash": sha256_hex("from_json"), "token": "from_json" });
        std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).unwrap();
        // A stale handoff file must NOT shadow the app-written json token.
        std::fs::write(dir.path().join("remote-access-token.txt"), "stale_handoff").unwrap();
        assert_eq!(read_plaintext_token(&path).as_deref(), Some("from_json"));
    }
}
