//! Target-safety validation for `request_secret`'s write destination, shared
//! by the blocking request handler (`hooks_server::secret`, refuse before
//! showing the card) and the write-time responder (`methods::secret`,
//! re-check right before the write - the prompt can sit open for up to an
//! hour, during which the repo's ignore rules or even the cwd itself could
//! change underneath it).
//!
//! Also owns the lifetime of `temporary: true` secrets (`TempSecrets`): the
//! list of file+key pairs a chat wrote, swept when the chat closes. The list
//! is mirrored to `temp-secrets[suffix].json` in the data dir (file and key
//! names only, never a value) so a daemon that died with a live temporary
//! secret removes it on its next boot. A temporary write never replaces a key
//! that already sits in the file (`temporary_conflict`), and a sweep re-checks
//! its target (not a symlink, still resolving to the recorded path inside the
//! chat's cwd) before rewriting it.

use crate::daemon::state::DaemonState;
use serde::{Deserialize, Serialize};
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TempSecret {
    pub session_id: String,
    /// The path `resolve_target` produced when the secret was written.
    pub file: PathBuf,
    pub key: String,
    /// The write made the file, or another held secret in it did; it was
    /// absent beforehand.
    pub created_file: bool,
    /// The chat's cwd, so the sweep can re-run `resolve_target` on `file`.
    /// Defaulted so a list written before this field existed still loads: one
    /// unparseable entry would otherwise empty the whole boot sweep.
    #[serde(default)]
    pub cwd: PathBuf,
}

/// Chat-scoped secrets awaiting their chat's close. Once persistence is on
/// (`init_persistence`), every change is mirrored to disk so a crashed daemon's
/// leftovers are swept on the next boot.
#[derive(Default)]
pub(crate) struct TempSecrets {
    inner: std::sync::Mutex<Vec<TempSecret>>,
    persist_path: std::sync::OnceLock<PathBuf>,
}

impl TempSecrets {
    /// Re-recording the same file+key keeps the first entry's `created_file`:
    /// it is the one that knows whether the file predates us. Another chat
    /// asking for the same key becomes a second holder of the one line on
    /// disk, which stays until the last holder closes. A file any held entry
    /// created is treated as created by all of them, so whichever entry is
    /// swept last takes the then-empty file with it.
    pub(crate) fn record(&self, mut entry: TempSecret) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(first) = guard.iter().find(|e| e.file == entry.file && e.key == entry.key) {
            if first.session_id == entry.session_id {
                return;
            }
            entry.created_file = first.created_file;
        }
        if guard.iter().any(|e| e.file == entry.file && e.created_file) {
            entry.created_file = true;
        }
        guard.push(entry);
        self.persist(&guard);
    }

    /// A later permanent write to the same file+key must outlive the chat, so
    /// it takes the line off the cleanup list.
    pub(crate) fn forget(&self, file: &Path, key: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let before = guard.len();
        guard.retain(|e| !(e.file == file && e.key == key));
        if guard.len() != before {
            self.persist(&guard);
        }
    }

    /// Whether any chat holds `key` in `file` as a temporary secret.
    pub(crate) fn holds(&self, file: &Path, key: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.iter().any(|e| e.file == file && e.key == key)
    }

    #[cfg(test)]
    pub(crate) fn live_for(&self, session_id: &str) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.iter().filter(|e| e.session_id == session_id).count()
    }

    /// Remove every temporary secret `session_id` holds. Returns how many were
    /// taken off disk or found already gone; a line another chat still holds
    /// stays and is not counted. Logs file paths and key names, never values.
    pub(crate) fn sweep_session(&self, session_id: &str) -> usize {
        let taken: Vec<TempSecret> = {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let (mine, rest): (Vec<_>, Vec<_>) =
                guard.drain(..).partition(|e| e.session_id == session_id);
            *guard = rest;
            if !mine.is_empty() {
                self.persist(&guard);
            }
            mine
        };
        let mut removed = 0;
        for entry in &taken {
            if self.held_elsewhere(entry) {
                continue;
            }
            removed += 1;
            if let Err(e) = remove_entry(entry) {
                log::warn!(
                    "[secret-relay] could not remove temporary secret {} from {}: {e}",
                    entry.key,
                    entry.file.display()
                );
            }
        }
        removed
    }

    /// Another chat still holds the same line, so this chat's close leaves it.
    fn held_elsewhere(&self, entry: &TempSecret) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.iter().any(|e| e.file == entry.file && e.key == entry.key)
    }

    /// Turn on the on-disk mirror at `path`, after removing whatever a
    /// previous daemon run left listed there. Returns how many leftovers were
    /// swept. Call once, at daemon boot, before any chat can write a secret.
    pub(crate) fn init_persistence(&self, path: &Path) -> usize {
        let leftovers: Vec<TempSecret> = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let mut swept = 0;
        for entry in &leftovers {
            swept += 1;
            if let Err(e) = remove_entry(entry) {
                log::warn!(
                    "[secret-relay] could not remove leftover temporary secret {} from {}: {e}",
                    entry.key,
                    entry.file.display()
                );
            }
        }
        if self.persist_path.set(path.to_path_buf()).is_ok() {
            let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            self.persist(&guard);
        }
        swept
    }

    /// Best-effort: a failed write only costs the crash-leftover sweep, never
    /// the chat's own close-time cleanup, which runs from memory.
    fn persist(&self, entries: &[TempSecret]) {
        let Some(path) = self.persist_path.get() else { return };
        let body = match serde_json::to_string_pretty(entries) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("[secret-relay] could not serialize the temporary-secret list: {e}");
                return;
            }
        };
        if let Err(e) = crate::util::write_json_atomic(path, &body) {
            log::warn!("[secret-relay] could not persist the temporary-secret list: {e}");
        }
    }
}

/// The process-wide list the write path records into and chat close sweeps.
pub(crate) fn temporary_secrets() -> &'static TempSecrets {
    static CELL: std::sync::OnceLock<TempSecrets> = std::sync::OnceLock::new();
    CELL.get_or_init(TempSecrets::default)
}

/// Daemon boot: sweep the previous run's leftover temporary secrets, then
/// mirror the live list to `<app_data>/temp-secrets[suffix].json`.
pub(crate) fn init_persistence(app_data: &Path, instance_suffix: &str) {
    let path = app_data.join(format!("temp-secrets{instance_suffix}.json"));
    let swept = temporary_secrets().init_persistence(&path);
    if swept > 0 {
        log::info!("[secret-relay] swept {swept} temporary secret(s) left by a previous daemon run");
    }
}

/// Why a `temporary` write to `key` in `file` must be refused, or `None` when
/// it may go ahead. A temporary secret is deleted when its chat closes, so
/// letting it replace a value Joe stored permanently would destroy that value.
/// A key a chat already holds as temporary is fine to overwrite.
pub(crate) fn temporary_conflict(file: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    if without_key_line(&text, key).is_none() || temporary_secrets().holds(file, key) {
        return None;
    }
    Some(format!(
        "{key} is already set in {}; a temporary secret is deleted when its chat closes, so it \
         never replaces a stored value. Ask for it without temporary, or use a different key or file",
        file.display()
    ))
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
/// case only the one line is dropped. The path is re-validated first: a chat
/// can swap the recorded file for a symlink (or a directory above it for a
/// junction) between the write and the close, and the rewrite must not follow
/// that to another file holding the same `KEY=` line.
fn remove_entry(entry: &TempSecret) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    match std::fs::symlink_metadata(&entry.file) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(Error::new(ErrorKind::PermissionDenied, "the target is now a symlink, left alone"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    let resolved = resolve_target(&entry.cwd, &entry.file.to_string_lossy())
        .map_err(|e| Error::new(ErrorKind::PermissionDenied, e))?;
    if resolved != entry.file {
        return Err(Error::new(ErrorKind::PermissionDenied, "the target no longer resolves to the recorded path"));
    }
    let text = match std::fs::read_to_string(&entry.file) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
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
        let cwd = file.parent().unwrap().to_path_buf();
        TempSecret { session_id: sid.into(), file: file.to_path_buf(), key: key.into(), created_file, cwd }
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

    /// Two chats sharing one temporary key: the first to close leaves the line
    /// the other still uses, and the last one out removes it, file included
    /// when the first chat's write created it.
    #[test]
    fn a_line_two_chats_hold_goes_when_the_last_one_closes() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-new\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", true));
        reg.record(entry("s2", &file, "API_KEY", false));

        assert_eq!(reg.sweep_session("s1"), 0);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "API_KEY=sk-new\n");

        assert_eq!(reg.sweep_session("s2"), 1);
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

    /// A key already stored in the file is a conflict for a temporary write:
    /// the close would delete Joe's value. A missing file or key is not, and a
    /// key a chat already holds as temporary may be overwritten.
    #[test]
    fn temporary_write_over_an_existing_key_is_a_conflict() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        assert_eq!(temporary_conflict(&file, "API_KEY"), None, "no file yet");
        std::fs::write(&file, "OTHER=1\nAPI_KEY=sk-kept\n").unwrap();
        let reason = temporary_conflict(&file, "API_KEY").expect("an existing key must be refused");
        assert!(reason.contains("API_KEY") && !reason.contains("sk-kept"), "got: {reason}");
        assert_eq!(temporary_conflict(&file, "NEW_KEY"), None, "a key the file lacks is fine");

        temporary_secrets().record(entry("conflict-held-chat", &file, "API_KEY", false));
        assert_eq!(temporary_conflict(&file, "API_KEY"), None, "a held temporary key may be rewritten");
        temporary_secrets().forget(&file, "API_KEY");
    }

    /// A file swapped for a symlink to another file that holds the same key
    /// must not have that other file rewritten by the close.
    #[test]
    fn sweep_refuses_a_target_swapped_for_a_symlink() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        let victim = root.join("victim.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        std::fs::write(&victim, "API_KEY=precious\nOTHER=1\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "API_KEY", false));
        std::fs::remove_file(&file).unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&victim, &file);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&victim, &file);
        if made.is_err() {
            eprintln!("skipping: symlink creation not permitted here");
            return;
        }

        reg.sweep_session("s1");

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "API_KEY=precious\nOTHER=1\n");
    }

    /// The same swap one level up: the recorded file's directory becomes a
    /// junction to another directory inside cwd. `mklink /J` needs no
    /// privilege, so this runs on every Windows machine.
    #[cfg(windows)]
    #[test]
    fn sweep_refuses_a_target_whose_directory_became_a_junction() {
        let (_tmp, root) = fixture();
        let sub = root.join("sub");
        let other = root.join("other");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let file = sub.join("secrets.env");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        std::fs::write(other.join("secrets.env"), "API_KEY=precious\nOTHER=1\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(TempSecret { cwd: root.clone(), ..entry("s1", &file, "API_KEY", false) });
        std::fs::rename(&sub, root.join("sub-old")).unwrap();
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("mklink").arg("/J").arg(&sub).arg(&other);
        crate::util::process::hide_console(&mut cmd);
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));

        reg.sweep_session("s1");

        assert_eq!(
            std::fs::read_to_string(other.join("secrets.env")).unwrap(),
            "API_KEY=precious\nOTHER=1\n"
        );
    }

    /// A daemon that died holding a temporary secret removes it on the next
    /// boot, and the persisted list carries file and key names, never a value.
    #[test]
    fn boot_sweeps_the_previous_runs_leftover_temporary_secrets() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        let list = root.join("temp-secrets.json");
        std::fs::write(&file, "OTHER=1\nAPI_KEY=sk-leaked\n").unwrap();
        let before_crash = TempSecrets::default();
        assert_eq!(before_crash.init_persistence(&list), 0);
        before_crash.record(entry("s1", &file, "API_KEY", false));
        let persisted = std::fs::read_to_string(&list).unwrap();
        assert!(persisted.contains("API_KEY") && !persisted.contains("sk-leaked"), "got: {persisted}");

        let after_restart = TempSecrets::default();
        assert_eq!(after_restart.init_persistence(&list), 1);

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "OTHER=1\n");
        assert_eq!(std::fs::read_to_string(&list).unwrap().trim(), "[]", "the swept list is emptied");
    }

    /// A list written before `cwd` existed still loads: its entry is refused by
    /// the re-validation (no cwd to resolve against) instead of the parse
    /// failure silently dropping every entry from the boot sweep.
    #[test]
    fn boot_loads_a_persisted_list_from_before_the_cwd_field() {
        let (_tmp, root) = fixture();
        let old_file = root.join("old.env");
        let new_file = root.join("new.env");
        let list = root.join("temp-secrets.json");
        std::fs::write(&old_file, "API_KEY=sk-old
").unwrap();
        std::fs::write(&new_file, "API_KEY=sk-new
OTHER=1
").unwrap();
        let body = serde_json::json!([
            { "session_id": "s-old", "file": old_file, "key": "API_KEY", "created_file": false },
            { "session_id": "s-new", "file": new_file, "key": "API_KEY", "created_file": false, "cwd": root },
        ]);
        std::fs::write(&list, body.to_string()).unwrap();

        let reg = TempSecrets::default();
        assert_eq!(reg.init_persistence(&list), 2, "both entries must load, not none");

        assert_eq!(std::fs::read_to_string(&new_file).unwrap(), "OTHER=1
");
        assert_eq!(
            std::fs::read_to_string(&old_file).unwrap(),
            "API_KEY=sk-old
",
            "an entry with no cwd cannot be re-validated, so it is left alone"
        );
    }

    /// A normal close takes the entry off the persisted list too, so the next
    /// boot has nothing to sweep.
    #[test]
    fn a_closed_chat_leaves_nothing_on_the_persisted_list() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        let list = root.join("temp-secrets.json");
        std::fs::write(&file, "API_KEY=sk-abc\n").unwrap();
        let reg = TempSecrets::default();
        reg.init_persistence(&list);
        reg.record(entry("s1", &file, "API_KEY", true));

        reg.sweep_session("s1");

        assert_eq!(std::fs::read_to_string(&list).unwrap().trim(), "[]");
    }

    /// Saving A then B as temporary into a file neither chat found leaves no
    /// empty file behind, whichever order the entries are swept in.
    #[test]
    fn a_file_left_empty_after_two_temporary_keys_is_removed() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "A=1\nB=2\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "A", true));
        reg.record(entry("s1", &file, "B", false));

        reg.sweep_session("s1");

        assert!(!file.exists(), "an empty leftover file must not stay behind");
    }

    /// The same, when the two keys belong to different chats.
    #[test]
    fn a_file_two_chats_filled_is_removed_when_the_last_closes() {
        let (_tmp, root) = fixture();
        let file = root.join("secrets.env");
        std::fs::write(&file, "A=1\nB=2\n").unwrap();
        let reg = TempSecrets::default();
        reg.record(entry("s1", &file, "A", true));
        reg.record(entry("s2", &file, "B", false));

        reg.sweep_session("s1");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "B=2\n");
        reg.sweep_session("s2");

        assert!(!file.exists());
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
        // Canonical, because a sweep compares the recorded path with what
        // `resolve_target` returns, and that is always canonical.
        let root = std::fs::canonicalize(&root).unwrap();
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
