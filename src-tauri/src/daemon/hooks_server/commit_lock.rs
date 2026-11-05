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
//!
//! The lock is keyed on the git dir of the tree the commit runs in (a worktree
//! has its own index, so two worktrees cannot collide), falling back to the
//! project id when that cannot be resolved. A lock is also dropped when its
//! holder moves on (see [`release_held_by`]), because the `PostToolUse` release
//! never fires when another hook denied the call, and the lock would otherwise
//! stall the whole tree until its TTL.
//!
//! Decided 2026-08-12 (todo 425): deliberately does NOT auto-post into
//! `daemon::methods::channel`'s coordination channel - that channel is
//! voluntary by design, and auto-posting would make it enforcement.

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

/// For the first `git commit` in `command` (or, for a chained shell line, any
/// part of it): `Some(dir)` with the `-C <path>` directory when it has one (the
/// project's own `/commit` skill convention, never `cd` first), `Some(None)` for a
/// plain `git commit`, and `None` when the line commits nothing. Deliberately
/// loose: a false positive just costs one redundant lock round-trip (cheap); a
/// false negative would let a real commit slip past the mutex, so this errs toward
/// over-matching rather than under-matching.
fn commit_target(command: &str) -> Option<Option<String>> {
    command.split(['&', ';', '|']).map(str::trim).find_map(|part| {
        let tokens: Vec<&str> = part.split_whitespace().collect();
        let git_idx = tokens.iter().position(|t| *t == "git")?;
        let rest = &tokens[git_idx + 1..];
        let (dir, rest) = if rest.first() == Some(&"-C") {
            let dir = rest.get(1).map(|d| d.trim_matches(['"', '\'']).to_string());
            (dir, rest.get(2..).unwrap_or(&[]))
        } else {
            (None, rest)
        };
        (rest.first() == Some(&"commit")).then_some(dir)
    })
}

fn is_git_commit(command: &str) -> bool {
    commit_target(command).is_some()
}

/// The lock's key for a commit by a session of `project_id` run from `cwd`: the
/// absolute git dir of the tree being committed in. `git rev-parse` is asked
/// because only git knows which index a worktree owns. Anything it cannot answer
/// (no cwd, not a repo, git missing) keys on the project, today's behaviour.
async fn lock_key(project_id: &str, cwd: Option<&str>, command: &str) -> String {
    let dir = match (commit_target(command).flatten(), cwd) {
        (Some(c), Some(base)) if std::path::Path::new(&c).is_relative() => {
            Some(std::path::Path::new(base).join(c))
        }
        (Some(c), _) => Some(std::path::PathBuf::from(c)),
        (None, Some(base)) => Some(std::path::PathBuf::from(base)),
        (None, None) => None,
    };
    let Some(dir) = dir else { return project_id.to_string() };
    let git_dir = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&dir).args(["rev-parse", "--absolute-git-dir"]);
        crate::util::process::hide_console(&mut cmd);
        let out = cmd.output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    })
    .await
    .ok()
    .flatten();
    match git_dir {
        Some(g) => format!("git:{}", crate::daemon::subchats::git::path_key(&g)),
        None => project_id.to_string(),
    }
}

/// Drops every commit lock `session_id` still holds. Called when the session
/// moves on: its next tool batch, its turn ending, its process exiting. A commit
/// call it made cannot still be running by then, so a lock left behind is a leak.
pub(crate) fn release_held_by(state: &crate::daemon::state::DaemonState, session_id: &str) {
    let n = state.release_commit_locks_held_by(session_id);
    if n > 0 {
        log::info!("commit lock: released {n} lock(s) session {session_id} still held");
    }
}

const LOCK_HELD_REASON: &str =
    "Another Conductor chat session is committing in this project right now. Wait and retry \
the commit shortly - do not force through, skip hooks, or use --no-verify to route around this.";

/// Core of the PreToolUse hook, split out for unit testing (mirrors
/// `question::ask_question_decision`). `budget`/`interval` are parameters so
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
    // This session's previous commit call is over (it is issuing a new one), so
    // anything it still holds, under any tree's key, is a leak. Without this a
    // commit another hook denied keeps the tree locked for the whole TTL.
    release_held_by(&ctx.state, session_id);
    let key = lock_key(&project_id, body.get("cwd").and_then(|v| v.as_str()), command).await;

    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if ctx.state.try_acquire_commit_lock(&key, session_id) {
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
            // Whatever key the request took, this session's commit is over.
            release_held_by(&ctx.state, session_id);
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

    fn commit_body(session: &str, cwd: &std::path::Path) -> Value {
        json!({ "session_id": session, "cwd": cwd.to_string_lossy(), "tool_input": { "command": "git commit -m x" } })
    }

    /// Two chats of one project, one committing in the main tree and one in a
    /// linked worktree of it: separate indexes, so neither may wait for the other.
    /// Both register at the main tree, which is how a sub in a worktree shares its
    /// parent's project.
    #[tokio::test]
    async fn commits_in_two_worktrees_of_one_project_do_not_wait_on_each_other() {
        let (_dir, root) = crate::daemon::subchats::git::test_repo::init();
        let wt_dir = tempfile::tempdir().unwrap();
        let wt = wt_dir.path().join("wt");
        crate::daemon::subchats::git::test_repo::git(&root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "side"]);
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", root.to_str().unwrap());
        register(&ctx, &settings, "s2", root.to_str().unwrap());
        assert_eq!(
            ctx.state.registry.get("s1").unwrap().project_id,
            ctx.state.registry.get("s2").unwrap().project_id,
        );

        let first = commit_lock_decision(&ctx, commit_body("s1", &root)).await;
        assert_eq!(first["hookSpecificOutput"]["permissionDecision"], "allow");
        let second = commit_lock_decision_with_budget(
            &ctx, commit_body("s2", &wt), Duration::from_millis(30), Duration::from_millis(10),
        ).await;
        assert_eq!(second["hookSpecificOutput"]["permissionDecision"], "allow", "a worktree has its own index");
    }

    /// Chats on one tree still take turns, whatever directory under it they run from.
    #[tokio::test]
    async fn commits_in_the_same_tree_still_take_turns() {
        let (_dir, root) = crate::daemon::subchats::git::test_repo::init();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", root.to_str().unwrap());
        register(&ctx, &settings, "s2", root.to_str().unwrap());

        let first = commit_lock_decision(&ctx, commit_body("s1", &root)).await;
        assert_eq!(first["hookSpecificOutput"]["permissionDecision"], "allow");
        let second = commit_lock_decision_with_budget(
            &ctx, commit_body("s2", &root.join("sub")), Duration::from_millis(30), Duration::from_millis(10),
        ).await;
        assert_eq!(second["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    /// `git -C <path> commit` names its tree itself, whatever the call's cwd is.
    #[tokio::test]
    async fn a_dash_c_commit_is_keyed_on_the_tree_it_names() {
        let (_dir, root) = crate::daemon::subchats::git::test_repo::init();
        let (_other_dir, other) = crate::daemon::subchats::git::test_repo::init();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", root.to_str().unwrap());
        register(&ctx, &settings, "s2", root.to_str().unwrap());

        assert_eq!(commit_lock_decision(&ctx, commit_body("s1", &root)).await["hookSpecificOutput"]["permissionDecision"], "allow");
        let body = json!({
            "session_id": "s2", "cwd": root.to_string_lossy(),
            "tool_input": { "command": format!("git -C {} commit -m x", other.to_string_lossy().replace('\\', "/")) },
        });
        let second = commit_lock_decision_with_budget(&ctx, body, Duration::from_millis(30), Duration::from_millis(10)).await;
        assert_eq!(second["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    /// A commit another hook denied never reaches PostToolUse. The holder's
    /// next commit call frees what it left behind, under any tree's key.
    #[tokio::test]
    async fn a_holders_next_commit_request_frees_the_lock_it_leaked() {
        let (_dir, root) = crate::daemon::subchats::git::test_repo::init();
        let (_other_dir, other) = crate::daemon::subchats::git::test_repo::init();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", root.to_str().unwrap());
        register(&ctx, &settings, "s2", root.to_str().unwrap());

        assert_eq!(commit_lock_decision(&ctx, commit_body("s1", &root)).await["hookSpecificOutput"]["permissionDecision"], "allow");
        // s1 moves on to commit elsewhere; its old tree must be free again.
        assert_eq!(commit_lock_decision(&ctx, commit_body("s1", &other)).await["hookSpecificOutput"]["permissionDecision"], "allow");
        let s2 = commit_lock_decision_with_budget(&ctx, commit_body("s2", &root), Duration::from_millis(30), Duration::from_millis(10)).await;
        assert_eq!(s2["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[tokio::test]
    async fn release_held_by_frees_what_a_session_left_and_spares_others() {
        let (_dir, root) = crate::daemon::subchats::git::test_repo::init();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let settings = std::sync::Mutex::new(Settings::default());
        register(&ctx, &settings, "s1", root.to_str().unwrap());
        register(&ctx, &settings, "s2", root.to_str().unwrap());
        assert_eq!(commit_lock_decision(&ctx, commit_body("s1", &root)).await["hookSpecificOutput"]["permissionDecision"], "allow");

        release_held_by(&ctx.state, "s2");
        let still = commit_lock_decision_with_budget(&ctx, commit_body("s2", &root), Duration::from_millis(30), Duration::from_millis(10)).await;
        assert_eq!(still["hookSpecificOutput"]["permissionDecision"], "deny", "s2 never held it");
        release_held_by(&ctx.state, "s1");
        let freed = commit_lock_decision_with_budget(&ctx, commit_body("s2", &root), Duration::from_millis(30), Duration::from_millis(10)).await;
        assert_eq!(freed["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[test]
    fn commit_target_reads_the_dash_c_directory() {
        assert_eq!(commit_target("git commit -m x"), Some(None));
        assert_eq!(commit_target("git -C /a/b commit -m x"), Some(Some("/a/b".to_string())));
        assert_eq!(commit_target("git -C \"C:/a/b\" commit"), Some(Some("C:/a/b".to_string())));
        assert_eq!(commit_target("git status"), None);
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
