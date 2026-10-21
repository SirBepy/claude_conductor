//! Reads and writes the single sessionKey cookie value.

use anyhow::{Context, Result};
use std::path::Path;

use crate::util::secret_store;

/// Returns the current sessionKey, or `None` if no session has been saved or
/// the stored value cannot be decrypted (treated like logged out, so the
/// re-login flow runs instead of polling with a garbage cookie). A legacy
/// plaintext file still reads and is rewritten wrapped on the spot.
pub fn load(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let key = match secret_store::unprotect(trimmed) {
        Ok(k) => k,
        Err(e) => {
            // Set aside, never left for the next login to overwrite: a blob
            // wrapped by another Windows user may still be recoverable.
            let aside = path.with_extension("unreadable");
            let kept = std::fs::rename(path, &aside).is_ok();
            log::warn!("session: {path:?} unreadable: {e} (old file {})", if kept { "kept as .unreadable" } else { "could not be set aside" });
            return None;
        }
    };
    if secret_store::needs_migration(trimmed) {
        if let Err(e) = save(path, &key) {
            log::warn!("session: could not wrap legacy plaintext at {path:?}: {e}");
        }
    }
    Some(key)
}

/// Saves the sessionKey, creating parent dirs as needed. Write-temp-then-
/// rename via `util::write_json_atomic` (the helper writes whatever text
/// it's given, not just JSON) so a crash or kill mid-write can't leave a
/// torn cookie file behind - matching `settings::store::save`.
pub fn save(path: &Path, session_key: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let stored = secret_store::protect(session_key.trim())
        .with_context(|| format!("protecting session for {path:?}"))?;
    crate::util::write_json_atomic(path, &stored)
        .with_context(|| format!("writing session to {path:?}"))?;
    Ok(())
}

/// Deletes the session file. Used on explicit logout or after repeated 401s.
pub fn clear(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn undecryptable_blob_is_kept_beside_the_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.txt");
        std::fs::write(&path, "ccsec1:garbage-not-a-real-blob").unwrap();
        if load(&path).is_some() {
            return; // platform treats this text as plaintext; nothing to set aside
        }
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(path.with_extension("unreadable")).unwrap(),
            "ccsec1:garbage-not-a-real-blob"
        );
    }

    #[test]
    fn missing_session_file_returns_none() {
        let dir = tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.txt")), None);
    }

    #[test]
    fn empty_session_file_returns_none() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        std::fs::write(&p, "   \n").unwrap();
        assert_eq!(load(&p), None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        save(&p, "sk-ant-abc123").unwrap();
        assert_eq!(load(&p).as_deref(), Some("sk-ant-abc123"));
    }

    #[test]
    fn saved_file_does_not_hold_the_raw_key_where_wrapping_exists() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        save(&p, "sk-ant-abc123").unwrap();
        let on_disk = std::fs::read_to_string(&p).unwrap();
        assert_eq!(on_disk.contains("sk-ant-abc123"), !secret_store::WRAPS_AT_REST);
    }

    #[test]
    fn legacy_plaintext_file_loads_and_is_rewritten_wrapped() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        std::fs::write(&p, "sk-ant-legacy\n").unwrap();
        assert_eq!(load(&p).as_deref(), Some("sk-ant-legacy"));
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(secret_store::is_protected(after.trim()), secret_store::WRAPS_AT_REST);
        // The rewritten file must still load to the same key.
        assert_eq!(load(&p).as_deref(), Some("sk-ant-legacy"));
    }

    #[test]
    fn corrupt_wrapped_file_loads_as_logged_out() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        std::fs::write(&p, format!("{}AAAAAAAAAAAAAAAA", secret_store::PREFIX)).unwrap();
        assert_eq!(load(&p), None);
    }

    #[test]
    fn clear_removes_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        save(&p, "x").unwrap();
        clear(&p).unwrap();
        assert_eq!(load(&p), None);
    }

    #[test]
    fn clear_is_idempotent_when_missing() {
        let dir = tempdir().unwrap();
        clear(&dir.path().join("never.txt")).unwrap();
    }
}
