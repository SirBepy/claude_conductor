//! Shared "must stay inside this root" path confinement check.
//! Several call sites join a root directory with a caller-supplied relative
//! path and must refuse anything that resolves outside the root - several of
//! them reachable from the phone or a paired machine over remote transport,
//! so getting `..`/symlink handling right once here matters more than in a
//! log-only helper.

use std::path::{Path, PathBuf};

/// Suffix of `confine`'s escape error, so a caller can reword that case while
/// passing a missing-file error through unchanged.
pub(crate) const OUTSIDE_ROOT: &str = "outside the confinement root";

/// Joins `root` and `rel`, then rejects anything whose canonical form falls
/// outside the canonical `root`: `..` segments, a symlink/junction resolving
/// out, or `rel` itself being absolute (`Path::join` with an absolute second
/// argument discards `root` entirely, so canonicalizing the join and checking
/// the prefix is what actually catches that case, not the join itself).
///
/// Both `root` and the joined path must already exist on disk -
/// `canonicalize` requires it. A target that is about to be CREATED (not yet
/// on disk) cannot use this helper; seek the per-site check instead, as
/// `create_project.rs` does when it allocates a brand new directory.
pub(crate) fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("root {}: {e}", root.display()))?;
    let joined = root.join(rel);
    let resolved = joined
        .canonicalize()
        .map_err(|e| format!("{rel}: {e}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!("{rel}: {OUTSIDE_ROOT}"));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::confine;
    use std::fs;

    /// A root dir with `inside.txt`, plus a sibling dir OUTSIDE the root
    /// holding `outside.txt` - mirrors `waiting_target.rs`'s own fixture.
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("inside.txt"), b"hello").unwrap();
        fs::write(outside.join("outside.txt"), b"nope").unwrap();
        (tmp, root)
    }

    #[test]
    fn a_plain_relative_path_inside_root_resolves() {
        let (_tmp, root) = fixture();
        let resolved = confine(&root, "inside.txt").unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap().join("inside.txt"));
    }

    #[test]
    fn dot_dot_traversal_out_of_root_is_rejected() {
        let (_tmp, root) = fixture();
        let err = confine(&root, "../outside/outside.txt").unwrap_err();
        assert!(err.contains("outside the confinement root"), "{err}");
    }

    #[test]
    fn an_absolute_path_outside_root_is_rejected() {
        let (_tmp, root) = fixture();
        let outside = root.parent().unwrap().join("outside").join("outside.txt");
        let abs = outside.to_str().unwrap();
        let err = confine(&root, abs).unwrap_err();
        assert!(err.contains("outside the confinement root"), "{err}");
    }

    #[test]
    fn a_missing_path_is_rejected_not_silently_treated_as_outside() {
        let (_tmp, root) = fixture();
        let err = confine(&root, "never-written.txt").unwrap_err();
        assert!(!err.contains("outside the confinement root"), "{err}");
    }

    /// A junction pointing from inside the root to a directory outside it:
    /// `fs::canonicalize` resolves junctions (unlike a bare string compare),
    /// which is the whole reason `confine` canonicalizes before checking the
    /// prefix rather than after. Skips rather than fails if junction creation
    /// needs privileges this machine/account doesn't have.
    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_root_is_rejected() {
        let (_tmp, root) = fixture();
        let outside = root.parent().unwrap().join("outside");
        let link = root.join("escape_link");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            eprintln!("skipping: junction/symlink_dir creation not permitted here");
            return;
        }
        let err = confine(&root, "escape_link/outside.txt").unwrap_err();
        assert!(err.contains("outside the confinement root"), "{err}");
    }
}
