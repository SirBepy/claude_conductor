//! Jarvis singleton orchestrator RPC (todo 272, chunk 1: daemon core plumbing
//! only). `ensure_jarvis_session` is the one method this chunk exposes: it
//! returns the existing Jarvis session id if the settings pointer still
//! resolves to a live registry entry, or spawns a fresh one otherwise. No
//! briefing/first-message is sent here - a later chunk owns that.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, Recurrence, RecurrenceRule, ScheduledItem, ScheduledKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Model/effort the Jarvis singleton always spawns with. "opus" matches the
/// bare family-alias form `is_valid_model` accepts (see
/// `daemon::lifecycle::is_valid_model`); "high" mirrors the effort every
/// other opus spawn path in this file defaults to (e.g.
/// `daemon::schedule::respawn_for_message`).
const JARVIS_MODEL: &str = "opus";
const JARVIS_EFFORT: &str = "high";

/// Jarvis's standing instructions, written to `<jarvis-home>/CLAUDE.md` the
/// first time the singleton is spawned. The `claude` CLI loads this file
/// natively every turn (and re-loads it after context compaction) - that's
/// the platform primitive this chunk relies on instead of an injected first
/// message, which would only ever appear once in the transcript and get
/// evicted on compaction like anything else.
const JARVIS_CLAUDE_MD: &str = r#"# Jarvis - Conductor fleet orchestrator

You are Jarvis, the single point of contact between Joe and a fleet of worker chat sessions in Claude Conductor. You never write code yourself - you dispatch, mediate, and relay.

## Tools
- spawn_worker(cwd, task, name?, model?, account?) - start a real worker session in a project. Default model sonnet; override only with a stated reason. `account` is optional - omit it and the daemon auto-picks whichever fleet-eligible account has the most 5h-window headroom; name one explicitly only when a task must run on a specific account (rejected if that account isn't fleet-eligible).
- send_to_session(session_id, text) - message one of your workers. Rejects if the worker is mid-turn; retry after its next [fleet] terminal note.
- fleet_status() - your workers: busy state, awaiting, pending prompt ids.
- respond_worker_prompt(request_id, allow, message?/updated_input?) - answer a worker's permission/question prompt yourself when the answer is obvious from context; relay to Joe when it isn't.

## Wake notes
Lines starting with [fleet] are injected by the daemon, not typed by Joe: worker terminal states (done/question/waiting), blocked prompts, and "Joe messaged worker X directly". Act on them; never attribute them to Joe.

## Discipline
- Fan-out cap: at most 4 concurrent workers. Say so in chat when the cap or the usage window gates a dispatch.
- Every worker briefing must include: a tight spec, a disjoint file domain, the project's verify floor (typecheck/tests/build), and the commit policy: workers run /commit themselves when their work verifies green.
- Relay policy: stay quiet while workers work. Report to Joe on terminal states, blockers, and questions - batched, outcome first, no play-by-play.
- state.md in this folder is your source of truth: current plan, worker roster (session ids + tasks), decisions made, open questions. Update it after every dispatch, completion, and decision.
- At the start of any conversation - and whenever your context feels incomplete (e.g. after compaction) - read state.md and call fleet_status() before assuming anything about the fleet. Never trust a remembered summary of a worker you can re-query.
"#;

/// Empty-template seed for `<jarvis-home>/state.md`, written alongside
/// `JARVIS_CLAUDE_MD` on first spawn only. Jarvis is instructed (in the
/// CLAUDE.md above) to keep this updated as its own scratch/roster file; this
/// is just the starting shape.
const JARVIS_STATE_MD_SEED: &str = r#"# Jarvis state

## Plan
(nothing active)

## Fleet
(no workers)

## Decisions
(none yet)

## Open questions
(none)
"#;

/// Writes `<jarvis-home>/CLAUDE.md` and `/state.md` iff each is individually
/// missing - never overwrites either, since Joe may hand-tune them once
/// Jarvis (or Joe himself) has edited them. Called only on the fresh-spawn
/// path in `ensure_jarvis_session`, never on reuse of an existing pointer.
fn seed_jarvis_home_files(cwd: &std::path::Path) -> Result<(), RpcError> {
    let claude_md = cwd.join("CLAUDE.md");
    if !claude_md.exists() {
        std::fs::write(&claude_md, JARVIS_CLAUDE_MD).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    let state_md = cwd.join("state.md");
    if !state_md.exists() {
        std::fs::write(&state_md, JARVIS_STATE_MD_SEED).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    Ok(())
}

/// Weekly memory-hygiene prompt sent to Jarvis (todo 272 remainder): lints
/// `state.md` and every other memory file in `jarvis-home` so months-old
/// stale facts can't keep steering it. Verbatim per spec - the const is the
/// single source of truth, stored into the seeded `ScheduledItem.prompt` so
/// `daemon::schedule::fire_jarvis_hygiene` never needs its own copy.
const JARVIS_HYGIENE_PROMPT: &str = r###"[fleet] Weekly memory hygiene pass. Do this now, autonomously:
1. Read state.md and every other .md file in this folder (except CLAUDE.md).
2. Dedupe repeated facts; resolve contradictions in favor of the newest evidence; delete entries about work that is finished and recorded in git.
3. Expire stale facts: anything you cannot re-verify via fleet_status() or the files themselves gets removed or marked unverified.
4. If a correction from Joe has come up more than once, promote it into a short rule in CLAUDE.md under a "## Learned rules" section (create it if missing).
5. Rewrite state.md clean and compact. Reply with a one-paragraph summary of what changed.
"###;

/// The Monday-morning weekly recurrence the hygiene item seeds with. Time is
/// local wall-clock per `Recurrence::time`'s semantics; the exact slot is an
/// arbitrary-but-reasonable default (start of week, low-traffic hour) - Joe
/// can drag it in the Schedule view like any other recurring item afterward.
fn jarvis_hygiene_recurrence() -> Recurrence {
    Recurrence {
        time: "09:00".to_string(),
        rule: RecurrenceRule::Weekly { weekdays: vec![0] }, // Monday
    }
}

/// True iff a `JarvisHygiene`-kind item already exists anywhere in the
/// schedule store. The kind itself IS the stable idempotency marker (it
/// carries no session id to dedupe on - see `ScheduledKind::JarvisHygiene`'s
/// doc comment for why), so this is a plain existence check, not a lookup by
/// id. Pure (takes the already-loaded list) so it's testable without disk I/O.
fn jarvis_hygiene_already_seeded(items: &[ScheduledItem]) -> bool {
    items.iter().any(|it| matches!(it.kind, ScheduledKind::JarvisHygiene))
}

/// Builds the (not-yet-persisted) recurring hygiene item, its first `fire_at`
/// computed as the next Monday-09:00 occurrence strictly after `now`. Pure
/// builder, split out from `seed_jarvis_hygiene_schedule` so the shape is
/// testable without touching the real scheduled-items store.
fn build_jarvis_hygiene_item(now: chrono::DateTime<chrono::Utc>) -> ScheduledItem {
    let recurrence = jarvis_hygiene_recurrence();
    let fire_at = scheduled_items::next_occurrence(now, &recurrence).to_rfc3339();
    ScheduledItem::new(ScheduledKind::JarvisHygiene, JARVIS_HYGIENE_PROMPT.to_string(), fire_at, Some(recurrence))
}

/// Seeds the recurring weekly memory-hygiene pass (todo 272 remainder), once,
/// the first time a fresh Jarvis singleton is spawned - never called from the
/// pointer-reuse branch in `ensure_jarvis_session`. An existing item already
/// targets Jarvis correctly regardless of respawns (it resolves the live
/// session id at FIRE time, not creation time - see `ScheduledKind::
/// JarvisHygiene` and `daemon::schedule::fire_jarvis_hygiene`), so a second
/// fresh spawn (e.g. after the stored pointer went stale) must not create a
/// duplicate recurring item - `jarvis_hygiene_already_seeded` is the guard.
fn seed_jarvis_hygiene_schedule() {
    if jarvis_hygiene_already_seeded(&scheduled_items::list()) {
        return;
    }
    scheduled_items::upsert(build_jarvis_hygiene_item(chrono::Utc::now()));
}

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
            seed_jarvis_home_files(&cwd)?;
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
            // On by default: Jarvis runs unattended, so requiring manual approval
            // on every tool call would stall the whole fleet on a prompt no one
            // is watching for.
            crate::sessions::chat_config::set_auto_accept(&sid, true);
            crate::sessions::persistence::save_snapshot_default(&state.registry);
            // Fresh-spawn only (never on pointer reuse, above) and idempotent -
            // see the function doc for why a respawn never duplicates this.
            seed_jarvis_hygiene_schedule();

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

/// Reads the daemon's cached per-account 5h-window utilization straight out
/// of `companion.db`'s `usage_snapshots` table: latest snapshot per account,
/// mapped to its `five_hour.utilization`. Same underlying read as
/// `daemon::methods::usage::get_usage_map`'s `reduce_to_latest_per_account`,
/// duplicated here rather than shared since that helper is private to its own
/// (currently locked-for-edit) file - see the module doc there for why
/// `account_id: None` legacy rows are skipped. An account absent from the
/// returned map has never been polled yet; `pick_worker_account` below treats
/// that as full headroom (utilization 0.0), not as "unranked" or "excluded".
async fn five_hour_utilization_by_account(state: &Arc<DaemonState>) -> HashMap<String, f64> {
    let Some(db) = state.db.clone() else { return HashMap::new(); };
    tokio::task::spawn_blocking(move || {
        let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
        let all = crate::storage::usage_store::get_all_snapshots(mgr.conn()).unwrap_or_default();
        let mut map: HashMap<String, f64> = HashMap::new();
        for snap in all {
            if let Some(id) = snap.account_id.clone() {
                map.insert(id, snap.five_hour.utilization);
            }
        }
        map
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
/// and sends `task` as its first turn. Mirrors the bookkeeping in
/// `daemon::schedule::fire_new_chat` (project upsert, registry entries,
/// chat-config record, `instances_changed` notify) - that function is
/// private to `schedule.rs` and has no `set_worker_of` step, so this is a
/// parallel copy rather than a shared call, with one extra step:
/// `set_worker_of` right after registration, tagging the new session as
/// belonging to this Jarvis's fleet (consumed by `fleet_status` and the
/// ownership checks in `send_to_session`/`respond_worker_prompt` below).
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
    // On by default: a worker is spawned unattended by Jarvis itself, so
    // requiring manual approval on every tool call would stall the fleet.
    crate::sessions::chat_config::set_auto_accept(&sid, true);
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, task, false).await.map_err(|e| e.to_string())?;
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

    #[test]
    fn seed_jarvis_home_files_creates_both_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        seed_jarvis_home_files(dir.path()).unwrap();

        let claude_md = std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap();
        assert_eq!(claude_md, JARVIS_CLAUDE_MD);
        let state_md = std::fs::read_to_string(dir.path().join("state.md")).unwrap();
        assert_eq!(state_md, JARVIS_STATE_MD_SEED);
    }

    #[test]
    fn seed_jarvis_home_files_never_overwrites_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "Joe's hand-tuned instructions").unwrap();
        std::fs::write(dir.path().join("state.md"), "Joe's hand-tuned state").unwrap();

        seed_jarvis_home_files(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "Joe's hand-tuned instructions"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("state.md")).unwrap(),
            "Joe's hand-tuned state"
        );
    }

    #[test]
    fn seed_jarvis_home_files_fills_in_only_the_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "Joe's hand-tuned instructions").unwrap();
        // state.md left absent.

        seed_jarvis_home_files(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "Joe's hand-tuned instructions"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("state.md")).unwrap(),
            JARVIS_STATE_MD_SEED
        );
    }

    // `ensure_jarvis_session_reuses_existing_pointer` above doubles as coverage
    // for "reuse writes nothing": the reuse branch returns at the `Ok(json!(
    // {"session_id": id}))` early-return, before `jarvis_home_dir()` or
    // `seed_jarvis_home_files` are ever reached (see the non-test code above),
    // so there's no filesystem side effect to assert on - the call graph
    // itself is the guarantee.

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

    // ── weekly memory-hygiene seed (todo 272 remainder) ─────────────────────

    #[test]
    fn jarvis_hygiene_already_seeded_true_when_a_jarvis_hygiene_item_exists() {
        let items = vec![ScheduledItem::new(
            ScheduledKind::JarvisHygiene,
            "x".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        )];
        assert!(jarvis_hygiene_already_seeded(&items), "idempotency guard must detect the existing marker item");
    }

    #[test]
    fn jarvis_hygiene_already_seeded_false_when_only_other_kinds_exist() {
        let items = vec![
            ScheduledItem::new(
                ScheduledKind::Message { session_id: "s".into(), cwd: "C:/x".into() },
                "x".into(),
                "2026-01-01T00:00:00Z".into(),
                None,
            ),
            ScheduledItem::new(
                ScheduledKind::NewChat {
                    cwd: "C:/y".into(), model: "opus".into(), effort: "high".into(),
                    account_id: None, placeholder_id: None, character_id: None, auto_accept: false,
                },
                "x".into(),
                "2026-01-01T00:00:00Z".into(),
                None,
            ),
        ];
        assert!(!jarvis_hygiene_already_seeded(&items), "Message/NewChat items must never be mistaken for the hygiene marker");
    }

    #[test]
    fn jarvis_hygiene_already_seeded_false_for_empty_list() {
        assert!(!jarvis_hygiene_already_seeded(&[]));
    }

    #[test]
    fn build_jarvis_hygiene_item_shape_is_weekly_with_the_verbatim_prompt() {
        let now = chrono::Utc::now();
        let item = build_jarvis_hygiene_item(now);
        assert!(matches!(item.kind, ScheduledKind::JarvisHygiene));
        assert_eq!(item.prompt, JARVIS_HYGIENE_PROMPT);
        let rec = item.recurrence.expect("hygiene item must recur");
        assert!(matches!(rec.rule, RecurrenceRule::Weekly { .. }), "must be a weekly recurrence, not one-shot");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&item.fire_at).is_ok(),
            "fire_at must be a valid RFC3339 instant"
        );
        assert!(
            chrono::DateTime::parse_from_rfc3339(&item.fire_at).unwrap() > now,
            "seeded fire_at must be strictly in the future"
        );
    }

    #[test]
    fn build_jarvis_hygiene_item_two_calls_produce_distinct_ids() {
        // Guards against `seed_jarvis_hygiene_schedule` ever accidentally
        // upserting over itself by id (it doesn't - `ScheduledItem::new` mints
        // a fresh uuid every call, same as every other kind).
        let now = chrono::Utc::now();
        let a = build_jarvis_hygiene_item(now);
        let b = build_jarvis_hygiene_item(now);
        assert_ne!(a.id, b.id);
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
