//! Commit-mutex endpoints: `/hooks/commit-lock-request` (`PreToolUse`, Bash)
//! and `/hooks/commit-lock-release` (`PostToolUse`, Bash). Two concurrent
//! `claude -p` sessions in the SAME project repo must never run `git commit`
//! at the same time - hit live 2026-07-21 as a patch-apply collision during
//! partial-staging surgery with a concurrent session. MCP tool calls are pure
//! request/response with no channel to push a message into another session's
//! live turn (confirmed against `hooks_server::permission`'s design), so this
//! mutex is enforced daemon-side instead: an `if: "Bash(git *)"` filter (see
//! `claude_config::write_hook_settings`) keeps this hook from even firing for
//! non-git Bash calls, `is_git_commit` narrows the rest down to actual `git
//! commit` invocations, and the daemon-held per-project lock
//! (`DaemonState::try_acquire_commit_lock`) is polled for up to
//! [`COMMIT_LOCK_POLL_BUDGET`] before giving up and denying.

use super::decision::{allow_decision, deny_decision};
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Total time a PreToolUse call will poll the lock before denying the commit
/// (Joe, 2026-07-21: "wait 2 minutes and try again").
const COMMIT_LOCK_POLL_BUDGET: Duration = Duration::from_secs(120);
const COMMIT_LOCK_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// True if `command` is (or, for a chained shell line, contains) a `git
/// commit` invocation, tolerating the project's own `/commit` skill
/// convention of `git -C <path> commit ...` (never `cd` first). Deliberately
/// loose: a false positive just costs one redundant lock round-trip (cheap);
/// a false negative would let a real commit slip past the mutex, so this
/// errs toward over-matching rather than under-matching.
fn is_git_commit(command: &str) -> bool {
    command.split(['&', ';', '|']).map(str::trim).any(|part| {
        let tokens: Vec<&str> = part.split_whitespace().collect();
        let Some(git_idx) = tokens.iter().position(|t| *t == "git") else { return false };
        let rest = &tokens[git_idx + 1..];
        let rest = if rest.first() == Some(&"-C") { rest.get(2..).unwrap_or(&[]) } else { rest };
        rest.first() == Some(&"commit")
    })
}

const LOCK_HELD_REASON: &str =
    "Another Conductor chat session is committing in this project right now. Wait and retry \
the commit shortly - do not force through, skip hooks, or use --no-verify to route around this.";

/// Core of the PreToolUse hook, split out for unit testing (mirrors
/// `permission::ask_question_decision`). `budget`/`interval` are parameters so
/// tests can exercise the deny-after-timeout path without a real 2-minute
/// wait; [`on_commit_lock_request`] is the only caller of the public
/// constants.
async fn commit_lock_decision_with_budget(
    ctx: &Arc<HookCtx>,
    body: Value,
    budget: Duration,
    interval: Duration,
) -> Value {
    let command = body
        .get("tool_input")
        .and_then(|t| t.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !is_git_commit(command) {
        return allow_decision();
    }
    let Some(session_id) = body.get("session_id").and_then(|v| v.as_str()) else {
        // Can't scope a lock without knowing whose it is - fail open rather
        // than block a caller we can't identify.
        return allow_decision();
    };
    let Some(project_id) = ctx.state.registry.get(session_id).map(|i| i.project_id) else {
        // Unregistered session (e.g. a terminal-side or test caller) - same
        // fail-open reasoning.
        return allow_decision();
    };

    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if ctx.state.try_acquire_commit_lock(&project_id, session_id) {
            return allow_decision();
        }
        if tokio::time::Instant::now() >= deadline {
            return deny_decision(LOCK_HELD_REASON);
        }
        tokio::time::sleep(interval).await;
    }
}

pub(super) async fn commit_lock_decision(ctx: &Arc<HookCtx>, body: Value) -> Value {
    commit_lock_decision_with_budget(ctx, body, COMMIT_LOCK_POLL_BUDGET, COMMIT_LOCK_POLL_INTERVAL).await
}

pub(super) async fn on_commit_lock_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(commit_lock_decision(&ctx, body).await))
}

/// PostToolUse companion: releases the lock this session's own
/// `commit_lock_decision` acquired, once the `git commit` Bash call has
/// finished (success or failure - either way the risky window is over).
/// `PostToolUse` output isn't a permission decision, so the body is just an
/// empty acknowledgement.
pub(super) async fn on_commit_lock_release(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let command = body
        .get("tool_input")
        .and_then(|t| t.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if is_git_commit(command) {
        if let Some(session_id) = body.get("session_id").and_then(|v| v.as_str()) {
            if let Some(project_id) = ctx.state.registry.get(session_id).map(|i| i.project_id) {
                ctx.state.release_commit_lock(&project_id, session_id);
            }
        }
    }
    (StatusCode::OK, Json(json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::RegisterInput;
    use crate::types::Settings;
    use std::path::PathBuf;

    /// Registers `session_id` under `cwd` (same `cwd` across calls resolves to
    /// the same `project_id` via `settings::upsert_project_for_cwd`, which is
    /// all these tests need - the literal derived id is never asserted on).
    fn register(ctx: &HookCtx, settings: &std::sync::Mutex<Settings>, session_id: &str, cwd: &str) {
        let now = "2026-07-21T00:00:00Z";
        ctx.state.registry.register(
            RegisterInput {
                session_id: session_id.to_string(),
                cwd: PathBuf::from(cwd),
                pid: 1,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: now.to_string(),
            },
            settings,
            now,
        );
    }

    #[test]
    fn matches_plain_and_dash_c_commit() {
        assert!(is_git_commit("git commit -m \"x\""));
        assert!(is_git_commit("git -C /repo commit -m \"x\""));
        assert!(is_git_commit("echo hi; git commit -m x"));
    }

    #[test]
    fn ignores_non_commit_git_and_unrelated_commands() {
        assert!(!is_git_commit("git status"));
        assert!(!is_git_commit("git add file.ts"));
        assert!(!is_git_commit("echo \"git commit test\""));
        assert!(!is_git_commit("npm run build"));
    }

    #[tokio::test]
    async fn non_commit_command_allows_without_touching_the_lock() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let body = json!({ "session_id": "s1", "tool_input": { "command": "git status" } });
        let decision = commit_lock_decision(&ctx, body).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[tokio::test]
    async fn unregistered_session_fails_open() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let body = json!({ "session_id": "ghost", "tool_input": { "command": "git commit -m x" } });
        let decision = commit_lock_decision(&ctx, body).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[tokio::test]
    async fn free_lock_is_acquired_and_allowed() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", "/tmp/proj-a");
        let body = json!({ "session_id": "s1", "tool_input": { "command": "git commit -m x" } });
        let decision = commit_lock_decision(&ctx, body).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[tokio::test]
    async fn held_lock_denies_after_the_poll_budget_elapses() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", "/tmp/proj-a");
        register(&ctx, &settings, "s2", "/tmp/proj-a");
        let project_id = ctx.state.registry.get("s1").unwrap().project_id;
        assert!(ctx.state.try_acquire_commit_lock(&project_id, "s1"));

        let body = json!({ "session_id": "s2", "tool_input": { "command": "git commit -m x" } });
        let decision = commit_lock_decision_with_budget(
            &ctx, body, Duration::from_millis(30), Duration::from_millis(10),
        ).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(decision["hookSpecificOutput"]["permissionDecisionReason"], LOCK_HELD_REASON);
    }

    #[tokio::test]
    async fn release_frees_the_lock_for_the_next_commit() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", "/tmp/proj-a");
        register(&ctx, &settings, "s2", "/tmp/proj-a");
        let project_id = ctx.state.registry.get("s1").unwrap().project_id;
        assert!(ctx.state.try_acquire_commit_lock(&project_id, "s1"));

        let release_body = json!({ "session_id": "s1", "tool_input": { "command": "git commit -m x" } });
        on_commit_lock_release(AxState(ctx.clone()), Json(release_body)).await;

        let acquire_body = json!({ "session_id": "s2", "tool_input": { "command": "git commit -m x" } });
        let decision = commit_lock_decision(&ctx, acquire_body).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "allow");
    }
}
