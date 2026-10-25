//! `/messages/send` route: the `cc_conductor` `send_message` MCP tool POSTs
//! here. The transcript already carries the message via Claude's own
//! stream-json output; this route validates AND records the send (Stop-hook
//! enforcement, mirroring `report_turn_status`).

use super::validated_json::ValidatedJson;
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
    // `message` alias: the sibling UpdateMessageBody below has its OWN unrelated
    // `message: u64` field (an ordinal), and this route's tool is literally named
    // `send_message` - both nudge a caller toward guessing `message` here too.
    // Documented 8x across 2026-08-09 through 2026-10-19 in
    // project_report_turn_status_relay_decode_error.md, the last time landing a
    // "Failed to send" marker mid-transcript in a chat Joe was reading. Accepting
    // the alias is cheaper than relying on every caller recalling the right name.
    #[serde(alias = "message")]
    text: String,
    #[serde(default)]
    details: Option<Vec<Detail>>,
}

#[derive(Deserialize)]
pub(super) struct UpdateMessageBody {
    session_id: String,
    message: u64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    retract: bool,
    #[serde(default)]
    details: Option<Vec<Detail>>,
}

/// One click-to-open detail. The daemon does not store it: the frontend reads
/// `details` from the tool_use input in the transcript, so this only validates.
#[derive(Deserialize)]
pub(super) struct Detail {
    id: String,
    // Read by the frontend from the transcript, not here.
    #[allow(dead_code)]
    label: String,
    body_md: String,
}

const MAX_DETAILS: usize = 6;
const MAX_DETAIL_BODY: usize = 4096;

fn valid_detail_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Mirrors the limits in the tool schema; the model may not honour a schema, so
/// the route enforces them too.
fn validate_details(details: &[Detail]) -> Result<(), String> {
    if details.len() > MAX_DETAILS {
        return Err(format!("details has more than {MAX_DETAILS} items"));
    }
    let mut seen = std::collections::HashSet::new();
    for d in details {
        if !valid_detail_id(&d.id) {
            return Err(format!("detail id \"{}\" must match ^[a-z0-9-]{{1,32}}$", d.id));
        }
        if !seen.insert(d.id.as_str()) {
            return Err(format!("detail id \"{}\" is used twice", d.id));
        }
        if d.body_md.chars().count() > MAX_DETAIL_BODY {
            return Err(format!("detail \"{}\" body_md exceeds {MAX_DETAIL_BODY} chars", d.id));
        }
    }
    Ok(())
}

fn details_rejection(err: String) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::OK, Json(json!({"ok": false, "error": err})))
}

pub(super) async fn on_send_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SendMessageBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `send_message` tool -
    // mark even a validation-rejected call, since arrival alone is the proof.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
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
    if let Some(Err(e)) = body.details.as_deref().map(validate_details) {
        return details_rejection(e);
    }
    let gen = ctx.state.registry.current_turn_gen(&body.session_id);
    ctx.state.registry.mark_message_sent(&body.session_id, gen);
    log::debug!("session {} sent a message", body.session_id);
    (StatusCode::OK, Json(json!({"ok": true, "message": 1})))
}

pub(super) async fn on_update_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<UpdateMessageBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `update_message` tool.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
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
    if let Some(Err(e)) = body.details.as_deref().map(validate_details) {
        return details_rejection(e);
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

    #[test]
    fn send_message_body_accepts_the_documented_text_field() {
        let body: SendMessageBody =
            serde_json::from_str(r#"{"session_id":"s1","text":"hi"}"#).unwrap();
        assert_eq!(body.text, "hi");
    }

    #[test]
    fn send_message_body_also_accepts_the_commonly_guessed_message_field() {
        let body: SendMessageBody =
            serde_json::from_str(r#"{"session_id":"s1","message":"hi"}"#).unwrap();
        assert_eq!(body.text, "hi");
    }

    fn detail(id: &str, body: &str) -> serde_json::Value {
        json!({"id": id, "label": "L", "body_md": body})
    }

    async fn send_with(details: Vec<serde_json::Value>) -> serde_json::Value {
        let body: SendMessageBody = serde_json::from_value(
            json!({"session_id": "s", "text": "hi", "details": details}),
        )
        .unwrap();
        body_json(on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response()).await
    }

    #[tokio::test]
    async fn valid_details_are_accepted_on_send_and_update() {
        let v = send_with(vec![detail("a-1", "body"), detail("b", "")]).await;
        assert_eq!(v, json!({"ok": true, "message": 1}));
        let upd: UpdateMessageBody = serde_json::from_value(
            json!({"session_id": "s", "message": 1, "text": "x", "details": [detail("a", "b")]}),
        )
        .unwrap();
        let resp = on_update_message(AxState(ctx()), ValidatedJson(upd)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn bad_details_are_rejected() {
        for bad in ["Bad", "has space", "", &"a".repeat(33)] {
            assert_eq!(send_with(vec![detail(bad, "b")]).await["ok"], json!(false), "id {bad:?}");
        }
        let dup = send_with(vec![detail("a", "1"), detail("a", "2")]).await;
        assert!(dup["error"].as_str().unwrap().contains("twice"));
        let seven: Vec<_> = (0..7).map(|i| detail(&format!("d{i}"), "b")).collect();
        assert_eq!(send_with(seven).await["ok"], json!(false));
        let big = send_with(vec![detail("a", &"x".repeat(4097))]).await;
        assert_eq!(big["ok"], json!(false));
        assert_eq!(send_with(vec![detail("a", &"x".repeat(4096))]).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn bad_details_on_update_do_not_record_message_sent() {
        let c = ctx();
        let upd: UpdateMessageBody = serde_json::from_value(
            json!({"session_id": "s", "message": 1, "text": "x", "details": [detail("Bad", "b")]}),
        )
        .unwrap();
        on_update_message(AxState(c.clone()), ValidatedJson(upd)).await;
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());
    }

    #[tokio::test]
    async fn valid_text_route_returns_ok() {
        let body = SendMessageBody { session_id: "s".into(), text: "Finished the build.".into(), details: None };
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true, "message": 1}));
    }

    #[tokio::test]
    async fn send_accepts_text_over_the_repo_channel_cap() {
        let body = SendMessageBody { session_id: "s".into(), text: "x".repeat(4000), details: None };
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn retract_needs_no_text() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: true, details: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn edit_without_text_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: false, details: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("text is required"));
    }

    #[tokio::test]
    async fn zero_ordinal_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 0, text: Some("x".into()), retract: false, details: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(false));
    }

    #[tokio::test]
    async fn update_records_message_sent_so_a_correction_only_turn_counts() {
        let c = ctx();
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: Some("fixed".into()), retract: false, details: None,
        };
        on_update_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn valid_text_route_records_message_sent_for_current_gen() {
        let c = ctx();
        let body = SendMessageBody { session_id: "s".into(), text: "Finished the build.".into(), details: None };
        on_send_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn empty_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "   ".into(), details: None };
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("empty"));
    }

    #[tokio::test]
    async fn empty_text_route_does_not_record_message_sent() {
        let c = ctx();
        let body = SendMessageBody { session_id: "s".into(), text: "   ".into(), details: None };
        on_send_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());
    }

    #[tokio::test]
    async fn overlong_text_route_returns_ok_false_with_error() {
        let body = SendMessageBody { session_id: "s".into(), text: "x".repeat(MAX_MESSAGE_LEN + 1), details: None };
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("8000"));
    }
}
