//! `/messages/send` route: the `cc_conductor` `send_message` MCP tool POSTs
//! here. No state mutation - the transcript already carries the message via
//! Claude's own stream-json output; this route exists purely to validate.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;

/// Hard cap mirroring `sessions::repo_channel::MAX_TEXT_LEN`, so a runaway
/// agent can't blow up the chat view with one message.
const MAX_TEXT_LEN: usize = 2000;

#[derive(Deserialize)]
pub(super) struct SendMessageBody {
    session_id: String,
    text: String,
}

pub(super) async fn on_send_message(Json(body): Json<SendMessageBody>) -> impl IntoResponse {
    let trimmed = body.text.trim();
    if trimmed.is_empty() {
        return (StatusCode::OK, Json(json!({"ok": false, "error": "text must not be empty"})));
    }
    if trimmed.chars().count() > MAX_TEXT_LEN {
        return (StatusCode::OK, Json(json!({"ok": false, "error": "text exceeds 2000 chars"})));
    }
    log::debug!("session {} sent a message", body.session_id);
    (StatusCode::OK, Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn valid_text_route_returns_ok() {
        let body = SendMessageBody { session_id: "s".into(), text: "Finished the build.".into() };
        let resp = on_send_message(Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true}));
    }

    #[tokio::test]
    async fn empty_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "   ".into() };
        let resp = on_send_message(Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("empty"));
    }

    #[tokio::test]
    async fn overlong_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "x".repeat(MAX_TEXT_LEN + 1) };
        let resp = on_send_message(Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("2000"));
    }
}
