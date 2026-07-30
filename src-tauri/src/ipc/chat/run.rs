//! Per-turn chat execution (daemon-backed).
//!
//! - `start_session`: first turn. Spawns the session in the daemon via RPC,
//!   bridges its events to `chat:<real_id>`, and hands the real id to the
//!   frontend via a synthetic `SessionStarted` on the placeholder channel.
//! - `send_message`: subsequent turns on an existing daemon session.
//! - `cancel_turn`: cancels the in-flight turn via daemon RPC.
//!
//! Mutations to the Registry also emit `instances-changed` (per existing
//! convention, the IPC layer fires it after the registry call).

use crate::state::AppState;
use crate::types::chat::{ChatEvent, ContentBlock};
use chrono::Utc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn start_session(
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    remote: bool,
    placeholder_id: Option<String>,
    account_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    start_session_daemon(cwd, prompt, model, effort, remote, placeholder_id, account_id, &state, &app).await
}

/// Daemon-backed new session: spawn via RPC, bridge events, hand the real id
/// to the frontend via a synthetic SessionStarted on the placeholder channel.
async fn start_session_daemon(
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    remote: bool,
    placeholder_id: Option<String>,
    account_id: Option<String>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<String, String> {
    let real_id = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        // account_id: Some when the new-chat picker (milestone 04) has the
        // user's explicit pick; None (unbound project, default untouched)
        // resolves to Settings.default_account_id daemon-side (see
        // docs/multi-account/02-chat-routing.md step 5).
        client.start_session(&cwd, &model, &effort, None, remote, account_id.as_deref()).await.map_err(|e| e.to_string())?
    };

    // Bridge daemon chat_event -> chat:<real_id> BEFORE sending the prompt so
    // no turn events are missed.
    super::daemon_bridge::ensure_attached(app, &real_id).await?;

    // Hand the real id to the frontend: emit a synthetic SessionStarted on the
    // placeholder channel the frontend is listening on. The frontend swaps its
    // renderer subscription to chat:<real_id>, matching Path C.
    if let Some(ph) = placeholder_id.as_deref() {
        let synthetic = ChatEvent::SessionStarted {
            session_id: real_id.clone(),
            model: model.clone(),
            cwd: cwd.clone(),
            timestamp: Utc::now().timestamp_millis(),
        };
        let _ = app.emit(&format!("chat:{}", ph), &synthetic);
    }

    // Send the first turn's prompt. Events flow over the attached bridge.
    {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        client.send_message(&real_id, &prompt).await.map_err(|e| e.to_string())?;
    }

    // Reseed cached_instances immediately so the Sessions view's list_instances
    // call sees the new session before the async instances_changed notification
    // arrives (same race that register_historical_session avoids: the daemon
    // notification travels via a lossy broadcast and can arrive after the
    // frontend's pending-pane clears pendingNewSession and fires the
    // instances-changed pane-clear check, which then finds the session missing
    // and blanks the pane).
    {
        let guard = state.daemon_client.lock().await;
        if let Some(client) = guard.as_ref() {
            crate::daemon_link::fetch_and_reseed_instances(client, state).await;
        }
    }

    Ok(real_id)
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    cwd: String,
    blocks: Vec<ContentBlock>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let prompt = blocks_to_prompt_text(&blocks);
    let (model, effort, account_id) = {
        let inst = state
            .cached_instances
            .lock()
            .unwrap()
            .iter()
            .find(|i| i.session_id == session_id)
            .cloned();
        match inst {
            // Model/effort fall back to defaults when unset (e.g. a
            // `register_historical_session` entry never had them recorded),
            // but account_id must NOT ride on that same guard - a historical
            // session's account was just explicitly picked in the "Continue
            // this chat" flow and lives on the instance regardless of
            // whether model/effort are empty. Coupling the two silently
            // dropped account_id to None, which then resolved to
            // `Settings.default_account_id` (often unset) instead of the
            // account the user chose.
            Some(i) => {
                let (model, effort) = if !i.model.is_empty() && !i.effort.is_empty() {
                    (i.model.clone(), i.effort.clone())
                } else {
                    ("opus".to_string(), "high".to_string())
                };
                (model, effort, i.account_id.clone())
            }
            None => ("opus".to_string(), "high".to_string(), None),
        }
    };

    send_message_daemon(&session_id, &cwd, &prompt, &model, &effort, account_id.as_deref(), &state, &app).await
}

/// Daemon-backed turn on an existing session. If the daemon no longer holds the
/// session, respawn with resume_id and retry once.
async fn send_message_daemon(
    session_id: &str,
    cwd: &str,
    prompt: &str,
    model: &str,
    effort: &str,
    account_id: Option<&str>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<String, String> {
    super::daemon_bridge::ensure_attached(app, session_id).await.ok();

    // First attempt.
    let first = {
        let guard = state.daemon_client.lock().await;
        let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
        client.send_message(session_id, prompt).await
    };

    match first {
        Ok(()) => Ok(session_id.to_string()),
        Err(crate::daemon_client::ClientError::Rpc { code: -32004, .. }) => {
            // Session not live in the daemon: respawn with resume_id, re-attach, retry.
            // Pass the session's ORIGINAL account_id (not the current default) so a
            // resume never silently rebinds to a different account.
            {
                let guard = state.daemon_client.lock().await;
                let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
                client
                    // Resume respawn: never request a fresh remote-control bridge.
                    .start_session(cwd, model, effort, Some(session_id), false, account_id)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            // Force re-attach: the respawned session has a NEW daemon broadcast
            // channel, so the prior subscription is dead. ensure_attached alone
            // would no-op (id still in attached_sessions).
            super::daemon_bridge::reattach(app, session_id).await?;
            {
                let guard = state.daemon_client.lock().await;
                let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
                client.send_message(session_id, prompt).await.map_err(|e| e.to_string())?;
                // Reseed cache so the pane-clear check sees the revived session
                // (same race as start_session_daemon; see comment there).
                crate::daemon_link::fetch_and_reseed_instances(client, state).await;
            }
            Ok(session_id.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_session_effort(
    session_id: String,
    effort: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let valid = ["low", "medium", "high", "xhigh", "max"];
    if !valid.contains(&effort.as_str()) {
        return Err(format!("invalid effort: {effort}"));
    }
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_session_effort(&session_id, &effort).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_session_model(
    session_id: String,
    model: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !crate::daemon::lifecycle::is_valid_model(&model) {
        return Err(format!("invalid model: {model}"));
    }
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_session_model(&session_id, &model).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist a chat's auto-accept-permissions toggle. Forwarded to the daemon so
/// it stays the sole writer of chat-config.json (the read side is the local
/// `list_auto_accept` command in misc.rs, which reads the same shared file).
#[tauri::command]
pub async fn set_auto_accept(
    session_id: String,
    value: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_auto_accept(&session_id, value).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_turn(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.cancel_turn(&session_id).await.map_err(|e| e.to_string())
}

/// Convert ContentBlocks to the single string `claude -p` accepts as its
/// positional prompt arg. Path C does NOT use stream-json input format
/// (interactive doesn't support it), so we flatten to plain text.
/// Image attachments are surfaced as `<file:path>` mentions in Phase 6;
/// this helper just renders Image blocks as a placeholder if they ever
/// arrive without going through the disk-path conversion in the composer.
pub(crate) fn blocks_to_prompt_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            ContentBlock::Text { text } => out.push_str(text),
            ContentBlock::Image { .. } => {
                out.push_str("<image not yet persisted to disk>");
            }
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Register a historical (ended) session as an Interactive entry in the
/// registry so the Sessions view can find and display it. Called by the
/// History view "Continue this chat" flow before navigating back to Sessions.
#[tauri::command]
pub async fn register_historical_session(
    session_id: String,
    cwd: String,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    super::attachments::validate_session_id(&session_id)?;
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.register_historical(&session_id, &cwd, &account_id).await.map_err(|e| e.to_string())?;
    // Sync the instance cache immediately so the Sessions view's list_instances
    // call sees the new entry before the async instances_changed notification
    // arrives via daemon_link (avoids a race that caused the resume to silently
    // no-op when the cache was still stale on mount).
    crate::daemon_link::fetch_and_reseed_instances(client, &state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_to_prompt_text_text_only() {
        let blocks = vec![ContentBlock::Text { text: "hi".into() }];
        assert_eq!(blocks_to_prompt_text(&blocks), "hi");
    }
}
