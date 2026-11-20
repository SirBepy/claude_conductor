//! The host's half of an offloaded research sub (`docs/cross-machine-subchats.md`,
//! "Offloading read-only subs"): a read-only sub the home placed here without a
//! project runs in an empty scratch folder under THIS machine's own home, so the
//! machine never holds a clone of a project just to host a sub.
//!
//! The folder is `<home>/conductor-scratch/<sub id>`. The sub id is a uuid the
//! daemon parses and re-prints before it is joined to a path, so a peer cannot steer
//! the folder anywhere else, and a path never travels in either direction. The
//! folder goes when its sub ends (`host_actions`) and, for anything a crash or an
//! ended-by-itself sub left, on the watchdog tick ([`sweep`]).
//!
//! Also here: `sub_host_info`, the one question the home asks before it picks this
//! machine (how much disk is free), so a nearly full Mac is never chosen.

use crate::daemon::rpc::{ConnectionContext, Router, RpcError};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const GIB: u64 = 1024 * 1024 * 1024;

/// The free disk the home asks for before it offloads a sub here. A research sub
/// writes next to nothing, but its transcript, a browser profile and a tool's cache
/// do, and the Mac this was built for has 46 GB free in all.
pub const MIN_FREE_BYTES: u64 = 15 * GIB;

/// The least this machine keeps for itself whatever the home asks: `sub_spawn`
/// refuses below it, so a home that skipped or lied in the probe cannot fill the disk.
const HOST_FLOOR_BYTES: u64 = GIB;

/// A folder younger than this is never swept: `sub_spawn` makes it a moment before
/// the sub's row exists, and the sweep must not take it in that gap.
const SWEEP_MIN_AGE: Duration = Duration::from_secs(10 * 60);

const FOLDER: &str = "conductor-scratch";

/// The folder every scratch folder sits in: under this machine's home, never a path
/// a peer chose. A test gets one temp folder for the whole process, so nothing a test
/// does reaches the real home.
fn root() -> Option<PathBuf> {
    #[cfg(test)]
    {
        static TEST_HOME: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        Some(TEST_HOME.get_or_init(|| tempfile::tempdir().expect("a temp home")).path().join(FOLDER))
    }
    #[cfg(not(test))]
    {
        dirs::home_dir().map(|h| h.join(FOLDER))
    }
}

/// The id's canonical spelling, or `None` when it is not a uuid: the only form that
/// is ever joined to a path here.
fn canonical(sub_id: &str) -> Option<String> {
    uuid::Uuid::parse_str(sub_id).ok().map(|u| u.hyphenated().to_string())
}

/// The scratch folder of `sub_id`, whether or not it exists.
pub fn dir_for(sub_id: &str) -> Option<PathBuf> {
    Some(root()?.join(canonical(sub_id)?))
}

/// Free bytes on the disk this machine's scratch folders sit on, or `None` when the
/// disk list names none of the folder's parents (the home then counts as unknown, and
/// an unknown figure never offloads).
pub fn free_bytes() -> Option<u64> {
    let probe = root()?;
    free_bytes_at(&probe)
}

fn free_bytes_at(path: &Path) -> Option<u64> {
    let want = norm(path);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    // The disk with the longest mount point that is a prefix of the path: `C:\` and a
    // volume mounted at `C:\data` both match a path under the second, and the second is right.
    disks
        .list()
        .iter()
        .filter(|d| {
            let m = norm(d.mount_point());
            want == m || want.starts_with(&format!("{}/", m.trim_end_matches('/')))
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

/// A path as one lower-case string with `/` separators, so a Windows drive letter's case
/// and the two separators never decide a prefix match.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Makes the folder for `sub_id`, or says why not. Refuses when the disk is below
/// [`HOST_FLOOR_BYTES`] (an unknown figure passes: the home's probe already asked).
pub fn create(sub_id: &str) -> Result<PathBuf, String> {
    let dir = dir_for(sub_id).ok_or("a scratch sub needs a session id (a uuid)")?;
    if free_bytes().is_some_and(|free| free < HOST_FLOOR_BYTES) {
        return Err("this machine is nearly out of disk space, so it takes no new sub".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the scratch folder: {e}"))?;
    Ok(dir)
}

/// Removes the folder of `sub_id`. A link in its place is taken away without being followed;
/// a folder that is not there is already done. Returns whether anything is left.
pub fn remove(sub_id: &str) -> bool {
    let Some(dir) = dir_for(sub_id) else { return false };
    let Ok(meta) = std::fs::symlink_metadata(&dir) else { return false };
    let gone = if meta.is_dir() { std::fs::remove_dir_all(&dir) } else { std::fs::remove_file(&dir) };
    match gone {
        Ok(()) => false,
        Err(e) => {
            // A child of the sub can still hold the folder open (Windows); the next sweep retries.
            log::warn!("subchats: could not remove the scratch folder of {sub_id}: {e}");
            true
        }
    }
}

/// Removes every scratch folder older than `min_age` whose sub `live` does not name. Returns
/// the ids removed. A name that is not a canonical uuid is not ours and is left alone.
pub fn sweep_with(live: impl Fn(&str) -> bool, min_age: Duration) -> Vec<String> {
    let Some(root) = root() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let now = SystemTime::now();
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if canonical(&name).as_deref() != Some(name.as_str()) || live(&name) {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).map_or(false, |age| age >= min_age))
            .unwrap_or(false);
        if old_enough && !remove(&name) {
            removed.push(name);
        }
    }
    removed
}

/// The watchdog tick: a scratch folder whose sub is neither a live row nor waiting in the
/// held list is a leftover.
pub fn sweep(state: &crate::daemon::state::DaemonState) -> Vec<String> {
    sweep_with(|id| is_live(state, id), SWEEP_MIN_AGE)
}

fn is_live(state: &crate::daemon::state::DaemonState, sub_id: &str) -> bool {
    state.registry.get(sub_id).is_some_and(|i| i.ended_at.is_none() && i.end_reason.is_none()) || crate::daemon::subchats::held::is_held(sub_id)
}

/// What the sub is told about where it runs, appended to its first message. The folder is a
/// path on this machine; the home's words about the job stay as they were written.
pub fn first_message_note(dir: &Path) -> String {
    format!(
        "\n\nWhere you run: you were started on another machine to research, in an empty scratch folder at {}. The project's files are not here and nothing in this folder is worth keeping, so work from the brief above (web search and reading pages are what this is for). If the job turns out to need the project's own files, finish and say so in your report instead of guessing.",
        dir.display()
    )
}

/// Registers `sub_host_info` (`M`): this machine's free disk, for a home that is choosing
/// where to run a sub.
pub fn register(router: &mut Router) {
    router.register("sub_host_info", |_params, ctx| async move { info(&ctx).await });
}

async fn info(ctx: &ConnectionContext) -> Result<Value, RpcError> {
    super::host::peer_of(ctx, "sub_host_info")?;
    let free = tokio::task::spawn_blocking(free_bytes).await.map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(json!({ "ok": true, "scratch": true, "free_bytes": free }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn the_folder_is_under_the_root_and_only_for_a_uuid() {
        let dir = dir_for(ID).unwrap();
        assert_eq!(dir.parent().unwrap(), root().unwrap());
        assert!(dir_for("../../etc").is_none());
        assert!(dir_for("").is_none());
        assert!(dir_for("not a uuid").is_none());
        // Another spelling of the same uuid names the same folder, never another one.
        assert_eq!(dir_for(&ID.to_uppercase()), dir_for(ID));
        assert_eq!(dir_for(&format!("{{{ID}}}")), dir_for(ID));
    }

    #[test]
    fn create_and_remove_leave_nothing() {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = create(&id).unwrap();
        assert!(dir.is_dir());
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        assert!(!remove(&id), "nothing left");
        assert!(!dir.exists());
        assert!(!remove(&id), "a folder that is not there is already done");
    }

    #[test]
    fn a_sweep_takes_a_dead_subs_folder_and_keeps_a_live_one_and_a_young_one() {
        let (dead, alive, young) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        let dirs: Vec<PathBuf> = [&dead, &alive, &young].iter().map(|id| create(id).unwrap()).collect();
        let stray = root().unwrap().join("not-a-sub-folder");
        std::fs::create_dir_all(&stray).unwrap();
        // Age zero: every folder is old enough, so only `live` decides, except for `young`.
        let removed = sweep_with(|id| id == alive, Duration::ZERO);
        assert!(removed.contains(&dead) && removed.contains(&young), "{removed:?}");
        assert!(!dirs[0].exists() && dirs[1].is_dir());
        assert!(stray.is_dir(), "a folder that is not a sub's is not ours");
        // With the real minimum age a fresh folder is untouched.
        let fresh = uuid::Uuid::new_v4().to_string();
        create(&fresh).unwrap();
        assert!(sweep_with(|_| false, SWEEP_MIN_AGE).iter().all(|id| id != &fresh));
        assert!(dir_for(&fresh).unwrap().is_dir());
        remove(&alive);
        remove(&fresh);
        let _ = std::fs::remove_dir_all(stray);
    }

    #[test]
    fn free_space_is_read_from_the_disk_the_folder_is_on() {
        // The root is a temp folder, which sits on a disk the OS lists.
        assert!(free_bytes().is_some_and(|b| b > 0));
        assert!(free_bytes_at(Path::new("/definitely/not/a/mounted/path/zz")).is_none() || cfg!(unix));
    }

    #[test]
    fn the_note_names_the_folder_and_says_the_project_is_absent() {
        let note = first_message_note(Path::new("/home/x/conductor-scratch/abc"));
        assert!(note.contains("/home/x/conductor-scratch/abc") && note.contains("project's files are not here"), "{note}");
    }
}
