//! Reads and writes the single sessionKey cookie value.

use anyhow::{Context, Result};
use std::path::Path;

/// Returns the current sessionKey, or `None` if no session has been saved.
pub fn load(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
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
    crate::util::write_json_atomic(path, session_key.trim())
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
