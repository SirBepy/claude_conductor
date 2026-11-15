//! `/hooks/autopilot-pick`: the `autopilot_pick` MCP tool. The route hands the
//! call to `daemon::subchats::picks`, which holds the gate (only an unattended
//! run records) and the validation. Every refusal is an `ok:false` naming the
//! fix, never a decode error: every field is optional here so a chat that leaves
//! one out learns which one.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::subchats::picks::{self, NewPick};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Default)]
pub(super) struct PickBody {
    session_id: String,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    pick: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    landed: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

pub(super) async fn on_autopilot_pick(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<PickBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let action = body.action.as_deref().map(str::trim).unwrap_or("record");
    let result = match action {
        "" | "record" => picks::record(
            &ctx.state,
            &body.session_id,
            &NewPick {
                question: body.question.unwrap_or_default(),
                options: body.options,
                pick: body.pick.unwrap_or_default(),
                reason: body.reason.unwrap_or_default(),
                landed: body.landed.unwrap_or_default(),
            },
        ),
        "corrected" => match body.id.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
            Some(id) => picks::mark_corrected(&ctx.state, &body.session_id, id, body.note.as_deref().unwrap_or("")),
            None => Err("id is missing: name the overruled pick you changed in the code (P1, P2, ...)".to_string()),
        },
        other => Err(format!("action {other:?} is not one of record, corrected")),
    };
    match result {
        Ok(p) => (StatusCode::OK, Json(json!({"ok": true, "id": p.id, "status": p.status}))),
        // A refused attended call is expected control flow, not a malformed one.
        Err(e) if e == picks::ATTENDED_REFUSAL => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
        Err(e) => rejected_sends::reply("/hooks/autopilot-pick", &body.session_id, e),
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

    async fn call(c: &Arc<HookCtx>, v: serde_json::Value) -> serde_json::Value {
        let body: PickBody = serde_json::from_value(v).unwrap();
        let resp = on_autopilot_pick(AxState(c.clone()), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn pick(session: &str) -> serde_json::Value {
        json!({"session_id": session, "question": "Which header colour?", "options": ["Teal", "Navy"],
               "pick": "Teal", "reason": "matches the logo", "landed": "src/header.css"})
    }

    /// The real route: an unattended chat's call records and reports the id; an
    /// attended chat's call is an ok:false that names the question card.
    #[tokio::test]
    async fn the_route_records_for_an_unattended_chat_and_refuses_an_attended_one() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["ap-on", "ap-off"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-15T08:00:00+00:00");
        }
        c.state.registry.set_autopilot("ap-on", true);

        let ok = call(&c, pick("ap-on")).await;
        assert_eq!(ok["ok"], json!(true), "{ok}");
        assert_eq!(ok["id"], json!("P1"));
        assert_eq!(ok["status"], json!("unreviewed"));

        let no = call(&c, pick("ap-off")).await;
        assert_eq!(no["ok"], json!(false));
        assert_eq!(no["error"], json!(picks::ATTENDED_REFUSAL));

        // A field left out is an ok:false naming it, never a decode error.
        let mut missing = pick("ap-on");
        missing.as_object_mut().unwrap().remove("reason");
        let e = call(&c, missing).await;
        assert!(e["error"].as_str().unwrap().starts_with("reason is missing"), "{e}");

        let bad_action = call(&c, json!({"session_id": "ap-on", "action": "wipe"})).await;
        assert!(bad_action["error"].as_str().unwrap().contains("not one of record, corrected"));
        let no_id = call(&c, json!({"session_id": "ap-on", "action": "corrected"})).await;
        assert!(no_id["error"].as_str().unwrap().starts_with("id is missing"));
    }
}
