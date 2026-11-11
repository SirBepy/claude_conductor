//! `/subchats/finish`: the `finish_subchat` MCP tool, a sub's one way to end.
//! The route validates the call (a `report`'s fields with `send_message`'s own
//! limits, plus the two log fields this tool adds) and hands it to
//! `daemon::subchats::finish`. Every failure is a clean `ok:false` naming the
//! fix, because the model reads it as the tool result and retries; a malformed
//! body never reaches it as a decode error.

use super::messages::{validate_report, ReportFields};
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::subchats::finish::{missing_fields, request_finish, FinishArgs};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

fn refusal(error: String) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({"ok": false, "error": error})))
}

/// Decode and validate one call, before anything is looked up or checked on disk.
fn parse_and_validate(body: &Value) -> Result<FinishArgs, String> {
    // First, and all at once: a sub that called the tool before loading its schema
    // sends an empty or wrong-named body, and one refusal per field costs a retry each.
    if let Some(missing) = missing_fields(body) {
        return Err(missing);
    }
    let args = FinishArgs::parse(body)?;
    validate_report(ReportFields {
        text: args.text.clone().unwrap_or_default(),
        verdict: args.verdict.clone(),
        tone: args.tone.clone(),
        points: args.points.clone(),
        done: args.done.clone(),
        not_done: args.not_done.clone(),
        waiting_on: args.waiting_on.clone(),
        your_move: args.your_move.clone(),
    })?;
    Ok(args)
}

pub(super) async fn on_finish_subchat(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<Value>,
) -> impl IntoResponse {
    let Some(session_id) = body["session_id"].as_str().map(str::to_string) else {
        return refusal("session_id is missing".to_string());
    };
    // The call arriving at all proves the MCP transport is up this turn.
    super::mark_mcp_tool_used(&ctx, &session_id);
    let args = match parse_and_validate(&body) {
        Ok(a) => a,
        Err(e) => return refusal(e),
    };
    // A sub's job ends here, not at report_turn_status: refused once while
    // its plan has open steps (daemon::plan_close).
    let gen = ctx.state.registry.current_turn_gen(&session_id);
    if let Some(error) = ctx.state.plan_close.check_end(&session_id, gen, "finish_subchat") {
        return refusal(error);
    }
    match request_finish(&ctx.state, &session_id, args).await {
        Ok(text) => (StatusCode::OK, Json(json!({"ok": true, "text": text}))),
        Err(e) => refusal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    async fn call(ctx: &Arc<HookCtx>, body: Value) -> Value {
        let resp = on_finish_subchat(AxState(ctx.clone()), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn good(session: &str) -> Value {
        json!({
            "session_id": session, "verdict": "Built, not pushed", "text": "Header done",
            "decided": ["nothing"], "ruled_out": ["nothing"],
        })
    }

    fn make_sub(c: &HookCtx, tag: &str) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        c.state.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        c.state.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        c.state.registry.set_subchat_of(&sub, Some(main));
        sub
    }

    #[tokio::test]
    async fn a_well_formed_call_from_a_sub_is_accepted() {
        let c = ctx();
        let sub = make_sub(&c, "route-ok");
        let v = call(&c, good(&sub)).await;
        assert_eq!(v["ok"], json!(true), "{v}");
        assert!(crate::daemon::subchats::runtime::runtime().finish_pending(&sub));
    }

    /// A sub whose plan still has open steps is refused once, naming them, and
    /// nothing is queued; the next finish in the same turn goes through.
    #[tokio::test]
    async fn a_finish_with_an_open_plan_is_refused_once() {
        use crate::types::PlanStepSnapshot;
        let c = ctx();
        let sub = make_sub(&c, "route-openplan");
        c.state.plan_close.record(&sub, &[PlanStepSnapshot { text: "Ship it".into(), status: "pending".into() }]);
        let v = call(&c, good(&sub)).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("call finish_subchat again"), "{v}");
        assert!(!crate::daemon::subchats::runtime::runtime().finish_pending(&sub));
        let again = call(&c, good(&sub)).await;
        assert_eq!(again["ok"], json!(true), "{again}");
    }

    /// A kindless-style call (no verdict) and a malformed one are `ok:false`
    /// naming the fix, never a decode error.
    #[tokio::test]
    async fn a_missing_verdict_names_the_fix() {
        let c = ctx();
        let sub = make_sub(&c, "route-noverdict");
        let mut body = good(&sub);
        body.as_object_mut().unwrap().remove("verdict");
        let v = call(&c, body).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("missing verdict"), "{v}");
        assert!(!crate::daemon::subchats::runtime::runtime().finish_pending(&sub));
    }

    /// The tool is deferred, so a sub calls it before its schema is loaded: an
    /// empty body, or one with invented names (`summary`). The first refusal names
    /// every missing field and the limits, so one retry fixes it; four refusals
    /// of one field each is what the first real run hit.
    #[tokio::test]
    async fn the_first_refusal_names_every_missing_field_at_once_with_the_limits() {
        let c = ctx();
        let sub = make_sub(&c, "route-allmissing");
        for body in [json!({"session_id": sub}), json!({"session_id": sub, "summary": "Edit was refused"})] {
            let v = call(&c, body).await;
            assert_eq!(v["ok"], json!(false));
            let e = v["error"].as_str().unwrap();
            for field in ["verdict", "text", "decided", "ruled_out"] {
                assert!(e.contains(field), "{field} named in one go: {e}");
            }
            assert!(e.contains("40 chars") && e.contains("200 chars") && e.contains("[\"nothing\"]"), "the limits ride along: {e}");
        }
        // Only what is missing is named.
        let mut body = good(&sub);
        body.as_object_mut().unwrap().remove("ruled_out");
        body.as_object_mut().unwrap().remove("text");
        let e = call(&c, body).await["error"].as_str().unwrap().to_string();
        assert!(e.contains("missing text, ruled_out"), "{e}");
        assert!(!e.contains("missing verdict") && !e.contains("verdict,"), "{e}");
    }

    #[tokio::test]
    async fn malformed_fields_name_the_fix_instead_of_failing_to_decode() {
        let c = ctx();
        let sub = make_sub(&c, "route-malformed");
        for (patch, needle) in [
            (json!({"decided": "text"}), "decided must be a list of strings"),
            (json!({"decided": []}), "missing decided"),
            (json!({"ruled_out": null}), "missing ruled_out"),
            (json!({"done": [1, 2]}), "done must be a list of strings"),
            (json!({"text": ""}), "missing text"),
            (json!({"verdict": "x".repeat(41)}), "over 40"),
            (json!({"text": "x".repeat(201)}), "over report's 200"),
            (json!({"tone": "loud"}), "tone"),
            (json!({"your_move": vec!["x"; 9]}), "your_move has 9 items"),
        ] {
            let mut body = good(&sub);
            for (k, val) in patch.as_object().unwrap() {
                body[k] = val.clone();
            }
            let v = call(&c, body).await;
            assert_eq!(v["ok"], json!(false), "{patch}");
            assert!(v["error"].as_str().unwrap().contains(needle), "{patch} -> {v}");
        }
    }

    #[tokio::test]
    async fn the_report_rows_use_send_messages_limits() {
        let c = ctx();
        let sub = make_sub(&c, "route-rows");
        let mut body = good(&sub);
        body["not_done"] = json!(["x".repeat(121)]);
        let v = call(&c, body).await;
        assert!(v["error"].as_str().unwrap().contains("not_done"), "{v}");
        let mut ok = good(&sub);
        ok["done"] = json!(["a", "b"]);
        ok["reviewer_tool_use_id"] = json!("toolu_1");
        assert_eq!(call(&c, ok).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn a_chat_that_is_not_a_sub_is_told_so() {
        let c = ctx();
        c.state.registry.upsert_interactive("plain-route", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let v = call(&c, good("plain-route")).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("only for a sub"), "{v}");
    }

    #[tokio::test]
    async fn a_body_with_no_session_id_is_a_clean_refusal() {
        let c = ctx();
        let v = call(&c, json!({"verdict": "v"})).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("session_id"));
    }
}
