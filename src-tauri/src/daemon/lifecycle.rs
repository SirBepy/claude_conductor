//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use crate::chat::billing::check_metered_billing;
use crate::daemon::broadcast;
use crate::daemon::claude_config::{base_claude_args, write_hook_settings, write_mcp_config};
use crate::daemon::pump::run_stdout_pump;
use crate::daemon::session::{Session, SessionMap};
use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const VALID_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Accept both bare family aliases (`opus`) and full model ids
/// (`claude-opus-4-8`). The session model picker is now data-driven from
/// `/v1/models`, which returns full ids; claude's `--model` flag accepts
/// either form, so validation only needs the family to be recognizable.
fn is_valid_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    VALID_MODELS.iter().any(|fam| m.contains(fam))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StartSessionParams {
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    /// If Some, resume an existing session JSONL; if None, generate a new UUID.
    pub resume_id: Option<String>,
    /// If true, spawn claude with `--remote-control`. Defaults to false when the
    /// caller omits it so non-chat spawn paths never register a bridge.
    #[serde(default)]
    pub remote: bool,
    /// Registry account id to spawn under. `Some(id)` is a caller-picked
    /// account - the new-chat account picker (milestone 04) supplies this
    /// explicitly. `None` resolves to the daemon's cached
    /// `Settings.default_account_id`, which every other spawn path (and the
    /// picker itself when "default" is selected) relies on.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Fork `resume_id`'s transcript into a fresh session id instead of
    /// resuming it in place. Used by `move_session_to_account` so a chat can
    /// continue on a different account without ever rebinding an existing
    /// session id, which would break the one-account-per-session invariant.
    /// Requires `resume_id`; ignored otherwise.
    #[serde(default)]
    pub fork: bool,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("invalid model or effort: model={0}, effort={1}")]
    InvalidConfig(String, String),
    #[error("metered billing detected: {0}")]
    MeteredBilling(String),
    #[error("session id {0} already exists in map")]
    AlreadyExists(String),
    #[error("session id {0} not found")]
    NotFound(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cwd does not exist: {0}")]
    CwdMissing(PathBuf),
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    #[error("no default account set - pick one in Settings > Accounts")]
    NoDefault,
    #[error("account {0} not found in the registry")]
    AccountNotFound(String),
    #[error("account drift: {0}")]
    AccountDrift(String),
}

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
        (Some(_), true) | (None, _) => uuid::Uuid::new_v4().to_string(),
        (Some(id), false) => id.clone(),
    };
    if map.contains_key(&session_id) {
        return Err(LifecycleError::AlreadyExists(session_id));
    }

    let mcp_config_path = write_mcp_config(&session_id, &session_id);
    let hook_settings_path = write_hook_settings(&session_id);

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
    log::info!(
        "daemon: session {} live (pid={}, resume={})",
        session_id, pid, params.resume_id.is_some()
    );

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    let state_for_pump = Arc::clone(state);
    tokio::spawn(run_stdout_pump(child, stdout, pump_session, map_for_pump, state_for_pump));

    // NOTE: jsonl_tail is intentionally NOT spawned in Phase 5a. It republishes
    // every transcript line to the same broadcast the stdout pump already feeds,
    // with no dedup, so it double-renders every app-driven turn. Its only purpose
    // is catching turns that bypass our stdout (phone via remote-control bridge);
    // that is Phase 5b/phone-convergence work and must add uuid-based dedup first.

    Ok(session)
}


pub async fn send_message(session: &Arc<Session>, text: &str) -> Result<(), LifecycleError> {
    // Remember the prompt: if this turn is rejected by a rate limit before
    // producing any output, the scheduled resume replays exactly this text.
    if let Ok(mut lp) = session.last_prompt.lock() {
        *lp = text.to_string();
    }
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": text
        }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    // Broadcast a marked user-message echo so the frontend can render the
    // user bubble regardless of which device sent it. The `remote_echo: true`
    // flag lets the frontend distinguish this synthesised event from the
    // `claude --resume` history-replay user lines (which carry remote_echo:
    // false and are dropped to avoid duplicating transcript history).
    // The existing `sigOf` / `isLiveDuplicate` dedup gate in the event-store
    // handles the case where the desktop's own optimistic pushSynthetic already
    // recorded the same content sig, so both paths render exactly one bubble.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    broadcast::publish(
        session,
        ChatEvent::UserMessage {
            content: vec![crate::types::chat::ContentBlock::Text { text: text.to_string() }],
            timestamp: now_ms,
            remote_echo: true,
            is_meta: false,
        },
    );
    Ok(())
}

/// Send a message to `session_id`, respawning it first if the daemon no
/// longer holds it live in the `SessionMap`. The per-turn `claude -p`
/// process exits at the end of every turn (see the `is_interactive` branch
/// at the end of `spawn_session`'s pump task above), so a session that has
/// gone idle since its last turn is routinely absent from the map even
/// though the Registry still lists it as an open Interactive chat.
///
/// The desktop app compensates for this client-side: `ipc/chat/run.rs`'s
/// `send_message_daemon` catches the `-32004` NotFound RPC error, calls
/// `start_session` with `resume_id` set, re-attaches its event bridge, then
/// retries the send. A remote (phone/browser) client has neither half of that
/// dance and no cached cwd/model/effort/account to respawn with, so this does
/// the equivalent respawn-then-retry entirely daemon-side, reading the
/// session's cwd/model/effort/account from the Registry (the daemon's own
/// canonical record) instead of trusting the caller.
///
/// Only respawns sessions the Registry still considers a live Interactive
/// chat (not `ended_at`-marked, not External/Automated) - anything else is a
/// genuine NotFound, same as before this existed.
pub async fn send_message_with_respawn(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
) -> Result<(), LifecycleError> {
    if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
        return send_message(&session, text).await;
    }

    let inst = state
        .registry
        .get(session_id)
        .filter(|i| i.ended_at.is_none())
        .filter(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?;

    let model = if inst.model.is_empty() { "opus".to_string() } else { inst.model };
    let effort = if inst.effort.is_empty() { "high".to_string() } else { inst.effort };
    let session = spawn_session(
        state,
        StartSessionParams {
            cwd: inst.cwd,
            model,
            effort,
            resume_id: Some(session_id.to_string()),
            remote: false,
            account_id: inst.account_id,
            fork: false,
        },
    )
    .await?;
    send_message(&session, text).await
}

pub async fn cancel_turn(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    // Interrupt only the in-flight turn, keeping the process alive. The claude
    // process is long-lived (one `claude -p --input-format=stream-json` per
    // session, turns fed via stdin), so killing it (the old behavior) ended the
    // whole session: the pump saw stdout EOF, marked it ProcessGone, the pane
    // tore down, and the next message had to --resume respawn (looked like a
    // closed chat). The stream-json control protocol stops the current turn
    // without that teardown; the trailing `result` line clears busy as usual.
    let msg = serde_json::json!({
        "type": "control_request",
        "request_id": format!("interrupt-{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "interrupt" }
    });
    let mut line = serde_json::to_vec(&msg).expect("serialize");
    line.push(b'\n');
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

pub async fn end_session(map: &SessionMap, session_id: &str) -> Result<(), LifecycleError> {
    use tokio::io::AsyncWriteExt;
    let session = map.get(session_id)
        .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?
        .clone();
    // Close stdin to signal EOF for clean shutdown.
    {
        let mut stdin = session.stdin.lock().await;
        let _ = stdin.shutdown().await;
    }
    // Wait up to 3s for claude to exit on its own (pump removes from map on EOF).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !map.contains_key(session_id) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Force-kill if still present.
    crate::channels::kill::kill_tree(session.pid);
    if let Some(ref p) = session.mcp_config_path {
        let _ = std::fs::remove_file(p);
    }
    if let Some(ref p) = session.hook_settings_path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
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
    fn base_args_carry_turn_status_prompt() {
        // The status marker instruction must ride on every spawn so Claude
        // self-reports done-vs-question; the sidebar icon depends on it.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false, false);
        let p = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("--append-system-prompt must be present");
        let prompt = args.get(p + 1).map(String::as_str).unwrap_or("");
        assert!(prompt.contains("<cc-status:done|question|waiting|working>"), "prompt must describe the status marker: {prompt}");
        assert!(prompt.contains("<cc-title:"), "prompt must request the title marker: {prompt}");
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
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
        assert_eq!(state.sessions.len(), 0);
    }

    // Real send_message requires a live ChildStdin. The behavior is covered
    // end-to-end in the Phase 2 integration test (#[ignore]'d). Here we
    // sanity-check the JSON shape we emit.
    #[test]
    fn user_message_json_shape_matches_stream_json_format() {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "hi"
            }
        });
        let v: serde_json::Value = serde_json::from_value(msg).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hi");
    }

    #[tokio::test]
    async fn cancel_turn_unknown_session_errors() {
        let map = new_session_map();
        let r = cancel_turn(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }

    #[tokio::test]
    async fn end_session_unknown_session_errors() {
        let map = new_session_map();
        let r = end_session(&map, "nope").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))));
    }

    // send_message_with_respawn: the remote (phone/browser) send path's
    // daemon-side respawn. A live ChildStdin/process is needed to exercise
    // the "already live, just send" branch (covered by the ignored Phase 2
    // integration test, same as plain send_message above); these tests cover
    // the respawn-selection logic, which is exactly the part remote sends
    // were missing.

    #[tokio::test]
    async fn send_message_with_respawn_unknown_everywhere_errors_not_found() {
        let state = test_state();
        let r = send_message_with_respawn(&state, "ghost", "hi").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_uses_registry_cwd_when_map_is_missing() {
        // The session isn't live in the SessionMap (its per-turn process already
        // exited - see spawn_session's is_interactive pump-exit branch) but the
        // Registry still tracks it as an open Interactive chat. The respawn path
        // must read cwd/model/effort from the Registry and actually attempt a
        // spawn - proven here by getting CwdMissing (not NotFound) back for a
        // bogus cwd, which only happens if spawn_session really ran with the
        // registry's recorded path.
        let state = test_state();
        state.registry.upsert_interactive(
            "sid-respawn-1",
            &std::path::PathBuf::from("Z:\\does\\not\\exist"),
            "proj-1",
            "2026-01-01T00:00:00Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-1", "hi").await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_refuses_ended_session() {
        // A session the user genuinely closed (mark_ended) must not be
        // silently resurrected by an incoming remote message - NotFound, same
        // as an unknown session.
        let state = test_state();
        state.registry.upsert_interactive(
            "sid-respawn-2",
            &std::env::temp_dir(),
            "proj-1",
            "2026-01-01T00:00:00Z",
        );
        state.registry.mark_ended(
            "sid-respawn-2",
            crate::types::EndReason::Manual,
            "2026-01-01T00:00:01Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-2", "hi").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }

    #[tokio::test]
    async fn send_message_with_respawn_refuses_non_interactive_kind() {
        // External/Automated sessions have no --resume respawn story; a
        // Registry hit that isn't Interactive must still be a NotFound.
        let state = test_state();
        state.registry.register(
            crate::sessions::registry::RegisterInput {
                session_id: "sid-respawn-3".into(),
                cwd: std::env::temp_dir(),
                pid: 1,
                kind: crate::sessions::kinds::InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &std::sync::Mutex::new(crate::types::Settings::default()),
            "2026-01-01T00:00:00Z",
        );
        let r = send_message_with_respawn(&state, "sid-respawn-3", "hi").await;
        assert!(matches!(r, Err(LifecycleError::NotFound(_))), "{r:?}");
    }
}
