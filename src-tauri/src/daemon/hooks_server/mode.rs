//! `POST /hooks/mode` sets (or, with `"mode": null`, clears) the current mode and
//! `GET /hooks/mode` reads it. Loopback only, behind the Host + Origin guard
//! (`origin_guard.rs`) like every route here, with no token: Joe's call
//! (docs/architecture/daemon-messages.md, Modes), the same trust the rest of this server runs on.
//!
//! A bad request answers 400 `{"ok":false,"error":...}`, not the 200 that
//! `ValidatedJson` gives the MCP relay: this caller is a script, and it needs
//! the status to tell a refusal from a stored mode.

use super::HookCtx;
use crate::daemon::modes::{self, ModeRequest};
use axum::{
    body::Bytes,
    extract::State as AxState,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn bad_request(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": reason}))).into_response()
}

/// `mode` must be present (a string, or null to clear): an empty object is a
/// mistake, not a request to end the mode.
pub(super) fn parse_body(bytes: &[u8]) -> Result<ModeRequest, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("body is not JSON ({e})"))?;
    let obj = v.as_object().ok_or("body must be a JSON object")?;
    let mode = match obj.get("mode") {
        None => return Err("body needs a \"mode\" key: a name, or null to clear".to_string()),
        Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("mode must be a string or null".to_string()),
    };
    let flags = match obj.get("flags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| i.as_str().map(str::to_string).ok_or("flags must be a list of strings"))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("flags must be a list of strings".to_string()),
    };
    let text = |key: &str| match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    };
    Ok(ModeRequest { mode, flags, until: text("until")?, set_by: text("set_by")? })
}

pub(super) async fn on_mode_set(AxState(ctx): AxState<Arc<HookCtx>>, body: Bytes) -> Response {
    let req = match parse_body(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(&e),
    };
    match modes::apply(&ctx.state, req).await {
        Ok(applied) => (StatusCode::OK, Json(modes::state_json(&applied.state))).into_response(),
        Err(e) if e == modes::UNREADABLE => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok": false, "error": e}))).into_response()
        }
        Err(e) => bad_request(&e),
    }
}

pub(super) async fn on_mode_get() -> Response {
    (StatusCode::OK, Json(modes::state_json(&modes::current()))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_without_a_mode_key_is_refused_so_an_empty_object_never_ends_a_mode() {
        assert!(parse_body(b"{}").unwrap_err().contains("\"mode\""));
        assert!(parse_body(br#"{"flags":["pause_chats"]}"#).is_err());
    }

    #[test]
    fn null_clears_and_a_full_body_parses() {
        let clear = parse_body(br#"{"mode":null}"#).unwrap();
        assert_eq!(clear, ModeRequest::clear());
        let full = parse_body(br#"{"mode":"sleep","flags":["mute_conductor"],"until":"2026-11-16T09:00:00Z","set_by":"timers"}"#).unwrap();
        assert_eq!(full.mode.as_deref(), Some("sleep"));
        assert_eq!(full.flags, vec!["mute_conductor".to_string()]);
        assert_eq!(full.until.as_deref(), Some("2026-11-16T09:00:00Z"));
        assert_eq!(full.set_by.as_deref(), Some("timers"));
    }

    #[test]
    fn wrong_types_name_the_field() {
        assert!(parse_body(b"nope").unwrap_err().starts_with("body is not JSON"));
        assert!(parse_body(b"[]").unwrap_err().contains("object"));
        assert!(parse_body(br#"{"mode":3}"#).unwrap_err().contains("mode"));
        assert!(parse_body(br#"{"mode":"a","flags":"x"}"#).unwrap_err().contains("flags"));
        assert!(parse_body(br#"{"mode":"a","flags":[1]}"#).unwrap_err().contains("flags"));
        assert!(parse_body(br#"{"mode":"a","until":5}"#).unwrap_err().contains("until"));
    }

    /// A stored mode that cannot be read is the server's problem, not a bad request:
    /// a caller that does not retry 4xx must still see it as retryable.
    #[tokio::test]
    async fn an_unreadable_stored_mode_is_a_503_not_a_400() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", tmp.path());
        std::fs::create_dir(modes::config_path_for(&crate::daemon::instance::instance_suffix()).unwrap()).unwrap();
        let ctx = Arc::new(HookCtx { state: crate::daemon::state::DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) });
        let resp = on_mode_set(AxState(ctx), Bytes::from_static(br#"{"mode":"sleep"}"#)).await;
        std::env::remove_var("CC_DATA_DIR");
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap()["ok"], json!(false));
    }

    #[tokio::test]
    async fn a_refused_request_is_a_400_with_the_reason() {
        let resp = bad_request("nope");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!({"ok": false, "error": "nope"}));
    }
}
