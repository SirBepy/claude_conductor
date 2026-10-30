//! `respond_secret` RPC: resolves the oneshot that
//! `hooks_server::secret::on_secret_request` is blocking on, writing the
//! value into the target file via `api_keys::rewrite_env` BEFORE resolving
//! the oneshot - a write failure must report an error, never a false "saved".
//!
//! Secret hygiene (load-bearing): `value` lives only as a local in
//! this file, on the path params -> `rewrite_env` -> `std::fs::write`. It is
//! never logged, never placed in a prompt payload or notifier publish, never
//! interpolated into a panic/expect/error message, and `Body` below derives
//! only `Deserialize` - never `Debug` - so an accidental `{b:?}` log can't
//! leak it either.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// `(ok, error)` for the APP's own ack to its `respond_secret` call -
/// independent of the tool-result payload sent through the oneshot to the
/// blocked MCP caller (built here, but delivered via `tx.send`, never
/// returned to the app).
async fn respond_secret_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    value: Option<String>,
    cancelled: bool,
) -> (bool, Option<String>) {
    if cancelled {
        let tx = state.pending.lock().await.remove(request_id);
        let Some(tx) = tx else {
            return (false, Some("no such secret request".to_string()));
        };
        let _ = tx.send(json!({"ok": true, "text": "cancelled"}));
        state.remove_prompt(request_id).await;
        return (true, None);
    }

    let Some(value) = value else {
        return (false, Some("value is required unless cancelled".to_string()));
    };

    let Some(payload) = state.prompt_payload(request_id).await else {
        return (false, Some("no such secret request".to_string()));
    };
    let file = payload["file"].as_str().unwrap_or_default().to_string();
    let key = payload["key"].as_str().unwrap_or_default().to_string();
    let session_id = payload["session_id"].as_str().map(str::to_string);
    let temporary = payload["temporary"].as_bool().unwrap_or(false);

    // Re-check right before the write: the prompt can sit open for up to an
    // hour (PROMPT_TIMEOUT), long enough for the target's gitignore status -
    // or the file itself - to have changed.
    if let Err(reason) =
        crate::daemon::secret_target::validate(state, session_id.as_deref(), &file, &key).await
    {
        // Prompt stays open on a validation refusal: Joe can still retry
        // with a different value, or cancel.
        return (false, Some(reason));
    }

    let path = PathBuf::from(&file);
    // Decided before the write: afterwards the file always exists. A dangling
    // symlink counts as present, matching what `resolve_target` treats as one.
    let created_file = std::fs::symlink_metadata(&path).is_err();
    // The file may have gained the key while the prompt sat open, so the
    // request-time refusal is not enough.
    if temporary {
        if let Some(reason) = crate::daemon::secret_target::temporary_conflict(&path, &key) {
            return (false, Some(reason));
        }
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = match crate::api_keys::rewrite_env(&existing, &key, &value) {
        Ok(u) => u,
        // Prompt stays open here too - same reasoning as the validation
        // refusal above.
        Err(e) => return (false, Some(e)),
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (false, Some(e.to_string()));
        }
    }
    if let Err(e) = std::fs::write(&path, &updated) {
        return (false, Some(e.to_string()));
    }

    let char_count = value.chars().count();
    let cwd = session_id.as_deref().and_then(|sid| state.registry.get(sid)).map(|i| i.cwd);
    record_lifetime(session_id.as_deref(), cwd, &path, &key, temporary, created_file);
    let tx = state.pending.lock().await.remove(request_id);
    let Some(tx) = tx else {
        // The write succeeded, but the blocked HTTP handler is already gone
        // (daemon restart, client disconnect) - report it to the app; there
        // is no live waiter left to resolve. Still tear down the ghost record.
        state.remove_prompt(request_id).await;
        return (false, Some("no such secret request".to_string()));
    };
    let _ = tx.send(json!({
        "ok": true,
        "text": format!("saved {char_count} characters to {file} ({key})"),
    }));
    state.remove_prompt(request_id).await;
    (true, None)
}

/// Ties a just-written secret to its chat when it was asked for as temporary;
/// a permanent write to a key an earlier temporary request used takes that key
/// off the cleanup list, so closing the chat does not delete what Joe kept.
fn record_lifetime(
    session_id: Option<&str>,
    cwd: Option<PathBuf>,
    path: &std::path::Path,
    key: &str,
    temporary: bool,
    created_file: bool,
) {
    use crate::daemon::secret_target::{temporary_secrets, TempSecret};
    match (temporary, session_id, cwd) {
        (true, Some(sid), Some(cwd)) => temporary_secrets().record(TempSecret {
            session_id: sid.to_string(),
            file: path.to_path_buf(),
            key: key.to_string(),
            created_file,
            cwd,
        }),
        // The chat closed (or was never registered) while the prompt was open,
        // so there is no cwd to re-validate the path against at sweep time and
        // no close left to trigger one. The value stays on disk; say so rather
        // than let a "temporary" secret outlive its chat unnoticed.
        (true, sid, _) => log::warn!(
            "[secret-relay] temporary secret {key} written to {} is not tracked for cleanup: \
             no registry entry for session {}",
            path.display(),
            sid.unwrap_or("(none)")
        ),
        (false, ..) => temporary_secrets().forget(path, key),
    }
}

pub fn register_secret(router: &mut Router, state: Arc<DaemonState>) {
    router.register("respond_secret", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct Body {
                request_id: String,
                #[serde(default)]
                value: Option<String>,
                #[serde(default)]
                cancelled: bool,
            }
            let b: Body = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let (ok, error) = respond_secret_inner(&state, &b.request_id, b.value, b.cancelled).await;
            Ok(json!({"ok": ok, "error": error}))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request, Router};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state_with_session(sid: &str, cwd: &std::path::Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session(sid, cwd, &settings, "2026-08-18T00:00:00Z");
        state
    }

    async fn open_prompt(state: &Arc<DaemonState>, id: &str, sid: &str, file: &std::path::Path, key: &str) -> tokio::sync::oneshot::Receiver<Value> {
        open_prompt_with(state, id, sid, file, key, false).await
    }

    async fn open_prompt_with(
        state: &Arc<DaemonState>,
        id: &str,
        sid: &str,
        file: &std::path::Path,
        key: &str,
        temporary: bool,
    ) -> tokio::sync::oneshot::Receiver<Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        state.pending.lock().await.insert(id.to_string(), tx);
        state
            .add_prompt(
                id,
                "secret-requested",
                json!({"id": id, "session_id": sid, "label": "x", "file": file.to_string_lossy(), "key": key, "temporary": temporary}),
                false,
            )
            .await;
        rx
    }

    async fn respond(state: &Arc<DaemonState>, id: &str, value: &str) {
        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_secret".into(),
                    params: Some(json!({"request_id": id, "value": value})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!({"ok": true, "error": null})));
    }

    /// Closing the chat that asked for a temporary secret removes its key line
    /// and leaves the file's other lines. Unique session ids keep these tests
    /// off each other's entries in the process-wide cleanup list.
    #[tokio::test]
    async fn closing_the_chat_removes_a_temporary_key() {
        let tmp = tempfile::tempdir().unwrap();
        // Canonical like the path the request handler stores in the payload.
        let cwd = std::fs::canonicalize(tmp.path()).unwrap();
        let sid = "temp-remove-key";
        let state = state_with_session(sid, &cwd);
        let target = cwd.join("secrets.env");
        std::fs::write(&target, "OTHER=1
").unwrap();
        let _rx = open_prompt_with(&state, "p1", sid, &target, "API_KEY", true).await;
        respond(&state, "p1", "sk-abc").await;
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "OTHER=1
API_KEY=sk-abc
");

        crate::daemon::secret_target::temporary_secrets().sweep_session(sid);

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "OTHER=1
");
    }

    /// A temporary secret that made its file takes the file with it.
    #[tokio::test]
    async fn closing_the_chat_deletes_a_file_the_temporary_secret_created() {
        let tmp = tempfile::tempdir().unwrap();
        // Canonical like the path the request handler stores in the payload.
        let cwd = std::fs::canonicalize(tmp.path()).unwrap();
        let sid = "temp-delete-file";
        let state = state_with_session(sid, &cwd);
        let target = cwd.join("secrets.env");
        let _rx = open_prompt_with(&state, "p1", sid, &target, "API_KEY", true).await;
        respond(&state, "p1", "sk-abc").await;
        assert!(target.exists());

        crate::daemon::secret_target::temporary_secrets().sweep_session(sid);

        assert!(!target.exists());
    }

    /// A secret not asked for as temporary is still there after its chat closes.
    #[tokio::test]
    async fn closing_the_chat_keeps_a_permanent_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let sid = "temp-permanent-survives";
        let state = state_with_session(sid, &cwd);
        let target = cwd.join("secrets.env");
        let _rx = open_prompt(&state, "p1", sid, &target, "API_KEY").await;
        respond(&state, "p1", "sk-abc").await;

        crate::daemon::secret_target::temporary_secrets().sweep_session(sid);

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "API_KEY=sk-abc
");
    }

    /// A temporary secret never replaces a value already stored under its key:
    /// the write is refused with a clear reason, the file keeps Joe's value,
    /// and the prompt stays open for a retry.
    #[tokio::test]
    async fn a_temporary_secret_over_an_existing_key_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let sid = "temp-refuse-existing-key";
        let state = state_with_session(sid, &cwd);
        let target = cwd.join("secrets.env");
        std::fs::write(&target, "API_KEY=sk-kept\n").unwrap();
        let _rx = open_prompt_with(&state, "p1", sid, &target, "API_KEY", true).await;

        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_secret".into(),
                    params: Some(json!({"request_id": "p1", "value": "sk-new"})),
                },
                dummy_ctx(),
            )
            .await;

        let result = resp.result.unwrap();
        assert_eq!(result["ok"], json!(false));
        let reason = result["error"].as_str().unwrap();
        assert!(reason.contains("API_KEY") && reason.contains("temporary"), "got: {reason}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "API_KEY=sk-kept\n");
        assert_eq!(state.list_prompts().await.len(), 1, "the prompt stays open");
        assert_eq!(crate::daemon::secret_target::temporary_secrets().live_for(sid), 0);
    }

    /// Saving the same key again as permanent cancels the earlier temporary
    /// request's cleanup, so the value Joe kept survives the close.
    #[tokio::test]
    async fn a_later_permanent_save_of_the_same_key_survives_the_close() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let sid = "temp-then-permanent";
        let state = state_with_session(sid, &cwd);
        let target = cwd.join("secrets.env");
        let _rx1 = open_prompt_with(&state, "p1", sid, &target, "API_KEY", true).await;
        respond(&state, "p1", "sk-one").await;
        let _rx2 = open_prompt(&state, "p2", sid, &target, "API_KEY").await;
        respond(&state, "p2", "sk-two").await;

        crate::daemon::secret_target::temporary_secrets().sweep_session(sid);

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "API_KEY=sk-two
");
    }

    /// A temporary write whose chat is gone from the registry cannot be tied to
    /// a close, so it is not put on the cleanup list (the sweep would have no
    /// cwd to validate against) and the write path does not panic on it.
    #[test]
    fn a_temporary_write_with_no_registry_entry_is_not_tracked() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("untracked.env");

        record_lifetime(Some("closed-mid-prompt"), None, &file, "API_KEY", true, true);
        record_lifetime(None, None, &file, "API_KEY", true, true);

        assert!(!crate::daemon::secret_target::temporary_secrets().holds(&file, "API_KEY"));
    }

    /// Full round trip: request -> respond -> the target file ends up
    /// holding `KEY=value`, and the blocked caller's oneshot resolves with
    /// the expected tool-result text - never the value itself.
    #[tokio::test]
    async fn respond_secret_writes_the_value_and_resolves_with_a_safe_text() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let state = state_with_session("s1", &cwd);
        let target = cwd.join("secrets.env");
        let rx = open_prompt(&state, "p1", "s1", &target, "API_KEY").await;

        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_secret".into(),
                    params: Some(json!({"request_id": "p1", "value": "sk-abc"})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!({"ok": true, "error": null})));

        let written = std::fs::read_to_string(&target).unwrap();
        assert_eq!(written, "API_KEY=sk-abc\n");

        let payload = rx.await.unwrap();
        assert_eq!(payload["ok"], json!(true));
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("saved 6 characters"), "got: {text}");
        assert!(!text.contains("sk-abc"), "the tool result text must never carry the value");
        assert!(state.list_prompts().await.is_empty());
    }

    /// Existing sibling lines in the target file must survive untouched.
    #[tokio::test]
    async fn respond_secret_preserves_existing_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let target = cwd.join("secrets.env");
        std::fs::write(&target, "# header\nOTHER=1\n").unwrap();
        let state = state_with_session("s1", &cwd);
        let _rx = open_prompt(&state, "p1", "s1", &target, "API_KEY").await;

        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        r.dispatch(
            Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "respond_secret".into(),
                params: Some(json!({"request_id": "p1", "value": "sk-abc"})),
            },
            dummy_ctx(),
        )
        .await;

        let written = std::fs::read_to_string(&target).unwrap();
        assert_eq!(written, "# header\nOTHER=1\nAPI_KEY=sk-abc\n");
    }

    /// Cancel resolves the waiter with `"cancelled"` and writes nothing.
    #[tokio::test]
    async fn respond_secret_cancel_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let target = cwd.join("secrets.env");
        let state = state_with_session("s1", &cwd);
        let rx = open_prompt(&state, "p1", "s1", &target, "API_KEY").await;

        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_secret".into(),
                    params: Some(json!({"request_id": "p1", "cancelled": true})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!({"ok": true, "error": null})));
        assert!(!target.exists(), "cancel must never write the file");

        let payload = rx.await.unwrap();
        assert_eq!(payload, json!({"ok": true, "text": "cancelled"}));
    }

    /// An id the daemon has never seen (already resolved, or never existed)
    /// settles as a clean error, not a panic or a false success.
    #[tokio::test]
    async fn unknown_request_id_is_a_clean_error() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut r = Router::new();
        register_secret(&mut r, state.clone());
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_secret".into(),
                    params: Some(json!({"request_id": "ghost", "value": "x"})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!({"ok": false, "error": "no such secret request"})));
    }
}
