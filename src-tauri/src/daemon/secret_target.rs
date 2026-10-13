//! Target-safety validation for `request_secret`'s write destination, shared
//! by the blocking request handler (`hooks_server::secret`, refuse before
//! showing the card) and the write-time responder (`methods::secret`,
//! re-check right before the write - the prompt can sit open for up to an
//! hour, during which the repo's ignore rules or even the cwd itself could
//! change underneath it).

use crate::daemon::state::DaemonState;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `key` must look like an env-file variable name: `^[A-Za-z_][A-Za-z0-9_.-]*$`.
/// Hand-rolled instead of pulling in the `regex` crate for one check (no
/// other daemon module depends on it).
pub(crate) fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Resolve `file` (relative or absolute) against `cwd` and require it to stay
/// inside `cwd`. Modeled on `mcp::server::waiting_target::safe_local_path`,
/// but a secret's target file often does NOT exist yet (first write), so
/// `std::fs::canonicalize` can't run on the whole path the way that helper
/// does. Instead this canonicalizes only the deepest EXISTING ancestor - the
/// only part a symlink escape could hide in - and re-appends the
/// not-yet-existing tail components lexically; a path component that can't
/// exist on disk yet can't be a symlink either.
///
/// "Existing" means present as a directory entry (`symlink_metadata`), not
/// `Path::exists`, which follows links and reports a dangling symlink or
/// junction as absent. That dangling link then lands on the canonicalize
/// step, which fails on it, so it is refused instead of being re-appended
/// lexically and followed out of cwd by the later write.
pub(crate) fn resolve_target(cwd: &Path, file: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(file);
    // Reject `..` lexically too: a component that doesn't exist on disk yet
    // would otherwise sail past the canonicalize-based containment check
    // below (canonicalize only resolves components that exist).
    if candidate.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("file must not contain '..'".to_string());
    }
    let joined = if candidate.is_absolute() { candidate } else { cwd.join(&candidate) };

    let mut existing = joined.clone();
    let mut remainder: Vec<std::ffi::OsString> = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        let name = existing.file_name().map(|n| n.to_os_string());
        let Some(parent) = existing.parent().map(Path::to_path_buf) else {
            return Err("file path has no existing ancestor".to_string());
        };
        if let Some(name) = name {
            remainder.push(name);
        }
        existing = parent;
    }
    let canon_existing = std::fs::canonicalize(&existing)
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    let canon_cwd = std::fs::canonicalize(cwd)
        .map_err(|e| format!("cannot resolve session cwd: {e}"))?;
    if !canon_existing.starts_with(&canon_cwd) {
        return Err("file must be inside the session's working directory".to_string());
    }
    remainder.reverse();
    let mut result = canon_existing;
    for part in remainder {
        result.push(part);
    }
    Ok(result)
}

/// Blocking git spawn, console hidden on Windows (same pattern as
/// `ipc::git::run_git`, not reused directly since `ipc` is off limits here).
/// `(success, trimmed stdout)`, or `None` if git itself could not be run at all.
fn run_git(cwd: &Path, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    crate::util::process::hide_console(&mut cmd);
    let output = cmd.output().ok()?;
    Some((output.status.success(), String::from_utf8_lossy(&output.stdout).trim().to_string()))
}

fn is_git_worktree(cwd: &Path) -> bool {
    run_git(cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|(ok, out)| ok && out == "true")
        .unwrap_or(false)
}

fn is_gitignored(cwd: &Path, target: &Path) -> bool {
    run_git(cwd, &["check-ignore", "-q", &target.to_string_lossy()])
        .map(|(ok, _)| ok)
        .unwrap_or(false)
}

/// A session cwd not inside any git work tree skips the ignore check
/// entirely (decision: "not a git repo: no ignore check").
fn validate_gitignore(cwd: &Path, target: &Path) -> Result<(), String> {
    if !is_git_worktree(cwd) {
        return Ok(());
    }
    if is_gitignored(cwd, target) {
        Ok(())
    } else {
        Err(
            "target file must be gitignored - a secret is never written into a tracked or committable file"
                .to_string(),
        )
    }
}

/// Full target-safety check: key shape, containment inside the session's own
/// cwd, and (in a git repo) gitignore status. Spawns git on a blocking thread
/// so it never stalls the async executor. `file` may be relative (resolved
/// against the session's cwd) or absolute (still must resolve inside it).
/// Called both at request time (refuse before showing the card) and again
/// right before the write (`methods::secret::respond_secret_inner`).
pub(crate) async fn validate(
    state: &Arc<DaemonState>,
    session_id: Option<&str>,
    file: &str,
    key: &str,
) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err(format!("{key:?} is not a valid key name"));
    }
    let Some(sid) = session_id else {
        return Err("session_id is required".to_string());
    };
    let Some(instance) = state.registry.get(sid) else {
        return Err("unknown session".to_string());
    };
    let cwd = instance.cwd.clone();
    let file_owned = file.to_string();
    let resolved = tokio::task::spawn_blocking(move || resolve_target(&cwd, &file_owned))
        .await
        .map_err(|e| format!("target validation panicked: {e}"))??;

    let cwd2 = instance.cwd.clone();
    let resolved2 = resolved.clone();
    tokio::task::spawn_blocking(move || validate_gitignore(&cwd2, &resolved2))
        .await
        .map_err(|e| format!("git check panicked: {e}"))??;

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_key_accepts_env_style_names() {
        assert!(valid_key("API_KEY"));
        assert!(valid_key("_private"));
        assert!(valid_key("a.b-c9"));
    }

    #[test]
    fn valid_key_rejects_bad_shapes() {
        assert!(!valid_key(""));
        assert!(!valid_key("9START"));
        assert!(!valid_key("has space"));
        assert!(!valid_key("has/slash"));
        assert!(!valid_key("has=equals"));
    }

    /// A root dir to resolve `file` against, mirroring a session's cwd.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&root).unwrap();
        (tmp, root)
    }

    #[test]
    fn relative_path_inside_cwd_resolves() {
        let (_tmp, root) = fixture();
        let resolved = resolve_target(&root, "secrets.env").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&root).unwrap().join("secrets.env"));
    }

    #[test]
    fn nested_relative_path_with_missing_parent_dirs_still_resolves() {
        let (_tmp, root) = fixture();
        let resolved = resolve_target(&root, "nested/dir/secrets.env").unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(&root).unwrap().join("nested").join("dir").join("secrets.env")
        );
    }

    #[test]
    fn dot_dot_escape_is_rejected() {
        let (_tmp, root) = fixture();
        assert!(resolve_target(&root, "../outside.env").is_err());
        assert!(resolve_target(&root, "nested/../../outside.env").is_err());
    }

    #[test]
    fn absolute_path_outside_cwd_is_rejected() {
        let (tmp, root) = fixture();
        let outside = tmp.path().join("elsewhere").join("secrets.env");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        assert!(resolve_target(&root, outside.to_str().unwrap()).is_err());
    }

    #[test]
    fn absolute_path_inside_cwd_resolves() {
        let (_tmp, root) = fixture();
        let inside = root.join("secrets.env");
        let resolved = resolve_target(&root, inside.to_str().unwrap()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&root).unwrap().join("secrets.env"));
    }

    /// A junction inside cwd pointing at a directory outside it that does not
    /// exist yet. `Path::exists` follows the junction and reports false, so a
    /// walk keyed on it would treat `link` as "not created yet" and re-append
    /// it lexically, while the later write follows it out of cwd. `mklink /J`
    /// needs no symlink privilege and accepts a missing target, so this runs
    /// on every Windows machine rather than skipping.
    #[cfg(windows)]
    #[test]
    fn dangling_junction_out_of_cwd_is_rejected() {
        let (tmp, root) = fixture();
        let outside = tmp.path().join("elsewhere").join("not-yet");
        let link = root.join("link");
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("mklink").arg("/J").arg(&link).arg(&outside);
        crate::util::process::hide_console(&mut cmd);
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
        assert!(!link.exists(), "fixture must be dangling");
        assert!(resolve_target(&root, "link/secrets.env").is_err());
        assert!(resolve_target(&root, "link").is_err());
    }

    /// Same escape through a dangling file symlink as the target itself.
    /// Symlink creation needs Developer Mode or admin on Windows, so this one
    /// skips rather than fails where it is not permitted.
    #[test]
    fn dangling_symlink_target_is_rejected() {
        let (tmp, root) = fixture();
        let outside = tmp.path().join("outside.env");
        let link = root.join("x.env");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link);
        if made.is_err() {
            eprintln!("skipping: symlink creation not permitted here");
            return;
        }
        assert!(resolve_target(&root, "x.env").is_err());
    }

    fn git_fixture() -> (tempfile::TempDir, PathBuf) {
        let (tmp, root) = fixture();
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&root).args(["init", "-q"]);
        crate::util::process::hide_console(&mut cmd);
        assert!(cmd.status().unwrap().success(), "git init must succeed in the test fixture");
        (tmp, root)
    }

    #[test]
    fn non_git_cwd_skips_the_ignore_check() {
        let (_tmp, root) = fixture();
        let target = root.join("secrets.env");
        assert!(validate_gitignore(&root, &target).is_ok());
    }

    #[test]
    fn tracked_not_ignored_file_in_a_git_repo_is_refused() {
        let (_tmp, root) = git_fixture();
        let target = root.join("secrets.env");
        assert!(validate_gitignore(&root, &target).is_err());
    }

    #[test]
    fn gitignored_file_in_a_git_repo_is_accepted() {
        let (_tmp, root) = git_fixture();
        std::fs::write(root.join(".gitignore"), "secrets.env\n").unwrap();
        let target = root.join("secrets.env");
        assert!(validate_gitignore(&root, &target).is_ok());
    }
}
