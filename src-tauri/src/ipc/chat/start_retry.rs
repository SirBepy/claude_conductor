//! Daemon session-start retry path, extracted from `run.rs`'s
//! `start_session_daemon` (todo 827: keep `run.rs` under the module-size
//! rule while `start_session_daemon`'s happy path stays there).

use crate::daemon_client::ClientError;
use crate::state::AppState;
use tauri::State;

/// Errors where the daemon may well have done the work and only the reply was
/// lost. An `Rpc` error is its considered answer and never qualifies.
pub(crate) fn is_transport_error(e: &ClientError) -> bool {
    matches!(e, ClientError::Closed | ClientError::Io(_) | ClientError::Frame(_) | ClientError::Handshake(_))
}

/// Block until `daemon_link` installs a connection newer than `stale_generation`.
/// Bounded at ~10s so a daemon that never returns can't hang the IPC command.
pub(crate) async fn wait_for_reconnect(state: &State<'_, AppState>, stale_generation: u64) {
    for _ in 0..100 {
        let current = { state.daemon_client.lock().await.clone() };
        match current {
            Some(c) if c.generation != stale_generation => return,
            _ => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
}

/// Run `spawn`, retrying once if the reply was merely lost to a transport
/// error rather than a considered RPC rejection: the daemon's spawn is not
/// cancelled by a dead connection, so retrying under the same placeholder id
/// resolves to that same session instead of stranding it (todo 228).
pub(crate) async fn start_session_with_retry<F, Fut>(state: &State<'_, AppState>, spawn: F) -> Result<String, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<String, (u64, ClientError)>>,
{
    match spawn().await {
        Ok(id) => Ok(id),
        Err((generation, e)) if is_transport_error(&e) => {
            log::warn!("start_session lost the daemon connection on generation {generation} ({e}); retrying once");
            wait_for_reconnect(state, generation).await;
            spawn().await.map_err(|(_, e)| e.to_string())
        }
        Err((_, e)) => Err(e.to_string()),
    }
}
