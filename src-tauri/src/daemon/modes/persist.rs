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
}

pub fn config_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("modes{suffix}.json")))
}

pub fn config_path() -> Option<PathBuf> {
    config_path_for(&crate::daemon::instance::instance_suffix())
}

pub fn load() -> Loaded {
    match config_path() {
        Some(path) => load_at(&path),
        None => Loaded::Missing,
    }
}

/// The current mode; a missing or unreadable file is "no mode".
pub fn current() -> ModeState {
    match load() {
        Loaded::Ok(state) => state,
        Loaded::Missing | Loaded::Bad => ModeState::default(),
    }
}

pub fn load_at(path: &Path) -> Loaded {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
        Err(e) => {
            log::warn!("modes: read of {} failed: {e}", path.display());
            return Loaded::Bad;
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

pub fn save(state: &ModeState) {
    if let Some(path) = config_path() {
        save_at(&path, state);
    }
}

pub fn save_at(path: &Path, state: &ModeState) {
    let json = match serde_json::to_string_pretty(state) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("modes: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("modes: write failed: {e}");
    }
}
