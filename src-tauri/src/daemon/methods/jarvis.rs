//! Jarvis singleton orchestrator RPC (todo 272, chunk 1: daemon core plumbing
//! only). `ensure_jarvis_session` is the one method this chunk exposes: it
//! returns the existing Jarvis session id if the settings pointer still
//! resolves to a live registry entry, or spawns a fresh one otherwise. No
//! briefing/first-message is sent here - a later chunk owns that.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// Model/effort the Jarvis singleton always spawns with. "opus" matches the
/// bare family-alias form `is_valid_model` accepts (see
/// `daemon::lifecycle::is_valid_model`); "high" mirrors the effort every
/// other opus spawn path in this file defaults to (e.g.
/// `daemon::schedule::respawn_for_message`).
const JARVIS_MODEL: &str = "opus";
const JARVIS_EFFORT: &str = "high";

/// Default model/effort for a `spawn_worker`-created session. Model default
/// ("sonnet") is spec'd (todo 272 chunk 2b); effort isn't, so this picks the
/// middle of `daemon::lifecycle::VALID_EFFORTS` - workers are meant to be
/// cheap parallel labor, not a second Jarvis-grade reasoner, but "low" felt
/// too thin for arbitrary briefed tasks.
const WORKER_DEFAULT_MODEL: &str = "sonnet";
const WORKER_DEFAULT_EFFORT: &str = "medium";

fn err_to_rpc(e: LifecycleError) -> RpcError {
    match e {
        LifecycleError::InvalidConfig(_, _)
        | LifecycleError::CwdMissing(_)
        | LifecycleError::NoAccounts
        | LifecycleError::NoDefault
        | LifecycleError::AccountNotFound(_)
        | LifecycleError::AccountDrift(_) => RpcError::invalid_params(e.to_string()),
        LifecycleError::NotFound(_) => RpcError { code: -32004, message: e.to_string(), data: None },
        LifecycleError::AlreadyExists(_) => RpcError { code: -32005, message: e.to_string(), data: None },
        LifecycleError::MeteredBilling(_) | LifecycleError::Io(_) => RpcError::internal(e.to_string()),
    }
}

/// Resolves (and creates if missing) the dedicated cwd Jarvis spawns in:
/// `<data-dir>/jarvis-home/`. A non-project cwd is fine for
/// `upsert_project_for_cwd`/`upsert_interactive` - both accept any existing
/// directory and mint a fresh `ProjectConfig`/registry entry keyed off it
/// (see module docs below on `ensure_jarvis_session`), so this doesn't panic
/// or wedge the sessions UI; it just shows up as an ordinary project named
/// "jarvis-home" until a later chunk special-cases it in the frontend.
fn jarvis_home_dir() -> Result<std::path::PathBuf, RpcError> {
    let dir = crate::settings::paths::data_dir()
        .map_err(|e| RpcError::internal(e.to_string()))?
        .join("jarvis-home");
    std::fs::create_dir_all(&dir).map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(dir)
}

pub fn register_jarvis(router: &mut Router, state: Arc<DaemonState>) {
    router.register("ensure_jarvis_session", move |_params, _ctx| {
        let state = state.clone();
        async move {
            let existing = state.settings.snapshot().jarvis_session_id;
            if let Some(id) = existing {
                // Require the pointer to resolve to a still-live entry (not
                // merely present-but-ended): an ended Jarvis session can't
                // take the follow-up briefing/orchestration messages a later
                // chunk sends it, so treat "ended" the same as "gone" and
                // fall through to respawning a fresh singleton.
                if let Some(inst) = state.registry.get(&id) {
                    if inst.ended_at.is_none() {
                        return Ok(json!({"session_id": id}));
                    }
                }
            }

            let cwd = jarvis_home_dir()?;
            let params = StartSessionParams {
                cwd: cwd.clone(),
                model: JARVIS_MODEL.to_string(),
                effort: JARVIS_EFFORT.to_string(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
            };
            // check_metered_billing already gates inside spawn_session.
            let session = lifecycle::spawn_session(&state, params).await.map_err(err_to_rpc)?;
            let sid = session.session_id.clone();
            let account_id = session.account_id.clone();
            let now = chrono::Utc::now().to_rfc3339();

            let (project_id, created_new) = state.settings.upsert_project_for_cwd(&cwd, &now);
            if created_new {
                state.notifier.publish("project_created", json!({
                    "project_id": project_id,
                    "cwd": cwd.to_string_lossy(),
                    "now": now,
                }));
            }
            state.registry.upsert_interactive(&sid, &cwd, &project_id, &now);
            state.registry.set_model_effort(&sid, JARVIS_MODEL, JARVIS_EFFORT);
            state.registry.set_account(&sid, &account_id);
            state.registry.set_jarvis(&sid, true);
            crate::sessions::chat_config::record(&sid, JARVIS_MODEL, JARVIS_EFFORT);
            crate::sessions::chat_config::set_account(&sid, &account_id);
            crate::sessions::persistence::save_snapshot_default(&state.registry);

            // Instant in-memory read for this and any other daemon-side
            // consumer; the app process persists the same value to
            // settings.json off the `jarvis_session_created` notification
            // below (daemon has no direct write access to that file - see
            // `SettingsCache`'s module header).
            state.settings.set_jarvis_session_id(&sid);
            state.notifier.publish("jarvis_session_created", json!({"session_id": sid}));
            state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));

            Ok(json!({"session_id": sid}))
        }
    });
}

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

/// `spawn_worker` tool: spawns a brand-new Interactive session under `cwd`
/// and sends `task` as its first turn. Mirrors the bookkeeping in
/// `daemon::schedule::fire_new_chat` (project upsert, registry entries,
/// chat-config record, `instances_changed` notify) - that function is
/// private to `schedule.rs` and has no `set_worker_of` step, so this is a
/// parallel copy rather than a shared call, with one extra step:
/// `set_worker_of` right after registration, tagging the new session as
/// belonging to this Jarvis's fleet (consumed by `fleet_status` and the
/// ownership checks in `send_to_session`/`respond_worker_prompt` below).
pub(crate) async fn spawn_worker(
    state: &Arc<DaemonState>,
    jarvis_session_id: &str,
    cwd: &str,
    task: &str,
    name: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    if !is_jarvis_caller(state, jarvis_session_id) {
        return Err("caller is not the Jarvis session".to_string());
    }

    let cwd_path = std::path::PathBuf::from(cwd);
    let model = model.unwrap_or(WORKER_DEFAULT_MODEL).to_string();
    let params = StartSessionParams {
        cwd: cwd_path.clone(),
        model: model.clone(),
        effort: WORKER_DEFAULT_EFFORT.to_string(),
        resume_id: None,
        remote: false,
        account_id: None,
        fork: false,
    };
    let session = lifecycle::spawn_session(state, params).await.map_err(|e| e.to_string())?;
    let sid = session.session_id.clone();

    let now = chrono::Utc::now().to_rfc3339();
    let (project_id, created_new) = state.settings.upsert_project_for_cwd(&cwd_path, &now);
    if created_new {
        state.notifier.publish("project_created", json!({
            "project_id": project_id,
            "cwd": cwd,
            "now": now,
        }));
    }
    state.registry.upsert_interactive(&sid, &cwd_path, &project_id, &now);
    state.registry.set_model_effort(&sid, &model, WORKER_DEFAULT_EFFORT);
    state.registry.set_account(&sid, &session.account_id);
    state.registry.set_worker_of(&sid, Some(jarvis_session_id.to_string()));
    if let Some(n) = name {
        state.registry.set_name(&sid, n.to_string());
    }
    crate::sessions::chat_config::record(&sid, &model, WORKER_DEFAULT_EFFORT);
    crate::sessions::chat_config::set_account(&sid, &session.account_id);
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, task).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy(&sid, true);
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
    lifecycle::send_message_with_respawn(state, target_session_id, text)
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
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn ensure_jarvis_session_reuses_existing_pointer() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-x", "2026-07-27T00:00:00Z");
        state.settings.set_jarvis_session_id("jv-1");

        let mut r = Router::new();
        register_jarvis(&mut r, state.clone());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "ensure_jarvis_session".into(),
            params: None,
        }, dummy_ctx()).await;

        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"session_id": "jv-1"})));
    }

    // No test exercises the "pointer is stale/ended -> spawn a fresh singleton"
    // branch: that requires reaching `lifecycle::spawn_session`'s account
    // resolution, which reads the REAL accounts.json off this machine (see
    // `accounts::resolve_account` / `load_registry` - unmocked, not test-
    // isolated) and would actually launch a `claude` child process under
    // `cargo test --lib`. Every other RPC test in this daemon avoids that same
    // trap by using an invalid cwd to short-circuit before account resolution
    // (see `methods::mod::tests::start_session_invalid_cwd_does_not_register`);
    // that shortcut isn't available here since a missing cwd is exactly what
    // this method's happy path needs to create. The `ended_at.is_none()` guard
    // itself is covered by code review; verify manually via the app.
}
