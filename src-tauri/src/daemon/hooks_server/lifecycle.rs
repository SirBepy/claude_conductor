//! Lifecycle endpoints: `/hooks/session-start` + `/hooks/session-end`. These
//! populate / close registry entries and own the background enrichment that
//! resolves pid, bridgeSessionId, channel-tagging, and session name.

use super::HookCtx;
use crate::sessions::kinds::InstanceKind;
use crate::sessions::registry::RegisterInput;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Debug, Default)]
pub(super) struct SessionStartPayload {
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
pub(super) struct SessionEndPayload {
    pub session_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
pub(super) struct CloseConfirmPayload {
    pub session_id: String,
}

/// `/sessions/close-confirm`: the `cc_conductor` `close_session` MCP tool -
/// fired by the `/close` skill's final phase - POSTs here to confirm the chat
/// really is being torn down (never on `--dont-close` or a failed chain). Sets
/// the registry's one-shot `close_requested` flag; the session's stdout pump
/// consumes it at turn end to mark_ended + kill the process tree. This is the
/// deterministic replacement for parsing a `<cc-close:done>` text marker: a
/// tool call either lands or doesn't, with no prose to mangle.
pub(super) async fn on_close_confirm(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<CloseConfirmPayload>,
) -> impl IntoResponse {
    log::info!("hook /sessions/close-confirm: session={}", payload.session_id);
    // todo 824 remaining 1: reachable only via the MCP `close_session` tool.
    super::mark_mcp_tool_used(&ctx, &payload.session_id);
    ctx.state.registry.set_close_requested(&payload.session_id);
    (StatusCode::OK, Json(json!({"ok": true})))
}

pub(super) async fn on_session_start(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionStartPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-start: session={} cwd={} pid={:?} source={:?}",
        payload.session_id,
        payload.cwd.as_deref().unwrap_or("-"),
        payload.pid,
        payload.source,
    );

    let Some(cwd) = payload.cwd.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "missing cwd"})));
    };
    let cwd_path = std::path::PathBuf::from(&cwd);

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    // Phase 4: if the hook's pid belongs to a channel we spawned, tag it
    // Automated + remote (restores the pre-Phase-3 correlation that lived in
    // the old app-side hook server). We match against BOTH the channel's
    // launcher pid and its resolved `claude` pid: on Windows the launcher is a
    // `cmd.exe` wrapper and the hook reports claude's (child) pid. When the
    // payload omits pid (common in v2.x) or the claude pid isn't resolved yet,
    // this misses here; the background enrichment block below re-runs the match
    // once the real pid is known, and the channel lifecycle also re-tags from
    // its side when it resolves the claude pid.
    let hook_pid = payload.pid.unwrap_or(0);
    let (kind, is_remote) = if hook_pid != 0
        && ctx.state.channels.list().iter()
            .any(|c| c.pid == Some(hook_pid) || c.claude_pid == Some(hook_pid))
    {
        (InstanceKind::Automated, true)
    } else {
        (InstanceKind::External, false)
    };

    let transcript_path_buf = payload.transcript_path.clone().map(std::path::PathBuf::from);

    // Mutate daemon cache first so the cache contains the new project_id.
    let (project_id, created_new) = ctx.state.settings.upsert_project_for_cwd(&cwd_path, &now);

    // Take fresh snapshot AFTER the cache mutation; the shim mutex below will
    // already contain the new project so Registry's internal upsert finds it.
    let snapshot = ctx.state.settings.snapshot();
    let shim_mutex = std::sync::Mutex::new(snapshot);

    let input = RegisterInput {
        session_id: payload.session_id.clone(),
        cwd: cwd_path.clone(),
        pid: payload.pid.unwrap_or(0),
        kind,
        is_remote,
        transcript_path: transcript_path_buf.clone(),
        started_at: now.clone(),
    };
    let (_registered_project_id, _registered_created_new) =
        ctx.state.registry.register(input, &shim_mutex, &now);

    if created_new {
        ctx.state.notifier.publish(
            "project_created",
            json!({"project_id": project_id, "cwd": cwd, "now": now}),
        );
    }

    // Background enrichment: pid + bridgeSessionId via session_files, name from transcript.
    let state = ctx.state.clone();
    let sid = payload.session_id.clone();
    let payload_pid = payload.pid;
    let transcript_path_opt = transcript_path_buf;
    tokio::spawn(async move {
        let mut changed = false;
        // Track the resolved real pid so we can re-run the channel match below.
        let mut resolved_pid: Option<u32> = None;
        if payload_pid.is_none() || payload_pid == Some(0) {
            if let Some(meta) = crate::hooks::session_files::resolve_session_meta(&sid).await {
                resolved_pid = Some(meta.pid);
                if state.registry.set_pid(&sid, meta.pid) { changed = true; }
                if let Some(bridge) = meta.bridge_session_id {
                    state.registry.set_bridge_session_id(&sid, bridge);
                    changed = true;
                }
            }
        } else if let Some(pid) = payload_pid {
            resolved_pid = Some(pid);
            if let Some(bridge) = crate::hooks::session_files::resolve_bridge_session_id(pid).await {
                state.registry.set_bridge_session_id(&sid, bridge);
                changed = true;
            }
        }
        // Phase 4 follow-up (ai_todo 60): once the real pid is known, re-run the
        // channel match. v2.x SessionStart often omits pid, so the immediate match
        // in the synchronous path above misses; this upgrades External -> Automated.
        if let Some(rpid) = resolved_pid {
            let is_channel = state.channels.list().iter()
                .any(|c| c.pid == Some(rpid) || c.claude_pid == Some(rpid));
            if is_channel
                && state.registry.set_kind(&sid, InstanceKind::Automated, true)
            {
                changed = true;
                log::info!("session {sid} re-tagged Automated (channel claude pid {rpid})");
            }
        }
        if let Some(path) = transcript_path_opt {
            if let Some(name) = poll_first_user_prompt(&path).await {
                if state.registry.set_name(&sid, name) { changed = true; }
            }
        }
        if changed {
            crate::daemon::machines::publish_instances_changed(&state);
        }
    });

    crate::daemon::machines::publish_instances_changed(&ctx.state);
    (StatusCode::NO_CONTENT, Json(json!({})))
}

/// Whether a `/hooks/session-end` should actually end the registry entry.
///
/// Interactive (Path C) sessions are daemon-owned: each user turn spawns a
/// short-lived `claude -p` process that fires SessionEnd when the turn
/// completes, so a hook SessionEnd is NOT a signal that the chat is over.
/// Their lifecycle is the chat IPC layer's (close-chat / app-quit), exactly
/// as the detector exempts Interactive from pid-based ending
/// (`sessions/detector.rs`). All other kinds (External / Automated) close on
/// SessionEnd as usual. Unknown sessions (`None`) fall through to a harmless
/// no-op `mark_ended`.
fn hook_session_end_should_close(kind: Option<InstanceKind>) -> bool {
    kind != Some(InstanceKind::Interactive)
}

pub(super) async fn on_session_end(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionEndPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-end: session={} reason={}",
        payload.session_id,
        payload.reason.as_deref().unwrap_or("-"),
    );
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let kind = ctx.state.registry.get(&payload.session_id).map(|i| i.kind);
    if !hook_session_end_should_close(kind) {
        log::debug!(
            "ignoring SessionEnd for daemon-owned Interactive session {}",
            payload.session_id
        );
        return StatusCode::NO_CONTENT;
    }
    if ctx.state.registry.mark_ended(&payload.session_id, crate::types::EndReason::HookSessionEnd, &now) {
        crate::daemon::machines::publish_instances_changed(&ctx.state);
    }
    StatusCode::NO_CONTENT
}

async fn poll_first_user_prompt(path: &std::path::Path) -> Option<String> {
    let path = path.to_path_buf();
    for _ in 0..30 {
        let p = path.clone();
        let found = tokio::task::spawn_blocking(move || crate::tokens::first_user_prompt(&p, 60))
            .await.ok().flatten();
        if let Some(name) = found { return Some(name); }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_end_hook_never_closes_interactive() {
        // Regression: per-turn `claude -p` fires SessionEnd on turn completion;
        // it must not close the daemon-owned Interactive session.
        assert!(!hook_session_end_should_close(Some(InstanceKind::Interactive)));
    }

    #[test]
    fn session_end_hook_closes_other_kinds() {
        assert!(hook_session_end_should_close(Some(InstanceKind::External)));
        assert!(hook_session_end_should_close(Some(InstanceKind::Automated)));
        // Unknown session: harmless no-op mark_ended downstream.
        assert!(hook_session_end_should_close(None));
    }
}
