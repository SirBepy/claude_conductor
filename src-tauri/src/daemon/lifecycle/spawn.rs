use crate::chat::billing::check_metered_billing;
use crate::daemon::claude_config::{base_claude_args, write_hook_settings, write_mcp_config};
use crate::daemon::pump::run_stdout_pump;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;
use tokio::process::Command;

use super::{is_valid_model, LifecycleError, StartSessionParams, VALID_EFFORTS};

pub async fn spawn_session(
    state: &Arc<DaemonState>,
    params: StartSessionParams,
) -> Result<Arc<Session>, LifecycleError> {
    let map = &state.sessions;
    if !is_valid_model(&params.model)
        || !VALID_EFFORTS.contains(&params.effort.as_str())
    {
        return Err(LifecycleError::InvalidConfig(params.model, params.effort));
    }
    if !params.cwd.exists() {
        return Err(LifecycleError::CwdMissing(params.cwd));
    }

    // Resolve the account this chat spawns under: explicit `account_id` if the
    // caller gave one, else the daemon's cached `default_account_id`. No spawn
    // path may fall back to `~/.claude` (00-overview.md locked decision).
    let default_account_id = state.settings.snapshot().default_account_id;
    let account = crate::accounts::resolve_account(
        params.account_id.as_deref(),
        default_account_id.as_deref(),
    )
    .map_err(|e| match e {
        crate::accounts::AccountResolveError::NoAccounts => LifecycleError::NoAccounts,
        crate::accounts::AccountResolveError::NoDefault => LifecycleError::NoDefault,
        crate::accounts::AccountResolveError::NotFound(id) => LifecycleError::AccountNotFound(id),
    })?;
    // Pre-spawn drift guard (step 3b): refuse if the profile dir's CLI
    // identity no longer matches what the registry recorded at add-account
    // time (someone ran `/login` inside it since onboarding).
    crate::accounts::drift::check(&account)
        .map_err(|e| LifecycleError::AccountDrift(e.to_string()))?;
    // Drift only asks whether credentials EXIST. A failed refresh leaves the
    // record in place with both tokens blanked, which passes that test and
    // then fails at the CLI with an opaque auth error - this catches it here.
    crate::accounts::credentials::check_now(&account)
        .map_err(|e| LifecycleError::AccountCredentials(e.to_string()))?;

    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    // Billing gate evaluates the CHILD's effective env (parent env + this
    // spawn's overrides/removals), not the daemon's ambient env alone.
    // `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`
    // are already guaranteed gone via `SCRUBBED_ENV_VARS` above, so what this
    // gate can still catch is a forbidden var that SURVIVES the unsets -
    // `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`.
    let effective_env = spawn_env.effective_env(std::env::vars());
    if let Err(e) = check_metered_billing(&|k| effective_env.get(k).cloned()) {
        return Err(LifecycleError::MeteredBilling(e.to_string()));
    }

    // The session id is known up front for BOTH paths: a new session gets a
    // freshly generated UUID that we hand to claude via `--session-id`, and a
    // resume reuses the existing id via `--resume`. No stdout capture needed,
    // so spawn_session never blocks (claude withholds its init line until the
    // first user message arrives, which the app sends only AFTER this returns).
    // A fork lands on a fresh id even though it resumes an existing one, so it
    // can never collide with the source session in `map`, in the mcp/hook
    // config paths (both keyed on session id), or in the registry.
    let session_id = match (&params.resume_id, params.fork) {
        (Some(_), true) | (None, _) => params.new_session_id.clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        (Some(id), false) => id.clone(),
    };
    if map.contains_key(&session_id) {
        return Err(LifecycleError::AlreadyExists(session_id));
    }
    // Single chokepoint every spawn/respawn/restart path shares - blocks
    // silent resurrection everywhere, including the desktop app's -32004 retry.
    if state.registry.get(&session_id).map(|i| i.frozen).unwrap_or(false) {
        return Err(LifecycleError::Frozen(session_id));
    }

    // Resume path: `session_id` is the pre-existing registry entry (see the
    // match above), so its `jarvis` flag - stamped by `ensure_jarvis_session`
    // before any message is ever sent to it - is already known here. New/fork
    // spawns get a brand-new id never seen by the registry yet, so this reads
    // false for them; the one caller that spawns a genuinely new Jarvis
    // session (`ensure_jarvis_session`) sends no first message itself, so no
    // MCP child is ever started off that particular config before the
    // registry's `jarvis` flag is set on the very next turn's respawn.
    let is_jarvis = state.registry.get(&session_id).map(|i| i.jarvis).unwrap_or(false);
    // Belt-and-suspenders (todo 441 area): every spawn/resume of a Jarvis-
    // flagged session re-asserts chat-config's auto-accept here, so no resume
    // path - present or future - can ever boot a Jarvis session whose
    // persisted flag was somehow left/found false.
    if is_jarvis {
        crate::sessions::chat_config::set_auto_accept(&session_id, true);
    }
    let mcp_config_path = write_mcp_config(&session_id, &session_id, is_jarvis);
    let hook_settings_path = write_hook_settings(&session_id, &session_id);

    let mut cmd = Command::new("claude");
    cmd.args(base_claude_args(
        params.resume_id.as_deref(),
        &session_id,
        &params.model,
        &params.effort,
        params.remote,
        params.fork,
    ));
    if let Some(ref mcp_path) = mcp_config_path {
        cmd.arg("--permission-prompt-tool")
           .arg("mcp__cc_conductor__approval_prompt")
           .arg("--mcp-config")
           .arg(mcp_path);
    }
    if let Some(ref settings_path) = hook_settings_path {
        cmd.arg("--settings").arg(settings_path);
    }
    cmd.current_dir(&params.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_env.apply_tokio(&mut cmd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Belt-and-suspenders orphan guard: `child` lives inside the pump task
    // spawned below for the session's whole natural lifetime (it is only
    // dropped after an explicit `child.wait().await` once stdout hits EOF,
    // i.e. after the process has already exited on its own - so this never
    // fires early on the normal per-turn respawn cycle). If the pump task's
    // future is instead dropped without reaching that point (daemon exiting
    // while a turn is in flight, or the pump task panicking), `kill_on_drop`
    // makes sure the child doesn't outlive it. Doesn't replace the explicit
    // `kill_tree` shutdown sweeps (those also reap grandchildren); this only
    // covers the direct child.
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn()?;
    // Extends kill_on_drop above from the direct child to the whole tree (the
    // cmd/npx shims and MCP servers claude starts). Chat sessions are already
    // daemon-lifetime-bound, so this changes no semantics; channels are left
    // out on purpose since channel_adopt relies on them outliving the daemon.
    crate::util::process::guard_orphan_tree(&child);
    let pid = child.id().expect("pid");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let _stderr = child.stderr.take().expect("piped stderr");

    let session = Session::new(
        session_id.clone(),
        params.cwd.clone(),
        params.model.clone(),
        params.effort.clone(),
        pid,
        stdin,
        mcp_config_path,
        hook_settings_path,
        account.id.clone(),
    );
    map.insert(session_id.clone(), Arc::clone(&session));
    // Every spawn/respawn/restart path funnels through this one insertion
    // point, so bumping the epoch here (not at each of the five daemon-
    // internal respawn callers) covers all of them by construction - see
    // Registry::bump_channel_epoch.
    state.registry.bump_channel_epoch(&session_id);
    log::info!(
        "daemon: session {} live (pid={}, resume={})",
        session_id, pid, params.resume_id.is_some()
    );

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    let state_for_pump = Arc::clone(state);
    tokio::spawn(run_stdout_pump(child, stdout, pump_session, map_for_pump, state_for_pump, params.resume_id.is_some()));

    // NOTE: jsonl_tail is intentionally NOT spawned in Phase 5a. It republishes
    // every transcript line to the same broadcast the stdout pump already feeds,
    // with no dedup, so it double-renders every app-driven turn. Its only purpose
    // is catching turns that bypass our stdout (phone via remote-control bridge);
    // that is Phase 5b/phone-convergence work and must add uuid-based dedup first.

    Ok(session)
}

/// Re-spawn `session_id` from the Registry's recorded cwd/model/effort/
/// account, resuming its existing transcript (never a fork, never a fresh
/// id). Only respawns sessions the Registry still considers a live
/// Interactive chat (not `ended_at`-marked, not External/Automated) -
/// anything else is a genuine NotFound. Shared by `send_message_with_respawn`
/// (sends a message right after) and `restart_session` (the Jarvis "Restart"
/// action - no message, just a fresh child).
pub(super) async fn respawn_interactive(
    state: &Arc<DaemonState>,
    session_id: &str,
) -> Result<Arc<Session>, LifecycleError> {
    let inst = state
        .registry
        .get(session_id)
        .filter(|i| i.ended_at.is_none())
        .filter(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
        .filter(|i| !i.frozen)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?;

    let model = if inst.model.is_empty() { "opus".to_string() } else { inst.model };
    let effort = if inst.effort.is_empty() { "high".to_string() } else { inst.effort };
    spawn_session(
        state,
        StartSessionParams {
            cwd: inst.cwd,
            model,
            effort,
            resume_id: Some(session_id.to_string()),
            remote: false,
            account_id: inst.account_id,
            fork: false,
            new_session_id: None,
        },
    )
    .await
}

/// Force-kill `session_id`'s live child (if any) and respawn it resuming the
/// SAME session id - the Jarvis kebab menu's "Restart Jarvis" action. Never
/// forks, never marks the session ended in the Registry (unlike
/// `end_session`), so the fleet-ownership/persisted-name/awaiting bookkeeping
/// survives untouched across the restart.
pub async fn restart_session(
    state: &Arc<DaemonState>,
    session_id: &str,
) -> Result<String, LifecycleError> {
    super::teardown::kill_and_wait_for_teardown(state, session_id).await;
    let session = respawn_interactive(state, session_id).await?;
    Ok(session.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A fork resumes one id and lands on another, so it must pass BOTH
    /// `--resume <old>` and `--session-id <new>` alongside `--fork-session`.
    /// Pinning the new id is what lets the daemon know it before spawning,
    /// instead of blocking on stdout to discover it.
    #[test]
    fn fork_passes_resume_and_a_distinct_pinned_session_id() {
        let args = base_claude_args(Some("old-id"), "new-id", "opus", "high", false, true);
        let r = args.iter().position(|a| a == "--resume").expect("--resume");
        assert_eq!(args.get(r + 1).map(String::as_str), Some("old-id"));
        assert!(args.iter().any(|a| a == "--fork-session"), "fork must pass --fork-session: {args:?}");
        let s = args.iter().position(|a| a == "--session-id").expect("--session-id");
        assert_eq!(args.get(s + 1).map(String::as_str), Some("new-id"));
    }

    /// Without `fork`, a resume keeps today's shape exactly: `--resume <id>`
    /// and no `--session-id`. Guards against the fork flag leaking into the
    /// ordinary respawn path, which would silently mint a new id per turn.
    #[test]
    fn plain_resume_is_unchanged_by_the_fork_flag() {
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high", false, false);
        assert!(!args.iter().any(|a| a == "--fork-session"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--session-id"), "{args:?}");
    }

    #[test]
    fn new_session_uses_session_id_not_resume() {
        // Root-cause guard: a brand-new session must use `--session-id <uuid>`,
        // NOT `--resume <uuid>`. claude rejects `--resume` of an unknown id
        // ("No conversation found with session ID") and exits.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false, false);
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "new session must not pass --resume: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id must be present for a new session");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("new-uuid"));
    }

    #[test]
    fn resume_session_uses_resume_not_session_id() {
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high", false, false);
        assert!(
            !args.iter().any(|a| a == "--session-id"),
            "resume must not pass --session-id: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume must be present when resuming");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn base_args_always_carry_model_and_effort() {
        let args = base_claude_args(None, "new-uuid", "sonnet", "medium", false, false);
        let m = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args.get(m + 1).map(String::as_str), Some("sonnet"));
        let e = args.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(args.get(e + 1).map(String::as_str), Some("medium"));
    }

    #[test]
    fn base_args_pretrust_our_own_mcp_ask_tool() {
        // Pre-trust (todo: AUQ dual-path incident, 2026-08-18): the first call
        // to mcp__cc_conductor__ask_user_question must never reach the
        // ordinary approval gate, so it always renders through index.ts's
        // fire-and-forget path, never permission-card.ts's fallback.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false, false);
        let p = args
            .iter()
            .position(|a| a == "--allowedTools")
            .expect("--allowedTools must be present");
        assert_eq!(
            args.get(p + 1).map(String::as_str),
            Some("mcp__cc_conductor__ask_user_question"),
        );
    }

    #[test]
    fn base_args_carry_turn_status_prompt() {
        // The report_turn_status nudge must ride on every spawn (todo 435).
        // cc-progress is unmigrated this pass, so its marker still rides too.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false, false);
        let p = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("--append-system-prompt must be present");
        let prompt = args.get(p + 1).map(String::as_str).unwrap_or("");
        assert!(prompt.contains("report_turn_status"), "prompt must nudge the report_turn_status tool: {prompt}");
        assert!(prompt.contains("<cc-progress:"), "prompt must request the progress marker: {prompt}");
    }

    #[tokio::test]
    async fn invalid_model_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "bogus".into(),
                effort: "high".into(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn full_model_id_accepted() {
        // The data-driven picker sends full ids like `claude-opus-4-8`; the
        // model gate must pass them through (it fails later on CwdMissing,
        // proving it got past the InvalidConfig check).
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "claude-opus-4-8".into(),
                effort: "high".into(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
    }

    #[tokio::test]
    async fn invalid_effort_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "opus".into(),
                effort: "ultra".into(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn missing_cwd_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "opus".into(),
                effort: "high".into(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
        assert_eq!(state.sessions.len(), 0);
    }
}
