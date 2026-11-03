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

const KINDS: [&str; 12] = [
    "answer", "report", "blocker", "do_this", "plan", "rating", "correction", "call", "handoff",
    "artifact", "discovery", "ack",
];
const MAX_VERDICT: usize = 40;
const MAX_POINTS: usize = 6;
const MAX_POINT: usize = 200;
const MAX_ROWS: usize = 8;
const MAX_ROW: usize = 120;
const MAX_WAS: usize = 100;
const MAX_COPY: usize = 4000;

/// How long a kind's `text` may be. Past the cap the prose belongs in `details`,
/// which sits behind a click; the card shows `text` at full size.
fn text_cap(kind: &str) -> usize {
    match kind {
        "ack" => 80,
        "report" => 200,
        "answer" => 400,
        _ => 300,
    }
}

/// `plan`, `handoff`, `artifact` and `ack` carry no verdict: their verdicts
/// tested as filler ("Plan ready"), so the card reads better without one.
fn takes_verdict(kind: &str) -> bool {
    !matches!(kind, "plan" | "handoff" | "artifact" | "ack")
}

fn kind_rejection(got: Option<&str>) -> String {
    let list = KINDS.join(", ");
    match got {
        None => format!(
            "kind is required: send_message declares what each message is. Resend with kind set to one of: {list}. Most kinds also need a verdict (at most {MAX_VERDICT} chars, the conclusion as a person would say it)."
        ),
        Some(k) => format!("kind \"{k}\" is not a kind. Resend with kind set to one of: {list}."),
    }
}

fn check_rows(name: &str, rows: &Option<Vec<String>>, max_items: usize, max_len: usize) -> Result<(), String> {
    let Some(rows) = rows else { return Ok(()) };
    if rows.len() > max_items {
        return Err(format!("{name} has {} items, over {max_items}: keep the most important", rows.len()));
    }
    for r in rows {
        let n = r.chars().count();
        if n > max_len {
            return Err(format!("a {name} item is {n} chars, over {max_len}: shorten it"));
        }
    }
    Ok(())
}

/// Mirrors the limits in the `send_message` tool schema; the model may not honour
/// a schema, so the route enforces them too. Every error names the fix, because
/// the model reads it as the tool result and retries.
fn validate_send(body: &SendMessageBody) -> Result<(), String> {
    let kind = match body.kind.as_deref().map(str::trim) {
        Some(k) if KINDS.contains(&k) => k,
        other => return Err(kind_rejection(other)),
    };
    let text = body.text.trim();
    if text.is_empty() {
        return Err("text must not be empty".to_string());
    }
    let (n, cap) = (text.chars().count(), text_cap(kind));
    if n > cap {
        return Err(format!("text is {n} chars, over {kind}'s {cap}: move detail into details"));
    }

    let verdict = body.verdict.as_deref().map(str::trim).filter(|v| !v.is_empty());
    match (takes_verdict(kind), verdict) {
        (true, None) => {
            return Err(format!(
                "{kind} needs a verdict (at most {MAX_VERDICT} chars): the conclusion as a person would say it out loud, like \"Built, not pushed\""
            ))
        }
        (false, Some(_)) => {
            return Err(format!("{kind} takes no verdict: remove it, the text carries the message"))
        }
        (true, Some(v)) if v.chars().count() > MAX_VERDICT => {
            return Err(format!(
                "verdict is {} chars, over {MAX_VERDICT}: say the conclusion shorter",
                v.chars().count()
            ))
        }
        _ => {}
    }

    if let Some(t) = body.tone.as_deref() {
        if !matches!(t, "good" | "bad" | "neutral") {
            return Err(format!("tone \"{t}\" is not valid: use good, bad or neutral, or leave it out"));
        }
    }
    if kind == "ack" && body.points.is_some() {
        return Err("ack takes no points: it is a bare acknowledgement".to_string());
    }
    check_rows("points", &body.points, MAX_POINTS, MAX_POINT)?;

    let report_rows = [
        ("done", &body.done),
        ("not_done", &body.not_done),
        ("waiting_on", &body.waiting_on),
        ("your_move", &body.your_move),
    ];
    for (name, rows) in report_rows {
        if rows.is_some() && kind != "report" {
            return Err(format!("{name} is only for report, not {kind}: remove it"));
        }
        check_rows(name, rows, MAX_ROWS, MAX_ROW)?;
    }

    if let Some(was) = body.was.as_deref() {
        if kind != "correction" {
            return Err(format!("was is only for correction, not {kind}: remove it"));
        }
        let n = was.chars().count();
        if n > MAX_WAS {
            return Err(format!("was is {n} chars, over {MAX_WAS}: quote the earlier claim shorter"));
        }
    }
    if let Some(copy) = body.copy.as_deref() {
        if kind != "do_this" {
            return Err(format!("copy is only for do_this, not {kind}: remove it"));
        }
        let n = copy.chars().count();
        if n > MAX_COPY {
            return Err(format!("copy is {n} chars, over {MAX_COPY}: trim the paste-ready payload"));
        }
    }
    Ok(())
}

/// An `ok:false` reply carrying the fix; shared by every validation failure.
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
    if let Err(e) = validate_send(&body) {
        return details_rejection(e);
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
            session_id: "s".into(), message: 1, text: Some("x".repeat(MAX_MESSAGE_LEN + 1)), retract: false, details: None,
        };
        let resp = on_update_message(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("8000"));
    }
}
