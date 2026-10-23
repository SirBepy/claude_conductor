//! `/hooks/publish-gate` (`PreToolUse`, Artifact|Read): the Publish to
//! claude.ai run's pre-execution check. The run's `--settings` hook curls here
//! with its run id; `claude_ai_publish::gate_refusal` decides.

use super::decision::deny_decision;
use axum::extract::Query;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub(super) struct GateQuery {
    run: String,
}

/// An empty object lets the call fall through to the normal permission rules
/// (`--allowedTools` already pre-approves both tools).
pub(super) async fn on_publish_gate(Query(q): Query<GateQuery>, Json(body): Json<Value>) -> Json<Value> {
    let tool = body["tool_name"].as_str().unwrap_or_default();
    match crate::claude_ai_publish::gate_refusal(&q.run, tool, &body["tool_input"]) {
        Some(reason) => {
            log::warn!("publish gate: refused {tool} call: {reason}");
            Json(deny_decision(reason))
        }
        None => Json(json!({})),
    }
}
