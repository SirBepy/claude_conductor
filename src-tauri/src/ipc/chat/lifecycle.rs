//! Chat-hub lifecycle + AppHandle / process-tree side IPC. Distinct from
//! `run.rs` (which owns the per-turn IO loop).

use super::attachments::validate_session_id;
use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

/// Background GC for chat-attachments older than 30 days. Scheduled once
/// on app startup; re-runs every 24h.
pub async fn gc_attachments() {
    let root = match crate::settings::paths::data_dir() {
        Ok(d) => d.join("chat-attachments"),
        Err(_) => return,
    };
    crate::util::sweep_dir_older_than(
        &root,
        std::time::Duration::from_secs(30 * 24 * 60 * 60),
        |_| true,
        true,
    );
}

/// Open the given chat session in a dedicated Tauri webview window. The
/// window is labeled `session-<session_id>`; if it already exists we just
/// focus it. Closing the window does NOT kill the session - it stays in
/// the registry and can be reattached by clicking the row in the main
/// sidebar.
#[tauri::command]
pub async fn detach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::webview::PageLoadEvent;
    let url = format!("index.html#detached?session={}", session_id);
    let shown = Arc::new(AtomicBool::new(false));
    // Built hidden so it doesn't flash white while WebView2 loads the page.
    // on_page_load fires once the page finishes loading; we show + focus then.
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(crate::ipc::window::test_title(&format!(
        "Session {}",
        &session_id[..session_id.len().min(8)]
    )))
    .inner_size(800.0, 600.0)
    .visible(false)
    .on_page_load(move |w, payload| {
        if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the detached window for `session_id`, if any. Does not kill the
/// session itself.
#[tauri::command]
pub async fn reattach_window(session_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let label = format!("session-{}", session_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Promote a Manual (External) session to Interactive. Kills the external
/// claude process so this app's per-turn `--resume` calls don't race the
/// external one for JSONL writes. Returns the session_id of the now-Interactive
/// entry; the frontend switches the chat pane to bind to it.
///
/// `account_id` is the account the user picked in the takeover confirmation
/// (the manual session was spawned outside this app, so there is no account
/// already on record for it - see `chat::takeover::takeover`).
#[tauri::command]
pub async fn takeover_manual(
    manual_pid: u32,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (model, effort) = resolve_takeover_model_effort(manual_pid, &state);
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.takeover_manual(manual_pid, &model, &effort, &account_id).await.map_err(|e| e.to_string())
}

/// Move a chat session to a different account: forks its transcript onto a
/// fresh session id spawned under `target_account_id`, replays the pending
/// rate-limit resume (or a generic continuation prompt) into it, then retires
/// the old session. Returns the new session_id; the frontend rebinds the chat
/// pane to it.
#[tauri::command]
pub async fn move_session_to_account(
    session_id: String,
    target_account_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .move_session_to_account(&session_id, &target_account_id)
        .await
        .map_err(|e| e.to_string())
}

/// Kebab menu's "Restart Jarvis" (Jarvis window only, gated in the frontend
/// on the session's `jarvis` flag): force-kills the daemon's live child for
/// `session_id` and respawns it resuming the SAME id - never a fork, never
/// marked ended. Returns the (unchanged) session id; the frontend re-selects
/// the pane in place (see `active-session.ts`'s `changeAccountForSession` for
/// the same "rebind the pane" precedent, used there because the id changes).
#[tauri::command]
pub async fn restart_jarvis_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.restart_jarvis_session(&session_id).await.map_err(|e| e.to_string())
}

/// Kebab menu's "Clear context" (Jarvis window only, same gating as Restart
/// above): force-ends the daemon's live child, discards its transcript, and
/// spawns a genuinely fresh singleton. Returns the NEW session id - unlike
/// Restart, the frontend must re-mount against a different id.
#[tauri::command]
pub async fn clear_jarvis_context(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.clear_jarvis_context(&session_id).await.map_err(|e| e.to_string())
}

/// Chat menu's "Freeze chat": cancels any in-flight turn, marks the session
/// frozen (blocks silent respawn), shown after in the sidebar's Frozen segment.
#[tauri::command]
pub async fn freeze_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.freeze_session(&session_id).await.map_err(|e| e.to_string())
}

/// Chat menu's "Unfreeze chat" - counterpart to `freeze_session`; auto-
/// continues a cancelled turn, otherwise a no-op resume.
#[tauri::command]
pub async fn unfreeze_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.unfreeze_session(&session_id).await.map_err(|e| e.to_string())
}

/// Debug builds only: fake a usage-limit rejection on `session_id` so the
/// blocked banner, the red chat state, and the staggered scheduled resume can
/// all be exercised without waiting for a real window to run out. Everything
/// downstream of the injection runs through the production path.
///
/// From the webview devtools console:
/// `__TAURI__.core.invoke("simulate_rate_limit", { sessionId: "<id>", resetsInSecs: 120 })`
#[tauri::command]
pub async fn simulate_rate_limit(
    session_id: String,
    resets_in_secs: Option<i64>,
    kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .simulate_rate_limit(
            &session_id,
            resets_in_secs.unwrap_or(120),
            kind.as_deref().unwrap_or("five_hour"),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Resolve model+effort for takeover from settings.extra:
/// 1. projectLastChoice[cwd_path] -> {model, effort}
/// 2. effortPresets[].name == "Normal" -> {model, effort}
/// 3. fall back to ("opus", "high")
fn resolve_takeover_model_effort(manual_pid: u32, state: &AppState) -> (String, String) {
    let entry = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.pid == manual_pid)
        .cloned();
    let cwd_key = entry
        .map(|e| e.cwd.to_string_lossy().to_string())
        .unwrap_or_default();

    let settings = state.settings.lock().unwrap();
    let extra = &settings.extra;

    // 1. projectLastChoice[cwd_key]
    if !cwd_key.is_empty() {
        if let Some(map) = extra.get("projectLastChoice").and_then(|v| v.as_object()) {
            if let Some(choice) = map.get(&cwd_key).and_then(|v| v.as_object()) {
                let model = choice.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let effort = choice.get("effort").and_then(|v| v.as_str()).unwrap_or("");
                if !model.is_empty() && !effort.is_empty() {
                    return (model.to_string(), effort.to_string());
                }
            }
        }
    }

    // 2. Normal preset
    if let Some(arr) = extra.get("effortPresets").and_then(|v| v.as_array()) {
        for p in arr {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name == "Normal" {
                let model = p.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let effort = p.get("effort").and_then(|v| v.as_str()).unwrap_or("");
                if !model.is_empty() && !effort.is_empty() {
                    return (model.to_string(), effort.to_string());
                }
            }
        }
    }

    // 3. fallback
    ("opus".to_string(), "high".to_string())
}

/// Respond to a pending permission request from the MCP server.
/// Looks up the oneshot sender in the shared pending map and resolves it.
///
/// Per Claude Code's `--permission-prompt-tool` contract, the resolved JSON
/// MUST match one of:
///   - `{"behavior": "allow", "updatedInput": <object>}` — updatedInput is
///     the (possibly modified) tool input. Claude rejects `null` here.
///   - `{"behavior": "deny", "message": <string>}` — message is shown to
///     claude as the rejection reason; required (validation error if missing).
///
/// For question-shaped permissions (AskUserQuestion / ask_user_question) the
/// frontend uses `behavior: "deny"` + `message` to relay the user's chosen
/// answer back to claude as text, since headless `claude -p` has no native
/// way to receive structured answers from the built-in tool.
#[tauri::command]
pub async fn respond_permission(
    id: String,
    behavior: String,
    updated_input: Option<Value>,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let allow = match behavior.as_str() {
        "allow" => true,
        "deny" => false,
        _ => return Err(format!("invalid behavior: {behavior:?} (must be 'allow' or 'deny')")),
    };
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .respond_permission(
            &id,
            allow,
            if allow { Some(updated_input.unwrap_or_else(|| serde_json::json!({}))) } else { None },
            if allow { None } else { Some(message.unwrap_or_else(|| "Denied by user.".to_string())) },
        )
        .await
        .map_err(|e| e.to_string())
}

/// Respond to a pending question request from the MCP server. Returns whether
/// a live blocking waiter was resolved - the frontend uses this to skip its
/// own redundant "answer as a chat message" send when the answer already went
/// back in-band as the tool's result (see PersistentClient::respond_question).
#[tauri::command]
pub async fn respond_question(
    id: String,
    answers: Value,
    skipped: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .respond_question(&id, answers, skipped)
        .await
        .map_err(|e| e.to_string())
}

/// Durable Skip marks for `session_id` (unix ms, oldest first, todo 661) -
/// fetched once per session attach/hydrate and folded into scrollback
/// client-side, since a Skip never reaches Claude's transcript JSONL.
#[tauri::command]
pub async fn get_skipped_question_marks(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<i64>, String> {
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .get_skipped_question_marks(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Every prompt the daemon still has open (`{ id, event, payload }` records).
/// `spawn_pending_prompt_poll` pushes each id once, so a webview that lost its
/// in-memory park needs this pull side to rebuild the card.
#[tauri::command]
pub async fn list_pending_prompts(state: State<'_, AppState>) -> Result<Value, String> {
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .list_pending_prompts()
        .await
        .map_err(|e| e.to_string())
}
