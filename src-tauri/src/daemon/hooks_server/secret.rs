//! Blocking secret endpoint: `/secrets/request` blocks on a oneshot until
//! `respond_secret` answers (saved/cancelled) or the prompt times out - same
//! shape as `permission.rs::on_permission_request`: a secret write needs the
//! human in the loop just as much as a tool permission does, not a
//! fire-and-forget question. The MCP relay's own `RELAY_TIMEOUT_SECS` (3660s)
//! already out-waits `PROMPT_TIMEOUT` below.
//!
//! The VALUE being saved never reaches this file: it travels only through
//! `respond_secret`'s own params straight into the write
//! (`methods::secret::respond_secret_inner`). This module only ever sees
//! `label`/`file`/`key`/`temporary` - the metadata about the secret, never its
//! contents.

use super::permission::{await_answer, PROMPT_TIMEOUT};
use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct SecretRequestBody {
    id: String,
    label: String,
    file: String,
    key: String,
    #[serde(default)]
    session_id: Option<String>,
    /// Delete the value when the asking chat closes.
    #[serde(default)]
    temporary: bool,
}

pub(super) async fn on_secret_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SecretRequestBody>,
) -> impl IntoResponse {
    // Same reachability proof as permission.rs: only the MCP relay reaches
    // this route, so landing here proves this session's MCP transport is up.
    if let Some(sid) = body.session_id.as_deref() {
        super::mark_mcp_tool_used(&ctx, sid);
    }

    // Refuse BEFORE registering the prompt or showing a card - a target that
    // fails the check never reaches the user at all.
    let resolved_file = match crate::daemon::secret_target::validate(
        &ctx.state,
        body.session_id.as_deref(),
        &body.file,
        &body.key,
    )
    .await
    {
        Ok(path) => path,
        Err(reason) => {
            return (StatusCode::OK, Json(json!({"ok": false, "error": reason})));
        }
    };

    let payload = json!({
        "id": body.id,
        "session_id": body.session_id,
        "label": body.label,
        "file": resolved_file.to_string_lossy(),
        "key": body.key,
        "temporary": body.temporary,
    });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.add_prompt(&body.id, "secret-requested", payload.clone(), false).await;
    // Push the phone if Joe is away, same as a blocking permission prompt.
    ctx.state.fire_blocked_prompt(body.session_id.as_deref(), &body.id);
    crate::daemon::jarvis_wake::wake_on_worker_blocked(
        &ctx.state,
        body.session_id.as_deref(),
        &body.id,
        Some("request_secret"),
    )
    .await;
    // Daemon-authoritative "needs input", same as the permission path.
    super::question::set_question_awaiting(&ctx.state, body.session_id.as_deref(), true).await;
    let subs = ctx.state.notifier.publish("secret_request", payload);
    log::info!(
        "[secret-relay] published secret_request id={} session={:?} -> {} subscriber(s)",
        body.id, body.session_id, subs
    );
    let result = match await_answer(rx, PROMPT_TIMEOUT).await {
        Some(val) => (StatusCode::OK, Json(val)),
        None => {
            ctx.state.pending.lock().await.remove(&body.id);
            (
                StatusCode::OK,
                Json(json!({"ok": false, "error": "user did not respond in time"})),
            )
        }
    };
    // Answered or timed out - clear the same way permission.rs does, gated so
    // a coincident genuinely-open question/permission prompt survives.
    super::question::set_question_awaiting(&ctx.state, body.session_id.as_deref(), false).await;
    ctx.state.remove_prompt(&body.id).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use std::path::Path;

    fn state_with_session(sid: &str, cwd: &Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session(sid, cwd, &settings, "2026-08-18T00:00:00Z");
        state
    }

    fn secret_body(id: &str, sid: &str, file: &str) -> SecretRequestBody {
        SecretRequestBody {
            id: id.to_string(),
            label: "Kinetic Panel API key".to_string(),
            file: file.to_string(),
            key: "API_KEY".to_string(),
            session_id: Some(sid.to_string()),
            temporary: false,
        }
    }

    async fn await_pending(state: &Arc<DaemonState>, id: &str) {
        for _ in 0..200 {
            if state.pending.lock().await.contains_key(id) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("secret handler never registered its pending oneshot");
    }

    /// A refused target (outside the session's cwd) must error out
    /// immediately, with no prompt ever registered - the card never shows.
    #[tokio::test]
    async fn refused_target_never_registers_a_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("s1", &cwd);
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let resp = on_secret_request(
            AxState(ctx),
            ValidatedJson(secret_body("p1", "s1", "../outside.env")),
        )
        .await
        .into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains(".."));
        assert!(state.list_prompts().await.is_empty());
        assert!(state.pending.lock().await.is_empty());
    }

    /// A valid target blocks on the oneshot, marks the session as awaiting
    /// input, and clears it again once `respond_secret` resolves the answer -
    /// the same observable shape as a blocking permission prompt.
    #[tokio::test]
    async fn valid_request_blocks_then_clears_awaiting_on_answer() {
        use axum::response::IntoResponse;
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("s1", &cwd);
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let handle = tokio::spawn(async move {
            on_secret_request(AxState(ctx), ValidatedJson(secret_body("p1", "s1", "secrets.env")))
                .await
                .into_response()
        });
        await_pending(&state, "p1").await;

        assert_eq!(
            state.registry.get("s1").unwrap().awaiting.as_deref(),
            Some("question"),
            "a blocked secret prompt is 'needs input', same as a permission prompt"
        );
        let prompts = state.list_prompts().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["event"], "secret-requested");
        assert!(
            prompts[0]["payload"]["file"].as_str().unwrap().ends_with("secrets.env"),
            "payload must carry the resolved absolute path"
        );

        let tx = state.pending.lock().await.remove("p1").unwrap();
        tx.send(json!({"ok": true, "text": "saved 3 characters to secrets.env (API_KEY)"})).unwrap();
        let resp = handle.await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], json!(true));

        assert!(
            state.registry.get("s1").unwrap().awaiting.is_none(),
            "answering clears 'needs input', same as permission.rs"
        );
    }

    /// The `temporary` flag rides the prompt payload to the card and to
    /// `respond_secret`, and defaults to a permanent secret.
    #[tokio::test]
    async fn temporary_flag_reaches_the_prompt_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("s1", &cwd);
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let mut body = secret_body("p1", "s1", "secrets.env");
        body.temporary = true;
        let handle = tokio::spawn(async move {
            on_secret_request(AxState(ctx), ValidatedJson(body)).await.into_response()
        });
        await_pending(&state, "p1").await;

        let prompts = state.list_prompts().await;
        assert_eq!(prompts[0]["payload"]["temporary"], json!(true));

        let tx = state.pending.lock().await.remove("p1").unwrap();
        tx.send(json!({"ok": true, "text": "cancelled"})).unwrap();
        handle.await.unwrap();

        let absent: SecretRequestBody =
            serde_json::from_value(json!({"id": "i", "label": "l", "file": "f", "key": "k"})).unwrap();
        assert!(!absent.temporary, "omitted means permanent");
    }
}
