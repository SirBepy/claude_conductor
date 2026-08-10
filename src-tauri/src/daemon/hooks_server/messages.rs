//! `/messages/send` route: the `cc_conductor` `send_message` MCP tool POSTs
//! here. The transcript already carries the message via Claude's own
//! stream-json output; this route validates AND records the send (Stop-hook
//! enforcement, mirroring `report_turn_status`) so a quiet-mode chat is never
//! left with zero visible messages.

use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

/// Deliberately NOT `repo_channel::MAX_TEXT_LEN` (2000) - that cap keeps a peer
/// wake line short inside another session's context; a report meant for Joe has
/// no such constraint. Sharing it is what produced the 3x-duplicate bug.
const MAX_MESSAGE_LEN: usize = 8000;

/// Sanity bound only. `resolveMessageOrdinal` in chat-event-handler.ts does the
/// real windowing (anything sent since Joe's second-most-recent message).
const MAX_ORDINAL: u64 = 64;

#[derive(Deserialize)]
pub(super) struct SendMessageBody {
    session_id: String,
    text: String,
}

#[derive(Deserialize)]
pub(super) struct UpdateMessageBody {
    session_id: String,
    message: u64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    retract: bool,
}

pub(super) async fn on_send_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<SendMessageBody>,
) -> impl IntoResponse {
    let trimmed = body.text.trim();
    if trimmed.is_empty() {
        return (StatusCode::OK, Json(json!({"ok": false, "error": "text must not be empty"})));
    }
    if trimmed.chars().count() > MAX_MESSAGE_LEN {
        return (
            StatusCode::OK,
            Json(json!({"ok": false, "error": format!("text exceeds {MAX_MESSAGE_LEN} chars")})),
        );
    }
    let gen = ctx.state.registry.current_turn_gen(&body.session_id);
    ctx.state.registry.mark_message_sent(&body.session_id, gen);
    log::debug!("session {} sent a message", body.session_id);
    (StatusCode::OK, Json(json!({"ok": true, "message": 1})))
}

pub(super) async fn on_update_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<UpdateMessageBody>,
) -> impl IntoResponse {
    if body.message < 1 || body.message > MAX_ORDINAL {
        return (StatusCode::OK, Json(json!({"ok": false, "error": "message must be 1 or greater"})));
    }
    if !body.retract {
        let trimmed = body.text.as_deref().unwrap_or("").trim().to_string();
        if trimmed.is_empty() {
            return (
                StatusCode::OK,
                Json(json!({"ok": false, "error": "text is required unless retract is true"})),
            );
        }
        if trimmed.chars().count() > MAX_MESSAGE_LEN {
            return (
                StatusCode::OK,
                Json(json!({"ok": false, "error": format!("text exceeds {MAX_MESSAGE_LEN} chars")})),
            );
        }
    }
    // A revision counts as this turn having spoken, so a correction-only turn
    // doesn't trip the Stop-hook's "said nothing" enforcement.
    let gen = ctx.state.registry.current_turn_gen(&body.session_id);
    ctx.state.registry.mark_message_sent(&body.session_id, gen);
    (StatusCode::OK, Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn valid_text_route_returns_ok() {
        let body = SendMessageBody { session_id: "s".into(), text: "Finished the build.".into() };
        let resp = on_send_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true, "message": 1}));
    }

    #[tokio::test]
    async fn send_accepts_text_over_the_repo_channel_cap() {
        let body = SendMessageBody { session_id: "s".into(), text: "x".repeat(4000) };
        let resp = on_send_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn retract_needs_no_text() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: true,
        };
        let resp = on_update_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn edit_without_text_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: false,
        };
        let resp = on_update_message(AxState(ctx()), Json(body)).await.into_response();
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("text is required"));
    }

    #[tokio::test]
    async fn zero_ordinal_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 0, text: Some("x".into()), retract: false,
        };
        let resp = on_update_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(false));
    }

    #[tokio::test]
    async fn update_records_message_sent_so_a_correction_only_turn_counts() {
        let c = ctx();
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: Some("fixed".into()), retract: false,
        };
        on_update_message(AxState(c.clone()), Json(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn valid_text_route_records_message_sent_for_current_gen() {
        let c = ctx();
        let body = SendMessageBody { session_id: "s".into(), text: "Finished the build.".into() };
        on_send_message(AxState(c.clone()), Json(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn empty_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "   ".into() };
        let resp = on_send_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("empty"));
    }

    #[tokio::test]
    async fn empty_text_route_does_not_record_message_sent() {
        let c = ctx();
        let body = SendMessageBody { session_id: "s".into(), text: "   ".into() };
        on_send_message(AxState(c.clone()), Json(body)).await;
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());
    }

    #[tokio::test]
    async fn overlong_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "x".repeat(MAX_MESSAGE_LEN + 1) };
        let resp = on_send_message(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("8000"));
    }
}
