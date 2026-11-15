//! The home's record of the subs it runs on another machine
//! (`docs/cross-machine-subchats.md`, "Identity and trust").
//!
//! A remote sub has no row of its own on the home that can say who hosts it, so
//! this file is the only thing that lets the home tell a mirrored row, prompt or
//! event from its own sub apart from a peer claiming one: [`accepts`] is true only
//! when the record names that sub id AND that machine.
//!
//! `<data_dir>/subchats/remote-subs[suffix].json`, one file per daemon instance
//! for the same reason `held[suffix].json` is: a test or dev daemon shares the
//! live app's data folder and a shared file let it wipe the live app's records.
//! Read and written like `held.rs`: the file is small, so there is no in-memory
//! copy to drift from it, and every entry is decoded on its own so one that will
//! not decode costs only itself (the whole text is kept as `.bad` first, see
//! [`super::super::jsonfile`]).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where a remote sub stands, as the home last learned it. A mirror row of the
/// host is fresher while the host is reachable; this is what is left when it is not.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RemoteState {
    /// Registered on the host and waiting (an `after` chain), not started.
    Held,
    #[default]
    Running,
    Finished,
    Ended,
}

/// One sub the home runs on `machine_id`.
///
/// Only `sub_id` is required: every other field has a default, so an entry
/// written by an older build still loads and a present-but-incomplete entry never
/// fails the whole file. An entry naming no sub has nobody to speak for.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct RemoteSub {
    pub sub_id: String,
    /// The paired machine that hosts the sub's process. Empty reads as unknown
    /// and is never trusted by [`accepts`].
    #[serde(default)]
    pub machine_id: String,
    /// The main chat on this machine the sub belongs to.
    #[serde(default)]
    pub main_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: RemoteState,
    #[serde(default)]
    pub spawned_at: String,
    /// When the host first stopped answering, cleared when it answers again.
    #[serde(default)]
    pub unreachable_since: Option<String>,
    /// The main chat was already woken once for this gap, so it is not woken again.
    #[serde(default)]
    pub woke_unreachable: bool,
    /// The branch the sub's commits merge into on this machine.
    #[serde(default)]
    pub target: String,
    /// The home commit the sub's tree started from.
    #[serde(default)]
    pub base: String,
    /// The main chat's checkout on this machine, where bundles are made and
    /// imported; the start-up sweep clears a crash's scratch refs there.
    #[serde(default)]
    pub repo: PathBuf,
}

/// Serialises read-modify-write of the file.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn file_path() -> Option<PathBuf> {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::data_dir().ok().map(|d| d.join("subchats").join(format!("remote-subs{suffix}.json")))
}

fn no_data_dir() -> std::io::Error {
    std::io::Error::other("no data dir")
}

// The `_at` functions take the file path so a test needs no data dir at all and
// can never reach the live one.

fn read_at(path: &Path) -> Vec<RemoteSub> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let entries: Vec<serde_json::Value> = match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            super::super::jsonfile::keep_bad_copy(path, &raw, &e.to_string());
            return Vec::new();
        }
    };
    let mut subs = Vec::with_capacity(entries.len());
    let mut unreadable = 0;
    for entry in entries {
        match serde_json::from_value::<RemoteSub>(entry) {
            Ok(s) => subs.push(s),
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        super::super::jsonfile::keep_bad_copy(path, &raw, &format!("{unreadable} of its entries did not decode"));
    }
    subs
}

fn write_at(path: &Path, all: &[RemoteSub]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string(all).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(path, &body)
}

fn record_at(path: &Path, sub: RemoteSub) -> std::io::Result<()> {
    let mut all = read_at(path);
    // A second record for the same sub replaces the first, in its place, so the
    // order stays the order the subs were spawned in.
    match all.iter_mut().find(|s| s.sub_id == sub.sub_id) {
        Some(slot) => *slot = sub,
        None => all.push(sub),
    }
    write_at(path, &all)
}

fn update_state_at(path: &Path, sub_id: &str, state: RemoteState) -> std::io::Result<bool> {
    let mut all = read_at(path);
    let Some(sub) = all.iter_mut().find(|s| s.sub_id == sub_id) else { return Ok(false) };
    if sub.state != state {
        sub.state = state;
        write_at(path, &all)?;
    }
    Ok(true)
}

fn remove_at(path: &Path, sub_id: &str) -> std::io::Result<Option<RemoteSub>> {
    let mut all = read_at(path);
    let Some(at) = all.iter().position(|s| s.sub_id == sub_id) else { return Ok(None) };
    let taken = all.remove(at);
    write_at(path, &all)?;
    Ok(Some(taken))
}

/// Every record, oldest first.
pub fn all() -> Vec<RemoteSub> {
    let Some(path) = file_path() else { return Vec::new() };
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_at(&path)
}

/// Stores `sub`, replacing the record of the same sub id.
pub fn record(sub: RemoteSub) -> std::io::Result<()> {
    let path = file_path().ok_or_else(no_data_dir)?;
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    record_at(&path, sub)
}

pub fn get(sub_id: &str) -> Option<RemoteSub> {
    all().into_iter().find(|s| s.sub_id == sub_id)
}

/// Sets the state of `sub_id`'s record; `Ok(false)` when there is none.
pub fn update_state(sub_id: &str, state: RemoteState) -> std::io::Result<bool> {
    let path = file_path().ok_or_else(no_data_dir)?;
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    update_state_at(&path, sub_id, state)
}

/// Takes `sub_id`'s record out, returning it.
pub fn remove(sub_id: &str) -> std::io::Result<Option<RemoteSub>> {
    let path = file_path().ok_or_else(no_data_dir)?;
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    remove_at(&path, sub_id)
}

/// The remote subs of one main chat: the remote half of the family lookup.
pub fn of_main(main_id: &str) -> Vec<RemoteSub> {
    all().into_iter().filter(|s| s.main_id == main_id).collect()
}

fn accepts_in(records: &[RemoteSub], sub_id: &str, machine_id: &str) -> bool {
    // An empty id on either side is "unknown", never a match: an old record with
    // no machine must not accept a caller that also names none.
    !sub_id.is_empty() && !machine_id.is_empty() && records.iter().any(|s| s.sub_id == sub_id && s.machine_id == machine_id)
}

/// Whether `machine_id` may speak for `sub_id`: the record names that sub AND that
/// machine. A peer claiming a sub it does not host (or one this machine never
/// sent out) is refused. `machine_id` must come from `ctx.transport`, never from a
/// request payload.
pub fn accepts(sub_id: &str, machine_id: &str) -> bool {
    accepts_in(&all(), sub_id, machine_id)
}

/// The distinct, non-empty repo folders the records name, in first-seen order.
fn repos_of(records: &[RemoteSub]) -> Vec<PathBuf> {
    let mut repos: Vec<PathBuf> = Vec::new();
    for sub in records {
        if !sub.repo.as_os_str().is_empty() && !repos.contains(&sub.repo) {
            repos.push(sub.repo.clone());
        }
    }
    repos
}

/// Daemon start: clears the scratch refs and bundle files a crash can leave, in
/// every repo a remote sub is recorded for. Runs when no bundle is being made or
/// imported (nothing can be before the daemon serves), which is what
/// `git_sync::sweep_leftovers` requires. With no records it does nothing.
pub fn sweep_at_start() {
    for repo in repos_of(&all()) {
        // A folder that was moved or deleted has nothing to sweep.
        if repo.is_dir() {
            super::git_sync::sweep_leftovers(&repo);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(id: &str, machine: &str, main: &str) -> RemoteSub {
        RemoteSub { sub_id: id.into(), machine_id: machine.into(), main_id: main.into(), ..RemoteSub::default() }
    }

    fn file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subchats").join("remote-subs-test.json");
        (dir, path)
    }

    fn bad_copies(path: &Path) -> usize {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&format!("{name}.bad")))
            .count()
    }

    #[test]
    fn a_record_round_trips_and_a_second_for_the_same_sub_replaces_the_first_in_place() {
        let (_d, path) = file();
        record_at(&path, sub("s1", "mac", "m1")).unwrap();
        record_at(&path, sub("s2", "mac", "m1")).unwrap();
        let mut again = sub("s1", "mac", "m1");
        again.name = "docs".into();
        again.target = "master".into();
        again.unreachable_since = Some("2026-11-15T10:00:00Z".into());
        again.woke_unreachable = true;
        record_at(&path, again.clone()).unwrap();
        let all = read_at(&path);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], again, "the replaced record keeps its place");
        assert_eq!(all[1].sub_id, "s2");
    }

    #[test]
    fn an_entry_that_names_only_its_sub_still_loads_with_defaults() {
        let (_d, path) = file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"[{"sub_id":"old"},{"sub_id":"half","machine_id":"mac","state":"finished"}]"#).unwrap();
        let all = read_at(&path);
        assert_eq!(all.len(), 2, "a present-but-incomplete entry does not fail the file");
        assert_eq!(all[0], RemoteSub { sub_id: "old".into(), ..RemoteSub::default() });
        assert_eq!(all[0].state, RemoteState::Running);
        assert_eq!(all[1].machine_id, "mac");
        assert_eq!(all[1].state, RemoteState::Finished);
        assert_eq!(all[1].main_id, "");
        assert_eq!(bad_copies(&path), 0, "nothing unreadable, nothing kept");
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_never_replaced_by_an_empty_one() {
        let (_d, path) = file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_at(&path).is_empty());
        let kept = path.with_file_name(format!("{}.bad", path.file_name().unwrap().to_string_lossy()));
        assert_eq!(std::fs::read_to_string(kept).unwrap(), "{ not json");
        // The next write replaces the file, but the damaged text is already safe.
        record_at(&path, sub("s1", "mac", "m1")).unwrap();
        assert_eq!(read_at(&path).len(), 1);
        assert_eq!(bad_copies(&path), 1);
    }

    #[test]
    fn one_entry_that_will_not_decode_is_kept_aside_and_the_others_survive() {
        let (_d, path) = file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // No sub id, and a state no build knows: neither can be read as a record.
        let raw = r#"[{"machine_id":"mac"},{"sub_id":"ok","machine_id":"mac"},{"sub_id":"odd","state":"vanished"}]"#;
        std::fs::write(&path, raw).unwrap();
        let all = read_at(&path);
        assert_eq!(all.iter().map(|s| s.sub_id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
        let kept = path.with_file_name(format!("{}.bad", path.file_name().unwrap().to_string_lossy()));
        assert_eq!(std::fs::read_to_string(kept).unwrap(), raw, "the whole text, so the two lost entries can be recovered");
    }

    #[test]
    fn state_updates_and_removal_touch_only_the_named_sub() {
        let (_d, path) = file();
        record_at(&path, sub("s1", "mac", "m1")).unwrap();
        record_at(&path, sub("s2", "mac", "m1")).unwrap();
        assert!(update_state_at(&path, "s1", RemoteState::Finished).unwrap());
        assert!(!update_state_at(&path, "nope", RemoteState::Ended).unwrap(), "no record, no change");
        let all = read_at(&path);
        assert_eq!(all[0].state, RemoteState::Finished);
        assert_eq!(all[1].state, RemoteState::Running);
        let taken = remove_at(&path, "s1").unwrap().expect("it was recorded");
        assert_eq!(taken.sub_id, "s1");
        assert!(remove_at(&path, "s1").unwrap().is_none());
        assert_eq!(read_at(&path).iter().map(|s| s.sub_id.as_str()).collect::<Vec<_>>(), vec!["s2"]);
    }

    #[test]
    fn a_peer_is_accepted_only_for_a_sub_the_record_says_it_hosts() {
        let records = vec![sub("s1", "mac", "m1"), sub("s2", "other-mac", "m1"), sub("legacy", "", "m1")];
        assert!(accepts_in(&records, "s1", "mac"));
        assert!(!accepts_in(&records, "s1", "other-mac"), "another peer claiming a sub it does not host");
        assert!(!accepts_in(&records, "s2", "mac"));
        assert!(!accepts_in(&records, "unknown", "mac"), "a sub nobody recorded");
        assert!(!accepts_in(&records, "legacy", ""), "an unknown machine never matches an unknown caller");
        assert!(!accepts_in(&records, "", ""));
    }

    #[test]
    fn the_family_lookup_returns_one_mains_subs_in_spawn_order() {
        let (_d, path) = file();
        record_at(&path, sub("a", "mac", "m1")).unwrap();
        record_at(&path, sub("b", "mac", "m2")).unwrap();
        record_at(&path, sub("c", "mac", "m1")).unwrap();
        let ids = |main: &str| read_at(&path).into_iter().filter(|s| s.main_id == main).map(|s| s.sub_id).collect::<Vec<_>>();
        assert_eq!(ids("m1"), vec!["a", "c"]);
        assert_eq!(ids("m2"), vec!["b"]);
        assert!(ids("m3").is_empty());
    }

    #[test]
    fn the_public_store_uses_the_per_instance_file_under_the_data_dir() {
        let _d = crate::daemon::subchats::TempDataDir::new();
        assert!(all().is_empty());
        record(sub("p1", "mac", "m1")).unwrap();
        record(sub("p2", "mac", "m2")).unwrap();
        assert_eq!(get("p1").unwrap().main_id, "m1");
        assert_eq!(of_main("m2").len(), 1);
        assert!(accepts("p1", "mac") && !accepts("p1", "pc"));
        assert!(update_state("p1", RemoteState::Ended).unwrap());
        assert_eq!(get("p1").unwrap().state, RemoteState::Ended);
        assert_eq!(remove("p2").unwrap().unwrap().sub_id, "p2");
        assert!(get("p2").is_none());
        let suffix = crate::daemon::instance::instance_suffix();
        let file = crate::settings::paths::data_dir().unwrap().join("subchats").join(format!("remote-subs{suffix}.json"));
        assert!(file.is_file(), "{}", file.display());
    }

    #[test]
    fn the_start_up_sweep_names_each_recorded_repo_once_and_skips_records_without_one() {
        let mut a = sub("a", "mac", "m1");
        a.repo = PathBuf::from("/work/one");
        let mut b = sub("b", "mac", "m1");
        b.repo = PathBuf::from("/work/one");
        let c = sub("c", "mac", "m1");
        let mut d = sub("d", "mac", "m2");
        d.repo = PathBuf::from("/work/two");
        assert_eq!(repos_of(&[a, b, c, d]), vec![PathBuf::from("/work/one"), PathBuf::from("/work/two")]);
        assert!(repos_of(&[]).is_empty());
    }

    fn git(root: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn the_start_up_sweep_clears_a_crash_leftover_in_a_recorded_repo_and_survives_a_missing_one() {
        let _d = crate::daemon::subchats::TempDataDir::new();
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "t"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("f.txt"), "x\n").unwrap();
        git(&repo, &["add", "f.txt"]);
        git(&repo, &["commit", "-q", "-m", "one"]);
        git(&repo, &["update-ref", "refs/cc-bundle/stale", "HEAD"]);
        let stale = || {
            let out = std::process::Command::new("git").arg("-C").arg(&repo).args(["for-each-ref", "refs/cc-bundle/"]).output().unwrap();
            !String::from_utf8_lossy(&out.stdout).trim().is_empty()
        };
        assert!(stale());

        let mut gone = sub("gone", "mac", "m1");
        gone.repo = repo.join("no-such-folder");
        let mut live = sub("live", "mac", "m1");
        live.repo = repo.clone();
        record(gone).unwrap();
        record(live).unwrap();
        sweep_at_start();
        assert!(!stale(), "the scratch ref the crash left is gone");
    }
}
