//! A worktree sub's private cargo build folder, `sub-<id>/target` beside its
//! tree (`worktree::write_build_config`). Each one recompiles the project's whole
//! dependency tree, 5 to 17GB, and the folder lives as long as the sub's folder:
//! a finished sub keeps its tree until its main chat closes (21 of them held
//! 130GB on 2026-11-15). Two ways it is freed before then:
//!
//! - [`free`] when a sub finishes and its commits landed, called by
//!   `worktree::defer`;
//! - [`sweep_idle`] at daemon start, for subs the registry says are finished.
//!
//! Only the folder the daemon's own config names is ever deleted: the path is
//! built from a holder that `worktree::holder_of` checked sits under the repo's
//! `.claude/worktrees`, never from anything a chat sent, and a holder without the
//! daemon's `.cargo/config.toml` is left alone (a tree from before holders had one
//! keeps its project's own `target`).

use super::worktree::{is_link, unlink_reparse_points};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TARGET: &str = "target";

/// How deep below the build folder a folder's mtime is read (`target/debug/deps`).
const MTIME_DEPTH: usize = 3;

/// The holder's build folder, if the daemon made this holder and the folder is a
/// real directory (a link is never followed).
fn own_target(holder: &Path) -> Option<PathBuf> {
    if !holder.join(".cargo").join("config.toml").is_file() {
        return None;
    }
    let target = holder.join(TARGET);
    let meta = std::fs::symlink_metadata(&target).ok()?;
    (meta.is_dir() && !is_link(&meta)).then_some(target)
}

/// Bytes of the files under `dir`, links not followed.
pub(super) fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if is_link(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// Deletes the holder's build folder and returns the bytes it held, `0` when it
/// has none. The tree and the build config stay, so a sub that is continued
/// builds again into the same place.
pub(super) fn free(holder: &Path) -> Result<u64, String> {
    let Some(target) = own_target(holder) else { return Ok(0) };
    unlink_reparse_points(&target)?;
    let bytes = dir_size(&target);
    std::fs::remove_dir_all(&target).map_err(|e| format!("its build folder {} could not be deleted: {e}", target.display()))?;
    Ok(bytes)
}

/// Whether nothing was added to or removed from the build folder's first three
/// levels for `idle_for` before `now`. A build creates files in `deps`,
/// `.fingerprint` and `build`, which moves those folders' mtimes; a clock that
/// cannot be compared counts as not idle.
fn quiet_for(target: &Path, now: SystemTime, idle_for: Duration) -> bool {
    let mut newest: Option<SystemTime> = None;
    let mut stack = vec![(target.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(modified) = std::fs::metadata(&dir).and_then(|m| m.modified()) else { return false };
        newest = Some(newest.map_or(modified, |n| n.max(modified)));
        if depth >= MTIME_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() && !is_link(&meta) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    newest.and_then(|n| now.duration_since(n).ok()).is_some_and(|quiet| quiet >= idle_for)
}

#[derive(Debug, Default, PartialEq)]
pub struct Swept {
    /// Bytes in every build folder found, before anything was deleted.
    pub total: u64,
    /// Bytes deleted.
    pub freed: u64,
    pub freed_subs: usize,
    pub kept_subs: usize,
}

impl Swept {
    pub(super) fn add(&mut self, other: Swept) {
        self.total += other.total;
        self.freed += other.freed;
        self.freed_subs += other.freed_subs;
        self.kept_subs += other.kept_subs;
    }
}

/// Deletes the build folder of each `sub-*` holder under `worktrees_root` that
/// `is_idle` (given the holder's folder name) calls finished and that nothing wrote
/// to for `idle_for` before `now`. The clock and the predicate are parameters so a
/// test needs neither real time nor a registry; the daemon's predicate is the
/// registry's, which never names a running or queued sub. `worktrees_root` must
/// be a repo's `.claude/worktrees`, so a wrong argument deletes nothing.
pub(super) fn sweep_idle(worktrees_root: &Path, now: SystemTime, idle_for: Duration, is_idle: &dyn Fn(&str) -> bool) -> Swept {
    let mut swept = Swept::default();
    if !worktrees_root.ends_with(".claude/worktrees") {
        log::warn!("subchats: not sweeping build folders under {}: not a .claude/worktrees folder", worktrees_root.display());
        return swept;
    }
    let Ok(entries) = std::fs::read_dir(worktrees_root) else { return swept };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };
        if !name.starts_with("sub-") || !meta.is_dir() || is_link(&meta) {
            continue;
        }
        let holder = entry.path();
        let Some(target) = own_target(&holder) else { continue };
        let size = dir_size(&target);
        swept.total += size;
        if !is_idle(&name) || !quiet_for(&target, now, idle_for) {
            swept.kept_subs += 1;
            continue;
        }
        match free(&holder) {
            Ok(bytes) => {
                swept.freed += bytes;
                swept.freed_subs += 1;
            }
            Err(why) => {
                log::warn!("subchats: could not free the build folder of {name}: {why}");
                swept.kept_subs += 1;
            }
        }
    }
    swept
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    /// `<root>/.claude/worktrees/sub-<tag>/` with a tree, the daemon's cargo
    /// config and a build folder of `bytes` bytes (`with_config` false leaves the
    /// config out, as a tree from before holders had one).
    fn holder(root: &Path, tag: &str, bytes: usize, with_config: bool) -> PathBuf {
        let h = root.join(".claude").join("worktrees").join(format!("sub-{tag}"));
        std::fs::create_dir_all(h.join("tree")).unwrap();
        if with_config {
            std::fs::create_dir_all(h.join(".cargo")).unwrap();
            std::fs::write(h.join(".cargo").join("config.toml"), "[build]\n").unwrap();
        }
        let deps = h.join("target").join("debug").join("deps");
        std::fs::create_dir_all(&deps).unwrap();
        std::fs::write(deps.join("libapp.rlib"), vec![0u8; bytes]).unwrap();
        h
    }

    fn root_of(root: &Path) -> PathBuf {
        root.join(".claude").join("worktrees")
    }

    fn later(by: Duration) -> SystemTime {
        SystemTime::now() + by
    }

    #[test]
    fn an_idle_finished_subs_build_folder_is_freed_and_its_tree_and_config_stay() {
        let dir = tempfile::tempdir().unwrap();
        let h = holder(dir.path(), "aaaa", 4096, true);
        let swept = sweep_idle(&root_of(dir.path()), later(4 * HOUR), 3 * HOUR, &|_| true);
        assert_eq!(swept, Swept { total: 4096, freed: 4096, freed_subs: 1, kept_subs: 0 });
        assert!(!h.join("target").exists());
        assert!(h.join("tree").is_dir() && h.join(".cargo").join("config.toml").is_file(), "a continued sub builds into the same place again");
    }

    #[test]
    fn a_build_folder_written_to_within_the_idle_time_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let h = holder(dir.path(), "bbbb", 100, true);
        let swept = sweep_idle(&root_of(dir.path()), later(HOUR), 3 * HOUR, &|_| true);
        assert_eq!(swept, Swept { total: 100, freed: 0, freed_subs: 0, kept_subs: 1 });
        assert!(h.join("target").is_dir(), "an hour of quiet is not three");
        let before_it_was_written = SystemTime::now() - 4 * HOUR;
        let swept = sweep_idle(&root_of(dir.path()), before_it_was_written, 3 * HOUR, &|_| true);
        assert_eq!(swept.freed, 0, "a clock that is behind the files proves nothing");
        assert!(h.join("target").is_dir());
    }

    #[test]
    fn only_the_subs_the_predicate_names_lose_their_build_folder() {
        let dir = tempfile::tempdir().unwrap();
        let done = holder(dir.path(), "done", 10, true);
        let live = holder(dir.path(), "live", 20, true);
        let swept = sweep_idle(&root_of(dir.path()), later(4 * HOUR), 3 * HOUR, &|name| name == "sub-done");
        assert_eq!(swept, Swept { total: 30, freed: 10, freed_subs: 1, kept_subs: 1 });
        assert!(!done.join("target").exists());
        assert!(live.join("target").is_dir(), "a sub the registry does not call finished keeps its build");
    }

    #[test]
    fn a_holder_the_daemon_did_not_configure_and_a_folder_that_is_not_a_holder_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let old = holder(dir.path(), "old", 10, false);
        let stray = root_of(dir.path()).join("notes");
        std::fs::create_dir_all(stray.join("target")).unwrap();
        std::fs::write(stray.join("target").join("x"), b"x").unwrap();
        let swept = sweep_idle(&root_of(dir.path()), later(4 * HOUR), 3 * HOUR, &|_| true);
        assert_eq!(swept, Swept::default());
        assert!(old.join("target").is_dir() && stray.join("target").is_dir());
    }

    #[test]
    fn a_folder_that_is_not_a_repos_worktrees_folder_is_never_swept() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("cargo-target");
        let h = elsewhere.join("sub-zzzz");
        std::fs::create_dir_all(h.join(".cargo")).unwrap();
        std::fs::write(h.join(".cargo").join("config.toml"), "[build]\n").unwrap();
        std::fs::create_dir_all(h.join("target")).unwrap();
        std::fs::write(h.join("target").join("x"), b"x").unwrap();
        let swept = sweep_idle(&elsewhere, later(4 * HOUR), 3 * HOUR, &|_| true);
        assert_eq!(swept, Swept::default());
        assert!(h.join("target").join("x").is_file());
    }

    #[test]
    fn freeing_a_holder_with_no_build_folder_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let h = holder(dir.path(), "none", 1, true);
        std::fs::remove_dir_all(h.join("target")).unwrap();
        assert_eq!(free(&h), Ok(0));
    }
}
