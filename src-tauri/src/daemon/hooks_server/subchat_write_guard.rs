//! `/hooks/sub-write-guard` (`PreToolUse`, Edit|Write|NotebookEdit|MultiEdit): the
//! writer slot's enforcement point (`subchats::writers`). Registered only in a
//! sub's hook settings (`claude_config::write_hook_settings`), so a chat that is
//! not a sub never pays for the extra round trip.
//!
//! A refusal is a `deny`. An allowed edit answers with an EMPTY object and not
//! `allow`: a hook's `allow` skips Claude Code's permission check, which would
//! hand every sub auto-accept for its edits and break the rule that a sub's
//! permission prompts reach Joe.

use super::decision::deny_decision;
use super::HookCtx;
use crate::daemon::subchats::writers::{self, WriteCheck};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

/// The tools that write a file by themselves. Bash is not here: a guard on shell
/// commands would be guessing, which is why the refusal calls this a guard and
/// not a sandbox.
const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

pub(super) fn decide(ctx: &HookCtx, body: &Value) -> Value {
    let tool = body.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !WRITE_TOOLS.contains(&tool) {
        return json!({});
    }
    // Unidentifiable callers pass: this guard never blocks a chat it cannot place.
    let Some(session_id) = body.get("session_id").and_then(Value::as_str) else { return json!({}) };
    match writers::check_write(&ctx.state, session_id) {
        WriteCheck::Allow => json!({}),
        WriteCheck::ReadOnly => deny_decision(writers::READ_ONLY_REFUSAL),
        WriteCheck::Wait { holder } => deny_decision(&writers::wait_refusal(&holder)),
    }
}

pub(super) async fn on_sub_write_guard(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(decide(&ctx, &body)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::daemon::subchats::{git::test_repo, store_sub_brief, SubchatBrief, TempDataDir};
    use crate::types::Settings;

    fn ctx() -> HookCtx {
        HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) }
    }

    fn add_sub(c: &HookCtx, id: &str, cwd: &std::path::Path, writes: bool) {
        let parent = format!("{id}-main");
        c.state.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        c.state.registry.upsert_interactive(id, cwd, "proj", "2026-11-05T00:00:00Z");
        c.state.registry.set_subchat_of(id, Some(parent.clone()));
        store_sub_brief(id, &parent);
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.writes = writes;
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn call(c: &HookCtx, session: &str, tool: &str) -> Value {
        decide(c, &json!({"session_id": session, "tool_name": tool, "tool_input": {"file_path": "x"}}))
    }

    fn denied(v: &Value) -> Option<&str> {
        (v["hookSpecificOutput"]["permissionDecision"] == "deny")
            .then(|| v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap_or(""))
    }

    #[test]
    fn a_read_only_sub_has_edit_write_and_notebook_edit_refused_and_a_writer_does_not() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-reader", &root, false);
        add_sub(&c, "wg-writer", &root, true);
        for tool in ["Edit", "Write", "NotebookEdit"] {
            let answer = call(&c, "wg-reader", tool);
            let why = denied(&answer).unwrap_or_else(|| panic!("{tool} must be refused"));
            assert!(why.contains("guard, not a sandbox") && why.contains("writes: true"), "{why}");
        }
        for tool in ["Edit", "Write", "NotebookEdit"] {
            assert_eq!(call(&c, "wg-writer", tool), json!({}), "{tool}: an empty answer leaves the permission flow alone");
        }
    }

    #[test]
    fn other_tools_and_non_subs_are_never_touched() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-ro2", &root, false);
        for tool in ["Read", "Bash", "Grep"] {
            assert_eq!(call(&c, "wg-ro2", tool), json!({}), "{tool}");
        }
        // Mode off: an ordinary chat editing is none of this guard's business.
        c.state.registry.upsert_interactive("wg-plain", &root, "proj", "2026-11-05T00:00:00Z");
        assert_eq!(call(&c, "wg-plain", "Edit"), json!({}));
        assert_eq!(call(&c, "wg-ghost", "Write"), json!({}));
        assert_eq!(decide(&c, &json!({"tool_name": "Edit"})), json!({}), "no session id");
    }

    #[test]
    fn a_second_writer_is_refused_naming_the_first() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-first", &root, true);
        add_sub(&c, "wg-second", &root, true);
        assert_eq!(call(&c, "wg-first", "Write"), json!({}));
        let why = denied(&call(&c, "wg-second", "Edit")).expect("refused").to_string();
        assert!(why.contains("holds this project's writer slot") && why.contains("queued"), "{why}");
    }
}
