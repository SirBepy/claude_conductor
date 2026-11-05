//! Lifecycle endpoints: `/hooks/session-start` + `/hooks/session-end`. These
//! populate / close registry entries and own the background enrichment that
//! resolves pid and session name.

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
    /// `"started"` marks the chat Closing without confirming teardown; absent
    /// is the final confirmation.
    #[serde(default)]
    pub stage: Option<String>,
}

/// What a sub is told when it calls `close_session`.
const SUB_CLOSE_REFUSAL: &str = "close_session does not apply to a sub: you do not close, you finish. Call finish_subchat when the job is done; the chat is then stopped and kept for follow-ups.";

/// Applies one `close_session` call to the registry. `started` only raises the
/// `closing` row state (returns true if that changed it, so the caller
/// publishes); anything else is the confirmation that arms teardown at turn end.
fn apply_close_stage(registry: &crate::sessions::registry::Registry, session_id: &str, stage: Option<&str>) -> bool {
    if stage == Some("started") {
        return registry.set_closing(session_id, true);
    }
    registry.set_close_requested(session_id);
    false
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
    log::info!(
        "hook /sessions/close-confirm: session={} stage={}",
        payload.session_id,
        payload.stage.as_deref().unwrap_or("confirm")
    );
    // todo 824 remaining 1: reachable only via the MCP `close_session` tool.
    super::mark_mcp_tool_used(&ctx, &payload.session_id);
    // Every chat is told by the global rules to run `/close`, so a sub reaches
    // here by habit; only `finish_subchat` ends one, and it keeps the row.
    if ctx.state.registry.get(&payload.session_id).is_some_and(|i| crate::daemon::subchats::is_sub(&i)) {
        return (StatusCode::OK, Json(json!({"ok": false, "error": SUB_CLOSE_REFUSAL})));
    }
    if apply_close_stage(&ctx.state.registry, &payload.session_id, payload.stage.as_deref()) {
        crate::daemon::machines::publish_instances_changed(&ctx.state);
    }
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

    // Ask sidecars are daemon-internal `claude -p` runs, not
    // chats. The global hook fires for them too, and registering one put a
    // ghost External row in the sidebar that died the instant the sidecar
    // exited, plus the app-data dir itself in the project list.
    if crate::sessions::internal::is_internal_sidecar_cwd(&cwd_path) {
        log::info!(
            "hook /hooks/session-start: ignoring internal sidecar session={}",
            payload.session_id,
        );
        return (StatusCode::NO_CONTENT, Json(json!({})));
    }

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    // A session reaching the hook server was started outside this daemon.
    let (kind, is_remote) = (InstanceKind::External, false);

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

    // Background enrichment: pid via session_files, name from transcript.
    let state = ctx.state.clone();
    let sid = payload.session_id.clone();
    let payload_pid = payload.pid;
    let transcript_path_opt = transcript_path_buf;
    tokio::spawn(async move {
        let mut changed = false;
        if payload_pid.is_none() || payload_pid == Some(0) {
            if let Some(meta) = crate::hooks::session_files::resolve_session_meta(&sid).await {
                if state.registry.set_pid(&sid, meta.pid) { changed = true; }
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
    fn close_stage_started_marks_closing_without_arming_teardown() {
        use crate::sessions::registry::Registry;
        let registry = Registry::new();
        let settings = std::sync::Mutex::new(crate::types::Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-11-03T00:00:00Z");

        assert!(apply_close_stage(&registry, "s", Some("started")), "the row flips to closing");
        assert!(registry.get("s").unwrap().closing);
        assert!(!registry.take_close_requested("s"), "started must not confirm teardown");
        assert!(!apply_close_stage(&registry, "s", Some("started")), "a repeat changes nothing");

        assert!(!apply_close_stage(&registry, "s", None));
        assert!(registry.take_close_requested("s"), "the final call arms teardown");
    }

    async fn close_confirm(ctx: &Arc<HookCtx>, session: &str, stage: Option<&str>) -> serde_json::Value {
        let payload = CloseConfirmPayload { session_id: session.to_string(), stage: stage.map(str::to_string) };
        let resp = on_close_confirm(AxState(ctx.clone()), Json(payload)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn close_ctx() -> Arc<HookCtx> {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        Arc::new(HookCtx {
            state: crate::daemon::state::DaemonState::new(
                new_session_map(),
                SettingsCache::new(crate::types::Settings::default()),
            ),
        })
    }

    #[tokio::test]
    async fn close_session_from_a_sub_is_refused_naming_finish_subchat_and_arms_nothing() {
        let ctx = close_ctx();
        for id in ["close-main", "close-sub"] {
            ctx.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        ctx.state.registry.set_subchat_of("close-sub", Some("close-main".into()));
        for stage in [None, Some("started")] {
            let v = close_confirm(&ctx, "close-sub", stage).await;
            assert_eq!(v["ok"], serde_json::json!(false), "{stage:?}");
            assert!(v["error"].as_str().unwrap().contains("finish_subchat"), "{v}");
        }
        assert!(!ctx.state.registry.take_close_requested("close-sub"), "no teardown is armed for a sub");
        assert!(!ctx.state.registry.get("close-sub").unwrap().closing);
    }

    #[tokio::test]
    async fn close_session_from_an_ordinary_chat_and_from_a_main_chat_still_works() {
        let ctx = close_ctx();
        for id in ["close-plain", "close-main2", "close-sub2"] {
            ctx.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        ctx.state.registry.set_subchat_of("close-sub2", Some("close-main2".into()));
        assert_eq!(close_confirm(&ctx, "close-plain", None).await["ok"], serde_json::json!(true));
        assert!(ctx.state.registry.take_close_requested("close-plain"));
        // The parent of a sub is not itself a sub.
        assert_eq!(close_confirm(&ctx, "close-main2", Some("started")).await["ok"], serde_json::json!(true));
    }

    #[test]
    fn session_end_hook_closes_other_kinds() {
        assert!(hook_session_end_should_close(Some(InstanceKind::External)));
        assert!(hook_session_end_should_close(Some(InstanceKind::Automated)));
        // Unknown session: harmless no-op mark_ended downstream.
        assert!(hook_session_end_should_close(None));
    }
}
