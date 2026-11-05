//! Reading the small JSON files under `<data_dir>/subchats/` without losing them.
//!
//! A file that fails to parse used to read as "empty", and the next write then
//! replaced it, so one damaged entry (or a build that added a required field)
//! silently dropped every queued sub. [`keep_bad_copy`] sets the unreadable bytes
//! aside as `<name>.bad` and logs an error before anything can overwrite them.

use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};

fn bad_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".bad{suffix}"));
    path.with_file_name(name)
}

/// Sets `raw` (the text of `path` that could not be read) aside next to it. The
/// first copy is `<name>.bad`; a different damaged text later gets a timestamped
/// name, and the same text again is not copied twice, so a file that is read on
/// every call does not pile up copies or log lines.
pub(crate) fn keep_bad_copy(path: &Path, raw: &str, why: &str) {
    let first = bad_path(path, "");
    let target = match std::fs::read_to_string(&first) {
        Err(_) => first,
        Ok(kept) if kept == raw => return,
        Ok(_) => bad_path(path, &format!("-{}", chrono::Utc::now().timestamp_millis())),
    };
    match std::fs::write(&target, raw) {
        Ok(()) => log::error!("subchats: {} could not be read ({why}); the unreadable text is kept at {}", path.display(), target.display()),
        Err(e) => log::error!("subchats: {} could not be read ({why}) and a copy could not be kept: {e}", path.display()),
    }
}

/// Reads `path` as `T`. A missing file is the default; one that does not parse is
/// kept aside (see [`keep_bad_copy`]) and read as the default.
pub(crate) fn read_or_keep<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(raw) = std::fs::read_to_string(path) else { return T::default() };
    match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            keep_bad_copy(path, &raw, &e.to_string());
            T::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_damaged_file_is_kept_once_per_distinct_text_and_reads_as_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(read_or_keep::<Vec<u32>>(&path), Vec::<u32>::new());
        assert_eq!(read_or_keep::<Vec<u32>>(&path), Vec::<u32>::new());
        assert_eq!(std::fs::read_to_string(dir.path().join("x.json.bad")).unwrap(), "{ nope");
        std::fs::write(&path, "[1, still nope").unwrap();
        read_or_keep::<Vec<u32>>(&path);
        let copies = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("x.json.bad")).count();
        assert_eq!(copies, 2, "the second text did not overwrite the first");
    }

    #[test]
    fn a_missing_or_valid_file_keeps_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("y.json");
        assert_eq!(read_or_keep::<Vec<u32>>(&path), Vec::<u32>::new());
        std::fs::write(&path, "[1,2]").unwrap();
        assert_eq!(read_or_keep::<Vec<u32>>(&path), vec![1, 2]);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
