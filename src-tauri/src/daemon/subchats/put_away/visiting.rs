//! The host's half of a put-away (pc-1806 step 4): what a paired machine keeps for the
//! visiting subs of a main chat that was put away on its home.
//!
//! A visiting sub's `subchat_of` is the HOME's main chat id, so every gate door on the host
//! (`is_gated`, `family_main`) already asks [`super::is_hidden_family`] with that id. The
//! family's own record (`<main>.hidden.json`) belongs to the machine that owns the main chat
//! and is never written for a chat this machine does not have, so the host keeps a second
//! file of the same shape, `<main>.visiting-paused.json`, that [`super::is_hidden_in`] reads
//! too. It is written BEFORE the pause starts, and the gate it closes holds every start and
//! wake of the family's subs here until the home sends `sub_resume`.
//!
//! The record lists the subs this machine paused so `visiting_forget` can open the gate
//! when the last one ends or leaves; `hidden_at` is the gate itself: the first resume opens
//! it (as a reopen opens the home's), the subs stay listed and frozen until each is resumed
//! or ends, and the file goes when the list is empty.

use super::*;

/// `<root>/subchats/<main>.visiting-paused.json`; `main` is the HOME's main chat id.
pub(crate) fn visiting_path_in(root: &Path, main: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.visiting-paused.json", file_stem(main)))
}

/// Records `sub` as paused for the home's main chat `main` and closes the gate on this
/// machine. A second call for the same sub keeps the first prior state (the pause may be
/// resent through the outbox after a lost reply).
pub fn visiting_pause(main: &str, sub: PausedSub, now: &str) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    visiting_pause_in(&root, main, sub, now)
}

pub(crate) fn visiting_pause_in(root: &Path, main: &str, sub: PausedSub, now: &str) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = visiting_path_in(root, main);
    let mut record = read_path(&path)?.unwrap_or_default();
    // A pause after a resume closes the gate again; an unreadable record keeps it shut and
    // holds no list worth keeping (the damaged text stays aside as `.bad`).
    if record.hidden_at.as_deref().is_none_or(|t| t == UNREADABLE) {
        record.hidden_at = Some(now.to_string());
    }
    if !record.subs.iter().any(|s| s.sub_id == sub.sub_id) {
        record.subs.push(sub);
    }
    jsonfile::write_json(&path, &record)
}

/// The home resumed `sub_id`: the gate opens (the home's reopen already did) and the sub
/// leaves the list. The other paused subs stay listed, and frozen, until each is resumed.
pub fn visiting_resume(main: &str, sub_id: &str) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    visiting_leave_in(&root, main, sub_id, true)
}

/// `sub_id` ended or left the family on this machine: it leaves the list; the gate stays
/// as it was, and the file goes with the last sub.
pub fn visiting_forget(main: &str, sub_id: &str) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    visiting_leave_in(&root, main, sub_id, false)
}

pub(crate) fn visiting_leave_in(root: &Path, main: &str, sub_id: &str, open: bool) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = visiting_path_in(root, main);
    let Some(mut record) = read_path(&path)? else { return Ok(()) };
    record.subs.retain(|s| s.sub_id != sub_id);
    if open {
        record.hidden_at = None;
    }
    // A damaged record names no subs, so its list is empty from the first call: only a
    // resume (the home asked for the gate to open) drops it, never a forget, which would
    // let any ending sub lift a gate the file can no longer explain.
    let damaged = record.hidden_at.as_deref() == Some(UNREADABLE);
    if record.subs.is_empty() && (open || !damaged) {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    jsonfile::write_json(&path, &record)
}
