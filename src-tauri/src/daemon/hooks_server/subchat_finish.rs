//! `/subchats/finish`: the `finish_subchat` MCP tool, a sub's one way to end.
//! The route validates the call (a `report`'s fields with `send_message`'s own
//! limits, plus the two log fields this tool adds) and hands it to
//! `daemon::subchats::finish`. Every failure is a clean `ok:false` naming the
//! fix, because the model reads it as the tool result and retries; a malformed
//! body never reaches it as a decode error.

use super::messages::{validate_report, ReportFields};
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::subchats::finish::{request_finish, FinishArgs};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

fn refusal(error: String) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({"ok": false, "error": error})))
}

/// Decode and validate one call, before anything is looked up or checked on disk.
fn parse_and_validate(body: &Value) -> Result<FinishArgs, String> {
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
        assert!(v["error"].as_str().unwrap().contains("needs a verdict"), "{v}");
        assert!(!crate::daemon::subchats::runtime::runtime().finish_pending(&sub));
    }

    #[tokio::test]
    async fn malformed_fields_name_the_fix_instead_of_failing_to_decode() {
        let c = ctx();
        let sub = make_sub(&c, "route-malformed");
        for (patch, needle) in [
            (json!({"decided": "text"}), "decided must be a list of strings"),
            (json!({"decided": []}), "decided is required"),
            (json!({"ruled_out": null}), "ruled_out is required"),
            (json!({"done": [1, 2]}), "done must be a list of strings"),
            (json!({"text": ""}), "text must not be empty"),
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
