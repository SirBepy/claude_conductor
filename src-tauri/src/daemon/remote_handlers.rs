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
        ws::WebSocketUpgrade,
        Path as AxPath, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::daemon::device_registry::DeviceRegistry;

use super::remote_server::RemoteCtx;
use super::remote_ws_pump::{pump_events, pump_global_events};

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
    // Write: spawns a claude process rooted at any client-supplied cwd. The
    // baseline capability every "strictly weaker" rationale below is measured against.
    "start_session",
    // Write: session_id is looked up in the live session map, not a path.
    "send_message",
    "cancel_turn",
    "respond_permission",
    "respond_question",
    // Write: resolves one render-confirmation waiter by client-supplied id.
    // Strictly weaker than `respond_question` above, which takes the same kind
    // of id and also delivers an answer. A phone is a legitimate renderer, so
    // excluding it would ack false for every phone-delivered question (todo 735).
    "confirm_question_rendered",
    // Read-only: durable Skip marks for one session_id, so a phone reopening
    // a chat sees "Skipped" instead of "awaiting answer" forever (todo 661).
    "get_skipped_question_marks",
    "set_session_effort",
    "set_session_model",
    "set_auto_accept",
    "list_auto_accept",
    "load_history_page",
    // Read-only: fetch one ToolResult's untruncated output (the "Load full
    // output" affordance on a page-truncated tool row). Same read-only
    // transcript access as load_history_page, just addressed by seq.
    "load_event_detail",
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
    // Read-only: path is canonicalized and prefix-checked against
    // <app-data>/chat-attachments/ in read_attachment_impl.
    "read_attachment",
    // Write: phone composer paperclip upload. Bytes land in the path-validated
    // chat-attachments dir (write_attachment rejects path-traversal session ids),
    // so this is not an arbitrary-write primitive.
    "paste_attachment",
    "list_characters",
    "list_project_groups",
    // Read-only: `file` is canonicalized and prefix-checked against the
    // character's own dir via Character::asset_path_checked (todo 656).
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
    // Read-only, gated by reject_unknown(cwd) in registry.rs (todo 656).
    "project_last_activity_at",
    // Read-only account-pin resolution, gated by reject_unknown(cwd) in the
    // handler (registry.rs) since cwd is client-supplied.
    "resolve_project_account",
    // Read-only, gated by reject_unknown(root) in registry.rs (todo 656).
    "get_project_tech",
    // Read-only fs read + base64 return; gated by reject_unknown(root) in
    // registry.rs - was the worst of the four todo-656 findings (unguarded).
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
    // Guarded by reject_unknown(project_dir) in registry.rs when project_dir is set.
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
    // Read/write worktree picker data (ai_todo 434): phone had no daemon RPC
    // for any of these, so the picker silently showed nothing. Same git
    // subprocess calls the desktop Tauri commands already run locally.
    // All path params reject_unknown-gated in worktrees.rs (verified todo 656).
    "list_worktree_details",
    "create_worktree",
    "remove_worktree",
    "get_recent_branches",
    // Read-only PR-review file browsing (ai_todo 244), mirrors desktop's
    // `ipc::git_diff` commands; pr_review.rs rejects any unknown `cwd`.
    "get_range_files",
    "get_file_diff",
    // Read-only statusbar chips + location-picker scan (mirrors desktop's
    // `ipc::git` / `ipc::servers` / `ipc::claude_scopes` commands), path
    // params reject_unknown-gated in statusbar.rs. Missing here was the
    // confirmed root cause of the phone's forever-loading git chips.
    "get_git_info",
    "get_git_dirty",
    "get_commit_sync",
    "get_commit_history",
    // Write action off the commits chip's push button (path gated by
    // reject_unknown in statusbar.rs, same as the worktree writes above).
    "push_commits",
    "list_project_servers",
    "list_claude_md_scopes",
    // Cross-surface draft sync: composer text, AUQ answers, held messages.
    // Session-scoped, not path-scoped - same "session_id known to this
    // daemon" boundary as send_message/respond_permission above. In-memory
    // (draft_store.rs), capped + LRU-evicted, never touches disk.
    "get_session_drafts",
    "set_composer_draft",
    "clear_composer_draft",
    "set_auq_draft",
    "clear_auq_draft",
    "add_held_message",
    "update_held_message",
    "remove_held_message",
    "clear_held_messages",
    // Read-only local-process log tail for a `waiting_on` chip (todo 675).
    // NETWORK-REACHABLE FILE READ: `path` is re-validated by `safe_local_path`
    // against the session's OWN registered cwd at the point the daemon
    // actually opens the file (methods/registry/waiting_tail.rs).
    "tail_waiting_log",
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
pub(super) fn strip_hidden_instances(instances: Vec<crate::types::Instance>) -> Vec<crate::types::Instance> {
    instances.into_iter().filter(|i| !i.jarvis && i.worker_of.is_none()).collect()
}

/// JSON-level counterpart of `strip_hidden_instances`, for call sites that
/// already hold a serialized instance array (the shared RPC router's dispatch
/// result, and forwarded notifier frames) rather than typed `Instance`s.
pub(super) fn strip_hidden_instances_json(arr: &mut Vec<serde_json::Value>) {
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

    // The phone's half of core.rs's mid-turn refusal (todo 873). Gated on a
    // live child: a session whose process already exited has a stale `busy` at
    // worst, and the respawn below is its way out. 409, not 500 - the phone's
    // transport re-stages that body into the held queue.
    if ctx.state.sessions.get(&id).is_some() {
        if let Err(e) = crate::daemon::lifecycle::refuse_if_busy(&ctx.state, &id) {
            return (StatusCode::CONFLICT, e.to_string()).into_response();
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
            "confirm_question_rendered",
            "get_skipped_question_marks",
            "respond_permission", "load_history_page", "load_event_detail", "list_history", "load_history",
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
            "list_worktree_details", "create_worktree", "remove_worktree", "get_recent_branches",
            "get_range_files", "get_file_diff",
            "get_git_info", "get_git_dirty", "get_commit_sync", "get_commit_history",
            "push_commits", "list_project_servers",
            "list_claude_md_scopes",
            "get_session_drafts", "set_composer_draft", "clear_composer_draft",
            "set_auq_draft", "clear_auq_draft", "add_held_message",
            "update_held_message", "remove_held_message", "clear_held_messages",
            "tail_waiting_log",
        ] {
            assert!(SAFE_METHODS.contains(&m), "{m} should be remotely callable");
        }
    }
}
