//! App-side daemon link: the startup task that connects to the daemon, seeds
//! caches from its snapshot, and routes daemon notifications into Tauri events,
//! plus the reconnect loop. Extracted from `lib.rs` (ai_todo 76); pure move, no
//! behavior change.

mod handlers;

use tauri::Manager;

/// Spawned once at startup. Connect-or-spawn the daemon (via `ensure_daemon`),
/// push settings, subscribe for notifications, seed the instance/channel caches
/// from the daemon snapshot, then pump notifications. On connection loss it
/// respawns + reconnects with capped backoff. The transport is a named pipe on
/// Windows and a Unix socket on macOS/Linux; channel automation stays
/// Windows-only (see `daemon::channel_adopt`).
pub async fn run_app_subscription(app_handle: tauri::AppHandle) {
    spawn_pending_prompt_poll(app_handle.clone());
    let state = app_handle.state::<crate::state::AppState>();
    {
        // Reconnect loop: on connection loss, respawn the daemon
        // (via ensure_daemon) + reconnect with capped backoff, then
        // re-subscribe + re-seed caches.
        let mut backoff_ms: u64 = 500;
        loop {
            let client = match crate::daemon_client::ensure_daemon().await {
                Ok(c) => c,
                Err(e) => {
                    log::error!("daemon connect failed: {e}; retrying in {backoff_ms}ms");
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(8000);
                    continue;
                }
            };
            backoff_ms = 500;
            let generation = client.generation;
            // Push initial settings BEFORE subscribing so the daemon's cache is
            // populated before any incoming hook traffic.
            let settings_snapshot = state.settings.lock().unwrap().clone();
            if let Err(e) = client.push_settings(&settings_snapshot).await {
                log::error!("push_settings failed: {e}");
            }
            let mut rx = match client.subscribe_global().await {
                Ok(rx) => rx,
                Err(e) => {
                    log::error!("subscribe_global failed: {e}; reconnecting");
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
            };
            // Seed the caches from the daemon's current snapshot so
            // already-running sessions/channels render immediately on
            // connect, instead of waiting for the next change event
            // (ai_todo 63). The frontend's `instances-changed` /
            // `channels-changed` listeners re-read the caches.
            {
                use tauri::Emitter;
                if let Some(instances) = fetch_and_reseed_instances(&client, &state).await {
                    let _ = app_handle.emit("instances-changed", instances);
                }
                if let Ok(channels) = client.list_channels().await {
                    if let Some(arr) = channels.as_array() {
                        *state.cached_channels.lock().unwrap() = arr.clone();
                        let _ = app_handle.emit("channels-changed", channels);
                    }
                }
            }
            {
                let mut slot = state.daemon_client.lock().await;
                *slot = Some(client);
            }
            { use tauri::Emitter; let _ = app_handle.emit("daemon-status-changed", serde_json::json!({"connected": true})); }
            while let Some(frame) = rx.recv().await {
                let method = frame.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let params = frame.get("params").cloned().unwrap_or(serde_json::Value::Null);
                handle_daemon_notification(&app_handle, &method, params).await;
            }
            log::warn!("daemon connection lost (generation {generation}); respawning + reconnecting");
            {
                use tauri::Emitter;
                *state.daemon_client.lock().await = None;
                let _ = app_handle.emit("daemon-status-changed", serde_json::json!({"connected": false}));
            }
        }
    }
}

/// Reliable delivery of question prompts. The lossy notifier broadcast can
/// silently drop a `question_request` frame under pipe backpressure, which left
/// AskUserQuestion turns hung with no card. So in addition to (now: instead of)
/// the broadcast, the app polls `list_pending_prompts` over the reliable RPC
/// channel and emits each open prompt's Tauri event exactly once. Spawned once;
/// reads the current daemon client from shared state each tick.
///
/// Adaptive interval, never skipping a poll (this is the must-deliver path):
/// stays at `MIN_POLL_INTERVAL` while a prompt is pending or any known session
/// is busy (cheap - reads the in-memory instance cache, no RPC), since either
/// can produce a prompt on the very next tick. Otherwise it steps up by
/// `BACKOFF_STEP` per consecutive empty poll, capped at `MAX_POLL_INTERVAL`
/// after `BACKOFF_STEPS_TO_MAX` empties in a row. Any poll that comes back
/// non-empty snaps straight back to `MIN_POLL_INTERVAL`.
fn spawn_pending_prompt_poll(app_handle: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    const MIN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
    const MAX_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(2000);
    const BACKOFF_STEP: std::time::Duration = std::time::Duration::from_millis(150);
    const BACKOFF_STEPS_TO_MAX: u32 = 10; // 500ms + 10*150ms = 2000ms

    tokio::spawn(async move {
        let state = app_handle.state::<crate::state::AppState>();
        let mut emitted: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
        let mut was_connected = false;
        let mut empty_streak: u32 = 0;
        let mut interval = MIN_POLL_INTERVAL;
        loop {
            tokio::time::sleep(interval).await;
            let (prompts, connected) = {
                let guard = state.daemon_client.lock().await;
                match guard.as_ref() {
                    Some(c) => (c.list_pending_prompts().await.ok(), true),
                    None => (None, false),
                }
            };
            // Reconnected after being offline: forget what we'd "emitted" so any
            // STILL-pending prompt re-surfaces (its card vanished when the app was
            // away). Without this the id stays in `emitted` and never re-shows -
            // the "my question card was gone when I came back" bug.
            if connected && !was_connected {
                emitted.clear();
            }
            was_connected = connected;
            let Some(prompts) = prompts else {
                // Not connected / RPC failed - not a confirmed-empty result,
                // so leave the backoff state alone and retry at the current
                // interval rather than treating this as "nothing pending".
                continue;
            };
            let arr = match prompts.as_array() {
                Some(a) => a.clone(),
                None => continue,
            };
            let mut present: std::collections::HashSet<String> = std::collections::HashSet::new();
            for p in &arr {
                let Some(id) = p.get("id").and_then(|v| v.as_str()) else { continue };
                present.insert(id.to_string());
                if emitted.contains_key(id) {
                    continue;
                }
                let event = p.get("event").and_then(|v| v.as_str()).unwrap_or("");
                if event.is_empty() {
                    continue;
                }
                if let Some(payload) = p.get("payload") {
                    let _ = app_handle.emit(event, payload.clone());
                    let durable = p.get("durable").and_then(|v| v.as_bool()).unwrap_or(false);
                    emitted.insert(id.to_string(), durable);
                }
            }
            // A prompt we'd shown is no longer pending (answered or timed out):
            // tell the UI to remove its card via the RELIABLE poll channel (the
            // lossy broadcast can't be trusted to deliver a removal).
            for (id, durable) in emitted.iter().filter(|(id, _)| !present.contains(*id)) {
                let _ = app_handle.emit("prompt-resolved", serde_json::json!({ "id": id, "durable": durable }));
            }
            emitted.retain(|id, _| present.contains(id));

            let any_busy = state.cached_instances.lock().unwrap().iter().any(|i| i.busy);
            if !arr.is_empty() || any_busy {
                empty_streak = 0;
                interval = MIN_POLL_INTERVAL;
            } else {
                empty_streak = (empty_streak + 1).min(BACKOFF_STEPS_TO_MAX);
                interval = (MIN_POLL_INTERVAL + BACKOFF_STEP * empty_streak).min(MAX_POLL_INTERVAL);
            }
        }
    });
}

/// Best-effort push of a fresh settings snapshot to the daemon's in-memory
/// cache (`daemon::settings_cache`), outside the handshake-time push in
/// `run_app_subscription` above. Without this, daemon-side reads (e.g.
/// `default_account_id` resolution in `daemon::lifecycle::spawn_session`) can
/// see a stale snapshot for the lifetime of an already-connected session,
/// despite `settings_cache`'s doc comment claiming "on every change". Call
/// this from every app-side chokepoint that persists a settings mutation the
/// daemon cares about (currently: `save_settings`, `set_default_account`).
/// No-op (logged) if the daemon isn't connected yet - the next successful
/// handshake will push the latest snapshot anyway.
pub async fn push_settings_to_daemon(state: &crate::state::AppState, settings: &crate::types::Settings) {
    let guard = state.daemon_client.lock().await;
    if let Some(client) = guard.as_ref() {
        if let Err(e) = client.push_settings(settings).await {
            log::warn!("push_settings (post-save) failed: {e}");
        }
    }
}

/// Overwrites `cached_instances` with `instances`. Single place for this assignment.
pub(crate) fn store_cached_instances(state: &crate::state::AppState, instances: Vec<crate::types::Instance>) {
    *state.cached_instances.lock().unwrap() = instances;
}

/// Fetches the current instance list from the daemon, parses it, stores it via
/// `store_cached_instances`, and returns the raw JSON for the caller to emit if
/// needed. Returns `None` if the RPC or parse fails.
pub(crate) async fn fetch_and_reseed_instances(
    client: &crate::daemon_client::PersistentClient,
    state: &crate::state::AppState,
) -> Option<serde_json::Value> {
    let raw = client.list_instances().await.ok()?;
    let parsed = serde_json::from_value::<Vec<crate::types::Instance>>(raw.clone()).ok()?;
    store_cached_instances(state, parsed);
    Some(raw)
}

/// Routes daemon-side notifications into app-side Tauri events + cache updates.
async fn handle_daemon_notification(app: &tauri::AppHandle, method: &str, params: serde_json::Value) {
    use tauri::{Emitter, Manager};
    match method {
        "instances_changed" => handlers::handle_instances_changed(app, params).await,
        "channels_changed" => {
            let state = app.state::<crate::state::AppState>();
            // params is the channel-snapshot JSON array (see daemon::channels::emit_changed).
            if let Some(arr) = params.as_array() {
                let mut cache = state.cached_channels.lock().unwrap();
                *cache = arr.clone();
            }
            let _ = app.emit("channels-changed", params);
        }
        // Scheduled messages / scheduled new-chats (`daemon::schedule::notify_changed`).
        // No app-side cache to seed (unlike instances/channels): the schedule view
        // and the missed-fire popup both re-read via `schedule_list` on this event
        // rather than trusting the payload shape, so this is a pure forward.
        "scheduled_items_changed" => {
            let _ = app.emit("scheduled-items-changed", params);
        }
        // A scheduled item just fired successfully. Carries { id, kind,
        // session_id, prompt } directly (unlike the list-shaped changed event),
        // so the app can pop a clickable "scheduled chat started" toast that
        // opens that chat. Pure forward.
        "scheduled_item_fired" => {
            let _ = app.emit("scheduled-item-fired", params);
        }
        // In-app HTML preview push (daemon::preview via POST /hooks/preview).
        // Pure forward: the docked preview panel re-reads via `list_previews`
        // on open/focus, so this is just the fast live-update nudge. Payload
        // carries { snapshot: PreviewMeta }.
        "preview" => {
            let _ = app.emit("preview", params);
        }
        // "permission_request" and "question_request" are intentionally NOT handled
        // here. Both are delivered via the reliable `list_pending_prompts` poll (see
        // `spawn_pending_prompt_poll`) because the broadcast can silently drop frames
        // under pipe backpressure. Handling them here too would double-emit cards.
        "token_history_updated" => {
            if let Some(h) = params.get("history") {
                let _ = app.emit("token-history-updated", h);
            }
        }
        "skill_usage_changed" => { let _ = app.emit("skill-usage-changed", serde_json::json!({})); }
        // Character turn sound: the daemon fires this when an in-app chat finishes
        // a turn (done / plain-text question) or surfaces an AskUserQuestion. We
        // map it to the existing notification path so it resolves the session
        // character + slot and respects mute/meeting/per-slot gating.
        "turn_sound" => {
            let session_id = params.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let kind = match params.get("awaiting").and_then(|v| v.as_str()) {
                Some("done") => Some(crate::notifications::NotifKind::WorkFinished),
                Some("question") => Some(crate::notifications::NotifKind::QuestionAsked),
                _ => None,
            };
            if let Some(kind) = kind {
                let name = cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
                crate::notifications::fire(
                    app,
                    kind,
                    crate::notifications::NotifContext { name, percent: None, ..Default::default() },
                    session_id.as_deref(),
                    cwd.as_deref(),
                );
            }
        }
        // Live-refresh request from the remote/phone usage dials (via the
        // daemon's `request_live_usage_refresh` RPC) - unlike "refresh_requested"
        // above, this must NOT fire a WorkFinished notification popup; it's a
        // silent poll triggered by a user clicking a dial, not a Claude Code
        // hook event. `account_id` (optional) scopes the poll to one account
        // instead of refreshing every configured account.
        "usage_poll_requested" => {
            let app2 = app.clone();
            let account_id = params.get("account_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            tokio::spawn(async move {
                let _ = crate::scheduler::poll_once_scoped(
                    &app2,
                    crate::scheduler::PollTrigger::Manual,
                    account_id.as_deref(),
                )
                .await;
            });
        }
        "refresh_requested" => {
            let app2 = app.clone();
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let session_id = params.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            tokio::spawn(async move {
                let _ = crate::scheduler::poll_once(&app2, crate::scheduler::PollTrigger::Hook).await;
                let name = cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
                crate::notifications::fire(
                    &app2,
                    crate::notifications::NotifKind::WorkFinished,
                    crate::notifications::NotifContext { name, percent: None, ..Default::default() },
                    session_id.as_deref(),
                    cwd.as_deref(),
                );
            });
        }
        "notify_requested" => {
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let session_id = params.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            let name = cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
            crate::notifications::fire(
                app,
                crate::notifications::NotifKind::QuestionAsked,
                crate::notifications::NotifContext { name, percent: None, ..Default::default() },
                session_id.as_deref(),
                cwd.as_deref(),
            );
        }
        // A question's prompt timed out with no answer. The card is removed via
        // the reliable `prompt-resolved` poll path; here we just notify the user
        // they missed it (best-effort - a dropped broadcast frame only costs the
        // notification, not the cleanup).
        "question_expired" => {
            let session_id = params.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            crate::notifications::fire(
                app,
                crate::notifications::NotifKind::QuestionAsked,
                crate::notifications::NotifContext { name: None, percent: None, ..Default::default() },
                session_id.as_deref(),
                None,
            );
        }
        "quit_requested" => {
            app.exit(0);
        }
        "project_created" => handlers::handle_project_created(app, params),
        "session_character_assigned" => handlers::handle_session_character_assigned(app, params),
        "jarvis_session_created" => handlers::handle_jarvis_session_created(app, params),
        other => {
            log::debug!("daemon notif ignored: {other}");
        }
    }
}
