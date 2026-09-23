//! `SubagentStart`/`SubagentStop` endpoints, and the per-turn block that tells
//! a session which subagents an interrupt killed.
//!
//! The daemon tracks in-flight `Agent` calls (`state::subagents`) for exactly
//! one purpose: `cancel_turn` kills them all, and nothing in the transcript
//! says so. The model's next turn just starts, with several dispatches it will
//! never hear back from and no way to tell "finished and reported" from "died
//! mid-flight". This closes that: the interrupt records the casualties, and the
//! next `UserPromptSubmit` names them.
//!
//! Both endpoints return an empty body. `SubagentStart` CAN return
//! `additionalContext`, but it is shown to the subagent, which is the one
//! party in the exchange that has no use for any of this.

use super::HookCtx;
use crate::daemon::state::subagents::LiveSubagent;
use axum::{
    extract::{Query, State as AxState},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct SubagentQuery {
    /// OUR registry id, baked into the hook URL by `claude_config` - the hook
    /// payload's own `session_id` is the CLI's, which drifts on a fork.
    #[serde(default)]
    session_id: String,
}

#[derive(Deserialize, Default)]
pub(super) struct SubagentBody {
    #[serde(default)]
    agent_id: String,
    /// Absent on `SubagentStop`, which only needs to identify the agent.
    #[serde(default)]
    agent_type: String,
}

pub(super) async fn on_subagent_start(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Query(q): Query<SubagentQuery>,
    body: String,
) -> impl IntoResponse {
    let b: SubagentBody = serde_json::from_str(&body).unwrap_or_default();
    if !q.session_id.is_empty() {
        ctx.state.subagent_started(&q.session_id, &b.agent_id, &b.agent_type);
    }
    (StatusCode::OK, String::new())
}

pub(super) async fn on_subagent_stop(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Query(q): Query<SubagentQuery>,
    body: String,
) -> impl IntoResponse {
    let b: SubagentBody = serde_json::from_str(&body).unwrap_or_default();
    if !q.session_id.is_empty() {
        ctx.state.subagent_finished(&q.session_id, &b.agent_id);
    }
    (StatusCode::OK, String::new())
}

/// The per-turn block naming subagents an interrupt killed, or None when the
/// last turn ended on its own - the overwhelmingly common case now that a
/// mid-turn message no longer needs an interrupt to be heard.
pub(crate) fn render_for_injection(
    state: &Arc<crate::daemon::state::DaemonState>,
    session_id: &str,
) -> Option<String> {
    let killed = state.take_subagents_killed_by_interrupt(session_id);
    if killed.is_empty() {
        return None;
    }
    Some(render(&killed))
}

fn render(killed: &[LiveSubagent]) -> String {
    let plural = if killed.len() == 1 { "" } else { "s" };
    let names = killed
        .iter()
        .map(|s| format!("- {}", if s.agent_type.is_empty() { "unnamed agent" } else { &s.agent_type }))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<subagents-killed-by-interrupt>\n\
         The previous turn was interrupted, killing {} still-running subagent{plural}. None of \
         them reported back, so that work is lost rather than pending:\n\
         {names}\n\
         Re-dispatch any whose work is still needed. If the interrupting message made it \
         irrelevant, say so rather than silently dropping it.\n\
         </subagents-killed-by-interrupt>",
        killed.len()
    )
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

    async fn start(ctx: &Arc<HookCtx>, sid: &str, body: &str) {
        let q = SubagentQuery { session_id: sid.to_string() };
        on_subagent_start(AxState(ctx.clone()), Query(q), body.to_string()).await;
    }

    async fn stop(ctx: &Arc<HookCtx>, sid: &str, body: &str) {
        let q = SubagentQuery { session_id: sid.to_string() };
        on_subagent_stop(AxState(ctx.clone()), Query(q), body.to_string()).await;
    }

    #[tokio::test]
    async fn a_turn_that_was_never_interrupted_injects_nothing() {
        let c = ctx();
        start(&c, "s1", r#"{"agent_id":"a1","agent_type":"Explore"}"#).await;
        stop(&c, "s1", r#"{"agent_id":"a1"}"#).await;
        c.state.record_subagents_killed_by_interrupt("s1");
        assert_eq!(render_for_injection(&c.state, "s1"), None);
    }

    #[tokio::test]
    async fn an_interrupt_names_the_agents_that_died() {
        let c = ctx();
        start(&c, "s1", r#"{"agent_id":"a1","agent_type":"Explore"}"#).await;
        start(&c, "s1", r#"{"agent_id":"a2","agent_type":"general-purpose"}"#).await;
        stop(&c, "s1", r#"{"agent_id":"a1"}"#).await;
        c.state.record_subagents_killed_by_interrupt("s1");

        let block = render_for_injection(&c.state, "s1").expect("a casualty should be reported");
        assert!(block.contains("general-purpose"));
        assert!(!block.contains("Explore"), "one that finished on its own is not a casualty");
        assert!(block.contains("1 still-running subagent."));
    }

    // A malformed payload must not take the daemon down or poison the set; the
    // worst acceptable outcome is that this one agent goes untracked.
    #[tokio::test]
    async fn a_malformed_payload_is_ignored() {
        let c = ctx();
        start(&c, "s1", "not json").await;
        c.state.record_subagents_killed_by_interrupt("s1");
        assert_eq!(render_for_injection(&c.state, "s1"), None);
    }

    #[test]
    fn plural_and_singular_both_read_correctly() {
        let one = render(&[LiveSubagent { agent_id: "a".into(), agent_type: "Plan".into() }]);
        assert!(one.contains("1 still-running subagent."));
        let two = render(&[
            LiveSubagent { agent_id: "a".into(), agent_type: "Plan".into() },
            LiveSubagent { agent_id: "b".into(), agent_type: "Explore".into() },
        ]);
        assert!(two.contains("2 still-running subagents."));
    }

    #[test]
    fn an_agent_with_no_type_still_gets_counted() {
        let block = render(&[LiveSubagent { agent_id: "a".into(), agent_type: String::new() }]);
        assert!(block.contains("unnamed agent"));
    }
}
