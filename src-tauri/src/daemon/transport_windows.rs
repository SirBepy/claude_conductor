//! Windows named-pipe transport for the daemon. Per-platform accept loop; the
//! handshake + request/notification loop is shared via `transport_common`.

#![cfg(windows)]

use crate::daemon::frame::FrameError;
use crate::daemon::rpc::Router;
use crate::daemon::transport_common::serve_connection;
use std::io;
use std::os::windows::io::AsRawHandle;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

/// Best-effort lookup of the PID owning the client end of a connected named
/// pipe. Used only for diagnostic logging when a client sends a garbage frame
/// (e.g. raw, unframed JSON from an old pre-frame-protocol binary), so we can
/// correlate the noise to the owning process. Returns `None` if the Win32 call
/// fails (cheap, never fatal).
fn client_pid(pipe: &NamedPipeServer) -> Option<u32> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let handle = HANDLE(pipe.as_raw_handle() as _);
    let mut pid: u32 = 0;
    // SAFETY: `handle` is a live server-side pipe handle owned by `pipe` for the
    // duration of this call; `pid` is a valid out pointer.
    unsafe { GetNamedPipeClientProcessId(handle, &mut pid).ok().map(|_| pid) }
}

/// Pipe name for an explicit instance suffix, bypassing `instance::
/// instance_suffix()` so callers can probe a DIFFERENT identity than the one
/// this process would otherwise use (see `daemon_client::ensure_daemon`'s
/// production-attach probe, and the `daemon_client` pipe-health test). The
/// single place that builds the Windows pipe name string - ai_todo 267.
pub fn pipe_name_for_suffix(suffix: &str) -> String {
    // SID-based naming is added in a later phase. For Phase 1, a per-user
    // suffix via USERNAME is sufficient on a single dev machine.
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    format!(r"\\.\pipe\cc-conductor-daemon-{user}{suffix}")
}

/// Pipe name for the current process's own instance identity. The instance
/// suffix (empty in production) isolates test daemons (ai_todo 71).
pub fn pipe_name_for_user() -> String {
    pipe_name_for_suffix(&crate::daemon::instance::instance_suffix())
}

pub async fn accept_loop(pipe_name: &str, router: Router) -> io::Result<()> {
    // First server instance must be created with `first_pipe_instance(true)`.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)?;

    loop {
        // Transient connect errors (e.g. ERROR_NO_DATA on close-race) should
        // log and continue, not kill the daemon. We only abort on errors
        // creating the NEXT server, which would mean the pipe is unusable.
        if let Err(e) = server.connect().await {
            log::warn!("daemon: pipe connect failed, retrying: {e}");
            server = ServerOptions::new().create(pipe_name)?;
            continue;
        }
        let connected = server;
        // Capture the client PID up front: `connected` is moved into the task
        // below, so the owning process can't be looked up at the log site.
        let peer_pid = client_pid(&connected);
        // Pre-create the next server BEFORE handling the current client so the
        // pipe stays open for the next connection (standard tokio pattern).
        server = ServerOptions::new().create(pipe_name)?;

        let router_clone = router.clone();
        tokio::spawn(async move {
            let pid_str = peer_pid.map_or_else(|| "unknown".to_string(), |p| p.to_string());
            log::debug!("daemon: client pid {pid_str} connected");
            match serve_connection(connected, router_clone).await {
                // 2026-07-11 incident follow-up: the app kept seeing "early eof"
                // pipe drops with nothing in this log to pair them with, because
                // clean closes were silent. Log every close with the peer pid so
                // the next recurring-drop investigation can tell WHO disconnected
                // (or was disconnected) and how often.
                Ok(()) => log::info!("daemon: client pid {pid_str} disconnected"),
                Err(e) => match e {
                    // A garbage length means the byte stream desynced: a JSON
                    // payload's first 4 bytes decode to a ~2GB big-endian length.
                    // Warn, never debug - logging this at debug is why todo 228
                    // read the daemon as closing these connections silently.
                    FrameError::TooLarge(len) => {
                        log::warn!(
                            "daemon: dropped unframed/garbage frame (len {len}) from pid {pid_str}"
                        );
                    }
                    other => {
                        log::warn!("daemon: connection ended with error: {other} (pid {pid_str})");
                    }
                },
            }
        });
    }
}
