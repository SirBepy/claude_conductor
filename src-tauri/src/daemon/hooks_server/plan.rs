//! `write_plan` hook route: the checklist's own tool, serving the role
//! `TodoWrite` mostly does not (4 of 188 transcripts, 2026-09-04 - the harness
//! withholds it). The checklist draws from this call's own `tool_use` event, so
//! this route holds no state; it validates the shape and acknowledges.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct PlanStep {
    text: String,
    status: String,
    #[serde(default)]
    #[allow(dead_code)]
    detail: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct WritePlanBody {
    session_id: String,
    steps: Vec<PlanStep>,
}

const STATUSES: [&str; 4] = ["pending", "active", "done", "skipped"];

/// Returns how many steps are `active`, or the reason the plan is unusable.
/// Split out so the tests exercise the real rule rather than a copy of it.
fn validate_steps(steps: &[PlanStep]) -> Result<usize, String> {
    if steps.is_empty() {
        return Err("steps must not be empty".to_string());
    }
    let mut seen: Vec<&str> = Vec::with_capacity(steps.len());
    for step in steps {
        let text = step.text.trim();
        if text.is_empty() {
            return Err("every step needs a non-empty text".to_string());
        }
        // A step's text is its identity across calls, so a duplicate silently
        // collapses two rows into one in the renderer's keyed map - the plan
        // loses a step instead of failing loudly.
        if seen.contains(&text) {
            return Err(format!("duplicate step text: {text}"));
        }
        seen.push(text);
        if !STATUSES.contains(&step.status.as_str()) {
            return Err(format!("unknown status: {}", step.status));
        }
    }
    Ok(steps.iter().filter(|s| s.status == "active").count())
}

pub(super) async fn on_write_plan(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WritePlanBody>,
) -> impl IntoResponse {
    // Before the validation below, and guarded on a non-empty id, matching
    // `turn_status.rs:29-31`: arrival alone proves the transport is up this
    // turn, and an empty id would stamp the empty-string key.
    if !body.session_id.is_empty() {
        super::mark_mcp_tool_used(&ctx, &body.session_id);
    }

    match validate_steps(&body.steps) {
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
        Ok(active) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "steps": body.steps.len(),
                // Not an error: a plan written up front is legitimately
                // all-pending, and the renderer copes with several active rows.
                // Reported back so a session that meant to advance a step can
                // see that it did not.
                "active": active,
            })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(text: &str, status: &str) -> PlanStep {
        PlanStep {
            text: text.to_string(),
            status: status.to_string(),
            detail: None,
        }
    }

    #[test]
    fn accepts_an_all_pending_plan_written_up_front() {
        let steps = vec![step("Read the spec", "pending"), step("Wire the feed", "pending")];
        assert_eq!(validate_steps(&steps), Ok(0));
    }

    #[test]
    fn counts_the_active_step() {
        let steps = vec![step("a", "done"), step("b", "active"), step("c", "pending")];
        assert_eq!(validate_steps(&steps), Ok(1));
    }

    #[test]
    fn rejects_an_empty_plan() {
        assert!(validate_steps(&[]).is_err());
    }

    #[test]
    fn rejects_a_blank_step_text() {
        assert!(validate_steps(&[step("   ", "pending")]).is_err());
    }

    #[test]
    fn rejects_duplicate_step_text() {
        let steps = vec![step("Same", "done"), step("Same", "pending")];
        assert_eq!(
            validate_steps(&steps),
            Err("duplicate step text: Same".to_string())
        );
    }

    /// `TodoWrite`'s vocabulary, which is the wrong one here - catching it
    /// keeps a session from silently rendering every step as pending.
    #[test]
    fn rejects_an_unknown_status() {
        let steps = vec![step("a", "in_progress")];
        assert_eq!(
            validate_steps(&steps),
            Err("unknown status: in_progress".to_string())
        );
    }
}
