//! Jarvis fleet operations (todo 272 chunk 2b) and the account-allocation
//! glue they use, split out of `jarvis.rs` (todo 329): `spawn_worker`,
//! `send_to_session`, `fleet_status`, `respond_worker_prompt`, and the
//! headroom-based worker-account picker. Called from `hooks_server::jarvis`'s
//! HTTP routes via `daemon::methods::jarvis`'s re-export - see that module's
//! header for why plain private-to-`daemon::methods` visibility isn't enough.

use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Default model/effort for a `spawn_worker`-created session. Model default
/// ("sonnet") is spec'd (todo 272 chunk 2b); effort isn't, so this picks the
/// middle of `daemon::lifecycle::VALID_EFFORTS` - workers are meant to be
/// cheap parallel labor, not a second Jarvis-grade reasoner, but "low" felt
/// too thin for arbitrary briefed tasks.
const WORKER_DEFAULT_MODEL: &str = "sonnet";
const WORKER_DEFAULT_EFFORT: &str = "medium";

/// True iff `session_id` both exists in the registry AND is flagged as the
/// Jarvis singleton. Every fleet-orchestration entry point below calls this
/// on the caller-supplied `jarvis_session_id` before touching any state:
/// `mcp::server`'s `CC_JARVIS` env gate only keeps these tools out of a
/// NORMAL session's `tools/list` - it can't stop a `tools/call` naming a tool
/// the model was never shown a schema for - so the daemon side must
/// independently verify the claim.
pub(crate) fn is_jarvis_caller(state: &Arc<DaemonState>, jarvis_session_id: &str) -> bool {
    state.registry.get(jarvis_session_id).map(|i| i.jarvis).unwrap_or(false)
}

/// Reads the daemon's cached per-account 5h-window utilization straight out
/// of `companion.db`'s `usage_snapshots` table: latest snapshot per account
/// (via the shared `usage::reduce_to_latest_per_account`, todo 330), mapped to
/// its `five_hour.utilization`. An account absent from the returned map has
/// never been polled yet; `pick_worker_account` below treats that as full
/// headroom (utilization 0.0), not as "unranked" or "excluded".
async fn five_hour_utilization_by_account(state: &Arc<DaemonState>) -> HashMap<String, f64> {
    let Some(db) = state.db.clone() else { return HashMap::new(); };
    tokio::task::spawn_blocking(move || {
        let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
        let all = crate::storage::usage_store::get_all_snapshots(mgr.conn()).unwrap_or_default();
        super::usage::reduce_to_latest_per_account(all)
            .into_iter()
            .map(|(id, snap)| (id, snap.five_hour.utilization))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Allocator for `spawn_worker` when Jarvis omits an explicit `account` arg
/// (todo 272, "Fleet account allocation", decided 2026-07-27): picks the
/// account with the most 5h-window headroom from the fleet-eligible pool
/// (`accounts::eligible_pool` - opted-in accounts unioned with the always-
/// eligible default). Returns `None` only when that pool is empty (no
/// default account set AND nothing opted in), in which case the caller
/// passes `account_id: None` straight through to `spawn_session`, which
/// falls back to its own `resolve_account`/`NoDefault` error - byte-identical
/// to v1's behavior before this allocator existed.
pub(crate) async fn pick_worker_account(state: &Arc<DaemonState>) -> Option<String> {
    let accounts = crate::accounts::load_registry();
    let default_account_id = state.settings.snapshot().default_account_id;
    let utilization = five_hour_utilization_by_account(state).await;
    crate::accounts::pick_worker_account_pure(&accounts, default_account_id.as_deref(), &utilization)
}

/// `spawn_worker` tool: spawns a brand-new Interactive session under `cwd`
/// and sends `task` as its first turn. Registers it via the shared
/// `session_registration::register_new_session` (todo 420), with one extra
/// step after: `set_worker_of`, tagging the new session as belonging to this
/// Jarvis's fleet (consumed by `fleet_status` and the ownership checks in
/// `send_to_session`/`respond_worker_prompt` below).
///
/// `account`: `Some(id)` is Jarvis naming a specific account explicitly -
/// validated against the same eligible pool `pick_worker_account` draws from
/// (a caller-picked account is never exempt from the opt-in gate); `None`
/// defers to `pick_worker_account`'s headroom ranking.
pub(crate) async fn spawn_worker(
    state: &Arc<DaemonState>,
    jarvis_session_id: &str,
    cwd: &str,
    task: &str,
    name: Option<&str>,
    model: Option<&str>,
    account: Option<&str>,
) -> Result<String, String> {
    if !is_jarvis_caller(state, jarvis_session_id) {
        return Err("caller is not the Jarvis session".to_string());
    }

    let account_id: Option<String> = match account {
        Some(explicit) => {
            let accounts = crate::accounts::load_registry();
            let default_account_id = state.settings.snapshot().default_account_id;
            if !crate::accounts::is_in_eligible_pool(&accounts, default_account_id.as_deref(), explicit) {
                return Err(format!(
                    "account {explicit} is not fleet-eligible - opt it in via Settings > Accounts, \
                     or omit `account` to let Jarvis auto-pick from the eligible pool"
                ));
            }
            Some(explicit.to_string())
        }
        None => pick_worker_account(state).await,
    };

    let cwd_path = std::path::PathBuf::from(cwd);
    let model = model.unwrap_or(WORKER_DEFAULT_MODEL).to_string();
    let params = StartSessionParams {
        cwd: cwd_path.clone(),
        model: model.clone(),
        effort: WORKER_DEFAULT_EFFORT.to_string(),
        resume_id: None,
        remote: false,
        account_id,
        fork: false,
        new_session_id: None,
    };
    let session = lifecycle::spawn_session(state, params).await.map_err(|e| e.to_string())?;
    let sid = session.session_id.clone();

    let now = chrono::Utc::now().to_rfc3339();
    // auto_accept=true, no character: a worker is spawned unattended by
    // Jarvis itself, so requiring manual approval on every tool call would
    // stall the fleet.
    crate::daemon::session_registration::register_new_session(
        state, &sid, &cwd_path, &model, WORKER_DEFAULT_EFFORT, &session.account_id, &now, true, None,
    );
    state.registry.set_worker_of(&sid, Some(jarvis_session_id.to_string()));
    if let Some(n) = name {
        state.registry.set_name(&sid, n.to_string());
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, task, false).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy(&sid, true);
    crate::sessions::chat_state::set_busy(&sid, true);
    state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
    Ok(sid)
}

/// `send_to_session` tool: relays a follow-up message to one of the calling
/// Jarvis's own workers. Scoped to `worker_of == jarvis_session_id` (not just
/// "any live session") - without that, a compromised or confused Jarvis turn
/// could stdin-inject text into an unrelated chat (including the user's own
/// manual sessions), which is well outside "orchestrate my fleet". Rejects a
/// busy target outright: the daemon has no turn queue, so writing to a
/// mid-turn child's stdin is undefined behavior (a later chunk adds queueing
/// for Jarvis wakes specifically).
pub(crate) async fn send_to_session(
    state: &Arc<DaemonState>,
    jarvis_session_id: &str,
    target_session_id: &str,
    text: &str,
) -> Result<(), String> {
    if !is_jarvis_caller(state, jarvis_session_id) {
        return Err("caller is not the Jarvis session".to_string());
    }
    let inst = state.registry.get(target_session_id)
        .ok_or_else(|| format!("unknown session: {target_session_id}"))?;
    if inst.worker_of.as_deref() != Some(jarvis_session_id) {
        return Err("target session is not one of this Jarvis's workers".to_string());
    }
    if inst.busy {
        return Err(
            "target session is still mid-turn; the daemon has no turn queue so sending now \
             would be undefined behavior - wait until it goes idle (see fleet_status) and retry"
                .to_string(),
        );
    }
    lifecycle::send_message_with_respawn(state, target_session_id, text, false)
        .await
        .map_err(|e| e.to_string())
}

/// `fleet_status` tool: the calling Jarvis's own workers (`worker_of ==
/// jarvis_session_id`), each with its busy/awaiting state and the ids of any
/// prompts it has open (permission or question) so Jarvis knows which
/// `respond_worker_prompt` calls are actionable.
pub(crate) async fn fleet_status(state: &Arc<DaemonState>, jarvis_session_id: &str) -> Result<Value, String> {
    if !is_jarvis_caller(state, jarvis_session_id) {
        return Err("caller is not the Jarvis session".to_string());
    }
    let prompts = state.list_prompts().await;
    let workers: Vec<Value> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.worker_of.as_deref() == Some(jarvis_session_id))
        .map(|i| {
            let pending_prompt_ids: Vec<&str> = prompts
                .iter()
                .filter(|p| p["payload"]["session_id"].as_str() == Some(i.session_id.as_str()))
                .filter_map(|p| p["id"].as_str())
                .collect();
            json!({
                "session_id": i.session_id,
                "name": i.name,
                "busy": i.busy,
                "awaiting": i.awaiting,
                "pending_prompt_ids": pending_prompt_ids,
            })
        })
        .collect();
    Ok(json!({"workers": workers}))
}

/// `respond_worker_prompt` tool: answers a pending permission/question prompt
/// raised by one of the calling Jarvis's workers, routed to
/// `permission::respond_permission_inner`/`respond_question_inner` by the
/// prompt's recorded `event` kind (`daemon::state::DaemonState::prompt_event`)
/// - the caller only supplies the allow/message/updated_input shape, it
/// doesn't (and shouldn't need to) know which underlying kind it's answering.
/// Ownership-checked the same way as `send_to_session`: the prompt's owning
/// session must be one of this Jarvis's own workers, so Jarvis can't resolve
/// (allow OR deny) a prompt belonging to an unrelated session on the machine.
///
/// A question prompt has no `allow`/`updated_input` concept - its answer is a
/// free-form `answers` value - so for that kind `message` (if given, else an
/// empty object) is forwarded as the answer text; `allow` is ignored.
pub(crate) async fn respond_worker_prompt(
    state: &Arc<DaemonState>,
    jarvis_session_id: &str,
    request_id: &str,
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<bool, String> {
    if !is_jarvis_caller(state, jarvis_session_id) {
        return Err("caller is not the Jarvis session".to_string());
    }
    let owner = state
        .prompt_session_id(request_id)
        .await
        .ok_or_else(|| "unknown or already-resolved request_id".to_string())?;
    let owner_is_worker = state
        .registry
        .get(&owner)
        .map(|i| i.worker_of.as_deref() == Some(jarvis_session_id))
        .unwrap_or(false);
    if !owner_is_worker {
        return Err("prompt does not belong to one of this Jarvis's workers".to_string());
    }

    let event = state.prompt_event(request_id).await.unwrap_or_default();
    let delivered = match event.as_str() {
        "permission-requested" => {
            crate::daemon::methods::permission::respond_permission_inner(
                state, request_id, allow, updated_input, message,
            ).await
        }
        "question-requested" => {
            let answers = message.map(Value::String).unwrap_or_else(|| json!({}));
            crate::daemon::methods::permission::respond_question_inner(state, request_id, answers).await
        }
        _ => false,
    };
    Ok(delivered)
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

    // ── fleet account allocation (todo 272) ─────────────────────────────────

    #[tokio::test]
    async fn spawn_worker_rejects_non_jarvis_caller_before_touching_accounts() {
        let state = test_state();
        let r = spawn_worker(&state, "not-jarvis", ".", "task", None, None, None).await;
        assert_eq!(r, Err("caller is not the Jarvis session".to_string()));
    }

    #[tokio::test]
    async fn spawn_worker_rejects_an_explicit_account_outside_the_eligible_pool() {
        // Real-machine accounts.json is read here (same unmocked trap as the
        // account-resolution path noted above) - an obviously-fake uuid can
        // never collide with a real registered account id, so the pool
        // membership check deterministically fails regardless of what's
        // actually registered on the machine running this test. The rejection
        // happens before `lifecycle::spawn_session` is ever called, so this
        // test does not spawn a `claude` child process.
        let state = test_state();
        state.registry.upsert_interactive("jv-fleet-1", std::path::Path::new("."), "proj-x", "2026-07-27T00:00:00Z");
        state.registry.set_jarvis("jv-fleet-1", true);

        let r = spawn_worker(
            &state,
            "jv-fleet-1",
            ".",
            "task",
            None,
            None,
            Some("obviously-fake-account-id-3f9c2a1e"),
        )
        .await;
        let err = r.expect_err("out-of-pool explicit account must be rejected");
        assert!(err.contains("not fleet-eligible"), "{err}");
    }

    #[tokio::test]
    async fn pick_worker_account_does_not_panic_with_no_db_attached() {
        // `test_state()` has no `db` (see `DaemonState::new`) - the allocator
        // must degrade to "no usage data" (full headroom for everyone) rather
        // than panic on the missing connection. The eligible-pool contents
        // depend on this machine's real accounts.json (same unmocked trap as
        // `spawn_worker_rejects_an_explicit_account_outside_the_eligible_pool`
        // above), so this only smoke-tests "returns without panicking"; the
        // ranking/pool logic itself is exhaustively covered by the pure
        // `accounts::pick_worker_account_pure` tests, which take the registry
        // and usage map as plain arguments instead of reading real disk.
        let state = test_state();
        let _ = pick_worker_account(&state).await;
    }
}
