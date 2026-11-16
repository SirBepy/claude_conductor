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

/// What a sub visiting from another machine is told when the link to its home is not
/// encrypted: the secret would have to cross it in the clear on the way from the home's
/// window to this machine. `session_id` is the sub's own, so the file is its own.
pub(crate) const PLAIN_LINK_NOTE: &str = "This chat runs on a different machine than its main chat, and the link between the two is not encrypted, so a secret cannot be typed in the main chat's window. Do not ask for it again. Ask Joe to put the value into the file on this machine by hand, then carry on.";

/// `Some(note)` when `session_id` is a visiting sub whose home is not reached over an
/// encrypted link, as this machine knows the pair. The home's own check is the real
/// guard (it never shows the card); this only tells the sub at once instead of leaving
/// it waiting an hour on a card nobody can see. An unknown home counts as unencrypted.
fn visiting_refusal(state: &crate::daemon::state::DaemonState, session_id: Option<&str>) -> Option<&'static str> {
    let home = crate::daemon::subchats::remote::events::home_of(session_id?)?;
    let encrypted = state
        .machines
        .get()
        .and_then(|r| r.peer(&home.machine_id))
        .is_some_and(|p| crate::daemon::machines::peer_client::link_is_encrypted(&p));
    (!encrypted).then_some(PLAIN_LINK_NOTE)
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

    if let Some(note) = visiting_refusal(&ctx.state, body.session_id.as_deref()) {
        return (StatusCode::OK, Json(json!({"ok": false, "error": note})));
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

    // Tell the asking chat now, before Joe is shown a card that could only
    // end in a refusal.
    if body.temporary {
        if let Some(reason) = crate::daemon::secret_target::temporary_conflict(&resolved_file, &body.key) {
            return (StatusCode::OK, Json(json!({"ok": false, "error": reason})));
        }
    }

    let mut payload = json!({
        "id": body.id,
        "session_id": body.session_id,
        "label": body.label,
        "file": resolved_file.to_string_lossy(),
        "key": body.key,
        "temporary": body.temporary,
    });
    crate::daemon::subchats::stamp_prompt_routing(&ctx.state, &mut payload, body.session_id.as_deref());
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.add_prompt(&body.id, "secret-requested", payload.clone(), false).await;
    // Push the phone if Joe is away, same as a blocking permission prompt.
    crate::daemon::notify_gate::push_blocked(&ctx.state, body.session_id.as_deref(), &body.id);
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

    /// A temporary request for a key the file already holds is answered with
    /// the reason straight away, with no card shown.
    #[tokio::test]
    async fn temporary_request_for_an_existing_key_is_refused_before_the_card() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join("secrets.env"), "API_KEY=sk-kept\n").unwrap();
        let state = state_with_session("s1", &cwd);
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let mut body = secret_body("p1", "s1", "secrets.env");
        body.temporary = true;
        let resp = on_secret_request(AxState(ctx), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("API_KEY"), "got: {v}");
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

    /// A sub's secret card shows in its parent's window; the answer still goes
    /// to the sub, so `session_id` stays the asker.
    #[tokio::test]
    async fn a_subs_secret_prompt_displays_on_its_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("sub", &cwd);
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("main", &cwd, &settings, "2026-08-18T00:00:00Z");
        state.registry.set_subchat_of("sub", Some("main".into()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let handle = tokio::spawn(async move {
            on_secret_request(AxState(ctx), ValidatedJson(secret_body("p1", "sub", "secrets.env")))
                .await
                .into_response()
        });
        await_pending(&state, "p1").await;
        let payload = state.list_prompts().await[0]["payload"].clone();
        assert_eq!(payload["session_id"], "sub");
        assert_eq!(payload["display_session_id"], "main");

        let tx = state.pending.lock().await.remove("p1").unwrap();
        tx.send(json!({"ok": true})).unwrap();
        handle.await.unwrap();
    }

    /// A sub visiting from another machine may ask for a secret only when its home is
    /// reached over an encrypted link (iroh); over a plain `http://` link it is told to
    /// have Joe put the value in by hand, and no card is raised.
    #[tokio::test]
    async fn a_visiting_subs_secret_request_is_refused_unless_its_home_link_is_encrypted() {
        use crate::daemon::machines::registry::PeerMachine;
        let _data = crate::daemon::subchats::TempDataDir::new();
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("vsub", &cwd);
        state.init_machines(tmp.path().join("machines"));
        crate::daemon::subchats::store_visiting_brief("vsub", "home-main", "pc");
        state.registry.set_subchat_of("vsub", Some("home-main".into()));
        let peer = |iroh: Option<&str>, direct: Option<&str>| PeerMachine {
            machine_id: "pc".into(),
            label: "PC".into(),
            os: "test".into(),
            iroh_id: iroh.map(str::to_string),
            direct_url: direct.map(str::to_string),
            token: "t".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        };
        let ask = |state: &Arc<DaemonState>| {
            let ctx = Arc::new(HookCtx { state: state.clone() });
            tokio::spawn(async move {
                let resp = on_secret_request(AxState(ctx), ValidatedJson(secret_body("p1", "vsub", "secrets.env"))).await.into_response();
                let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
                serde_json::from_slice::<Value>(&bytes).unwrap()
            })
        };
        // A direct URL is plain http, and a home this machine does not know is no better.
        for registered in [Some(peer(Some("iroh"), Some("http://192.168.1.5:27184"))), None] {
            if let Some(p) = registered {
                state.machines.get().unwrap().upsert_peer(p);
            }
            let v = ask(&state).await.unwrap();
            assert_eq!(v["ok"], json!(false));
            assert!(v["error"].as_str().unwrap().contains("by hand"), "{v}");
            assert!(state.list_prompts().await.is_empty(), "no card for a window that could not take the secret");
        }
        // Reached through iroh alone: the request goes on to raise its card.
        state.machines.get().unwrap().upsert_peer(peer(Some("iroh"), None));
        let handle = ask(&state);
        await_pending(&state, "p1").await;
        assert_eq!(state.list_prompts().await[0]["payload"]["display_session_id"], "home-main");
        state.pending.lock().await.remove("p1").unwrap().send(json!({"ok": true})).unwrap();
        assert_eq!(handle.await.unwrap()["ok"], json!(true));
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
