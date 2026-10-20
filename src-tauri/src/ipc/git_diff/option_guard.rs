//! Refusing option-looking revisions and paths before they reach `git`.

/// Refuses a revision/pathspec that git would read as an option. `git diff`
/// accepts `--output=<file>`, so an unchecked `to` is an arbitrary-file-write
/// primitive for anything that can reach these commands - and `get_range_files`
/// / `get_file_diff` are both phone-reachable (`remote_transport_table.rs`).
/// A real revision or path never starts with `-`.
pub(in crate::ipc) fn reject_option_like(label: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("invalid {label}: must not start with '-'"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::reject_option_like;

    #[test]
    fn plain_revisions_and_paths_pass() {
        for v in ["HEAD", "main", "abc1234", "src/main.rs", "a b/c.txt", ""] {
            assert!(reject_option_like("to", v).is_ok(), "rejected {v:?}");
        }
    }

    #[test]
    fn a_leading_dash_is_refused() {
        // `git diff --output=<file>` writes the diff wherever it is pointed, so
        // this is the difference between a read and an arbitrary file write.
        for v in ["--output=C:/Users/x/startup.bat", "-o", "--no-index", "-"] {
            assert!(reject_option_like("to", v).is_err(), "accepted {v:?}");
        }
    }

    #[test]
    fn the_error_names_which_argument_was_bad() {
        let err = reject_option_like("from", "--output=x").unwrap_err();
        assert!(err.contains("from"), "{err}");
    }
}
