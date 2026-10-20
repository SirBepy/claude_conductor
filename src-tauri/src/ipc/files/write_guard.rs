//! Confinement for `write_text_file`: where the in-app editor may write.

use crate::state::AppState;
use std::path::PathBuf;

/// Roots `write_text_file` may write under: every registered project's
/// directory, plus the app data dir (for the app's own files, e.g. a
/// settings/export doc opened through the same editor). Canonicalized so a
/// `..` or a symlink/junction can't walk the write outside either (todo
/// 1212). A root that no longer exists on disk (deleted project folder,
/// data dir not yet created) is silently skipped rather than failing the
/// whole write.
pub(super) fn write_text_file_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = crate::settings::paths::ensure_data_dir() {
        if let Ok(c) = dir.canonicalize() {
            roots.push(c);
        }
    }
    if let Ok(settings) = state.settings.lock() {
        for p in &settings.projects {
            if let Ok(c) = p.path.canonicalize() {
                roots.push(c);
            }
        }
    }
    roots
}

/// Pure core of `write_text_file`: canonicalizes `path` and requires it land
/// under one of `roots` (already-canonicalized), so the Tauri command can be
/// tested without spinning up a Tauri `AppState`/DB.
pub(super) fn write_text_file_impl(path: &str, content: &str, roots: &[PathBuf]) -> Result<(), String> {
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    if !roots.iter().any(|root| crate::util::path::confine_absolute(root, &target).is_ok()) {
        return Err(
            "write_text_file: path is outside every registered project root and the app data dir"
                .to_string(),
        );
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::write_text_file_impl;
    use tempfile::tempdir;

    #[test]
    fn accepts_a_write_inside_a_registered_root() {
        let root = tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        write_text_file_impl(file.to_str().unwrap(), "new", &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn accepts_a_write_in_a_subdirectory_of_a_registered_root() {
        let root = tempdir().unwrap();
        let sub = root.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("main.rs");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        write_text_file_impl(file.to_str().unwrap(), "new", &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn rejects_a_write_outside_every_registered_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let file = outside.path().join("secret.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        let err = write_text_file_impl(file.to_str().unwrap(), "pwned", &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old", "file must be untouched");
    }

    #[test]
    fn rejects_a_target_that_does_not_exist() {
        let root = tempdir().unwrap();
        let missing = root.path().join("does-not-exist.txt");
        let roots = vec![root.path().canonicalize().unwrap()];
        assert!(write_text_file_impl(missing.to_str().unwrap(), "x", &roots).is_err());
    }
}
