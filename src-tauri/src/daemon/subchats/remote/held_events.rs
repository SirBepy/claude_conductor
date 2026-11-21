//! The events of a visiting sub that arrive while its main chat is put away
//! (pc-1806 step 4), kept on the home until the chat is reopened.
//!
//! A put-away family draws nothing and starts nothing, and an event is what draws a card,
//! wakes the main chat, lands a finished sub's commits and releases the `after` chains
//! behind it. The home therefore ACKS an event it receives while hidden (the host's outbox
//! drops it, and the number is noted so a replay does nothing) and keeps the event itself
//! here, in arrival order, until `home::release_held_events` applies each one after the
//! reopen. `<data_dir>/subchats/<main>.remote-held.json`, a JSON list; an entry that will
//! not decode costs only itself (the whole text is kept as `.bad`, `jsonfile`).

use super::events::SubEvent;
use crate::daemon::subchats::decisions::file_stem;
use crate::daemon::subchats::jsonfile;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The most events kept for one family. A put-away chat can stay away for days with several
/// subs talking; past this the home answers the host with an internal error, which its outbox
/// retries on every pass (50 times at most, `outbox::MAX_UNDECIDED_ATTEMPTS`, then it drops the
/// entry), so nothing grows without end and a list that drains in time loses nothing.
pub const MAX_HELD: usize = 500;

/// One event waiting for the reopen.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Held {
    /// The machine the event arrived from (`ctx.transport`), checked again when it is applied.
    #[serde(default)]
    pub machine_id: String,
    /// `None` only for an entry written by a build this one cannot read the event of.
    #[serde(default)]
    pub req: Option<SubEvent>,
}

/// Serializes read-modify-write of every file. Never held across an await.
static LOCK: Mutex<()> = Mutex::new(());

fn path_in(root: &Path, main: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.remote-held.json", file_stem(main)))
}

/// What keeping an event came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Kept {
    Kept,
    /// The event was already kept (a resend of the same number): nothing was added.
    Already,
    /// The family's list is full: the caller refuses the event so the host sends it again.
    Full,
}

/// Keeps `req` for `main`, after the ones already kept.
pub fn hold(root: &Path, main: &str, machine_id: &str, req: &SubEvent) -> std::io::Result<Kept> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = path_in(root, main);
    let mut all: Vec<Held> = jsonfile::read_list_guarded(&path)?;
    if all.iter().any(|h| h.req.as_ref().is_some_and(|r| r.sub_id == req.sub_id && r.seq == req.seq)) {
        return Ok(Kept::Already);
    }
    if all.len() >= MAX_HELD {
        return Ok(Kept::Full);
    }
    all.push(Held { machine_id: machine_id.to_string(), req: Some(req.clone()) });
    jsonfile::write_json(&path, &all)?;
    Ok(Kept::Kept)
}

/// The events kept for `main`, oldest first. `Err` when the file is locked right now.
pub fn read(root: &Path, main: &str) -> std::io::Result<Vec<Held>> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    jsonfile::read_list_guarded(&path_in(root, main))
}

/// Whether an event is waiting for `main`. A file that cannot be read right now counts as
/// waiting: a live event must never overtake the ones kept before it.
pub fn any(root: &Path, main: &str) -> bool {
    read(root, main).map_or(true, |all| all.iter().any(|h| h.req.is_some()))
}

/// Takes one event off the list once it was applied (or can never be). The file goes with the last.
/// An entry this build cannot read the event of is never taken: a newer build may.
pub fn remove(root: &Path, main: &str, sub_id: &str, seq: u64) -> std::io::Result<()> {
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = path_in(root, main);
    let mut all: Vec<Held> = jsonfile::read_list_guarded(&path)?;
    all.retain(|h| h.req.as_ref().map_or(true, |r| !(r.sub_id == sub_id && r.seq == seq)));
    if all.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    jsonfile::write_json(&path, &all)
}
