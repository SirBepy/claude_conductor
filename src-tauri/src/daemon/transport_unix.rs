//! Unix-domain-socket transport for the daemon (macOS + Linux). Mirrors the
//! Windows named-pipe transport; the handshake + request loop is shared via
//! `transport_common`. The socket lives under the app data dir so the client
//! and daemon derive the identical path.

#![cfg(unix)]

use crate::daemon::rpc::Router;
use crate::daemon::transport_common::serve_connection;
use std::io;
use std::path::PathBuf;
use tokio::net::UnixListener;

/// Socket path for an explicit instance suffix, bypassing `instance::
/// instance_suffix()` so callers can probe a DIFFERENT identity than the one
/// this process would otherwise use. The single place that builds the Unix
/// socket path string - ai_todo 267.
pub fn socket_path_for_suffix(suffix: &str) -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    p.push("claude-conductor");
    p.push(format!("cc-conductor-daemon{suffix}.sock"));
    p
}

/// Socket path for the current user, matching the named-pipe naming on
/// Windows. The instance suffix (empty in production) isolates test daemons
/// (ai_todo 71).
pub fn socket_path_for_user() -> PathBuf {
    socket_path_for_suffix(&crate::daemon::instance::instance_suffix())
}

pub async fn accept_loop(socket_path: &std::path::Path, router: Router) -> io::Result<()> {
    // The data dir is created by run_daemon_main, but be defensive.
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A leftover socket file from a previous run makes bind() fail with
    // EADDRINUSE even though nothing is listening. The lockfile already
    // guarantees we're the only daemon, so removing it here is safe.
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)?;
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let router_clone = router.clone();
                tokio::spawn(async move {
                    // Log clean closes too (parity with the Windows transport):
                    // silent disconnects made the 2026-07-11 pipe-drop incident
                    // undiagnosable from this side.
                    match serve_connection(stream, router_clone).await {
                        Ok(()) => log::info!("daemon: client disconnected"),
                        Err(e) => log::warn!("daemon: connection ended with error: {e}"),
                    }
                });
            }
            Err(e) => {
                // Transient accept errors should log and continue, not kill the
                // daemon (mirrors the Windows connect-error handling).
                log::warn!("daemon: unix accept failed, retrying: {e}");
            }
        }
    }
}
