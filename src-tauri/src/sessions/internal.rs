//! Tells a daemon-internal `claude` sidecar (Ask, news summaries) apart from a
//! chat the developer is meant to see. Both run in the app-data ROOT so a stray
//! `CLAUDE.md` can't be read as instructions, and the global SessionStart hook
//! fires for them like any other session.
//!
//! The cwd is the filter rather than a pre-registered session id because
//! `claude` owns the id: `--resume` may continue under a different one, and the
//! hook fires before the sidecar's stdout reveals which it chose.

use std::path::Path;

/// True when `cwd` is the app-data root ITSELF. Sub-directories under it
/// (`jarvis-home`) host real chats and must stay visible.
pub fn is_internal_sidecar_cwd(cwd: &Path) -> bool {
    match crate::settings::paths::data_dir() {
        Ok(data_dir) => same_dir(cwd, &data_dir),
        Err(_) => false,
    }
}

/// `canonicalize` is the reliable comparison but fails on a path that no longer
/// exists, so a normalized string compare backs it up.
fn same_dir(a: &Path, b: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        return a == b;
    }
    norm(a) == norm(b)
}

/// The hook reports whatever casing and separator the spawner used. Only
/// Windows gets the case fold and the `\` rewrite - elsewhere a backslash is a
/// legal filename character.
fn norm(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/").trim_end_matches('/').to_lowercase()
    } else {
        s.trim_end_matches('/').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_data_dir_itself_is_internal() {
        let dir = crate::settings::paths::data_dir().expect("data dir");
        assert!(is_internal_sidecar_cwd(&dir));
    }

    #[test]
    fn a_subdirectory_of_the_data_dir_is_not_internal() {
        // jarvis-home lives under app-data and hosts a real, visible chat.
        let dir = crate::settings::paths::data_dir().expect("data dir").join("jarvis-home");
        assert!(!is_internal_sidecar_cwd(&dir));
    }

    #[test]
    fn a_project_checkout_is_not_internal() {
        assert!(!is_internal_sidecar_cwd(&PathBuf::from("C:/Users/x/Desktop/Projects/app")));
    }

    #[test]
    fn same_dir_ignores_a_trailing_separator() {
        assert!(same_dir(&PathBuf::from("/a/b/"), &PathBuf::from("/a/b")));
    }

    #[cfg(windows)]
    #[test]
    fn same_dir_ignores_windows_casing_and_separator_style() {
        assert!(same_dir(
            &PathBuf::from(r"C:\Users\X\AppData\Roaming\claude-conductor"),
            &PathBuf::from("c:/users/x/appdata/roaming/claude-conductor"),
        ));
    }

    #[test]
    fn same_dir_still_separates_siblings() {
        assert!(!same_dir(&PathBuf::from("/a/b"), &PathBuf::from("/a/c")));
    }
}
