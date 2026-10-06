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

/// The three ways the shared canonicalize-then-prefix-check core can fail,
/// carrying the raw `io::Error` so each caller can word its own message -
/// `confine` and `confine_absolute` report the same failures in different
/// phrasing, and only the check itself (not the wording) is load-bearing to
/// share.
#[derive(Debug)]
pub(crate) enum ConfineErr {
    /// `root` itself failed to canonicalize (missing, no access, ...).
    Root(std::io::Error),
    /// The target failed to canonicalize (missing, no access, ...).
    Target(std::io::Error),
    /// Both canonicalized, but the target's canonical form is not under
    /// the root's: `..`, an absolute escape, or a symlink/junction resolving
    /// out.
    Outside,
}

/// Canonicalizes `root` and `target`, then rejects anything whose canonical
/// form falls outside the canonical `root` - `..` segments, an absolute
/// escape, or a symlink/junction resolving out. Both must already exist on
/// disk - `canonicalize` requires it. Shared by `confine` (which joins a
/// root-relative path first) and `confine_absolute` (whose caller already
/// holds an absolute target).
fn canonicalize_confined(root: &Path, target: &Path) -> Result<PathBuf, ConfineErr> {
    let root = root.canonicalize().map_err(ConfineErr::Root)?;
    let resolved = target.canonicalize().map_err(ConfineErr::Target)?;
    if !resolved.starts_with(&root) {
        return Err(ConfineErr::Outside);
    }
    Ok(resolved)
}

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
    let joined = root.join(rel);
    canonicalize_confined(root, &joined).map_err(|e| match e {
        ConfineErr::Root(e) => format!("root {}: {e}", root.display()),
        ConfineErr::Target(e) => format!("{rel}: {e}"),
        ConfineErr::Outside => format!("{rel}: {OUTSIDE_ROOT}"),
    })
}

/// Same confinement check as `confine`, for a caller holding an
/// already-ABSOLUTE `target` that should live under `root`, rather than a
/// root-relative path to join (`read_attachment_impl`'s stored attachment
/// paths are absolute, so there is no `rel` to join). `target` must already
/// exist on disk, same as `confine`. Returns `ConfineErr` instead of a
/// pre-worded `String` so the caller keeps its own error phrasing.
pub(crate) fn confine_absolute(root: &Path, target: &Path) -> Result<PathBuf, ConfineErr> {
    canonicalize_confined(root, target)
}

#[cfg(test)]
mod tests {
    use super::{confine, confine_absolute, ConfineErr};
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

    /// An absolute target outside the root is rejected the same way a
    /// root-relative escape is - the shape `read_attachment_impl` holds (an
    /// absolute stored attachment path), not a `rel` to join.
    #[test]
    fn confine_absolute_rejects_a_target_outside_root() {
        let (_tmp, root) = fixture();
        let outside = root.parent().unwrap().join("outside").join("outside.txt");
        let err = confine_absolute(&root, &outside).unwrap_err();
        assert!(matches!(err, ConfineErr::Outside));
    }

    #[test]
    fn confine_absolute_accepts_a_target_inside_root() {
        let (_tmp, root) = fixture();
        let inside = root.join("inside.txt");
        let resolved = confine_absolute(&root, &inside).unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap().join("inside.txt"));
    }

    /// A junction inside the root pointing out of it, reached through an
    /// absolute target - same escape `a_junction_out_of_root_is_rejected`
    /// covers for `confine`, reached through `confine_absolute`'s path
    /// instead. Skips rather than fails if junction creation needs
    /// privileges this machine/account doesn't have.
    #[cfg(windows)]
    #[test]
    fn confine_absolute_rejects_a_junction_out_of_root() {
        let (_tmp, root) = fixture();
        let outside = root.parent().unwrap().join("outside");
        let link = root.join("escape_link_abs");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            eprintln!("skipping: junction/symlink_dir creation not permitted here");
            return;
        }
        let target = link.join("outside.txt");
        let err = confine_absolute(&root, &target).unwrap_err();
        assert!(matches!(err, ConfineErr::Outside));
    }
}
