//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

mod spawn;
mod teardown;
pub use spawn::*;
pub use teardown::*;

const VALID_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// RPC code for [`LifecycleError::Busy`]. Distinct from `-32004` (NotFound),
/// which the desktop answers with a respawn-and-retry - a busy session must
/// not be retried, it must be held.
pub const SESSION_BUSY_CODE: i32 = -32006;

/// RPC code for [`LifecycleError::ApiCreditBlocked`]. Like `-32006` it must not
/// be retried or respawned: the account has no credit to spend until its cycle
/// resets or Joe raises the Console limit.
pub const API_CREDIT_BLOCKED_CODE: i32 = -32007;

/// Is this session mid-turn right now. The one predicate every busy-refusal
/// site shares (todo 886) - `refuse_if_busy` below and `schedule_fire.rs`'s
/// own guard used to carry byte-identical copies of this same registry read.
pub(crate) fn is_busy(state: &crate::daemon::state::DaemonState, session_id: &str) -> bool {
    state.registry.get(session_id).map(|i| i.busy).unwrap_or(false)
}

/// `Err` when the session is mid-turn (todo 873). The daemon has no turn
/// queue, so a second write into a live child re-opens the cancel-then-send
/// race that latched `busy`; frontends match `SESSION_BUSY:` on the message
/// and re-stage into the held queue. Mirrors `schedule_fire.rs`'s refusal.
pub fn refuse_if_busy(
    state: &crate::daemon::state::DaemonState,
    session_id: &str,
) -> Result<(), LifecycleError> {
    if is_busy(state, session_id) {
        // Todo 926: this used to log nothing, so the one occurrence that
        // matters - a `busy` that never clears - left no trail to learn from.
        log::warn!("daemon: refuse_if_busy refused a mid-turn send for session {session_id}");
        return Err(LifecycleError::Busy(session_id.to_string()));
    }
    Ok(())
}

/// Whether a question card for `session_id` is open: its child is parked on the
/// answer, running nothing.
pub(crate) async fn has_open_prompt(state: &crate::daemon::state::DaemonState, session_id: &str) -> bool {
    // A quiet card (a decisions checkup) parks nothing: the child is not waiting on it.
    state.list_prompts().await.iter()
        .any(|v| v["payload"]["session_id"].as_str() == Some(session_id) && !crate::daemon::state::is_quiet(v))
}

/// The model and effort a chat is spawned with when its registry row never
/// recorded either. One definition for every respawn path (`respawn_interactive`,
/// a scheduled message's respawn, the desktop's cold-cache send) AND for
/// [`launch_differs`]: if they disagreed, an unrecorded row would read as stale
/// on every send and respawn each time.
pub(crate) const SPAWN_DEFAULT_MODEL: &str = "opus";
pub(crate) const SPAWN_DEFAULT_EFFORT: &str = "high";

/// Model and effort are launch-only CLI flags, so a live child keeps the pair it
/// was spawned with. Empty means the spawn default ([`SPAWN_DEFAULT_MODEL`] /
/// [`SPAWN_DEFAULT_EFFORT`]), so a registry row that never recorded either does
/// not read as a change.
fn launch_differs(live_model: &str, live_effort: &str, want_model: &str, want_effort: &str) -> bool {
    let model = |m: &str| if m.is_empty() { SPAWN_DEFAULT_MODEL.to_string() } else { m.to_string() };
    let effort = |e: &str| if e.is_empty() { SPAWN_DEFAULT_EFFORT.to_string() } else { e.to_string() };
    model(live_model) != model(want_model) || effort(live_effort) != effort(want_effort)
}

/// Would a respawn kill a turn that is running right now: the chat is mid-turn
/// and no question card is open. A card parks the child, which runs nothing, so
/// it is safe to respawn. The one rule behind both halves of the deferred
/// model/effort pick: `apply_launch_change` respawns exactly this chat at once
/// (and nudges it with "continue"), and [`refresh_stale_launch`] refuses to.
pub(crate) fn respawn_would_kill_a_turn(busy: bool, has_prompt: bool) -> bool {
    busy && !has_prompt
}

/// [`refresh_stale_launch`]'s decision: respawn only a chat whose child runs a
/// stale pair and is not in the middle of a turn.
fn stale_respawn_due(busy: bool, has_prompt: bool, stale: bool) -> bool {
    stale && !respawn_would_kill_a_turn(busy, has_prompt)
}

/// Does `session_id`'s live child run a different model/effort than the
/// registry now holds, i.e. a pick was made that only a respawn can apply.
/// Derived from the two records rather than stored as a flag, so picking the
/// original value back cancels the pending change and a daemon restart cannot
/// lose it.
pub(crate) fn launch_is_stale(state: &crate::daemon::state::DaemonState, session_id: &str) -> bool {
    let Some(live) = state.sessions.get(session_id) else { return false };
    let Some(inst) = state.registry.get(session_id) else { return false };
    launch_differs(&live.model, &live.effort, &inst.model, &inst.effort)
}

/// Respawn `session_id` with the registry's model/effort if its live child is
/// stale (see [`launch_is_stale`]). Called by a user send BEFORE the write, so
/// the picked model takes effect on that message without a "continue" turn.
/// Returns whether it respawned, which also means the child has a new broadcast
/// channel the caller's subscribers must re-attach to. A failed respawn is
/// logged and reported as `false`: the send then falls to its NotFound respawn.
///
/// The send right behind a respawn is not refused as busy: `restart_session`
/// returns after the old child leaves `state.sessions`, and the pump clears
/// `busy` in the same await-free stretch of `pump/exit.rs`, before the new
/// spawn's own awaits finish. A `busy` that outlives it is a gen mismatch the
/// registry logs (`set_busy_false_if_gen`), not something this respawn causes.
pub(crate) async fn refresh_stale_launch(
    state: &std::sync::Arc<crate::daemon::state::DaemonState>,
    session_id: &str,
) -> bool {
    // Each read is skipped once the answer no longer depends on it: this runs on
    // every user send, and most chats are not stale.
    let stale = launch_is_stale(state, session_id);
    let busy = stale && is_busy(state, session_id);
    let has_prompt = busy && has_open_prompt(state, session_id).await;
    // A turn running with no card open would be killed by this, and the send
    // behind it is about to be refused as busy anyway.
    if !stale_respawn_due(busy, has_prompt, stale) {
        return false;
    }
    log::info!("daemon: {session_id} runs a stale model/effort, respawning before the next send");
    match restart_session(state, session_id).await {
        Ok(_) => true,
        Err(e) => {
            log::warn!("daemon: stale-launch respawn failed for {session_id}: {e}");
            false
        }
    }
}

/// `Err(ApiCreditBlocked)` when `account_id` is an API-credit account whose
/// cached Console status says it is out of credit or at its spend limit. An
/// account with no status (a subscription account, or one not polled yet)
/// passes: unknown never blocks.
pub fn refuse_account_if_api_credit_blocked(
    state: &crate::daemon::state::DaemonState,
    account_id: &str,
) -> Result<(), LifecycleError> {
    match state.api_credit.blocked_reason(account_id) {
        Some(reason) => {
            log::warn!("daemon: refused a turn on API-credit account {account_id}: {reason}");
            Err(LifecycleError::ApiCreditBlocked(reason))
        }
        None => Ok(()),
    }
}

/// [`refuse_account_if_api_credit_blocked`] for the account `session_id` runs
/// under: the live child's, else the registry's. An unknown session passes and
/// is left to the caller's own NotFound.
pub fn refuse_if_api_credit_blocked(
    state: &crate::daemon::state::DaemonState,
    session_id: &str,
) -> Result<(), LifecycleError> {
    let account_id = state
        .sessions
        .get(session_id)
        .map(|s| s.account_id.clone())
        .or_else(|| state.registry.get(session_id).and_then(|i| i.account_id));
    match account_id {
        Some(id) => refuse_account_if_api_credit_blocked(state, &id),
        None => Ok(()),
    }
}

/// Accept both bare family aliases (`opus`) and full model ids
/// (`claude-opus-4-8`). The session model picker is now data-driven from
/// `/v1/models`, which returns full ids; claude's `--model` flag accepts
/// either form, so validation only needs the family to be recognizable.
pub(crate) fn is_valid_model(model: &str) -> bool {
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
    /// Caller-supplied id for the "mint a new id" branch, so the caller can
    /// register the id's chat-config (auto-accept) before the child boots -
    /// see `move_session_to_account`. `None` falls back to a fresh UUID.
    #[serde(default)]
    pub new_session_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("invalid model or effort: model={0}, effort={1}")]
    InvalidConfig(String, String),
    #[error("metered billing detected: {0}")]
    MeteredBilling(String),
    #[error("session id {0} already exists in map")]
    AlreadyExists(String),
    /// A caller-supplied id reaches `turn_id`, which is joined into the mcp /
    /// hook-settings filenames AND string-formatted into the curl commands
    /// those hooks run through a shell. `start_session` is phone- and
    /// peer-machine-reachable, so an unchecked id is both a path traversal and
    /// a command injection that never touches Claude's own tool-permission
    /// prompt. Real ids are UUIDs.
    #[error("invalid session id: {0}")]
    InvalidSessionId(String),
    #[error("session id {0} not found")]
    NotFound(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// Distinct from `Io` on purpose: a GUI-launched app inherits no shell
    /// PATH, so this used to surface as a bare `os error 2` with nothing to
    /// act on. See `crate::util::claude_bin`.
    #[error("{0}")]
    ClaudeNotFound(String),
    // "On this machine" because the usual cause is a mirrored chat's folder, which
    // lives on the peer hosting it, being resumed here by mistake.
    #[error("cwd does not exist on this machine: {0} (a chat's folder lives on the machine hosting it)")]
    CwdMissing(PathBuf),
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    #[error("no default account set - pick one in Settings > Accounts")]
    NoDefault,
    #[error("account {0} not found in the registry")]
    AccountNotFound(String),
    #[error("account drift: {0}")]
    AccountDrift(String),
    #[error("account credentials: {0}")]
    AccountCredentials(String),
    #[error("session {0} is frozen - unfreeze it first")]
    Frozen(String),
    /// The `SESSION_BUSY:` prefix is load-bearing: it rides `ClientError::Rpc`'s
    /// Display all the way to the webview, where `isSessionBusyError` keys off it.
    #[error("SESSION_BUSY: session {0} is mid-turn - hold this message until the turn ends")]
    Busy(String),
    /// The `API_CREDIT_BLOCKED:` prefix is load-bearing like `SESSION_BUSY:`:
    /// it survives every transport as plain text, so a client can tell the
    /// refusal from a failure. The payload is the human reason, e.g. "Console
    /// spend limit $200 reached, resets 2026-11-01".
    #[error("API_CREDIT_BLOCKED: {0}")]
    ApiCreditBlocked(String),
}

/// A live `Session` for tests that need `state.sessions` to hold a child: a
/// `Session` owns a real `ChildStdin`, so this spawns a throwaway process.
/// Windows-only, like the other tests that spawn a probe child.
#[cfg(all(test, windows))]
pub(crate) mod probe {
    use crate::daemon::session::Session;
    use crate::daemon::state::DaemonState;
    use std::sync::Arc;

    /// Registers `session_id` as an Interactive row in `cwd` (a folder that does
    /// not exist, so a respawn fails at the cwd check instead of starting
    /// `claude`) with the registry's pick set to `registry_pair`, and inserts a
    /// live session launched with `live_pair`. Keep the returned child alive for
    /// the test; it is killed on drop. A respawn attempt shows as
    /// `expected_exit`, which `kill_and_wait_for_teardown` sets before it kills.
    pub(crate) fn live_session(
        state: &DaemonState,
        session_id: &str,
        live_pair: (&str, &str),
        registry_pair: (&str, &str),
    ) -> (tokio::process::Child, Arc<Session>) {
        let cwd = std::path::Path::new("Z:\\does\\not\\exist");
        state.registry.upsert_interactive(session_id, cwd, "proj", "2026-11-07T00:00:00Z");
        state.registry.set_model_effort(session_id, registry_pair.0, registry_pair.1);
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "60", "127.0.0.1"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let pid = child.id().expect("pid");
        let session = Session::new(
            session_id.to_string(), cwd.to_path_buf(), live_pair.0.into(), live_pair.1.into(),
            pid, stdin, None, None, "acct".into(),
        );
        state.sessions.insert(session_id.to_string(), session.clone());
        (child, session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn blocked_status(account_id: &str) -> crate::accounts::ApiCreditStatus {
        crate::accounts::ApiCreditStatus {
            account_id: account_id.into(),
            blocked: true,
            block_reason: Some("API credit for this cycle is used up, expires 2026-11-02".into()),
            ..Default::default()
        }
    }

    #[test]
    fn api_credit_gate_refuses_a_blocked_account_by_registry_binding() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        for sid in ["on-api", "on-sub", "unbound"] {
            state.registry.record_interactive_session(sid, std::path::Path::new("/tmp/x"), &settings, "2026-10-26T00:00:00Z");
        }
        state.registry.set_account("on-api", "api-1");
        state.registry.set_account("on-sub", "sub-1");
        crate::daemon::api_credit::store(&state, blocked_status("api-1"));

        let err = refuse_if_api_credit_blocked(&state, "on-api").expect_err("blocked account must refuse");
        assert!(matches!(err, LifecycleError::ApiCreditBlocked(_)), "{err:?}");
        assert!(err.to_string().starts_with("API_CREDIT_BLOCKED: API credit for this cycle is used up"), "{err}");
        assert!(refuse_if_api_credit_blocked(&state, "on-sub").is_ok(), "another account is untouched");
        assert!(refuse_if_api_credit_blocked(&state, "unbound").is_ok(), "no account bound: unknown never blocks");
        assert!(refuse_if_api_credit_blocked(&state, "ghost").is_ok(), "unknown session is the caller's NotFound");

        // Lifting the block (a new cycle, a raised limit) lets turns through again.
        let mut ok = blocked_status("api-1");
        ok.blocked = false;
        ok.block_reason = None;
        crate::daemon::api_credit::store(&state, ok);
        assert!(refuse_if_api_credit_blocked(&state, "on-api").is_ok());
    }

    #[tokio::test]
    async fn a_blocked_api_credit_chat_refuses_before_any_respawn() {
        // The session is not live, so an unguarded send would try to respawn
        // it (and fail with CwdMissing for this bogus cwd). The gate must win.
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("blocked-sid", std::path::Path::new("Z:\\does\\not\\exist"), "p", "2026-10-26T00:00:00Z");
        state.registry.set_account("blocked-sid", "api-1");
        crate::daemon::api_credit::store(&state, blocked_status("api-1"));

        let r = send_message_with_respawn(&state, "blocked-sid", "hi", false).await;
        assert!(matches!(r, Err(LifecycleError::ApiCreditBlocked(_))), "{r:?}");
    }

    #[test]
    fn launch_differs_reads_empty_as_the_spawn_default() {
        assert!(!launch_differs("opus", "high", "opus", "high"));
        assert!(!launch_differs("opus", "high", "", ""), "an unrecorded pair respawns as opus/high");
        assert!(launch_differs("opus", "high", "sonnet", "high"), "a model pick is a change");
        assert!(launch_differs("opus", "high", "opus", "max"), "an effort pick is a change");
        assert!(!launch_differs("sonnet", "low", "sonnet", "low"), "picking the original back cancels it");
    }

    #[test]
    fn the_spawn_default_pair_is_never_a_launch_change() {
        assert!(!launch_differs(SPAWN_DEFAULT_MODEL, SPAWN_DEFAULT_EFFORT, "", ""));
        assert!(!launch_differs("", "", SPAWN_DEFAULT_MODEL, SPAWN_DEFAULT_EFFORT));
    }

    #[test]
    fn only_a_chat_mid_turn_with_no_card_open_would_lose_its_turn_to_a_respawn() {
        assert!(respawn_would_kill_a_turn(true, false), "a running turn dies with the child");
        assert!(!respawn_would_kill_a_turn(false, false), "idle: nothing runs");
        assert!(!respawn_would_kill_a_turn(true, true), "a question card parks the child, nothing runs");
        assert!(!respawn_would_kill_a_turn(false, true));
    }

    #[test]
    fn a_stale_pick_is_applied_on_the_next_send_unless_a_turn_is_running() {
        // (busy, has_prompt, stale)
        assert!(stale_respawn_due(false, false, true), "idle chat: the send applies the pick");
        assert!(stale_respawn_due(true, true, true), "open question card: the send applies the pick");
        assert!(!stale_respawn_due(true, false, true), "mid-turn: refused as busy, the child is left alone");
        assert!(!stale_respawn_due(false, false, false), "nothing pending");
        assert!(!stale_respawn_due(true, true, false));
        assert!(!stale_respawn_due(true, false, false));
    }

    /// The live-child cases below read `expected_exit` as "a respawn was
    /// attempted": the respawn itself cannot complete here (it would start
    /// `claude`), so it fails at the cwd check after the kill.
    #[cfg(windows)]
    async fn refresh_with(busy: bool, card: bool, stale: bool) -> (bool, bool) {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let registry_pair = if stale { ("sonnet", "low") } else { ("opus", "high") };
        let (_child, session) = probe::live_session(&state, "s", ("opus", "high"), registry_pair);
        state.registry.set_busy("s", busy);
        if card {
            state.add_prompt("p1", "question-requested", serde_json::json!({"session_id": "s", "seq": 1}), false).await;
        }
        let returned = refresh_stale_launch(&state, "s").await;
        (returned, session.expected_exit.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn refresh_stale_launch_respawns_an_idle_chat_and_one_parked_on_a_card() {
        assert!(refresh_with(false, false, true).await.1, "idle and stale: the send applies the pick");
        assert!(refresh_with(true, true, true).await.1, "a question card open: nothing runs, the send applies the pick");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn refresh_stale_launch_refuses_a_chat_mid_turn_without_a_card() {
        assert_eq!(refresh_with(true, false, true).await, (false, false), "the running turn must not be killed");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn refresh_stale_launch_leaves_a_chat_running_its_pick_alone() {
        assert_eq!(refresh_with(false, false, false).await, (false, false));
    }

    #[test]
    fn launch_is_stale_is_false_without_a_live_child() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("s", std::path::Path::new("/tmp/x"), "p", "2026-11-04T00:00:00Z");
        state.registry.set_model_effort("s", "sonnet", "low");
        assert!(!launch_is_stale(&state, "s"), "no live child means the next spawn already uses the pick");
    }

    #[test]
    fn refuse_if_busy_only_refuses_a_mid_turn_session() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session(
            "s",
            std::path::Path::new("/tmp/x"),
            &settings,
            "2026-09-03T00:00:00Z",
        );

        assert!(refuse_if_busy(&state, "s").is_ok(), "an idle session must accept a send");
        assert!(refuse_if_busy(&state, "ghost").is_ok(), "an unknown session is NotFound's call, not ours");

        state.registry.set_busy("s", true);
        let err = refuse_if_busy(&state, "s").expect_err("a mid-turn session must be refused");
        assert!(
            err.to_string().starts_with("SESSION_BUSY:"),
            "the frontend re-stage path keys off this prefix: {err}"
        );
    }
}
