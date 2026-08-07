//! Chat/session HTTP+WS handlers for the remote-access server
//! (`remote_server.rs` owns the router, auth middleware, and pairing-file
//! helpers; this module is the per-route business logic for the session/chat
//! surface specifically). Push notifications, the voice/STT relay, device
//! pairing, and SPA static-asset serving live in their own sibling modules
//! (`remote_push.rs`, `remote_voice.rs`, `remote_pairing.rs` - split out in
//! ai_todo 319 - and `remote_static.rs` - ai_todo 514) since none of them
//! share state or helpers with the chat/session core.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxPath, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;

use super::remote_server::RemoteCtx;

/// Daemon RPC methods the remote client may invoke via `POST /api/rpc`. This is
/// the load-bearing security allowlist: anything NOT here is 403, so adding a
/// method is a deliberate, reviewable act. Deliberately EXCLUDED: `shutdown_daemon`,
/// `set_settings` (could disable security), all `*_channel` (automation/bridge
/// control), and the streaming methods `attach_session` /
/// `detach_session` / `subscribe_global` (connection-scoped; the WS endpoint
/// handles streaming instead). See the test below.
const SAFE_METHODS: &[&str] = &[
    "list_instances",
    "list_pending_prompts",
    "start_session",
    "send_message",
    "cancel_turn",
    "respond_permission",
    "respond_question",
    "set_session_effort",
    "set_session_model",
    "set_auto_accept",
    "list_auto_accept",
    "load_history_page",
    // Read-only past-session browsing for the phone History view (mirrors
    // desktop's `list_history` / `load_history` Tauri commands). Without
    // these HttpTransport had no case for either name, so the view silently
    // rendered empty.
    "list_history",
    "load_history",
    // Write: re-registers an ended session as Interactive (History's "Continue
    // this chat"). Narrow mutation, strictly weaker than start_session
    // (already remote-callable). Without this the button silently no-op'd on
    // remote (403, swallowed by the caller).
    "register_historical",
    "read_attachment",
    // Write: phone composer paperclip upload. Bytes land in the path-validated
    // chat-attachments dir (write_attachment rejects path-traversal session ids),
    // so this is not an arbitrary-write primitive.
    "paste_attachment",
    "list_characters",
    "list_project_groups",
    "character_asset_url",
    // Read-only: resolves the same character/slot voiceline rule
    // `notifications::fire` uses natively (mute/whitelist/character gating
    // included) and returns a data URL instead of playing bytes, so the
    // remote client can mirror the sound the desktop app just played.
    "resolve_voiceline",
    "resolve_whitelist_characters",
    "list_session_characters",
    // Write: assigns a character to a freshly-created remote session (the
    // desktop-only Tauri command `ensure_session_character` had no remote
    // mirror, so remote-started chats never got an avatar - ai_todo fix).
    // Only mutates `session_characters` for the given session_id via
    // whitelist pick_random; cannot touch any other settings field.
    "ensure_session_character",
    "list_projects",
    "project_last_activity_at",
    "get_project_tech",
    "get_project_icon",
    // Read-only usage/token history for the remote homescreen + statistics.
    "get_history",
    "get_token_history",
    "get_active_sessions",
    // Read-only current-usage-percentage + per-account login-state maps for the
    // phone Dashboard (mirrors desktop's `get_usage_map` / `get_auth_state_map`
    // Tauri commands). See their handlers in `daemon/methods/registry.rs` for
    // the cross-process derivation notes.
    "get_usage_map",
    "get_auth_state_map",
    // Write-ish but narrow: triggers a live claude.ai poll on the connected
    // desktop app (click-to-refresh usage dials) - it cannot mutate anything
    // besides the usage snapshot cache/DB the read-only methods above already
    // expose, and only refreshes (never adds/removes) an account.
    "request_live_usage_refresh",
    // Read-only, transcript-derived context-window status for a session
    // (mirrors desktop's `context_status` Tauri command). Without this the
    // phone had no daemon RPC for it at all - it silently fell back to a
    // frontend heuristic using a possibly-stale cached model, which could
    // show a wildly different % than desktop for the same session.
    "context_status",
    // Read-only account registry so the phone's new-chat picker lists the same
    // accounts as desktop (ai_todo 241). Read-only: no add/remove/logout/default
    // mutators are exposed - the phone can pick an account to spawn under, not
    // reconfigure the desktop's accounts.
    "list_accounts",
    // Visual settings (theme, colors) so the phone mirrors the desktop appearance.
    // set_settings is deliberately NOT here (phone must not mutate desktop settings).
    "get_settings",
    // Read-only filesystem scan of the slash-command/skill dirs so the phone's
    // `/` autocomplete popup populates like desktop's (was always empty otherwise).
    "list_slash_commands",
    // Scheduled-items list + mutators (ai_todo 257 shipped the read; ai_todo 259
    // added the writes). Rationale for exposing the mutators remotely: a paired
    // client can already `start_session` + `send_message` (spawn and drive an
    // arbitrary `claude` run) and `respond_permission`, so every schedule
    // mutator is strictly WEAKER than the remote surface already granted -
    // `schedule_fire_now` just fires a pre-composed message `send_message`
    // could already send, and create/update/delete only manage a queue of
    // future sends. The trust boundary is the same pairing token for all of
    // them. `schedule_list_external` stays desktop-only (it's a Windows Task
    // Scheduler read, not a daemon RPC).
    "schedule_list",
    "schedule_create",
    "schedule_update",
    "schedule_delete",
    "schedule_fire_now",
    // Read-only HTML preview store (ai_todo 138), phone-ready per the design's
    // "RPC-mirrored like read_attachment" decision. The WRITE path
    // (`push_preview`) is deliberately NOT here: pushes go through the
    // unauthenticated `/hooks/preview` hook-server endpoint instead, mirroring
    // the existing push(hook server)/read(remote RPC) split for this feature.
    "list_previews",
    "get_preview",
    // Close-chat (ai_todo: phone's "clear_session" had no remote path at all,
    // so the button silently no-op'd). Strictly weaker than the remote surface
    // already granted: a paired client can already `start_session` +
    // `send_message` to spawn and drive an arbitrary `claude` run, so ending
    // one it already knows the id of is not a new capability class. Mirrors
    // desktop's `ipc::clear_session` (builtins.rs): `end_session` kills the
    // underlying process for daemon-hosted (interactive) sessions and marks
    // the registry entry ended; `mark_session_ended` alone is the fallback for
    // sessions `end_session` doesn't know about (e.g. External, not in the
    // daemon's SessionMap) so the sidebar entry still clears instead of
    // leaving a ghost row. Without both, remote close-chat would either 403
    // or silently leak the subprocess (the exact bug `clear_session` exists
    // to prevent - see builtins.rs's doc comment).
    "end_session",
    "mark_session_ended",
];

// ── Handlers ─────────────────────────────────────────────────────────────────

/// Jarvis (todo 272) and its worker sub-sessions never reach the remote/phone
/// cockpit - Joe's binding design decision: Jarvis exists only in its own
/// dedicated desktop window (`ipc::window::open_jarvis_window`), and a worker
/// is meaningless outside its parent session's context. Shared by every
/// remote session-list surface below: the `GET /api/sessions` REST route, the
/// `POST /api/rpc {"method":"list_instances"}` allowlisted RPC (the one the
/// phone SPA's `HttpTransport` actually calls - see `http-transport.ts`), the
/// WebSocket global-stream's initial resync frame, and its live-forwarded
/// `instances_changed` notifications.
fn strip_hidden_instances(instances: Vec<crate::types::Instance>) -> Vec<crate::types::Instance> {
    instances.into_iter().filter(|i| !i.jarvis && i.worker_of.is_none()).collect()
}

/// JSON-level counterpart of `strip_hidden_instances`, for call sites that
/// already hold a serialized instance array (the shared RPC router's dispatch
/// result, and forwarded notifier frames) rather than typed `Instance`s.
fn strip_hidden_instances_json(arr: &mut Vec<serde_json::Value>) {
    arr.retain(|v| {
        let jarvis = v.get("jarvis").and_then(serde_json::Value::as_bool).unwrap_or(false);
        let is_worker = v.get("worker_of").map(|w| !w.is_null()).unwrap_or(false);
        !jarvis && !is_worker
    });
}

pub(super) async fn list_sessions(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    Json(strip_hidden_instances(ctx.state.registry.list())).into_response()
}

#[derive(Deserialize)]
pub(super) struct SendBody {
    text: String,
}

pub(super) async fn send_message(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<SendBody>,
) -> Response {
    // Respawns the session first if its per-turn `claude -p` process already
    // exited since the last turn (the daemon-side equivalent of the desktop's
    // -32004 -> start_session(resume) -> retry dance - see
    // `lifecycle::send_message_with_respawn`). Without this a remote send into
    // an idle chat 404'd here instead of resuming it.
    match crate::daemon::lifecycle::send_message_with_respawn(&ctx.state, &id, &body.text, false).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(crate::daemon::lifecycle::LifecycleError::NotFound(_)) => {
            (StatusCode::NOT_FOUND, "no such session").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub(super) async fn cancel_turn(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
) -> Response {
    match crate::daemon::lifecycle::cancel_turn(&ctx.state.sessions, &id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct RpcBody {
    method: String,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

/// Generic command dispatch: forwards an allowlisted daemon RPC method to the
/// shared router. This is how the phone runs the real SPA (its transport calls
/// commands by name). A throwaway ConnectionContext is fine because every
/// allowlisted method is request/response - streaming methods are excluded and
/// served by the WS endpoint instead.
pub(super) async fn rpc_dispatch(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<RpcBody>,
) -> Response {
    if !SAFE_METHODS.contains(&body.method.as_str()) {
        return (
            StatusCode::FORBIDDEN,
            format!("method not allowed remotely: {}", body.method),
        )
            .into_response();
    }
    let method = body.method.clone();
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let conn = crate::daemon::rpc::ConnectionContext::new(tx);
    let req = crate::daemon::rpc::Request {
        jsonrpc: "2.0".into(),
        id: serde_json::json!(0),
        method: body.method,
        params: body.params,
    };
    let resp = ctx.router.dispatch(req, conn).await;
    match resp.error {
        Some(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
        None => {
            let mut result = resp.result.unwrap_or(serde_json::Value::Null);
            // `list_instances` is the one SAFE_METHODS entry backed by the
            // shared daemon RPC router (also used by the desktop app, whose
            // own Jarvis window needs the UNFILTERED data - see
            // sessions-helpers.ts's isJarvisOrWorker doc), so it can't be
            // filtered centrally. Strip it here instead, remote-transport-only.
            if method == "list_instances" {
                if let Some(arr) = result.as_array_mut() {
                    strip_hidden_instances_json(arr);
                }
            }
            Json(result).into_response()
        }
    }
}

#[derive(Deserialize)]
pub(super) struct StreamQuery {
    pub(super) token: String,
}

pub(super) async fn stream_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session) = ctx.state.sessions.get(&id).map(|s| s.clone()) else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    let state = ctx.state.clone();
    ws.on_upgrade(move |socket| pump_events(socket, state, id, session))
}

/// How often `pump_global_events` sends an app-level heartbeat text frame.
/// Browsers never surface native WS ping/pong to JS (`onclose` does not fire
/// on a half-open/zombie socket - e.g. after the phone's screen was off long
/// enough for the OS to freeze the connection without a clean FIN), so
/// http-transport.ts's watchdog needs a text frame it can time against to
/// detect a silently-dead connection instead.
const GLOBAL_HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Frames buffered while the host was asleep and older than this are dropped
/// rather than forwarded - see the `turn_sound` staleness check below.
const TURN_SOUND_STALE_MS: i64 = 15_000;

/// Not session-scoped: the remote (browser) equivalent of the internal
/// daemon<->app `subscribe_global` pipe link (see `daemon_link.rs`'s
/// `run_app_subscription`). Self-authenticates via `?token=` exactly like
/// `stream_ws`, since browsers cannot set the Authorization header on a WS
/// handshake.
pub(super) async fn global_stream_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let state = ctx.state.clone();
    ws.on_upgrade(move |socket| pump_global_events(socket, state))
}

/// Builds the same `instances_changed` frame shape the notifier publishes on
/// every registry mutation (see e.g. `daemon::methods::registry`), so a
/// freshly (re)connected client gets an immediate full resync instead of
/// waiting for the next mutation.
fn instances_changed_frame(state: &DaemonState) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "instances_changed",
        "params": {"instances": strip_hidden_instances(state.registry.list())},
    })
    .to_string()
}

/// Forwards every daemon-wide notifier event to a global (not
/// session-scoped) WebSocket client verbatim - no per-event filtering -
/// because every notifier event (`instances_changed`, `channels_changed`,
/// `project_created`, `scheduled_items_changed`, `scheduled_item_fired`,
/// `permission_request`, `question_request`, `question_expired`,
/// `turn_sound`, `refresh_requested`, `usage_poll_requested`, `notify_requested`, `quit_requested`,
/// `skill_usage_changed`, `session_character_assigned`,
/// `token_history_updated` - see the `notifier.publish` call sites across
/// `daemon/`) mirrors data already exposed by an allowlisted `/api/rpc`
/// method (`list_instances`, `list_pending_prompts`, `get_token_history`,
/// `list_session_characters`, ...), so nothing here is more sensitive than
/// what a paired remote client can already read over REST.
async fn pump_global_events(mut socket: WebSocket, state: Arc<DaemonState>) {
    // Heal a client that just (re)connected: send a full snapshot before any
    // future mutation, mirroring `fetch_and_reseed_instances` on the
    // desktop app-side link.
    if socket
        .send(Message::Text(instances_changed_frame(&state)))
        .await
        .is_err()
    {
        return;
    }

    let mut rx = state.notifier.subscribe();
    let mut heartbeat = tokio::time::interval(GLOBAL_HEARTBEAT_INTERVAL);
    heartbeat.tick().await; // consume the immediate first tick (right after the snapshot)

    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(mut frame) => {
                    // The notifier fans out every daemon-wide event verbatim
                    // (see this fn's doc), but `instances_changed` specifically
                    // must never carry Jarvis/worker sessions to a remote
                    // client - the initial resync frame above already strips
                    // them; do the same for every live one, or a later
                    // unrelated registry mutation anywhere in the daemon would
                    // re-leak the full unfiltered list within seconds.
                    if frame.get("method").and_then(serde_json::Value::as_str) == Some("instances_changed") {
                        if let Some(arr) = frame.pointer_mut("/params/instances").and_then(serde_json::Value::as_array_mut) {
                            strip_hidden_instances_json(arr);
                        }
                    }
                    // A suspended host doesn't cleanly close this socket, so `turn_sound`
                    // frames pile up in the broadcast buffer and blast out all at once on
                    // wake. Dropping ones older than the cutoff is intentional (user wants
                    // "missed while asleep" to mean missed), not a bug - every other event
                    // type still forwards unconditionally.
                    if frame.get("method").and_then(serde_json::Value::as_str) == Some("turn_sound") {
                        let fired_at_ms = frame.pointer("/params/fired_at_ms").and_then(serde_json::Value::as_i64);
                        let age_ms = fired_at_ms.map(|t| chrono::Utc::now().timestamp_millis() - t);
                        if age_ms.is_some_and(|age| age > TURN_SOUND_STALE_MS) {
                            continue;
                        }
                    }
                    let txt = match serde_json::to_string(&frame) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                Err(RecvError::Lagged(_)) => continue, // dropped frames under load; keep going
                Err(RecvError::Closed) => break, // notifier sender dropped (daemon shutting down)
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {} // ignore client->server frames
                _ => break,       // client closed or errored
            },
            _ = heartbeat.tick() => {
                let hb = serde_json::json!({"jsonrpc": "2.0", "method": "heartbeat", "params": {}}).to_string();
                if socket.send(Message::Text(hb)).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// How long `pump_events` keeps polling the SessionMap for a respawn after its
/// broadcast channel closes, before giving up and closing the socket (falling
/// back to the client's own reconnect-with-backoff in http-transport.ts).
/// Bounded so a browser tab left open on a session that has genuinely ended
/// doesn't poll the daemon forever.
const RESPAWN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
const RESPAWN_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Forward a session's live ChatEvent broadcast to the WebSocket client until
/// either side closes. Mirrors what the desktop Tauri event stream delivers, so
/// a phone client sees the same turns stream in real time.
///
/// The per-turn `claude -p` process exits at the end of every turn (see
/// `daemon::lifecycle::spawn_session`'s pump-exit handling), which drops this
/// session's broadcast sender and closes `rx`. A naive close-on-`Closed` here
/// would strand this window on the client's 1s-30s exponential WS reconnect
/// backoff - exactly the window in which a sibling window's message can
/// respawn the session and get silently missed here (the bug this whole
/// change fixes). Instead, poll the SessionMap for the respawn and resubscribe
/// to the NEW session's channel on the SAME socket.
async fn pump_events(mut socket: WebSocket, state: Arc<DaemonState>, session_id: String, session: Arc<Session>) {
    let mut rx = crate::daemon::broadcast::subscribe(&session);
    // Mid-turn attach resync (ai_todo 186): the stream now carries O(delta)
    // `assistant_delta` chunks, so a client joining mid-turn has no way to
    // recover the text already streamed. Send the accumulated block as one
    // `snapshot: true` frame first; any deltas already queued in `rx` carry a
    // `seq` at or below the snapshot's and are dropped client-side. (The PWA
    // client is served by this same daemon, so it always speaks the delta
    // protocol - no legacy conversion needed here, unlike `attach_session`.)
    // (Bound separately: an `if let` scrutinee would hold the MutexGuard
    // across the `.await`, making the future non-Send.)
    let resync = session.streaming.lock().unwrap().snapshot_event();
    if let Some(snap) = resync {
        if let Ok(txt) = serde_json::to_string(&snap) {
            if socket.send(Message::Text(txt)).await.is_err() {
                return; // client gone
            }
        }
    }
    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(ev) => {
                    let txt = match serde_json::to_string(&ev) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Dropped frames under load. Deltas don't compose across a
                    // gap, so resync the streamed text with a snapshot frame
                    // before continuing (a delta client drops anything its
                    // accumulator already covers).
                    log::warn!("remote stream lagged for {session_id}: dropped {n} chat events");
                    // Look the session up fresh: after a respawn+resubscribe
                    // (`wait_for_respawn` below) the captured `session` is the
                    // OLD object and its accumulator would be stale.
                    let snap = state
                        .sessions
                        .get(&session_id)
                        .map(|s| s.clone())
                        .and_then(|s| s.streaming.lock().unwrap().snapshot_event());
                    if let Some(snap) = snap {
                        if let Ok(txt) = serde_json::to_string(&snap) {
                            if socket.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                    }
                    continue;
                }
                Err(RecvError::Closed) => {
                    match wait_for_respawn(&state, &session_id, &mut socket).await {
                        Some(new_rx) => rx = new_rx,
                        None => break, // client disconnected, or no respawn within RESPAWN_MAX_WAIT
                    }
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames for now
                _ => break,            // client closed or errored
            },
        }
    }
}

/// Poll the SessionMap for `session_id` to come back live, up to
/// `RESPAWN_MAX_WAIT`, while still watching `socket` so a client-initiated
/// close is honored immediately instead of waiting out the poll.
async fn wait_for_respawn(
    state: &Arc<DaemonState>,
    session_id: &str,
    socket: &mut WebSocket,
) -> Option<tokio::sync::broadcast::Receiver<crate::types::chat::ChatEvent>> {
    let deadline = tokio::time::Instant::now() + RESPAWN_MAX_WAIT;
    loop {
        if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
            return Some(crate::daemon::broadcast::subscribe(&session));
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::select! {
            _ = tokio::time::sleep(RESPAWN_POLL_INTERVAL) => continue,
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => continue, // ignore client frames while waiting
                _ => return None,        // client closed or errored
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    #[test]
    fn instances_changed_frame_matches_notifier_shape() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let frame = instances_changed_frame(&state);
        let v: serde_json::Value = serde_json::from_str(&frame).expect("valid json frame");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "instances_changed");
        assert!(v["params"]["instances"].is_array(), "params.instances should be an array: {v}");
        assert_eq!(v["params"]["instances"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn strip_hidden_instances_json_drops_jarvis_and_workers() {
        let mut arr = vec![
            serde_json::json!({"session_id": "a", "jarvis": false, "worker_of": null}),
            serde_json::json!({"session_id": "b", "jarvis": true, "worker_of": null}),
            serde_json::json!({"session_id": "c", "jarvis": false, "worker_of": "a"}),
        ];
        strip_hidden_instances_json(&mut arr);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["session_id"], "a");
    }

    #[test]
    fn allowlist_excludes_dangerous_methods() {
        for m in [
            "shutdown_daemon", "set_settings", "start_channel", "stop_channel",
            "restart_channel", "show_channel", "hide_channel",
            "attach_session", "detach_session", "subscribe_global",
            "externalize_session", "takeover_manual",
            // schedule mutators became remote-callable in ai_todo 259 (they are
            // strictly weaker than start_session/send_message, which remote
            // already grants). schedule_list_external stays desktop-only: it's a
            // Windows Task Scheduler filesystem read with no daemon RPC at all.
            "schedule_list_external",
        ] {
            assert!(
                !SAFE_METHODS.contains(&m),
                "{m} must NOT be remotely callable"
            );
        }
    }

    #[test]
    fn allowlist_includes_core_chat_methods() {
        for m in [
            "list_instances", "send_message", "cancel_turn", "respond_question",
            "respond_permission", "load_history_page", "list_history", "load_history",
            "register_historical", "read_attachment",
            "paste_attachment", "list_characters", "list_project_groups",
            "character_asset_url", "resolve_voiceline", "resolve_whitelist_characters", "list_projects",
            "project_last_activity_at", "get_project_tech", "get_project_icon",
            "get_history", "get_token_history", "get_active_sessions",
            "get_usage_map", "get_auth_state_map", "context_status",
            "list_accounts", "list_slash_commands", "ensure_session_character",
            "schedule_list", "schedule_create", "schedule_update",
            "schedule_delete", "schedule_fire_now", "list_previews", "get_preview",
            "end_session", "mark_session_ended",
        ] {
            assert!(SAFE_METHODS.contains(&m), "{m} should be remotely callable");
        }
    }
}
