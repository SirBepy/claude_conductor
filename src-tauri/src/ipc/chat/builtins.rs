//! Built-in slash command IPC handlers. Currently just `clear_session`
//! (used by the frontend's `/clear` built-in handler).

use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn clear_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Kill the underlying claude so closing a chat actually TERMINATES it, not
    // just hides the row. External sessions (the user's own `claude` terminal)
    // are killed by pid here. Interactive (daemon-hosted) chats run a long-lived
    // `claude` in the daemon's SessionMap: `mark_session_ended` only flags the
    // registry entry and does NOT kill that process, so before this fix a closed
    // chat kept running (a leak - still visible via `list_instances`, e.g. on the
    // remote/mobile client). `end_session` closes stdin, waits up to 3s for a
    // clean exit, then force-kills the tree + removes the MCP config.
    let cached = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned();
    let is_interactive = cached
        .as_ref()
        .map(|i| i.kind == crate::sessions::kinds::InstanceKind::Interactive)
        .unwrap_or(false);
    if let Some(inst) = &cached {
        if inst.kind == crate::sessions::kinds::InstanceKind::External && inst.pid != 0 {
            let _ = crate::channels::kill::kill_tree(inst.pid);
        }
    }

    if let Some(client) = state.client().await {
        if is_interactive {
            // Fire-and-forget the graceful subprocess teardown. Awaiting
            // end_session blocks for up to 3 seconds (stdin close + wait +
            // force-kill), which kept the session alive in the registry long
            // enough for race conditions to re-surface it in the sidebar (delayed
            // instances_changed broadcasts arriving after stickyExitKeys cleared,
            // segment expansions during the kill window, etc.).  Spawning here
            // lets mark_session_ended + reseed run immediately so the sidebar
            // reflects the session as gone the moment the animation plays.
            // end_session still cleans up the subprocess and MCP config in the
            // background; the cloned client shares the same pipe via Arc.
            let client_bg = client.clone();
            let session_id_bg = session_id.clone();
            tokio::spawn(async move {
                let _ = client_bg.end_session(&session_id_bg).await;
            });
        }
        let _ = client.mark_session_ended(&session_id).await;
        // Re-seed the instance cache directly rather than waiting for the
        // `instances_changed` notification: that broadcast is lossy (can be
        // dropped under pipe backpressure), and if the frame carrying this
        // session's `ended_at` is dropped, `cached_instances` stays stale and
        // the closed chat reappears in the sidebar on the next window reopen.
        // Same direct-sync pattern register_historical uses for the inverse race.
        crate::daemon_link::fetch_and_reseed_instances(&client, &state).await;
    }
    Ok(())
}
