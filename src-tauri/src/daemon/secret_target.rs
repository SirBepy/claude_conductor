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

/// One `temporary: true` secret that was written to disk for a chat. Holds
/// where the value went, never the value itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TempSecret {
    pub session_id: String,
    pub file: PathBuf,
    pub key: String,
    /// The write made the file; it was absent beforehand.
    pub created_file: bool,
}

/// Chat-scoped secrets awaiting their chat's close. In memory only: a daemon
/// crash leaves the line on disk, which is what a non-temporary secret does
/// anyway, so this adds a cleanup on the happy path and no new exposure.
#[derive(Default)]
pub(crate) struct TempSecrets {
    inner: std::sync::Mutex<Vec<TempSecret>>,
}

impl TempSecrets {
    /// Re-recording the same file+key keeps the first entry: its
    /// `created_file` is the one that knows whether the file predates us.
    pub(crate) fn record(&self, entry: TempSecret) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if guard.iter().any(|e| e.file == entry.file && e.key == entry.key) {
            return;
        }
        guard.push(entry);
    }

    /// A later permanent write to the same file+key must outlive the chat, so
    /// it takes the line off the cleanup list.
    pub(crate) fn forget(&self, file: &Path, key: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|e| !(e.file == file && e.key == key));
    }

    #[cfg(test)]
    pub(crate) fn live_for(&self, session_id: &str) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.iter().filter(|e| e.session_id == session_id).count()
    }

    /// Remove every temporary secret `session_id` holds. Returns how many were
    /// taken off disk or found already gone. Logs file paths and key names,
    /// never values.
    pub(crate) fn sweep_session(&self, session_id: &str) -> usize {
        let taken: Vec<TempSecret> = {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let (mine, rest): (Vec<_>, Vec<_>) =
                guard.drain(..).partition(|e| e.session_id == session_id);
            *guard = rest;
            mine
        };
        for entry in &taken {
            if let Err(e) = remove_entry(entry) {
                log::warn!(
                    "[secret-relay] could not remove temporary secret {} from {}: {e}",
                    entry.key,
                    entry.file.display()
                );
            }
        }
        taken.len()
    }
}

/// The process-wide list the write path records into and chat close sweeps.
pub(crate) fn temporary_secrets() -> &'static TempSecrets {
    static CELL: std::sync::OnceLock<TempSecrets> = std::sync::OnceLock::new();
    CELL.get_or_init(TempSecrets::default)
}

/// `text` without the line that sets `key`, or `None` when no line does. Keys
/// match the way `api_keys::rewrite_env` finds a line to overwrite, and every
/// other line keeps its own line ending.
fn without_key_line(text: &str, key: &str) -> Option<String> {
    let mut found = false;
    let kept: Vec<&str> = text
        .split_inclusive('\n')
        .filter(|raw| {
            let line = raw.trim_end_matches(['\r', '\n']);
            let is_key = line.trim().split_once('=').map(|(k, _)| k.trim()) == Some(key);
            if is_key {
                found = true;
            }
            !is_key
        })
        .collect();
    if !found {
        return None;
    }
    Some(kept.concat())
}

/// Take one secret's line out of its file. A file this secret created goes
/// with it, unless a permanent secret has since been added beside it, in which
/// case only the one line is dropped.
fn remove_entry(entry: &TempSecret) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(&entry.file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let Some(remaining) = without_key_line(&text, &entry.key) else {
        return Ok(());
    };
    if entry.created_file && remaining.trim().is_empty() {
        return std::fs::remove_file(&entry.file);
    }
    std::fs::write(&entry.file, remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sid: &str, file: &Path, key: &str, created_file: bool) -> TempSecret {
        TempSecret { session_id: sid.into(), file: file.to_path_buf(), key: key.into(), created_file }
    }

    /// The chat closing takes the temporary key out and leaves its siblings.
    #[test]
    fn sweep_removes_the_temporary_key_line_and_keeps_the_rest() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "# header\nOTHER=1\nAPI_KEY=sk-abc\nLAST=2\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", false));

        assert_eq!(reg.sweep_session("s1"), 1);

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# header\nOTHER=1\nLAST=2\n");
        assert_eq!(reg.live_for("s1"), 0);
    }

    /// A file the secret itself created is deleted, not left empty.
    #[test]
    fn sweep_deletes_a_file_the_secret_created() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", true));

        reg.sweep_session("s1");

        assert!(!file.exists());
    }

    /// A permanent secret appended to a created file after the fact must not
    /// be deleted along with it.
    #[test]
    fn sweep_keeps_a_created_file_that_gained_other_keys() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\nKEEP=1\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", true));

        reg.sweep_session("s1");

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "KEEP=1\n");
    }

    /// A secret that was never recorded as temporary survives any chat's close.
    #[test]
    fn permanent_secret_survives_a_sweep() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        let reg = TempSecrets::default();

        assert_eq!(reg.sweep_session("s1"), 0);

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "API_KEY=sk-abc\n");
    }

    /// One chat's close leaves another chat's temporary secret in place.
    #[test]
    fn sweep_only_touches_the_closing_chats_secrets() {
        let (_tmp, root) = fixture();
        let a = root.join("a.env");
        let b = root.join("b.env");
        std::fs::write(&a, "KEY=1\n").unwrap();
        std::fs::write(&b, "KEY=2\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &a, "KEY", true));
        reg.record(entry("s2", &b, "KEY", true));

        reg.sweep_session("s1");

        assert!(!a.exists());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "KEY=2\n");
        assert_eq!(reg.live_for("s2"), 1);
    }

    /// Re-saving the same key as permanent drops it from the cleanup list.
    #[test]
    fn forget_takes_a_secret_off_the_cleanup_list() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", true));
        reg.forget(&file, "API_KEY");

        reg.sweep_session("s1");

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "API_KEY=sk-abc\n");
    }

    /// A second request for the same file+key must not overwrite the first
    /// entry's `created_file`, or the file would outlive the chat.
    #[test]
    fn re_recording_keeps_the_first_created_flag() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", true));
        reg.record(entry("s1", &file, "API_KEY", false));

        assert_eq!(reg.live_for("s1"), 1);
        reg.sweep_session("s1");
        assert!(!file.exists());
    }

    /// A file already deleted by hand is not an error and does not stall the
    /// rest of the sweep.
    #[test]
    fn sweep_tolerates_a_file_that_is_already_gone() {
        let (_tmp, root) = fixture();
        let gone = root.join("gone.env");
        let present = root.join("present.env");
        std::fs::write(&present, "KEY=1\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &gone, "KEY", true));
        reg.record(entry("s1", &present, "KEY", true));

        assert_eq!(reg.sweep_session("s1"), 2);

        assert!(!present.exists());
    }

    #[test]
    fn without_key_line_keeps_crlf_and_reports_a_missing_key() {
        assert_eq!(without_key_line("A=1\r\nB=2\r\nC=3\r\n", "B").as_deref(), Some("A=1\r\nC=3\r\n"));
        assert_eq!(without_key_line("A=1\n", "B"), None);
        assert_eq!(without_key_line("A=1\nB=2", "B").as_deref(), Some("A=1\n"));
        assert_eq!(without_key_line("# B=1\nA=1\n", "B"), None, "a commented-out key is not the key");
    }

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
