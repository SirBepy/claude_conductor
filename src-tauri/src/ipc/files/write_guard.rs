//! Confinement for `write_text_file`: where the in-app editor may write.

use super::TextFileStamp;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

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

/// Prefix of the error a write refused by its mtime check returns. The editor
/// matches on it to offer Reload / Keep mine instead of showing a plain error.
pub(super) const CHANGED_ON_DISK: &str = "CHANGED_ON_DISK";

fn canonical(path: &str) -> Result<PathBuf, String> {
    PathBuf::from(path).canonicalize().map_err(|e| format!("file not found: {e}"))
}

fn under_a_root(target: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| crate::util::path::confine_absolute(root, target).is_ok())
}

/// Microseconds, not nanoseconds: the value crosses into JS as a number, and
/// nanoseconds since the epoch overflow 2^53 while microseconds fit.
fn mtime_us(target: &Path) -> Result<u64, String> {
    let modified = std::fs::metadata(target).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
    let since = modified.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
    Ok(since.as_micros() as u64)
}

/// Pure core of `stat_text_file`: the stamp the editor compares against to
/// notice a chat (or anything else) changing the file under it.
pub(super) fn stat_text_file_impl(path: &str, roots: &[PathBuf]) -> Result<TextFileStamp, String> {
    let target = canonical(path)?;
    Ok(TextFileStamp { mtime_us: mtime_us(&target)?, writable: under_a_root(&target, roots) })
}

/// Pure core of `write_text_file`: canonicalizes `path` and requires it land
/// under one of `roots` (already-canonicalized), so the Tauri command can be
/// tested without spinning up a Tauri `AppState`/DB. With `expected_mtime_us`
/// the write is refused when the file changed since the editor loaded it, so
/// an autosave never silently overwrites an edit a chat just made. Returns the
/// file's new mtime for the editor's next write.
pub(super) fn write_text_file_impl(
    path: &str,
    content: &str,
    expected_mtime_us: Option<u64>,
    roots: &[PathBuf],
) -> Result<u64, String> {
    let target = canonical(path)?;
    if !under_a_root(&target, roots) {
        return Err(
            "write_text_file: path is outside every registered project root and the app data dir"
                .to_string(),
        );
    }
    if let Some(expected) = expected_mtime_us {
        if mtime_us(&target)? != expected {
            return Err(format!("{CHANGED_ON_DISK}: the file changed on disk since it was opened"));
        }
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    mtime_us(&target)
}

#[cfg(test)]
mod tests {
    use super::{stat_text_file_impl, write_text_file_impl, CHANGED_ON_DISK};
    use tempfile::tempdir;

    #[test]
    fn accepts_a_write_inside_a_registered_root() {
        let root = tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        write_text_file_impl(file.to_str().unwrap(), "new", None, &roots).unwrap();
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
        write_text_file_impl(file.to_str().unwrap(), "new", None, &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn rejects_a_write_outside_every_registered_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let file = outside.path().join("secret.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        let err = write_text_file_impl(file.to_str().unwrap(), "pwned", None, &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old", "file must be untouched");
    }

    #[test]
    fn rejects_a_target_that_does_not_exist() {
        let root = tempdir().unwrap();
        let missing = root.path().join("does-not-exist.txt");
        let roots = vec![root.path().canonicalize().unwrap()];
        assert!(write_text_file_impl(missing.to_str().unwrap(), "x", None, &roots).is_err());
    }

    #[test]
    fn a_write_with_the_loaded_mtime_succeeds_and_returns_the_new_one() {
        let root = tempdir().unwrap();
        let file = root.path().join("a.md");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        let path = file.to_str().unwrap();
        let loaded = stat_text_file_impl(path, &roots).unwrap().mtime_us;
        let after = write_text_file_impl(path, "new", Some(loaded), &roots).unwrap();
        assert_eq!(after, stat_text_file_impl(path, &roots).unwrap().mtime_us);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn a_write_is_refused_when_the_file_changed_since_it_was_loaded() {
        let root = tempdir().unwrap();
        let file = root.path().join("a.md");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        let path = file.to_str().unwrap();
        let loaded = stat_text_file_impl(path, &roots).unwrap().mtime_us;
        let err = write_text_file_impl(path, "mine", Some(loaded.wrapping_sub(1)), &roots).unwrap_err();
        assert!(err.starts_with(CHANGED_ON_DISK), "got: {err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old", "the other edit must survive");
    }

    #[test]
    fn stat_marks_only_files_under_a_root_writable() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let inside_file = root.path().join("in.txt");
        let outside_file = outside.path().join("out.txt");
        std::fs::write(&inside_file, "x").unwrap();
        std::fs::write(&outside_file, "x").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        assert!(stat_text_file_impl(inside_file.to_str().unwrap(), &roots).unwrap().writable);
        assert!(!stat_text_file_impl(outside_file.to_str().unwrap(), &roots).unwrap().writable);
    }
}
