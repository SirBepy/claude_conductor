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

/// The most copies of one file kept aside: a file that keeps changing while it is
/// unreadable (two damaged texts taking turns, a writer that keeps appending to a
/// damaged tail) must not fill the folder. At the cap the oldest copy goes first.
const MAX_BAD_COPIES: usize = 5;

/// Every `<name>.bad*` copy beside `path`, oldest first by modified time.
fn bad_copies(path: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().map(|n| n.to_string_lossy().into_owned())) else { return Vec::new() };
    let prefix = format!("{name}.bad");
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// `<name>.bad-<ms>`, or `<name>.bad-<ms>-<n>` when two different damaged texts are kept inside the
/// same millisecond: a name that is taken is never reused, or the second text would overwrite the first.
fn stamped_path(path: &Path, ms: i64) -> PathBuf {
    let mut n = 0;
    loop {
        let suffix = if n == 0 { format!("-{ms}") } else { format!("-{ms}-{n}") };
        let candidate = bad_path(path, &suffix);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Sets `bytes` (what `path` holds, unreadable) aside next to it, once per distinct
/// content: the first copy is `<name>.bad`, a different damaged content gets a
/// timestamped name, and a content any kept copy already holds is not copied
/// again, so a file read on every call does not pile up copies or log lines.
/// `Ok(None)` is "already kept".
fn keep_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<Option<PathBuf>> {
    let mut kept = bad_copies(path);
    if kept.iter().any(|p| std::fs::read(p).is_ok_and(|b| b == bytes)) {
        return Ok(None);
    }
    let first = bad_path(path, "");
    let target = if kept.contains(&first) { stamped_path(path, chrono::Utc::now().timestamp_millis()) } else { first };
    std::fs::write(&target, bytes)?;
    kept.push(target.clone());
    while kept.len() > MAX_BAD_COPIES {
        let oldest = kept.remove(0);
        if oldest != target {
            let _ = std::fs::remove_file(oldest);
        }
    }
    Ok(Some(target))
}

/// Sets `raw` (the text of `path` that could not be read) aside next to it, once
/// per distinct text (see [`keep_bytes`]).
pub(crate) fn keep_bad_copy(path: &Path, raw: &str, why: &str) {
    match keep_bytes(path, raw.as_bytes()) {
        Ok(Some(target)) => log::error!("subchats: {} could not be read ({why}); the unreadable text is kept at {}", path.display(), target.display()),
        Ok(None) => {}
        Err(e) => log::error!("subchats: {} could not be read ({why}) and a copy could not be kept: {e}", path.display()),
    }
}

/// The text of `path` for a reader that must not lose the file. `Ok(None)` is a file
/// that is not there, or one that is not UTF-8: its bytes are copied to `<name>.bad`
/// first (a new name when a different damaged text is already kept), so the next write
/// cannot take them with it. `Err` is a file that exists but cannot be read now (locked,
/// no permission): a writer must stop on it, because replacing a file it never read
/// would drop every record in it, and a read-only caller may treat it as empty.
pub(crate) fn read_text_guarded(path: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            let bytes = std::fs::read(path)?;
            if let Some(target) = keep_bytes(path, &bytes)? {
                log::error!("subchats: {} is not UTF-8 text; its bytes are kept at {}", path.display(), target.display());
            }
            Ok(None)
        }
        Err(e) => {
            log::error!("subchats: {} could not be read ({e}); it is left as it is", path.display());
            Err(e)
        }
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

/// The error of a store whose data folder cannot be found.
pub(crate) fn no_data_dir() -> std::io::Error {
    std::io::Error::other("no data dir")
}

/// `path` as JSON for a reader that must not lose the file: `Ok(None)` for a file that is not
/// there, is not UTF-8 or does not parse (the text is kept as `.bad` first, see
/// [`read_text_guarded`] and [`keep_bad_copy`]), `Err` for one that exists but cannot be read now.
/// The raw text comes back with the value so a caller that finds a part it cannot decode can keep
/// the whole text too.
pub(crate) fn read_json_guarded(path: &Path) -> std::io::Result<Option<(String, serde_json::Value)>> {
    let Some(raw) = read_text_guarded(path)? else { return Ok(None) };
    match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => Ok(Some((raw, v))),
        Err(e) => {
            keep_bad_copy(path, &raw, &e.to_string());
            Ok(None)
        }
    }
}

/// Decodes `parts` one by one: a part that will not decode costs only itself, and the whole text
/// (`raw`, what `path` holds) is kept as `.bad` first so the next write cannot take it away.
/// `what` names the parts in the log ("entries").
pub(crate) fn decode_parts<T: DeserializeOwned>(path: &Path, raw: &str, parts: Vec<serde_json::Value>, what: &str) -> Vec<T> {
    let mut out = Vec::with_capacity(parts.len());
    let mut unreadable = 0;
    for part in parts {
        match serde_json::from_value::<T>(part) {
            Ok(v) => out.push(v),
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        keep_bad_copy(path, raw, &format!("{unreadable} of its {what} did not decode"));
    }
    out
}

/// A file holding a JSON array, read entry by entry for a writer: `Err` when the file exists but
/// cannot be read now (locked), so the write stops instead of replacing every entry with a list
/// built from nothing; anything unreadable is kept as `.bad` (see [`read_json_guarded`] and
/// [`decode_parts`]) and costs only itself.
pub(crate) fn read_list_guarded<T: DeserializeOwned>(path: &Path) -> std::io::Result<Vec<T>> {
    let Some((raw, value)) = read_json_guarded(path)? else { return Ok(Vec::new()) };
    let serde_json::Value::Array(parts) = value else {
        keep_bad_copy(path, &raw, "it is not a list");
        return Ok(Vec::new());
    };
    Ok(decode_parts(path, &raw, parts, "entries"))
}

/// Writes `value` to `path` as JSON, atomically, creating the folder first.
pub(crate) fn write_json<T: serde::Serialize + ?Sized>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string(value).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(path, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_with_one_entry_that_will_not_decode_keeps_the_others_and_the_whole_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.json");
        std::fs::write(&path, r#"[1, "two", 3]"#).unwrap();
        assert_eq!(read_list_guarded::<u32>(&path).unwrap(), vec![1, 3]);
        assert_eq!(std::fs::read_to_string(dir.path().join("l.json.bad")).unwrap(), r#"[1, "two", 3]"#);
        // Not a list at all, and not JSON at all: nothing is read, both texts are kept.
        std::fs::write(&path, r#"{"a": 1}"#).unwrap();
        assert!(read_list_guarded::<u32>(&path).unwrap().is_empty());
        std::fs::write(&path, "{ nope").unwrap();
        assert!(read_list_guarded::<u32>(&path).unwrap().is_empty());
        assert_eq!(copies_of(dir.path(), "l.json.bad"), 3);
        assert!(read_list_guarded::<u32>(&dir.path().join("missing.json")).unwrap().is_empty());
    }

    #[test]
    fn write_json_makes_the_folder_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep").join("w.json");
        write_json(&path, &[1, 2]).unwrap();
        assert_eq!(read_list_guarded::<u32>(&path).unwrap(), vec![1, 2]);
    }

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

    fn copies_of(dir: &Path, name: &str) -> usize {
        std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(name)).count()
    }

    #[test]
    fn two_damaged_texts_taking_turns_are_kept_once_each() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        for _ in 0..4 {
            for text in ["{ a", "{ b"] {
                std::fs::write(&path, text).unwrap();
                read_or_keep::<Vec<u32>>(&path);
            }
        }
        assert_eq!(copies_of(dir.path(), "x.json.bad"), 2, "a text that was kept is not copied again");
    }

    #[test]
    fn a_stamped_copy_name_that_is_taken_is_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        let first = stamped_path(&path, 1000);
        std::fs::write(&first, "{ a").unwrap();
        let second = stamped_path(&path, 1000);
        assert_ne!(first, second, "a second text kept in the same millisecond must not overwrite the first");
        std::fs::write(&second, "{ b").unwrap();
        assert_ne!(stamped_path(&path, 1000), second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "{ a");
    }

    #[test]
    fn a_file_that_keeps_changing_while_damaged_keeps_a_bounded_number_of_copies() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        for n in 0..(MAX_BAD_COPIES * 3) {
            std::fs::write(&path, format!("{{ nope {n}")).unwrap();
            read_or_keep::<Vec<u32>>(&path);
            // The newest text is always among the copies.
            assert!(bad_copies(&path).iter().any(|p| std::fs::read_to_string(p).unwrap() == format!("{{ nope {n}")));
        }
        assert_eq!(copies_of(dir.path(), "x.json.bad"), MAX_BAD_COPIES);
    }

    #[test]
    fn a_file_that_is_not_utf8_is_kept_once_whatever_the_number_of_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x9f]).unwrap();
        for _ in 0..5 {
            assert!(read_text_guarded(&path).unwrap().is_none());
        }
        assert_eq!(copies_of(dir.path(), "x.json.bad"), 1);
        assert_eq!(std::fs::read(dir.path().join("x.json.bad")).unwrap(), vec![0xff, 0xfe, 0x00, 0x9f]);
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
