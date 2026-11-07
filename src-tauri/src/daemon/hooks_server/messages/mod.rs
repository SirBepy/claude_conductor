//! `/messages/send` route: the `cc_conductor` `send_message` MCP tool POSTs
//! here. The transcript already carries the message via Claude's own
//! stream-json output; this route validates AND records the send (Stop-hook
//! enforcement, mirroring `report_turn_status`).

mod validate;

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use validate::{validate_details, validate_send};
pub(super) use validate::{validate_report, ReportFields};

/// `update_message`'s text cap (`send_message` caps per kind, see `text_cap`).
/// Deliberately NOT `repo_channel::MAX_TEXT_LEN` (2000) - that cap keeps a peer
/// wake line short inside another session's context; a report meant for Joe has
/// no such constraint. Sharing it is what produced the 3x-duplicate bug.
const MAX_MESSAGE_LEN: usize = 8000;

/// Sanity bound only. `resolveMessageOrdinal` in chat-event-handler.ts does the
/// real windowing (anything sent since Joe's second-most-recent message).
const MAX_ORDINAL: u64 = 64;

#[derive(Deserialize, Default)]
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
    // Every kind field is optional at decode time: a chat spawned before `kind`
    // existed sends none, and must learn the field from a clean `ok:false`
    // listing the kinds, not from a body-decode error. The frontend reads these
    // from the tool_use input in the transcript; the route only validates them.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    tone: Option<String>,
    #[serde(default)]
    points: Option<Vec<String>>,
    #[serde(default)]
    done: Option<Vec<String>>,
    #[serde(default)]
    not_done: Option<Vec<String>>,
    #[serde(default)]
    waiting_on: Option<Vec<String>>,
    #[serde(default)]
    your_move: Option<Vec<String>>,
    #[serde(default)]
    was: Option<String>,
    #[serde(default)]
    copy: Option<String>,
    // Tables and charts. Loose Values so one malformed visual is an `ok:false`
    // naming the fix, never a body-decode error (see `visuals.rs`).
    #[serde(default)]
    visuals: Option<Vec<serde_json::Value>>,
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
    #[serde(default)]
    visuals: Option<Vec<serde_json::Value>>,
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

/// An `ok:false` reply carrying the fix; shared by every validation failure.
/// Also writes the rejection to the rejected-sends log, since the chat no
/// longer draws a pill for it.
fn rejection(route: &str, session_id: &str, kind: Option<&str>, err: String) -> (StatusCode, Json<serde_json::Value>) {
    super::rejected_sends::record(route, session_id, kind, &err);
    (StatusCode::OK, Json(json!({"ok": false, "error": err})))
}

/// A sub's `blocker` also shows in its main chat's window; every other kind
/// stays in the sub, which nobody reads. Nothing here wakes the main agent or
/// enters its transcript: it is a card-log append the chat renders itself.
fn draw_sub_blocker(ctx: &HookCtx, body: &SendMessageBody) {
    if body.kind.as_deref().map(str::trim) != Some("blocker") {
        return;
    }
    crate::daemon::subchats::card_log::on_blocker(
        &ctx.state,
        &body.session_id,
        crate::daemon::subchats::card_log::BlockerCard {
            text: body.text.trim().to_string(),
            verdict: body.verdict.as_deref().unwrap_or("").trim().to_string(),
            tone: body.tone.clone(),
            points: body.points.clone().unwrap_or_default(),
        },
    );
}

pub(super) async fn on_send_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SendMessageBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `send_message` tool -
    // mark even a validation-rejected call, since arrival alone is the proof.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let kind = body.kind.as_deref();
    if let Err(e) = validate_send(&body) {
        return rejection("/messages/send", &body.session_id, kind, e);
    }
    if let Some(Err(e)) = body.details.as_deref().map(validate_details) {
        return rejection("/messages/send", &body.session_id, kind, e);
    }
    let gen = ctx.state.registry.current_turn_gen(&body.session_id);
    ctx.state.registry.mark_message_sent(&body.session_id, gen);
    draw_sub_blocker(&ctx, &body);
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
        return rejection("/messages/update", &body.session_id, None, "message must be 1 or greater".into());
    }
    if !body.retract {
        let trimmed = body.text.as_deref().unwrap_or("").trim().to_string();
        if trimmed.is_empty() {
            return rejection("/messages/update", &body.session_id, None, "text is required unless retract is true".into());
        }
        if trimmed.chars().count() > MAX_MESSAGE_LEN {
            return rejection("/messages/update", &body.session_id, None, format!("text exceeds {MAX_MESSAGE_LEN} chars"));
        }
    }
    if let Some(Err(e)) = body.details.as_deref().map(validate_details) {
        return rejection("/messages/update", &body.session_id, None, e);
    }
    if let Some(Err(e)) = body.visuals.as_deref().map(super::visuals::validate_visuals) {
        return rejection("/messages/update", &body.session_id, None, e);
    }
    // A revision counts as this turn having spoken, so a correction-only turn
    // doesn't trip the Stop-hook's "said nothing" enforcement.
    let gen = ctx.state.registry.current_turn_gen(&body.session_id);
    ctx.state.registry.mark_message_sent(&body.session_id, gen);
    (StatusCode::OK, Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::validate::{text_cap, KINDS};
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
        send_json(json!({
            "session_id": "s", "text": "hi", "kind": "answer", "verdict": "Yes", "details": details
        }))
        .await
    }

    /// Decodes `v` the way the route does, so a field the struct does not know
    /// about would fail here rather than slip through.
    fn body_of(v: serde_json::Value) -> SendMessageBody {
        serde_json::from_value(v).unwrap()
    }

    async fn send_json(v: serde_json::Value) -> serde_json::Value {
        body_json(on_send_message(AxState(ctx()), ValidatedJson(body_of(v))).await.into_response()).await
    }

    /// A report body that passes; each test overrides one field.
    fn report(extra: serde_json::Value) -> serde_json::Value {
        let mut v = json!({"session_id": "s", "kind": "report", "verdict": "Built, not pushed", "text": "Built it."});
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    fn error_of(v: &serde_json::Value) -> String {
        assert_eq!(v["ok"], json!(false), "expected a rejection, got {v}");
        v["error"].as_str().unwrap().to_string()
    }

    fn kinded(kind: &str, verdict: Option<&str>, text: &str) -> SendMessageBody {
        SendMessageBody {
            session_id: "s".into(),
            text: text.into(),
            kind: Some(kind.into()),
            verdict: verdict.map(Into::into),
            ..Default::default()
        }
    }

    /// A sub's blocker reaches its main chat's card log through the real route,
    /// and a progress message from the same sub does not.
    #[tokio::test]
    async fn a_sub_blocker_is_drawn_in_the_main_chat_and_another_kind_is_not() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["blk-main", "blk-sub"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        c.state.registry.set_subchat_of("blk-sub", Some("blk-main".into()));
        let send = |v: serde_json::Value| {
            let c = c.clone();
            async move { body_json(on_send_message(AxState(c), ValidatedJson(body_of(v))).await.into_response()).await }
        };
        let ok = send(json!({"session_id": "blk-sub", "kind": "blocker", "verdict": "Blocked", "text": "No design file"})).await;
        assert_eq!(ok["ok"], json!(true), "{ok}");
        let ok = send(json!({"session_id": "blk-sub", "kind": "answer", "verdict": "Yes", "text": "progress"})).await;
        assert_eq!(ok["ok"], json!(true), "{ok}");
        let cards = crate::daemon::subchats::card_log::read("blk-main");
        assert_eq!(cards.len(), 1, "only the blocker is drawn: {cards:?}");
        assert_eq!((cards[0].kind.as_str(), cards[0].text.as_str()), ("blocker", "No design file"));
        // A chat that is not a sub draws nothing anywhere.
        let ok = send(json!({"session_id": "blk-main", "kind": "blocker", "verdict": "Blocked", "text": "mine"})).await;
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(crate::daemon::subchats::card_log::read("blk-main").len(), 1);
        assert!(crate::daemon::subchats::card_log::read("blk-sub").is_empty());
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
        let body = kinded("report", Some("Built"), "Finished the build.");
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true, "message": 1}));
    }

    #[tokio::test]
    async fn text_caps_are_per_kind_and_the_error_names_the_fix() {
        // (kind, cap, verdict): ack 80, report 200, answer 400, everything else 300.
        let cases = [
            ("ack", 80, None), ("report", 200, Some("v")), ("answer", 400, Some("v")),
            ("plan", 300, None), ("blocker", 300, Some("v")), ("do_this", 300, Some("v")),
            ("rating", 300, Some("v")), ("correction", 300, Some("v")), ("call", 300, Some("v")),
            ("handoff", 300, None), ("artifact", 300, None), ("discovery", 300, Some("v")),
        ];
        for (kind, cap, verdict) in cases {
            let at_cap = kinded(kind, verdict, &"x".repeat(cap));
            assert!(validate_send(&at_cap).is_ok(), "{kind} at {cap}");
            let over = validate_send(&kinded(kind, verdict, &"x".repeat(cap + 1))).unwrap_err();
            assert!(over.contains(&format!("text is {} chars, over {kind}'s {cap}", cap + 1)), "{over}");
            assert!(over.contains("details"), "{over}");
        }
    }

    #[tokio::test]
    async fn send_rejects_text_far_over_any_cap() {
        let v = send_json(report(json!({"text": "x".repeat(4000)}))).await;
        assert!(error_of(&v).contains("text is 4000 chars, over report's 200"));
    }

    #[tokio::test]
    async fn a_kindless_send_is_rejected_with_a_message_listing_the_kinds() {
        // A chat spawned before `kind` existed sends only text; it must decode
        // and then learn the field from the error.
        let v = send_json(json!({"session_id": "s", "text": "Finished the build."})).await;
        let e = error_of(&v);
        for k in KINDS {
            assert!(e.contains(k), "{e} should list {k}");
        }
        assert!(e.contains("kind is required"));
    }

    #[tokio::test]
    async fn an_unknown_kind_is_rejected_with_a_message_listing_the_kinds() {
        let e = error_of(&send_json(report(json!({"kind": "status"}))).await);
        assert!(e.contains("\"status\" is not a kind"), "{e}");
        assert!(e.contains("do_this") && e.contains("ack"), "{e}");
    }

    #[tokio::test]
    async fn a_rejected_send_still_counts_as_arriving_but_not_as_sent() {
        let c = ctx();
        let body = body_of(json!({"session_id": "s", "text": "no kind"}));
        let resp = on_send_message(AxState(c.clone()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(false));
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());
        assert_eq!(c.state.registry.peek_mcp_tool_used_gen("s"), Some(0), "arrival alone is the MCP proof");
    }

    #[tokio::test]
    async fn verdict_is_required_for_the_eight_kinds_that_carry_one() {
        for kind in ["report", "answer", "blocker", "do_this", "rating", "correction", "call", "discovery"] {
            let e = validate_send(&kinded(kind, None, "text")).unwrap_err();
            assert!(e.contains(&format!("{kind} needs a verdict")), "{e}");
            let blank = validate_send(&kinded(kind, Some("   "), "text")).unwrap_err();
            assert!(blank.contains("needs a verdict"), "{blank}");
            assert!(validate_send(&kinded(kind, Some("Yes"), "text")).is_ok(), "{kind}");
        }
    }

    #[tokio::test]
    async fn verdict_is_rejected_for_the_four_kinds_that_test_as_filler() {
        for kind in ["plan", "handoff", "artifact", "ack"] {
            let e = validate_send(&kinded(kind, Some("Plan ready"), "text")).unwrap_err();
            assert!(e.contains(&format!("{kind} takes no verdict")), "{e}");
            assert!(validate_send(&kinded(kind, None, "text")).is_ok(), "{kind}");
        }
    }

    #[tokio::test]
    async fn verdict_over_forty_chars_is_rejected() {
        assert!(validate_send(&kinded("report", Some(&"v".repeat(40)), "t")).is_ok());
        let e = validate_send(&kinded("report", Some(&"v".repeat(41)), "t")).unwrap_err();
        assert!(e.contains("verdict is 41 chars, over 40"), "{e}");
    }

    #[tokio::test]
    async fn tone_must_be_good_bad_or_neutral() {
        for t in ["good", "bad", "neutral"] {
            assert_eq!(send_json(report(json!({"tone": t}))).await["ok"], json!(true), "{t}");
        }
        let e = error_of(&send_json(report(json!({"tone": "angry"}))).await);
        assert!(e.contains("tone \"angry\""), "{e}");
    }

    #[tokio::test]
    async fn points_are_capped_in_count_and_length_and_banned_on_ack() {
        let six: Vec<_> = (0..6).map(|_| "p").collect();
        assert_eq!(send_json(report(json!({"points": six}))).await["ok"], json!(true));
        let seven: Vec<_> = (0..7).map(|_| "p").collect();
        assert!(error_of(&send_json(report(json!({"points": seven}))).await).contains("points has 7 items, over 6"));
        assert_eq!(send_json(report(json!({"points": ["x".repeat(200)]}))).await["ok"], json!(true));
        assert!(error_of(&send_json(report(json!({"points": ["x".repeat(201)]}))).await).contains("201 chars, over 200"));

        let ack = json!({"session_id": "s", "kind": "ack", "text": "ok", "points": ["p"]});
        assert!(error_of(&send_json(ack).await).contains("ack takes no points"));
    }

    #[tokio::test]
    async fn report_rows_are_capped_and_rejected_on_other_kinds() {
        for name in ["done", "not_done", "waiting_on", "your_move"] {
            let eight: Vec<_> = (0..8).map(|_| "r").collect();
            assert_eq!(send_json(report(json!({ name: eight }))).await["ok"], json!(true), "{name}");
            let nine: Vec<_> = (0..9).map(|_| "r").collect();
            let e = error_of(&send_json(report(json!({ name: nine }))).await);
            assert!(e.contains(&format!("{name} has 9 items, over 8")), "{e}");
            assert_eq!(send_json(report(json!({ name: ["x".repeat(120)] }))).await["ok"], json!(true));
            let long = error_of(&send_json(report(json!({ name: ["x".repeat(121)] }))).await);
            assert!(long.contains("121 chars, over 120"), "{long}");

            let answer = json!({"session_id": "s", "kind": "answer", "verdict": "Yes", "text": "t", name: ["r"]});
            let e = error_of(&send_json(answer).await);
            assert!(e.contains(&format!("{name} is only for report, not answer")), "{e}");
        }
    }

    #[tokio::test]
    async fn was_is_correction_only_and_capped_at_100() {
        let correction = |was: String| json!({
            "session_id": "s", "kind": "correction", "verdict": "Wrong earlier", "text": "t", "was": was
        });
        assert_eq!(send_json(correction("x".repeat(100))).await["ok"], json!(true));
        assert!(error_of(&send_json(correction("x".repeat(101))).await).contains("was is 101 chars, over 100"));
        assert!(error_of(&send_json(report(json!({"was": "old"}))).await).contains("was is only for correction, not report"));
    }

    #[tokio::test]
    async fn copy_is_do_this_only_and_capped_at_4000() {
        let do_this = |copy: String| json!({
            "session_id": "s", "kind": "do_this", "verdict": "Run this", "text": "t", "copy": copy
        });
        assert_eq!(send_json(do_this("x".repeat(4000))).await["ok"], json!(true));
        assert!(error_of(&send_json(do_this("x".repeat(4001))).await).contains("copy is 4001 chars, over 4000"));
        assert!(error_of(&send_json(report(json!({"copy": "cmd"}))).await).contains("copy is only for do_this, not report"));
    }

    #[tokio::test]
    async fn a_full_report_with_every_optional_field_is_accepted() {
        let v = report(json!({
            "tone": "good", "points": ["a"], "done": ["d"], "not_done": ["n"],
            "waiting_on": ["w"], "your_move": ["m"], "next_actions": ["/commit"],
            "details": [detail("x", "b")],
        }));
        assert_eq!(send_json(v).await, json!({"ok": true, "message": 1}));
    }

    #[tokio::test]
    async fn retract_needs_no_text() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: true, details: None, visuals: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn edit_without_text_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: None, retract: false, details: None, visuals: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("text is required"));
    }

    #[tokio::test]
    async fn zero_ordinal_is_rejected() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 0, text: Some("x".into()), retract: false, details: None, visuals: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(false));
    }

    #[tokio::test]
    async fn update_records_message_sent_so_a_correction_only_turn_counts() {
        let c = ctx();
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: Some("fixed".into()), retract: false, details: None, visuals: None,
        };
        on_update_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn valid_text_route_records_message_sent_for_current_gen() {
        let c = ctx();
        let body = kinded("report", Some("Built"), "Finished the build.");
        on_send_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert_eq!(c.state.registry.peek_message_sent_gen("s"), Some(0));
    }

    #[tokio::test]
    async fn empty_text_route_returns_ok_false_with_error() {
        let body = kinded("report", Some("Built"), "   ");
        let resp = on_send_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("empty"));
    }

    #[tokio::test]
    async fn empty_text_route_does_not_record_message_sent() {
        let c = ctx();
        let body = kinded("report", Some("Built"), "   ");
        on_send_message(AxState(c.clone()), ValidatedJson(body)).await;
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());
    }

    #[tokio::test]
    async fn overlong_update_text_returns_ok_false_with_error() {
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: Some("x".repeat(MAX_MESSAGE_LEN + 1)), retract: false, details: None, visuals: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("8000"));
    }

    // The daemon stores no kind, so a revision cannot look up its target's card
    // cap: update_message accepts up to MAX_MESSAGE_LEN whatever it replaces, and
    // the tool description tells the model to keep a revised card as short as the
    // original. This pins that decision; a stored-kind cap would change it.
    #[tokio::test]
    async fn update_text_is_not_held_to_the_per_kind_card_caps() {
        let report_cap = text_cap("report");
        let long = "x".repeat(MAX_MESSAGE_LEN);
        assert!(long.chars().count() > report_cap);
        let body = UpdateMessageBody {
            session_id: "s".into(), message: 1, text: Some(long), retract: false, details: None, visuals: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    // The schema file declares the same 12 kinds for the tool's `enum`. Neither
    // module can import the other's constant (`mcp::tool_schemas_coordination`
    // and `hooks_server::messages` are both private to their parents), so read the
    // schema source and compare: a kind added to one list only fails here instead
    // of the schema offering a kind this route rejects.
    #[test]
    fn schema_kind_enum_matches_the_route_kind_list() {
        const SCHEMA_SRC: &str = include_str!("../../../mcp/tool_schemas_coordination.rs");
        let from = SCHEMA_SRC
            .find("const SEND_MESSAGE_KINDS")
            .expect("schema file declares SEND_MESSAGE_KINDS");
        let block = &SCHEMA_SRC[from..];
        let list = &block[block.find("= [").unwrap()..block.find("];").unwrap()];
        let schema_kinds: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
        assert_eq!(schema_kinds, KINDS);
    }

    fn visuals_send(kind: &str, visuals: serde_json::Value) -> serde_json::Value {
        json!({"session_id": "s", "text": "hi", "kind": kind, "verdict": "Yes", "visuals": visuals})
    }

    #[tokio::test]
    async fn a_valid_visual_is_accepted_and_does_not_count_against_the_text_cap() {
        let table = json!({"type": "table", "columns": ["a", "b"], "rows": [["x", 1]]});
        assert_eq!(send_json(visuals_send("answer", json!([table]))).await["ok"], json!(true));
        // The text stays within its cap, the figures ride in the visual.
        let rows: Vec<_> = (0..40).map(|i| json!([format!("row {i}"), i])).collect();
        let big = json!({"type": "table", "columns": ["a", "b"], "rows": rows});
        assert_eq!(send_json(visuals_send("answer", json!([big]))).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn a_malformed_visual_is_an_ok_false_naming_the_fix_never_a_decode_error() {
        let bad = json!([{"type": "bar", "data": [{"label": "a", "value": "3"}]}]);
        let v = send_json(visuals_send("answer", bad)).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("visuals[0].data[0].value"), "{v}");
        // Not even an object: still a clean refusal, not a 4xx decode failure.
        let v = send_json(visuals_send("answer", json!(["table"]))).await;
        assert_eq!(v["ok"], json!(false));
    }

    #[tokio::test]
    async fn an_ack_takes_no_visuals() {
        let bar = json!([{"type": "bar", "data": [{"label": "a", "value": 1}]}]);
        let v = send_json(json!({"session_id": "s", "text": "ok", "kind": "ack", "visuals": bar})).await;
        assert!(v["error"].as_str().unwrap().contains("ack takes no visuals"), "{v}");
    }

    #[tokio::test]
    async fn update_message_validates_visuals_and_a_bad_one_does_not_record_a_send() {
        let c = ctx();
        let bad: UpdateMessageBody = serde_json::from_value(
            json!({"session_id": "s", "message": 1, "text": "x", "visuals": [{"type": "pie"}]}),
        )
        .unwrap();
        let resp = on_update_message(AxState(c.clone()), ValidatedJson(bad)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(false));
        assert!(c.state.registry.peek_message_sent_gen("s").is_none());

        let good: UpdateMessageBody = serde_json::from_value(
            json!({"session_id": "s", "message": 1, "text": "x", "visuals": [{"type": "donut", "data": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}]}),
        )
        .unwrap();
        let resp = on_update_message(AxState(c), ValidatedJson(good)).await.into_response();
        assert_eq!(body_json(resp).await["ok"], json!(true));
    }

    #[test]
    fn schema_visual_types_match_the_validator() {
        const SCHEMA_SRC: &str = include_str!("../../../mcp/tool_schemas_coordination.rs");
        for t in super::super::visuals::TYPE_NAMES {
            assert!(SCHEMA_SRC.contains(&format!("\"{t}\"")), "schema enum lacks visual type {t}");
        }
    }
}
