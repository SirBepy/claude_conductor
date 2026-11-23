//! A put-away project main chat and the family record that outlives the pause
//! (pc-1806 step 1; design in the todo and `docs/forever-chat-plan.md`).
//!
//! Not `sessions::hidden_chats` (`hidden-chats.json`): that is Joe's own list of
//! chat ids he hid from the sidebar, which pauses nothing and outlives its chat.
//! This is the "hidden" of a put-away: a flag on an open row plus a family record.
//!
//! Putting a main chat away deletes nothing: the chat stays an OPEN registry row
//! (an ended row leaves the snapshot) carrying `Instance::hidden_at`, and its
//! subs are paused at their next turn end. Two stores say so, and they are kept
//! true to each other:
//!
//! - the row flag `hidden_at`, persisted with the snapshot, which the lists read;
//! - `<data_dir>/subchats/<main>.hidden.json`, which the start and wake paths read
//!   through [`is_hidden_family`] and which names every sub the pause froze and the
//!   state it was in, so a reopen resumes exactly what the pause paused (and a
//!   daemon restart in between loses nothing).
//!
//! The record is written BEFORE the flag, so a crash between the two leaves a
//! hidden family with an unflagged row, which [`restore`] repairs at boot; the
//! reverse (a flag with no record) is repaired the same way. A record that exists
//! but cannot be read counts as hidden: a wake that wrongly starts a paused
//! family is the failure this record exists to stop, and the damaged text is kept
//! aside as `.bad` by `jsonfile`.
//!
//! Every field has `#[serde(default)]` (a newer build adds fields, an older one
//! must still read the file), and `reopen` keeps the paused-sub list until
//! `clear`, since the "Continue the plan?" answer comes after the user's own
//! message has already been delivered.

use super::decisions::{data_root, file_stem};
use super::jsonfile;
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serializes every read-modify-write of every record: a put-away and a reopen
/// racing on one family must not interleave a half-written list.
static LOCK: Mutex<()> = Mutex::new(());

/// What a sub was doing when the pause froze it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Prior {
    /// Between turns, nothing to continue.
    #[default]
    Idle,
    /// In a turn, on a background task or on an open card: reopening continues it.
    Working,
    /// It called its finish tool.
    Finished,
    /// Held without a child (`after`, the writer queue): the hold entry stays.
    Held,
    /// A state a newer build wrote that this one does not know.
    #[serde(other)]
    Unknown,
}

/// One sub the pause froze.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PausedSub {
    #[serde(default)]
    pub sub_id: String,
    /// The name the main chat gave it, for the "N subs paused" lines.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prior: Prior,
    /// Reopening must send it "continue": it was busy, ran a background task or
    /// waited on a card when the pause came.
    #[serde(default)]
    pub needs_continue: bool,
    /// RFC 3339 time it was frozen.
    #[serde(default)]
    pub paused_at: Option<String>,
    /// The paired machine that runs this sub (pc-1806 step 4): the pause was queued to it
    /// and a reopen's resume must go there. `None` for a sub on this machine. For a remote
    /// sub `prior` and `needs_continue` only say what the home knew: the host reads the
    /// real state off its own row when the pause reaches it.
    #[serde(default)]
    pub machine_id: Option<String>,
}

/// The durable record of one put-away main chat.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    /// When the family was put away; `None` once reopened (the gate is open, the
    /// subs below still wait for the resume answer).
    #[serde(default)]
    pub hidden_at: Option<String>,
    #[serde(default)]
    pub subs: Vec<PausedSub>,
}

/// `<root>/subchats/<main>.hidden.json`. The id is a session id the daemon
/// minted; the character filter only keeps a hostile one inside the folder.
pub(crate) fn path_in(root: &Path, main: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.hidden.json", file_stem(main)))
}

/// The text a record that exists but cannot be read stands for.
const UNREADABLE: &str = "unreadable record";

/// The record of `main`. `Ok(None)` is a family that was never put away (or was
/// cleared); a record that is damaged reads as hidden with no subs (see the module
/// docs), and `Err` is a file that exists but is locked right now.
pub(crate) fn read_in(root: &Path, main: &str) -> std::io::Result<Option<Record>> {
    read_path(&path_in(root, main))
}

/// [`read_in`] for any record file: the family's own and the host's paused-visitors one
/// ([`visiting_path_in`]) share the shape and the fail-closed reading.
fn read_path(path: &Path) -> std::io::Result<Option<Record>> {
    let path = path.to_path_buf();
    let Some((raw, value)) = jsonfile::read_json_guarded(&path)? else {
        return Ok(path.exists().then(|| Record { hidden_at: Some(UNREADABLE.to_string()), subs: Vec::new() }));
    };
    let serde_json::Value::Object(mut map) = value else {
        jsonfile::keep_bad_copy(&path, &raw, "it is not an object");
        return Ok(Some(Record { hidden_at: Some(UNREADABLE.to_string()), subs: Vec::new() }));
    };
    // A `hidden_at` of the wrong type is a damaged record, not an open one.
    let hidden_at = match map.remove("hidden_at") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(at)) => Some(at),
        Some(_) => {
            jsonfile::keep_bad_copy(&path, &raw, "hidden_at is not a time");
            Some(UNREADABLE.to_string())
        }
    };
    let parts = match map.remove("subs") {
        Some(serde_json::Value::Array(parts)) => parts,
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(_) => {
            jsonfile::keep_bad_copy(&path, &raw, "subs is not a list");
            Vec::new()
        }
    };
    Ok(Some(Record { hidden_at, subs: jsonfile::decode_parts(&path, &raw, parts, "subs") }))
}

fn write_in(root: &Path, main: &str, record: &Record) -> std::io::Result<()> {
    jsonfile::write_json(&path_in(root, main), record)
}

/// The record of `main` on this machine, if any.
pub fn read(main: &str) -> Option<Record> {
    read_in(&data_root()?, main).ok().flatten()
}

/// Whether `main`'s family is put away: nothing of it may start, wake or answer
/// until a reopen. The one question every start and wake path asks, keyed by the
/// id of the MAIN chat (a sub's id has no record and answers false). A record that
/// cannot be read now (locked) counts as hidden, since the cost of a wrong "no" is
/// a paused sub starting.
pub fn is_hidden_family(main: &str) -> bool {
    let Some(root) = data_root() else { return false };
    is_hidden_in(&root, main)
}

pub(crate) fn is_hidden_in(root: &Path, main: &str) -> bool {
    let closed = |read: std::io::Result<Option<Record>>| match read {
        Ok(record) => record.is_some_and(|r| r.hidden_at.is_some()),
        Err(_) => true,
    };
    // A visiting sub's family lives on its home: the home's own record says nothing on
    // the host, whose record of the same main id is the visiting one.
    closed(read_in(root, main)) || closed(read_path(&visiting_path_in(root, main)))
}

/// The id of the main chat whose put-away gates `id`: the chat's own parent when it
/// is a sub, else the chat itself. The start and wake paths hold a session id that
/// may be either, and the record is keyed by the main chat's.
pub fn family_main(state: &DaemonState, id: &str) -> String {
    state.registry.get(id).and_then(|i| i.subchat_of).unwrap_or_else(|| id.to_string())
}

/// Whether `id` (a main chat or one of its subs) is held back by a put-away: the
/// question every start and wake path asks when it holds a session id of either kind.
/// The main chat itself is held only while the family is put away (a reopen lets the
/// user's message in); a sub stays held until the reopen's answer has dealt with it
/// ([`is_paused_sub`]).
pub fn is_gated(state: &DaemonState, id: &str) -> bool {
    let main = family_main(state, id);
    if main == id {
        is_hidden_family(&main)
    } else {
        is_paused_sub(&main, id)
    }
}

/// Whether the pause of `main` still holds `sub_id`: the family is put away, or it was
/// reopened and the "Continue the plan?" answer has not dealt with this sub yet. A sub
/// the pause never froze (started after the reopen) is not held. A record that cannot be
/// read now holds, like [`is_hidden_family`].
pub fn is_paused_sub(main: &str, sub_id: &str) -> bool {
    let Some(root) = data_root() else { return false };
    is_paused_sub_in(&root, main, sub_id)
}

pub(crate) fn is_paused_sub_in(root: &Path, main: &str, sub_id: &str) -> bool {
    if is_hidden_in(root, main) {
        return true;
    }
    match read_in(root, main) {
        Ok(record) => record.is_some_and(|r| r.subs.iter().any(|s| s.sub_id == sub_id)),
        Err(_) => true,
    }
}

/// The subs a reopen left waiting for the "Continue the plan?" answer: empty while the
/// family is still put away (the pause is not over) and once every sub was dealt with.
/// `Err` when the record is locked right now.
pub fn awaiting(main: &str) -> std::io::Result<Vec<PausedSub>> {
    let Some(root) = data_root() else { return Ok(Vec::new()) };
    Ok(match read_in(&root, main)? {
        Some(r) if r.hidden_at.is_none() => r.subs,
        _ => Vec::new(),
    })
}

/// Whether wakes for `id`'s family stay queued: it is put away, or its reopen waits for
/// the answer, which drains the queue ([`reopen::resume_family`]). A wake for a main chat
/// the user is talking to would otherwise land before he has chosen what resumes.
pub fn holds_wakes(state: &DaemonState, id: &str) -> bool {
    let main = family_main(state, id);
    if is_hidden_family(&main) {
        return true;
    }
    // A sub started after the reopen is not in the record: its wakes are no part of
    // the choice the answer makes, so they are not held behind it.
    if main != id {
        return is_paused_sub(&main, id);
    }
    awaiting(&main).map_or(true, |subs| !subs.is_empty())
}

/// Takes `sub_ids` out of a reopened family's waiting list, so the gate stops holding
/// them; the record goes once nothing waits. A no-op while the family is put away, and
/// for an id the list does not name.
pub fn resolve(main: &str, sub_ids: &[String]) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    resolve_in(&root, main, sub_ids)
}

pub(crate) fn resolve_in(root: &Path, main: &str, sub_ids: &[String]) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut record) = read_in(root, main)? else { return Ok(()) };
    if record.hidden_at.is_some() {
        return Ok(());
    }
    let before = record.subs.len();
    record.subs.retain(|s| !sub_ids.contains(&s.sub_id));
    if record.subs.is_empty() {
        return match std::fs::remove_file(path_in(root, main)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if record.subs.len() != before {
        write_in(root, main, &record)?;
    }
    Ok(())
}

/// The prefix of every refusal a gate gives, load-bearing like `SESSION_BUSY:`: it
/// survives every transport as plain text, so a client can tell "put away" from a
/// failure.
pub const REFUSAL_PREFIX: &str = "PUT_AWAY:";

/// What a gate says when it refuses `id`.
pub fn refusal(id: &str) -> String {
    format!("{REFUSAL_PREFIX} the family of {id} is paused (put away, or reopened and waiting for the answer to \"Continue the plan?\"); reopen its main chat and answer that first")
}

/// The subs the pause froze, whether or not the chat is still put away. Tests only:
/// the daemon asks [`is_paused_sub`] for one sub, and the front end reads the row's
/// `hidden_at` for the chat.
#[cfg(test)]
pub fn paused_subs(main: &str) -> Vec<PausedSub> {
    read(main).map(|r| r.subs).unwrap_or_default()
}

/// Puts `main` away: the record first (`subs` is every sub this pause froze; while
/// the chat is already put away they are added to those an earlier pause recorded,
/// whose prior states stay, since a second pass finds them already frozen; after a
/// reopen they replace the old list), then the row flag, then the clients are told.
pub fn put_away(state: &DaemonState, main: &str, subs: Vec<PausedSub>, now: &str) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    put_away_in(&root, state, main, subs, now)
}

pub(crate) fn put_away_in(root: &Path, state: &DaemonState, main: &str, subs: Vec<PausedSub>, now: &str) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Only an open main chat has a record: a row that is missing, a sub or ended would
    // leave an orphan record holding the gate for good.
    if !state.registry.get(main).is_some_and(|i| !super::is_sub(&i) && i.ended_at.is_none() && i.end_reason.is_none()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an open main chat"));
    }
    let mut record = read_in(root, main)?.unwrap_or_default();
    if record.hidden_at.as_deref() == Some(UNREADABLE) {
        log::warn!("subchats: the hidden record of {main} was unreadable, so the earlier paused-sub list is lost (the damaged text is kept as .bad)");
    }
    // A reopened record still lists subs that may be running again or gone, so the pause
    // starts a new list: `subs` must name every sub this pause froze. While hidden, a
    // second pass only adds, and the first prior state of a sub stays.
    let reopened = record.hidden_at.is_none();
    if reopened {
        record.subs.clear();
    }
    // An unreadable record holds no sub list to keep; the stamp stays the first one.
    if record.hidden_at.as_deref().is_none_or(|t| t == UNREADABLE) {
        record.hidden_at = Some(now.to_string());
    }
    for sub in subs {
        if !record.subs.iter().any(|s| s.sub_id == sub.sub_id) {
            record.subs.push(sub);
        }
    }
    write_in(root, main, &record)?;
    if state.registry.set_hidden_at(main, record.hidden_at.clone()) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    Ok(())
}

/// Opens the gate for a reopen and returns the subs the pause froze, which stay
/// recorded until [`clear`] (the resume answer comes after the user's message).
/// The record is written first, so a crash between the two leaves an open record
/// with a flagged row, which [`restore`] repairs by trusting the record.
pub fn reopen(state: &DaemonState, main: &str) -> std::io::Result<Vec<PausedSub>> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    reopen_in(&root, state, main)
}

pub(crate) fn reopen_in(root: &Path, state: &DaemonState, main: &str) -> std::io::Result<Vec<PausedSub>> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut record = read_in(root, main)?.unwrap_or_default();
    if record.hidden_at.as_deref() == Some(UNREADABLE) {
        log::warn!("subchats: the hidden record of {main} was unreadable, so no paused sub can be resumed (the damaged text is kept as .bad)");
    }
    if record.hidden_at.is_some() {
        record.hidden_at = None;
        write_in(root, main, &record)?;
    }
    if state.registry.set_hidden_at(main, None) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    Ok(record.subs)
}

/// Forgets what the pause froze, once the resume (or the user's "No") has dealt
/// with every sub. Never touches the flag: a still-hidden family stays hidden.
pub fn clear(main: &str) -> std::io::Result<()> {
    let root = data_root().ok_or_else(jsonfile::no_data_dir)?;
    clear_in(&root, main)
}

pub(crate) fn clear_in(root: &Path, main: &str) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if read_in(root, main)?.is_some_and(|r| r.hidden_at.is_some()) {
        return Ok(());
    }
    match std::fs::remove_file(path_in(root, main)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Brings the row flags in line with the records after a restart or a crash
/// between the two writes: a record that says hidden flags its row, an open
/// record unflags it, and a flagged row with no record at all is unflagged too:
/// a put-away writes the record first, so the only way a flag outlives its record
/// is a reopen that was cleared before the snapshot caught up. A damaged record
/// never rewrites the row's flag. Returns whether any row changed, so the caller
/// publishes only then. Boot runs it.
pub fn restore(state: &DaemonState) -> bool {
    let Some(root) = data_root() else { return false };
    restore_in(&root, state)
}

pub(crate) fn restore_in(root: &Path, state: &DaemonState) -> bool {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut changed = false;
    for row in state.registry.list() {
        if super::is_sub(&row) || row.ended_at.is_some() || row.end_reason.is_some() {
            continue;
        }
        let record = match read_in(root, &row.session_id) {
            Ok(r) => r,
            Err(_) => continue,
        };
        match (record, row.hidden_at.clone()) {
            (Some(r), flagged) if r.hidden_at != flagged && r.hidden_at.as_deref() != Some(UNREADABLE) => {
                changed |= state.registry.set_hidden_at(&row.session_id, r.hidden_at);
            }
            (None, Some(_)) => {
                changed |= state.registry.set_hidden_at(&row.session_id, None);
            }
            _ => {}
        }
    }
    if changed {
        crate::daemon::machines::publish_instances_changed(state);
    }
    changed
}

mod rows;
pub use rows::{family_of, retain_visible_json, without_family};

mod visiting;
pub(crate) use visiting::visiting_path_in;
pub use visiting::{visiting_forget, visiting_pause, visiting_resume};

mod reopen;
pub use reopen::{begin_resume, paused_view, reopen_main, resume_family, run_resume, settle, ReopenError, ResumePlan, ResumeTiming};

mod flow;
pub(crate) use flow::{pause_sub, paused_sub_for};
pub use flow::{is_project_main_chat, pause_now, refuse_respawn, start, Refused, Timing, NOTE, RESPAWN_REFUSAL};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod reopen_tests;
