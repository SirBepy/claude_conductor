//! On-disk state for modes: `<app_data>/modes{instance_suffix}.json`.
//!
//! Unlike `gaming_mode::persist`, which reads a parse error as "off", a file
//! that exists but cannot be read is moved aside to `.bad` and reported as
//! such: a mode that carries `pause_chats` must never be silently forgotten
//! because one byte was wrong.

use super::ModeState;
use std::path::{Path, PathBuf};

/// What a read of the state file found.
#[derive(Debug, PartialEq)]
pub enum Loaded {
    /// No file: no mode was ever set on this daemon instance.
    Missing,
    Ok(ModeState),
    /// The file did not parse and was moved to `.bad`; the caller starts clear.
    Bad,
    /// The file exists and could not be read at all (a lock held by another
    /// program, a permission error). Not the same as no mode: a transition that
    /// writes must not go on as if there were none.
    Unreadable,
}

pub fn config_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("modes{suffix}.json")))
}

pub fn config_path() -> Option<PathBuf> {
    config_path_for(&crate::daemon::instance::instance_suffix())
}

/// The read for look-only callers, including the hooks that run on every tool
/// batch: two tries 20 ms apart (the sleep only happens after a failure), enough to
/// ride out the instant an atomic replace holds the file, so a chat is not told "the
/// mode ended" for a mode that is still on.
pub fn load() -> Loaded {
    match config_path() {
        Some(path) => load_at(&path, 2),
        None => Loaded::Missing,
    }
}

/// The read a transition decides on: a failed read is retried a few times first.
pub fn load_for_write() -> Loaded {
    match config_path() {
        Some(path) => load_at(&path, 4),
        None => Loaded::Missing,
    }
}

/// The current mode, for readers that only look (the hooks, the mute check, `GET`):
/// an unreadable file reads as "no mode" for that one look, and the next look tries again.
pub fn current() -> ModeState {
    match load() {
        Loaded::Ok(state) => state,
        Loaded::Missing | Loaded::Bad | Loaded::Unreadable => ModeState::default(),
    }
}

pub fn load_at(path: &Path, attempts: u32) -> Loaded {
    let text = match read_with_retry(path, attempts) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
        Err(e) => {
            log::warn!("modes: read of {} failed: {e}", path.display());
            return Loaded::Unreadable;
        }
    };
    match serde_json::from_str::<ModeState>(&text) {
        Ok(state) => Loaded::Ok(state),
        Err(e) => {
            let bad = path.with_extension("json.bad");
            log::warn!("modes: {} is unreadable ({e}); kept as {}", path.display(), bad.display());
            if let Err(e) = std::fs::rename(path, &bad) {
                log::warn!("modes: could not keep the unreadable file: {e}");
            }
            Loaded::Bad
        }
    }
}

/// A read that fails for any reason but "not there" is tried again a few times: on
/// Windows the atomic replace that writes the file can make a concurrent read fail
/// with a sharing violation, and reading that as "no mode" would clear a mode (and
/// skip gaming's resume) for no reason.
fn read_with_retry(path: &Path, attempts: u32) -> std::io::Result<String> {
    let attempts = attempts.max(1);
    let mut last = None;
    for attempt in 0..attempts {
        match std::fs::read_to_string(path) {
            Ok(t) => return Ok(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(e) => {
                last = Some(e);
                if attempt + 1 < attempts {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        }
    }
    Err(last.expect("the loop ran at least once"))
}

/// Whether the state reached the disk. A transition that parks chats must not go on
/// when it did not: the mode would read as "none" while the chats stay parked.
pub fn save(state: &ModeState) -> bool {
    match config_path() {
        Some(path) => save_at(&path, state),
        None => false,
    }
}

pub fn save_at(path: &Path, state: &ModeState) -> bool {
    let json = match serde_json::to_string_pretty(state) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("modes: serialize failed: {e}");
            return false;
        }
    };
    match crate::util::write_json_atomic(path, &json) {
        Ok(_) => true,
        Err(e) => {
            log::warn!("modes: write failed: {e}");
            false
        }
    }
}
