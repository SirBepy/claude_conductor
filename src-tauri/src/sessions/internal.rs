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
        Ok(data_dir) => crate::util::same_dir(cwd, &data_dir),
        Err(_) => false,
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
    fn a_trailing_separator_still_reads_as_the_data_dir() {
        let mut trailing = crate::settings::paths::data_dir().expect("data dir").into_os_string();
        trailing.push(std::path::MAIN_SEPARATOR.to_string());
        assert!(is_internal_sidecar_cwd(Path::new(&trailing)));
    }
}
