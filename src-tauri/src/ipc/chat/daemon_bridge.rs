//! Bridges daemon per-session `chat_event` notifications onto the app's
//! `chat:<id>` Tauri events (which the frontend renderer already consumes).
//! Every chat turn runs in the daemon (Path C was removed in Phase 7), so
//! this bridge is the only source of `chat:<id>` events.

use crate::state::AppState;
use crate::types::chat::ChatEvent;
use tauri::{AppHandle, Emitter, Manager};

/// Force a fresh daemon attach for `session_id`, even if we believe we are
/// already attached at the current epoch: unconditionally drops the
/// `attached_sessions` entry so `ensure_attached` below treats it as a miss.
pub async fn reattach(app: &AppHandle, session_id: &str) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        state.attached_sessions.lock().unwrap().remove(session_id);
    }
    ensure_attached(app, session_id).await
}

/// Ensure a pump task is running for `session_id` at its current
/// `channel_epoch`; a cached-epoch mismatch forces a fresh attach.
pub async fn ensure_attached(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let epoch = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .map(|i| i.channel_epoch)
        .unwrap_or(0);
    {
        let mut map = state.attached_sessions.lock().unwrap();
        if map.get(session_id) == Some(&epoch) {
            return Ok(());
        }
        map.insert(session_id.to_string(), epoch);
    }

    let mut rx = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        match client.attach_session(session_id).await {
            Ok(rx) => rx,
            Err(e) => {
                let mut map = state.attached_sessions.lock().unwrap();
                if map.get(session_id) == Some(&epoch) {
                    map.remove(session_id);
                }
                return Err(e.to_string());
            }
        }
    };

    let app = app.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if let Some(ev_val) = frame.pointer("/params/event") {
                if let Ok(ev) = serde_json::from_value::<ChatEvent>(ev_val.clone()) {
                    let _ = app.emit(&format!("chat:{}", sid), &ev);
                }
            }
        }
        let state = app.state::<AppState>();
        let mut map = state.attached_sessions.lock().unwrap();
        // Only clear if still ours: a later epoch bump may have already
        // replaced this entry, and its own task owns clearing it now.
        if map.get(&sid) == Some(&epoch) {
            map.remove(&sid);
        }
    });

    Ok(())
}
