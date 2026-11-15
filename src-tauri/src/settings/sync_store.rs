//! Where the settings-sync stamps live and who writes them (todo pc-1455 step 2).
//!
//! `settings-sync-clocks.json` sits beside `settings.json`. Two writers feed it,
//! both under one process-wide lock so a stamp and the value it describes never
//! split:
//!
//! - [`record_local_save`], called by `store::save` after every settings write: it
//!   diffs the file as it was against what was just written and stamps each
//!   personal key that changed, so every local edit is stamped in the one place a
//!   save lands, whichever command made it.
//! - [`apply_incoming`], for a peer's changes: it writes the merged settings and
//!   the stamps it received (never a fresh one), so a merge is not mistaken for a
//!   local edit on the next save and cannot bounce back to the peer as one.

use super::sync::{merge_at, Change, Clocks, Merged};
use crate::types::Settings;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const CLOCKS_FILE: &str = "settings-sync-clocks.json";

/// Held across "read the file as it was, write it, stamp what changed" and across
/// "merge, write, store the received stamps". Settings writers come from several
/// threads of the app process.
static SYNC_LOCK: Mutex<()> = Mutex::new(());

pub fn lock() -> MutexGuard<'static, ()> {
    SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `settings.json`'s sibling, so a test or a second instance on its own data dir
/// keeps its own stamps.
pub fn clocks_path(settings_path: &Path) -> PathBuf {
    settings_path.with_file_name(CLOCKS_FILE)
}

/// `#[serde(default)]` on every field: a file written before a field existed must
/// still load (CLAUDE.md, todo 785).
#[derive(Serialize, Deserialize, Default)]
struct ClocksFile {
    #[serde(default)]
    clocks: Clocks,
}

/// The stamps on disk. A missing file is "nothing stamped yet". A file that does
/// not parse is moved to `.bad` (kept for a look, never overwritten in place) and
/// reads as empty: an unstamped key takes a peer's value, so losing the stamps
/// costs a possible stale overwrite, never a crash or lost settings.
pub fn load_clocks(path: &Path) -> Clocks {
    let Ok(raw) = std::fs::read_to_string(path) else { return Clocks::new() };
    match serde_json::from_str::<ClocksFile>(&raw) {
        Ok(file) => file.clocks,
        Err(e) => {
            let bad = path.with_extension("json.bad");
            log::error!("[settings-sync] {} did not parse ({e}); kept as {}", path.display(), bad.display());
            let _ = std::fs::rename(path, &bad);
            Clocks::new()
        }
    }
}

/// The stamps on disk for a reader that does not own the file (the daemon): same
/// result as [`load_clocks`], but a file that does not parse is left where it is
/// for the app process to set aside.
pub fn peek_clocks(path: &Path) -> Clocks {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ClocksFile>(&raw).ok())
        .map(|f| f.clocks)
        .unwrap_or_default()
}

pub fn save_clocks(path: &Path, clocks: &Clocks) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(&ClocksFile { clocks: clocks.clone() }).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(path, &body)
}

/// The settings file as it is on disk, for the diff in [`record_local_save`].
/// `None` when it is missing or does not parse: with no known "before" there is
/// nothing to say changed, so nothing is stamped (an unstamped key never beats a
/// peer's, and the next save has a readable "before").
pub fn read_previous(settings_path: &Path) -> Option<Settings> {
    serde_json::from_str(&std::fs::read_to_string(settings_path).ok()?).ok()
}

/// This machine's id as the daemon registry stores it beside `settings.json`
/// (the same id a peer sees on the link). A machine that has not minted one yet
/// stamps as `local`: `by` only breaks a tie between two edits at one instant.
fn local_machine_id(settings_path: &Path) -> String {
    settings_path
        .parent()
        .and_then(crate::daemon::machines::registry::self_machine_id)
        .unwrap_or_else(|| "local".to_string())
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Stamps the personal keys `old` -> `new` changed. Caller holds [`lock`]. Never
/// fails the save it follows: a stamp that cannot be written is logged and the
/// key stays unstamped until its next edit.
pub fn record_local_save(settings_path: &Path, old: &Settings, new: &Settings) {
    let path = clocks_path(settings_path);
    let mut clocks = load_clocks(&path);
    let changes = super::sync::stamp_changes(old, new, &mut clocks, &now_rfc3339(), &local_machine_id(settings_path));
    if changes.is_empty() {
        return;
    }
    if let Err(e) = save_clocks(&path, &clocks) {
        log::warn!("[settings-sync] could not store stamps beside {}: {e}", settings_path.display());
    }
}

/// Merges a peer's `changes` into `local` and writes the result: the settings file
/// first, then the stamps. A crash between the two leaves a value with no stamp,
/// which takes the peer's value again; the other order would leave a stamp whose
/// value never arrived, and the peer's change would be refused as already seen.
/// Nothing is written when nothing applied.
pub fn apply_incoming(settings_path: &Path, local: &Settings, changes: &[Change], now: DateTime<Utc>) -> anyhow::Result<Merged> {
    let _guard = lock();
    let path = clocks_path(settings_path);
    let mut clocks = load_clocks(&path);
    let mut merged = merge_at(local, &mut clocks, changes, now);
    if merged.applied.is_empty() {
        return Ok(merged);
    }
    // The peer's values are already ours and only its stamps are new: store the stamps
    // and report nothing applied, so the caller writes no settings, bumps no generation
    // and pushes nothing. A change handed over again (the daemon repeats one after an
    // app push) therefore ends here instead of looping when the stamps cannot be written.
    if merged.settings == *local {
        if let Err(e) = save_clocks(&path, &clocks) {
            log::warn!("[settings-sync] could not store a peer's stamps: {e}");
        }
        merged.applied.clear();
        return Ok(merged);
    }
    merged.settings.bump_generation();
    super::store::write_settings_file(settings_path, &merged.settings)?;
    // The settings are on disk by now, so a stamp that cannot be written is not an
    // error: failing here would leave the live copy behind the file, and the next save
    // would stamp the peer's value as a local edit and send it back as a revert.
    if let Err(e) = save_clocks(&path, &clocks) {
        log::warn!("[settings-sync] stored a peer's settings but not their stamps: {e}");
    }
    Ok(merged)
}

/// [`apply_incoming`] against the app's live settings: under the live settings'
/// own lock (the one `save_settings` holds across its generation check and write),
/// so a frontend save cannot land between the merge and the replace. The live copy
/// is replaced only when something applied.
pub fn apply_to_live(live: &Mutex<Settings>, settings_path: &Path, changes: &[Change], now: DateTime<Utc>) -> anyhow::Result<Merged> {
    let mut guard = live.lock().unwrap_or_else(|e| e.into_inner());
    let merged = apply_incoming(settings_path, &guard, changes, now)?;
    if !merged.applied.is_empty() {
        *guard = merged.settings.clone();
    }
    Ok(merged)
}

/// What this machine would send a peer: every stamped personal key with its
/// current value (`null` for a value that went away) and its stamp. An unstamped
/// key is never sent, since nobody has edited it since stamping began.
pub fn stamped_state(settings: &Settings, clocks: &Clocks) -> Vec<Change> {
    let flat = super::sync::personal_subset(settings);
    clocks
        .iter()
        .filter(|(key, _)| super::sync::is_personal(key))
        .map(|(key, stamp)| Change {
            key: key.clone(),
            value: flat.get(key).cloned().unwrap_or(serde_json::Value::Null),
            stamp: stamp.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::store;
    use serde_json::json;
    use tempfile::tempdir;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2999-01-01T00:00:00Z").unwrap().with_timezone(&Utc)
    }

    fn change(key: &str, value: serde_json::Value, at: &str) -> Change {
        Change { key: key.into(), value, stamp: crate::settings::sync::Stamp { at: at.into(), by: "mac".into() } }
    }

    /// A settings file that already exists, so the next save has a "before".
    fn seeded(dir: &Path) -> PathBuf {
        let path = dir.join("settings.json");
        store::save(&path, &Settings::default()).unwrap();
        path
    }

    #[test]
    fn a_save_stamps_a_personal_edit_beside_the_settings_file() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let mut s = Settings::default();
        s.poll_interval_secs = 123;
        store::save(&path, &s).unwrap();
        let clocks = load_clocks(&clocks_path(&path));
        assert_eq!(clocks.keys().collect::<Vec<_>>(), vec!["poll_interval_secs"]);
        assert!(chrono::DateTime::parse_from_rfc3339(&clocks["poll_interval_secs"].at).is_ok());
    }

    #[test]
    fn a_machine_local_edit_leaves_no_stamp() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let mut s = Settings::default();
        s.hook_port = Some(4321);
        s.autostart = true;
        s.extra.insert("someFutureKey".into(), json!(1));
        store::save(&path, &s).unwrap();
        assert!(load_clocks(&clocks_path(&path)).is_empty());
    }

    #[test]
    fn a_save_with_no_readable_before_stamps_nothing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ torn").unwrap();
        let mut s = Settings::default();
        s.poll_interval_secs = 5;
        store::save(&path, &s).unwrap();
        assert!(load_clocks(&clocks_path(&path)).is_empty());
        // The next save has a "before" again and stamps normally.
        s.poll_interval_secs = 6;
        store::save(&path, &s).unwrap();
        assert!(load_clocks(&clocks_path(&path)).contains_key("poll_interval_secs"));
    }

    #[test]
    fn the_stamp_names_this_machine_when_the_registry_has_an_id() {
        let dir = tempdir().unwrap();
        let reg = crate::daemon::machines::MachineRegistry::load(dir.path());
        let id = reg.ensure_self().machine_id;
        let path = seeded(dir.path());
        let mut s = Settings::default();
        s.extra.insert("paceBand".into(), json!(4));
        store::save(&path, &s).unwrap();
        assert_eq!(load_clocks(&clocks_path(&path))["paceBand"].by, id);
    }

    #[test]
    fn a_clocks_file_missing_its_field_or_unparsable_never_loses_settings() {
        let dir = tempdir().unwrap();
        let path = clocks_path(&dir.path().join("settings.json"));
        std::fs::write(&path, "{}").unwrap();
        assert!(load_clocks(&path).is_empty());
        assert!(path.exists(), "a readable file is left in place");

        std::fs::write(&path, "not json").unwrap();
        assert!(load_clocks(&path).is_empty());
        assert!(path.with_extension("json.bad").exists(), "the broken file is kept for a look");
        assert!(!path.exists());
    }

    #[test]
    fn an_incoming_change_is_written_with_the_peers_stamp_and_is_not_restamped_by_the_next_save() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let local = store::load(&path);
        let at = "2026-11-15T10:00:00Z";
        let merged = apply_incoming(&path, &local, &[change("poll_interval_secs", json!(321), at)], now()).unwrap();
        assert_eq!(merged.applied, vec!["poll_interval_secs".to_string()]);

        let on_disk = store::load(&path);
        assert_eq!(on_disk.poll_interval_secs, 321);
        assert!(on_disk.settings_generation > local.settings_generation, "a stale frontend snapshot must be refused");
        let clocks = load_clocks(&clocks_path(&path));
        assert_eq!(clocks["poll_interval_secs"].at, at);
        assert_eq!(clocks["poll_interval_secs"].by, "mac");

        // Saving the merged settings again (any later save) is not an edit of that key.
        store::save(&path, &on_disk).unwrap();
        assert_eq!(load_clocks(&clocks_path(&path))["poll_interval_secs"].at, at);
        // A later edit of another key stamps only that key.
        let mut next = on_disk.clone();
        next.extra.insert("paceBand".into(), json!(2));
        store::save(&path, &next).unwrap();
        let clocks = load_clocks(&clocks_path(&path));
        assert_eq!(clocks["poll_interval_secs"].at, at);
        assert!(clocks.contains_key("paceBand"));
    }

    #[test]
    fn applying_to_the_live_settings_replaces_them_and_bumps_the_generation() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let live = Mutex::new(store::load(&path));
        let generation = live.lock().unwrap().settings_generation;
        let merged = apply_to_live(&live, &path, &[change("paceBand", json!(6), "2026-11-15T10:00:00Z")], now()).unwrap();
        assert_eq!(merged.applied, vec!["paceBand".to_string()]);
        let now_live = live.lock().unwrap().clone();
        assert_eq!(now_live.extra["paceBand"], json!(6));
        assert_eq!(now_live.settings_generation, generation + 1);
        assert_eq!(store::load(&path).extra["paceBand"], json!(6));

        // A refused change leaves the live copy alone.
        let before = live.lock().unwrap().clone();
        apply_to_live(&live, &path, &[change("hook_port", json!(1), "2026-11-15T10:00:00Z")], now()).unwrap();
        assert_eq!(*live.lock().unwrap(), before);
    }

    #[test]
    fn a_stamp_file_that_cannot_be_written_still_leaves_the_live_copy_matching_the_settings_file() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        // A directory where the stamps file belongs makes every write of it fail.
        std::fs::create_dir(clocks_path(&path)).unwrap();
        let live = Mutex::new(store::load(&path));
        let merged = apply_to_live(&live, &path, &[change("paceBand", json!(9), "2026-11-15T10:00:00Z")], now()).unwrap();
        assert_eq!(merged.applied, vec!["paceBand".to_string()]);
        assert_eq!(store::load(&path).extra["paceBand"], json!(9));
        assert_eq!(live.lock().unwrap().extra["paceBand"], json!(9), "live must not trail the file");
    }

    #[test]
    fn a_change_that_matches_what_this_machine_has_only_stores_its_stamp() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let live = Mutex::new(store::load(&path));
        let (before, file) = (live.lock().unwrap().clone(), std::fs::read_to_string(&path).unwrap());
        let same = change("poll_interval_secs", json!(before.poll_interval_secs), "2026-11-15T10:00:00Z");
        let merged = apply_to_live(&live, &path, &[same.clone()], now()).unwrap();
        assert!(merged.applied.is_empty(), "nothing to tell the app or the daemon about");
        assert_eq!(*live.lock().unwrap(), before, "no generation bump either");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), file, "the settings file is not rewritten");
        assert_eq!(load_clocks(&clocks_path(&path))["poll_interval_secs"].at, "2026-11-15T10:00:00Z");

        // With the stamps unwritable the same change comes round again and still ends
        // here, so a daemon that repeats it cannot start a write, push, repeat loop.
        std::fs::remove_file(clocks_path(&path)).unwrap();
        std::fs::create_dir(clocks_path(&path)).unwrap();
        for _ in 0..3 {
            assert!(apply_to_live(&live, &path, &[same.clone()], now()).unwrap().applied.is_empty());
        }
    }

    #[test]
    fn a_first_pair_keeps_the_old_machines_look_and_still_carries_its_later_edits() {
        // The old machine has a custom look from before stamping existed (written
        // without stamps, as an upgrade finds it).
        let old_dir = tempdir().unwrap();
        let old_path = old_dir.path().join("settings.json");
        let mut old_s = Settings::default();
        old_s.extra.insert("paceBand".into(), json!(20));
        old_s.extra.insert("overlayBackgroundStyle".into(), json!("card"));
        store::write_settings_file(&old_path, &old_s).unwrap();

        // The fresh machine's first Settings save writes the defaults its controls show.
        let new_dir = tempdir().unwrap();
        let new_path = seeded(new_dir.path());
        let mut fresh = Settings::default();
        fresh.extra.insert("paceBand".into(), json!(10));
        fresh.extra.insert("overlayBackgroundStyle".into(), json!("circles"));
        fresh.extra.insert("colorApplyTo".into(), json!({"dashboard": true, "overlay": true}));
        store::save(&new_path, &fresh).unwrap();

        // Fresh -> old: nothing was edited there, so nothing travels and the look stays.
        let sent = stamped_state(&store::load(&new_path), &peek_clocks(&clocks_path(&new_path)));
        assert!(sent.is_empty(), "defaults nobody chose must not be sent: {sent:?}");
        let merged = apply_incoming(&old_path, &store::load(&old_path), &sent, now()).unwrap();
        assert!(merged.applied.is_empty());
        assert_eq!(store::load(&old_path).extra["paceBand"], json!(20));
        assert_eq!(store::load(&old_path).extra["overlayBackgroundStyle"], json!("card"));

        // Old -> fresh: the old machine's first real edit reaches the fresh one.
        let mut edited = store::load(&old_path);
        edited.extra.insert("paceBand".into(), json!(25));
        store::save(&old_path, &edited).unwrap();
        let sent = stamped_state(&store::load(&old_path), &peek_clocks(&clocks_path(&old_path)));
        assert_eq!(sent.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), vec!["paceBand"]);
        let merged = apply_incoming(&new_path, &store::load(&new_path), &sent, now()).unwrap();
        assert_eq!(merged.applied, vec!["paceBand".to_string()]);
        assert_eq!(store::load(&new_path).extra["paceBand"], json!(25));
    }

    #[test]
    fn a_refused_incoming_change_writes_nothing() {
        let dir = tempdir().unwrap();
        let path = seeded(dir.path());
        let local = store::load(&path);
        let before = std::fs::read_to_string(&path).unwrap();
        let merged = apply_incoming(
            &path,
            &local,
            &[change("hook_port", json!(9), "2026-11-15T10:00:00Z"), change("projects", json!([]), "2026-11-15T10:00:00Z")],
            now(),
        )
        .unwrap();
        assert!(merged.applied.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(!clocks_path(&path).exists());
    }

    #[test]
    fn the_stamped_state_carries_only_stamped_personal_keys_with_their_current_values() {
        let mut s = Settings::default();
        s.poll_interval_secs = 90;
        s.hook_port = Some(7);
        let mut clocks = Clocks::new();
        let stamp = crate::settings::sync::Stamp { at: "2026-11-15T10:00:00Z".into(), by: "pc".into() };
        clocks.insert("poll_interval_secs".into(), stamp.clone());
        clocks.insert("paceBand".into(), stamp.clone()); // value went away: travels as null
        clocks.insert("hook_port".into(), stamp); // a stale or forged entry for a local key never travels
        let state = stamped_state(&s, &clocks);
        let keys: Vec<&str> = state.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, vec!["paceBand", "poll_interval_secs"]);
        assert_eq!(state[0].value, serde_json::Value::Null);
        assert_eq!(state[1].value, json!(90));
    }
}
