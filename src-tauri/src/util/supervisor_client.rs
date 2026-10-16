//! Shared location/credentials for the standalone `server_supervisor` app's
//! loopback API. `daemon::gaming_mode::executor` (blocking reqwest) and
//! `ipc::servers` (async reqwest) both used to re-derive this directory and
//! re-read the same two files independently (todo 1139) - this is the one
//! place either of them reads it from now, so the two can't drift on where
//! the config lives.

use std::path::PathBuf;

/// Directory `server_supervisor` writes its loopback API token/port into.
pub fn supervisor_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("com.sirbepy.server-supervisor").join("supervisor"))
}

pub fn read_trimmed(path: PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `(token, port)` for the supervisor's loopback API, or `None` when the
/// supervisor isn't running / hasn't written its config yet.
pub fn supervisor_config() -> Option<(String, String)> {
    let dir = supervisor_dir()?;
    let token = read_trimmed(dir.join("api_token.txt"))?;
    let port = read_trimmed(dir.join("api_port.txt"))?;
    Some((token, port))
}
