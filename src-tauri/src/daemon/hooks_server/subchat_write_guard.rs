//! `/hooks/sub-write-guard` (`PreToolUse`, Edit|Write|NotebookEdit|MultiEdit, plus
//! Bash|PowerShell for the push guard): the writer slot's enforcement point
//! (`subchats::writers`). Registered only in a
//! sub's hook settings (`claude_config::write_hook_settings`), so a chat that is
//! not a sub never pays for the extra round trip.
//!
//! A refusal is a `deny`. An allowed edit answers with an EMPTY object and not
//! `allow`: a hook's `allow` skips Claude Code's permission check, which would
//! hand every sub auto-accept for its edits and break the rule that a sub's
//! permission prompts reach Joe.
//!
//! The push guard (`push_refusal`) asks `publish_matcher::runs_publish_command` whether a shell
//! command publishes; that module holds the tokenizer and its list of known gaps.

use super::decision::deny_decision;
use super::publish_matcher::runs_publish_command;
use super::HookCtx;
use crate::daemon::subchats::writers::{self, WriteCheck};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

/// The tools that write a file by themselves. Bash is not here: a guard on shell
/// commands would be guessing, which is why the refusal calls this a guard and
/// not a sandbox.
const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
/// The shell tools the push guard reads (`push_refusal`). `Monitor` runs a `command`
/// in the same shell as Bash, so a sub could publish through it. The PreToolUse
/// matcher in `claude_config/hook_settings.rs` does not list it yet, so only the
/// permission relay reads it today.
const SHELL_TOOLS: [&str; 3] = ["Bash", "PowerShell", "Monitor"];

pub(super) fn decide(ctx: &HookCtx, body: &Value) -> Value {
    let tool = body.get("tool_name").and_then(Value::as_str).unwrap_or("");
    // Unidentifiable callers pass: this guard never blocks a chat it cannot place.
    let Some(session_id) = body.get("session_id").and_then(Value::as_str) else { return json!({}) };
    // A shell call is checked for a publish command here as well as in the permission
    // relay: with the user's own allow rule (`Bash(git push*)`) or auto mode, Claude
    // Code never asks the relay, but a PreToolUse hook always runs.
    if SHELL_TOOLS.contains(&tool) {
        let input = body.get("tool_input").unwrap_or(&Value::Null);
        return match push_refusal(&ctx.state, session_id, tool, input) {
            Some(refusal) => deny_decision(refusal),
            None => json!({}),
        };
    }
    if !WRITE_TOOLS.contains(&tool) {
        return json!({});
    }
    match writers::check_write(&ctx.state, session_id) {
        WriteCheck::Allow => json!({}),
        WriteCheck::ReadOnly => deny_decision(writers::READ_ONLY_REFUSAL),
        WriteCheck::Wait { holder } => deny_decision(&writers::wait_refusal(&holder)),
    }
}

/// What a refused sub is told. A gate sub is the one sub allowed to publish work
/// (`subchats::is_gate`); everything else hands its commits to the main chat.
pub(super) const PUSH_REFUSAL: &str = "Only a push gate sub may run git push or gh pr merge, and you are not one. This is a guard on the command text, not a sandbox, and auto-accept does not lift it. Commit your work, call finish_subchat, and let your main chat start a gate (spawn_chat with gate: true) once Joe asks for the push.";

/// `Some(refusal)` when `tool` is a shell call by a sub that is not a gate and its
/// command publishes work (`git push`, `gh pr merge`). Runs in the permission
/// relay BEFORE the auto-accept shortcut, because subs inherit auto-accept (on by
/// default) and also reach the relay from projects other than the main chat's.
/// A chat that is not a sub, and a gate, are never refused here.
pub(super) fn push_refusal(state: &crate::daemon::state::DaemonState, session_id: &str, tool: &str, input: &Value) -> Option<&'static str> {
    if !SHELL_TOOLS.contains(&tool) {
        return None;
    }
    let command = input.get("command").and_then(Value::as_str)?;
    if !runs_publish_command(command, tool == "PowerShell") {
        return None;
    }
    let is_sub = state.registry.get(session_id).is_some_and(|i| crate::daemon::subchats::is_sub(&i));
    (is_sub && !crate::daemon::subchats::is_gate(session_id)).then_some(PUSH_REFUSAL)
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

    fn shell(command: &str) -> Value {
        json!({"command": command})
    }

    #[test]
    fn a_non_gate_subs_push_is_refused_a_gate_and_a_plain_chat_are_not() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "pg-sub", &root, true);
        add_sub(&c, "pg-gate", &root, true);
        let mut gate: SubchatBrief = crate::sessions::chat_config::get("pg-gate").unwrap().subchat.unwrap();
        gate.gate = true;
        crate::sessions::chat_config::set_subchat("pg-gate", Some(gate));
        c.state.registry.upsert_interactive("pg-plain", &root, "proj", "2026-11-05T00:00:00Z");
        // Auto-accept on everywhere: the refusal must not depend on it.
        for sid in ["pg-sub", "pg-gate", "pg-plain"] {
            crate::sessions::chat_config::set_auto_accept(sid, true);
        }
        for cmd in ["git push", "git -C C:/repo push origin x", "cd a && git push", "gh pr merge 3"] {
            for tool in ["Bash", "PowerShell", "Monitor"] {
                let why = push_refusal(&c.state, "pg-sub", tool, &shell(cmd)).unwrap_or_else(|| panic!("{tool} {cmd} must be refused"));
                assert!(why.contains("finish_subchat") && why.contains("gate: true"), "{why}");
                assert_eq!(push_refusal(&c.state, "pg-gate", tool, &shell(cmd)), None, "a gate pushes: {cmd}");
                assert_eq!(push_refusal(&c.state, "pg-plain", tool, &shell(cmd)), None, "a plain chat is unaffected: {cmd}");
            }
        }
        // Harmless commands, other tools and unplaceable callers pass.
        assert_eq!(push_refusal(&c.state, "pg-sub", "Bash", &shell("git log --grep push")), None);
        assert_eq!(push_refusal(&c.state, "pg-sub", "Read", &shell("git push")), None);
        assert_eq!(push_refusal(&c.state, "pg-sub", "Bash", &json!({})), None);
        assert_eq!(push_refusal(&c.state, "pg-ghost", "Bash", &shell("git push")), None);
    }

    // The hook path: with an allow rule on `git push` Claude Code never asks the
    // permission relay, so the PreToolUse hook is the only place the guard can run.
    #[test]
    fn the_pre_tool_use_hook_denies_a_non_gate_subs_push_and_leaves_the_rest() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "ph-sub", &root, true);
        c.state.registry.upsert_interactive("ph-plain", &root, "proj", "2026-11-05T00:00:00Z");
        let run = |sid: &str, tool: &str, cmd: &str| decide(&c, &json!({"session_id": sid, "tool_name": tool, "tool_input": {"command": cmd}}));
        for tool in ["Bash", "PowerShell"] {
            let why = denied(&run("ph-sub", tool, "git push origin x")).unwrap_or_else(|| panic!("{tool} push must be denied")).to_string();
            assert!(why.contains("gate: true"), "{why}");
            assert_eq!(run("ph-sub", tool, "git status"), json!({}), "a non-push shell call passes");
            assert_eq!(run("ph-plain", tool, "git push"), json!({}), "a plain chat is untouched");
        }
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
