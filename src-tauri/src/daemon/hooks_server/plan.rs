//! `write_plan` hook route: the checklist's own tool, serving the role
//! `TodoWrite` mostly does not (4 of 188 transcripts, 2026-09-04 - the harness
//! withholds it). The checklist draws from this call's own `tool_use` event,
//! so the route only validates the shape and acknowledges - EXCEPT for one
//! piece of state (todo 898): a comment Joe left on a step from the checklist
//! UI (`DaemonState::step_comments`) is taken and handed back in this same
//! response the moment that step is reported `active`, which is the whole
//! reason this route holds anything at all.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
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
        Ok(active) => {
            // Deliver any comment Joe queued on a step this very call reports
            // `active` - the one moment the hard constraint (never stdin,
            // never early, never late) is satisfiable in one shot. Skipped for
            // an empty id for the same reason as `mark_mcp_tool_used` above:
            // arrival alone proves nothing about which session to key on.
            let mut comments = serde_json::Map::new();
            if !body.session_id.is_empty() {
                for step in &body.steps {
                    if step.status != "active" {
                        continue;
                    }
                    let text = step.text.trim();
                    if let Some(comment) = ctx.state.take_step_comment(&body.session_id, text).await {
                        comments.insert(text.to_string(), json!(comment));
                    }
                }
            }
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "steps": body.steps.len(),
                    // Not an error: a plan written up front is legitimately
                    // all-pending, and the renderer copes with several active rows.
                    // Reported back so a session that meant to advance a step can
                    // see that it did not.
                    "active": active,
                    // Comments Joe left on any step THIS call marks active
                    // (todo 898), keyed by that step's own text. Empty object
                    // when there is nothing to say - read it before doing a
                    // step's work; it might say to skip the step entirely.
                    "comments": Value::Object(comments),
                })),
            )
        }
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

    // --- Comment delivery (todo 898) ---------------------------------------

    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    fn body(session_id: &str, steps: Vec<PlanStep>) -> WritePlanBody {
        WritePlanBody { session_id: session_id.to_string(), steps }
    }

    async fn write_plan_json(ctx: Arc<HookCtx>, b: WritePlanBody) -> serde_json::Value {
        let resp = on_write_plan(AxState(ctx), ValidatedJson(b)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The heart of the feature: a comment queued on a pending step rides
    /// back in the SAME call that reports the step `active` - not a separate
    /// poll, not stdin, just this response.
    #[tokio::test]
    async fn a_queued_comment_is_delivered_the_moment_its_step_goes_active() {
        let c = ctx();
        c.state.add_step_comment("s1", "Read the spec", "skip this one").await;

        let resp = write_plan_json(
            c.clone(),
            body("s1", vec![step("Read the spec", "active"), step("Wire the feed", "pending")]),
        )
        .await;

        assert_eq!(resp["ok"], serde_json::json!(true));
        assert_eq!(resp["comments"]["Read the spec"], serde_json::json!("skip this one"));
        assert!(resp["comments"].get("Wire the feed").is_none());
    }

    /// Not yet active: the comment must not leak into the response early.
    #[tokio::test]
    async fn a_comment_on_a_still_pending_step_is_not_delivered() {
        let c = ctx();
        c.state.add_step_comment("s1", "Read the spec", "wait on this").await;

        let resp = write_plan_json(c.clone(), body("s1", vec![step("Read the spec", "pending")])).await;

        assert_eq!(resp["comments"], serde_json::json!({}));
        // Still there for the call that actually activates it.
        let resp2 = write_plan_json(c, body("s1", vec![step("Read the spec", "active")])).await;
        assert_eq!(resp2["comments"]["Read the spec"], serde_json::json!("wait on this"));
    }

    /// Delivered once: a second call that still reports the same step
    /// `active` (e.g. only `detail` changed) must not redeliver it.
    #[tokio::test]
    async fn a_delivered_comment_is_not_redelivered_on_a_later_call() {
        let c = ctx();
        c.state.add_step_comment("s1", "a", "note").await;

        let first = write_plan_json(c.clone(), body("s1", vec![step("a", "active")])).await;
        assert_eq!(first["comments"]["a"], serde_json::json!("note"));

        let second = write_plan_json(c, body("s1", vec![step("a", "active")])).await;
        assert_eq!(second["comments"], serde_json::json!({}));
    }

    /// A comment belongs to the session that owns it, not the step text
    /// alone - a different session's identical step text must not receive it.
    #[tokio::test]
    async fn a_comment_is_scoped_to_its_own_session() {
        let c = ctx();
        c.state.add_step_comment("s1", "a", "for s1 only").await;

        let resp = write_plan_json(c, body("s2", vec![step("a", "active")])).await;

        assert_eq!(resp["comments"], serde_json::json!({}));
    }

    /// No response at all is a delivery, on the exact terms the checklist
    /// renderer keys on: leading/trailing space in the DECLARED text is
    /// trimmed before lookup, matching `validate_steps`'s own trim.
    #[tokio::test]
    async fn comment_lookup_trims_the_step_text_like_validation_does() {
        let c = ctx();
        c.state.add_step_comment("s1", "a", "note").await;

        let resp = write_plan_json(c, body("s1", vec![step("  a  ", "active")])).await;

        assert_eq!(resp["comments"]["a"], serde_json::json!("note"));
    }
}
