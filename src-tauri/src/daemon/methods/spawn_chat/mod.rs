//! `spawn_chat`: the unconditional sibling-session spawn, shared by the
//! `spawn_chat` and `respawn` MCP tools.
//! Not `jarvis_fleet::spawn_worker`, which is `CC_JARVIS`-gated and fleet-
//! tagged. Guards instead: `cwd` must be either the caller's own working
//! directory or a project already in `Settings.projects` (never an arbitrary
//! path), and `respawn` at most once per turn (two would hand the caller off
//! to two successors); plain `spawn_chat` siblings are unlimited. It inherits the caller's own account;
//! model/effort and the character are inherited on the `respawn` path only (a
//! plain sibling opens on the project's default model/effort). Auto-accept is
//! inherited per `session_registration::spawned_auto_accept`. A caller with Use
//! subchats on gets a hidden sub instead, planned by `daemon::subchats::spawn`
//! (in its own project or any known one; `plain: true` opts out to an ordinary
//! chat); a sub itself may neither spawn nor respawn.
//!
//! Cross-machine spawn forwarding (`resolve_machine`, `spawn_chat_for_peer`,
//! `spawn_chat_or_forward`) lives in this module's own `forward` submodule
//! (todo 916), not in `daemon::machines::forward` - that module forwards a
//! call for a session `mirror` already knows is mirrored, keyed on
//! `session_id`; this one dispatches a brand-new spawn to an explicitly
//! named `machine` argument before any session exists to mirror. Different
//! key, different trigger - the shared name is coincidental.

use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::settings::identity::project_key;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod forward;
mod todo;
pub(crate) use forward::{resolve_machine, spawn_chat_or_forward};
pub use todo::register_todo_chat_rpc;

/// Used only when no explicit value, inherited respawn value, or project or
/// Settings default exists.
pub(crate) const FALLBACK_MODEL: &str = "sonnet";
pub(crate) const FALLBACK_EFFORT: &str = "medium";

/// The name a gate sub gets when the caller names none.
const GATE_DEFAULT_NAME: &str = "Gate";

/// A gate with no name: plain `Gate` in the caller's own project, `Gate: <folder>`
/// for another one, so a hub chat running a gate per repo can tell them apart
/// when it addresses one by name (`subchat send`, `after`).
fn default_gate_name(caller_cwd: &std::path::Path, target: &std::path::Path) -> String {
    if project_key(caller_cwd) == project_key(target) {
        return GATE_DEFAULT_NAME.to_string();
    }
    match target.file_name() {
        Some(folder) => format!("{GATE_DEFAULT_NAME}: {}", folder.to_string_lossy()),
        None => GATE_DEFAULT_NAME.to_string(),
    }
}

/// `default_gate_name`, made unique among the names the caller's subs already
/// answer to (`taken`, trimmed and lower-cased). Gates skip the duplicate-name
/// refusal, so two repos whose folders share a basename would otherwise both be
/// `Gate: <folder>` and `subchat send` or `after` by that name would be
/// ambiguous. A taken name tries the parent folder first (`Gate: <parent>/<folder>`),
/// then a counter on the last name tried (`... 2`, `... 3`).
fn unique_gate_name(caller_cwd: &std::path::Path, target: &std::path::Path, taken: &[String]) -> String {
    let is_taken = |name: &str| taken.iter().any(|t| *t == name.trim().to_lowercase());
    let base = default_gate_name(caller_cwd, target);
    if !is_taken(&base) {
        return base;
    }
    let with_parent = match (target.parent().and_then(|p| p.file_name()), target.file_name()) {
        (Some(parent), Some(folder)) if base != GATE_DEFAULT_NAME => {
            Some(format!("{GATE_DEFAULT_NAME}: {}/{}", parent.to_string_lossy(), folder.to_string_lossy()))
        }
        _ => None,
    };
    let stem = match with_parent {
        Some(name) if !is_taken(&name) => return name,
        Some(name) => name,
        None => base,
    };
    let mut n = 2;
    loop {
        let name = format!("{stem} {n}");
        if !is_taken(&name) {
            return name;
        }
        n += 1;
    }
}

/// `caller_session_id` -> the `turn_gen` it last spawned in. A static rather
/// than a `DaemonState` field: one guard does not earn a field threaded
/// through every construction site, and the daemon is a single process.
static SPAWNED_IN_GEN: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// True if the caller has NOT spawned during its current turn, recording this
/// attempt as it goes.
fn claim_turn_slot(state: &Arc<DaemonState>, caller_session_id: &str) -> bool {
    let gen = state.registry.current_turn_gen(caller_session_id);
    let mut guard = SPAWNED_IN_GEN.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.get(caller_session_id) == Some(&gen) {
        return false;
    }
    map.insert(caller_session_id.to_string(), gen);
    true
}

/// Frees the caller's slot when its model turn ends (the pump's result line).
/// `turn_gen` alone cannot mark that boundary: it only bumps on a delivered
/// user message, so turns woken by a background-task notification or a peer
/// message all share one gen, and a single spawn would lock the session out of
/// spawn_chat/respawn until Joe next typed (seen 2026-10-10: 40 minutes).
pub(crate) fn release_turn_slot(caller_session_id: &str) {
    let mut guard = SPAWNED_IN_GEN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(caller_session_id);
    }
}

/// Model and effort for a spawn, each half on its own: an explicit argument
/// wins; else `respawn` keeps the caller's own (it continues the same work);
/// else the target project's default, then Settings' default, then the
/// fallback. A plain sibling is a new job, so it does not inherit the
/// caller's model/effort, which may have been raised for that caller's task.
pub(crate) fn resolve_model_effort(
    state: &Arc<DaemonState>,
    project_cwd: &std::path::Path,
    model: Option<&str>,
    effort: Option<&str>,
    inherited: &crate::sessions::chat_config::ChatConfig,
    respawn: bool,
) -> (String, String) {
    let settings = state.settings.snapshot();
    let (default_model, default_effort) =
        crate::settings::identity::resolve_default_chat_choice(&settings.extra, &settings.projects, project_cwd);
    let pick = |explicit: Option<&str>, inherited: &str, default: Option<String>, fallback: &str| {
        explicit
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .or_else(|| Some(inherited.to_string()).filter(|v| respawn && !v.is_empty()))
            .or(default)
            .unwrap_or_else(|| fallback.to_string())
    };
    (
        pick(model, &inherited.model, default_model, FALLBACK_MODEL),
        pick(effort, &inherited.effort, default_effort, FALLBACK_EFFORT),
    )
}

/// Spawns a new Interactive session in the caller's own project - or another
/// project the user already has registered - and sends `prompt` as its first
/// turn. The prompt lands as a real, visible user message - the whole point
/// of this over the retired handoff button, which hid its context in a
/// scratch file. `respawn` makes it a takeover instead: `successor_of =
/// caller` plus a close flag the caller's pump acts on at turn end, both here
/// so the old spawn-then-close ordering trap is gone.
///
/// `sub` is the daemon's decision for a subchats-mode caller
/// (`subchats::spawn::plan`): it supplies the first message, the explicit model
/// and effort (so the project default is never consulted), and marks the new row
/// as the caller's sub. `None` is every ordinary chat, byte-for-byte what this
/// function always did.
pub(crate) async fn spawn_chat(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    cwd: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    name: Option<&str>,
    respawn: bool,
    mut sub: Option<crate::daemon::subchats::spawn::SubPlan>,
) -> Result<String, String> {
    crate::daemon::subchats::spawn::refuse_sub_caller(state, caller_session_id)?;
    let caller = state
        .registry
        .get(caller_session_id)
        .ok_or_else(|| format!("unknown caller session: {caller_session_id}"))?;

    let requested = std::path::PathBuf::from(cwd);
    let mut target_cwd = resolve_target_cwd(&caller.cwd, &requested, &state.settings.snapshot().projects)?;

    if respawn && !claim_turn_slot(state, caller_session_id) {
        return Err("this session already respawned during the current turn - one respawn per turn".to_string());
    }

    let inherited = crate::sessions::chat_config::get(caller_session_id).unwrap_or_default();
    let (model, effort) = match &sub {
        Some(plan) => resolve_model_effort(state, &target_cwd, Some(&plan.model), Some(&plan.effort), &inherited, respawn),
        None => resolve_model_effort(state, &target_cwd, model, effort, &inherited, respawn),
    };
    let account_id = Some(inherited.account_id.clone()).filter(|a| !a.is_empty());
    // A gate is spawned with a name and a prompt only; a name is what its card,
    // its list row and `after` find it by.
    let gate_name = sub.as_ref().filter(|p| p.brief.gate).map(|_| {
        let taken = crate::daemon::subchats::spawn::live_sub_names(state, caller_session_id);
        unique_gate_name(&caller.cwd, &target_cwd, &taken)
    });
    let name = name.or(gate_name.as_deref());

    // A writing sub that gets its own worktree (`subchats::worktree`) runs there,
    // not in the target project's own checkout. The tree is added now, so a failure reaches
    // the main chat as this call's error; the sub's setup runs at its launch.
    let sub_id = uuid::Uuid::new_v4().to_string();
    let tree = plan_worktree(state, &mut sub, &mut target_cwd, &sub_id).await?;
    // A spawn that fails after its worktree was made must not leave it behind.
    let discard_tree = |tree: &Option<crate::daemon::subchats::WorktreeInfo>| {
        if let Some(info) = tree {
            crate::daemon::subchats::worktree::discard(info);
        }
    };

    // A sub that must wait for another (`after`) gets its row and its recipe now
    // and its child later, from `subchats::held`.
    if let Some(plan) = sub.as_mut().filter(|p| p.hold.is_some()) {
        let spec = crate::daemon::subchats::held::LaunchSpec {
            cwd: target_cwd.clone(),
            model: model.clone(),
            effort: effort.clone(),
            account_id: account_id.clone(),
            first_message: plan.first_message.clone(),
        };
        let registered = crate::daemon::subchats::held::register(state, caller_session_id, name, &inherited, spec, plan).await;
        if registered.is_err() {
            discard_tree(&tree);
        }
        return registered;
    }
    if let (Some(plan), Some(_)) = (sub.as_mut(), tree.as_ref()) {
        let spec = crate::daemon::subchats::held::LaunchSpec {
            cwd: target_cwd.clone(),
            model: model.clone(),
            effort: effort.clone(),
            account_id: account_id.clone(),
            first_message: plan.first_message.clone(),
        };
        let registered =
            crate::daemon::subchats::worktree::register_and_start(state, caller_session_id, name, &inherited, spec, plan, sub_id).await;
        if registered.is_err() {
            discard_tree(&tree);
        }
        return registered;
    }

    // The writer slot (`subchats::writers`): a sub that edits files either takes a
    // free slot now or is registered here and held, to be started when it is its
    // turn. Every sub gets its session id up front so a held row and its later
    // child share one id.
    let decision = sub
        .as_ref()
        .map(|p| crate::daemon::subchats::writers::decide_spawn(state, &p.brief, &target_cwd));
    if let (Some(plan), Some(held)) = (sub.as_mut(), decision.as_ref().filter(|d| d.queued)) {
        let spec = crate::daemon::subchats::held::LaunchSpec {
            cwd: target_cwd.clone(),
            model: model.clone(),
            effort: effort.clone(),
            account_id: account_id.clone(),
            first_message: plan.first_message.clone(),
        };
        return crate::daemon::subchats::writers::register_queued(state, caller_session_id, name, &inherited, spec, plan, &held.sid)
            .await;
    }
    let params = StartSessionParams {
        cwd: target_cwd.clone(),
        model: model.clone(),
        effort: effort.clone(),
        resume_id: None,
        account_id,
        fork: false,
        new_session_id: decision.as_ref().map(|d| d.sid.clone()),
    };
    // A gate sub's prompt differs from an ordinary sub's, and the launch reads
    // the role from the stored brief rather than from this call's arguments. The
    // brief is therefore stored under the id chosen here, ahead of the spawn.
    let pre_stored = match (sub.as_ref().filter(|p| p.brief.gate), decision.as_ref()) {
        (Some(plan), Some(d)) => {
            crate::sessions::chat_config::set_subchat(&d.sid, Some(plan.brief.clone()));
            Some(d.sid.clone())
        }
        _ => None,
    };
    let spawned = lifecycle::spawn_session_as(state, params, sub.as_ref().map(|p| p.parent.as_str())).await;
    let session = match spawned {
        Ok(s) => s,
        Err(e) => {
            if let Some(id) = &pre_stored {
                crate::sessions::chat_config::set_subchat(id, None);
            }
            // The slot was taken for a child that never started.
            if let Some(d) = &decision {
                crate::daemon::subchats::writers::release(state, &d.sid);
            }
            return Err(e.to_string());
        }
    };
    let sid = session.session_id.clone();

    let first_message = sub.as_ref().map(|p| p.first_message.clone()).unwrap_or_else(|| prompt.to_string());
    // Lazy: nothing is written to the child until `adopt_spawned` awaits it, after
    // the row is registered and marked.
    let first_send = async { lifecycle::send_message(&session, &first_message, false).await.map_err(|e| e.to_string()) };
    let spawned = Spawned {
        sid: &sid,
        cwd: &target_cwd,
        model: &model,
        effort: &effort,
        account_id: &session.account_id,
    };
    adopt_spawned(state, &spawned, caller_session_id, name, respawn, &inherited, &mut sub, first_send).await?;
    Ok(sid)
}

/// A writing sub's own worktree: when the brief and the project call for one,
/// adds it, records it in the brief, tells the sub about it in its first message
/// and moves `target_cwd` into it. Anything else (no sub, a read-only sub, a gate,
/// a folder that cannot have one) leaves all three alone, so an ordinary chat's
/// spawn is exactly what it was.
async fn plan_worktree(
    state: &Arc<DaemonState>,
    sub: &mut Option<crate::daemon::subchats::spawn::SubPlan>,
    target_cwd: &mut std::path::PathBuf,
    sub_id: &str,
) -> Result<Option<crate::daemon::subchats::WorktreeInfo>, String> {
    let Some(plan) = sub.as_mut() else { return Ok(None) };
    let (st, brief, cwd, id) = (state.clone(), plan.brief.clone(), target_cwd.clone(), sub_id.to_string());
    let planned = tokio::task::spawn_blocking(move || crate::daemon::subchats::worktree::plan_spawn(&st, &brief, &cwd, &id))
        .await
        .map_err(|e| e.to_string())??;
    let Some(prepared) = planned else { return Ok(None) };
    plan.brief.worktree_at = Some(prepared.info.clone());
    plan.first_message.push_str(&crate::daemon::subchats::worktree::first_message_note(&prepared));
    *target_cwd = std::path::PathBuf::from(&prepared.info.cwd);
    Ok(Some(prepared.info))
}

/// The facts about a freshly spawned child that registering it needs.
struct Spawned<'a> {
    sid: &'a str,
    cwd: &'a std::path::Path,
    model: &'a str,
    effort: &'a str,
    account_id: &'a str,
}

/// Everything `spawn_chat` does once the child exists: register its row, link
/// it to the caller (successor or spawner, or the sub's parent), then send the
/// first message through `first_send`. Split out so the registration order and
/// the failed-send cleanup can be tested without a real `claude` child.
///
/// A hidden sub whose first send fails is ended: its row is hidden everywhere
/// and counts as running, so left alone it would hold one of the parent's five
/// slots forever while the parent gets an error and retries. An ordinary chat
/// stays as it was, since Joe can see and close it.
async fn adopt_spawned(
    state: &Arc<DaemonState>,
    spawned: &Spawned<'_>,
    caller_session_id: &str,
    name: Option<&str>,
    respawn: bool,
    inherited: &crate::sessions::chat_config::ChatConfig,
    sub: &mut Option<crate::daemon::subchats::spawn::SubPlan>,
    first_send: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let sid = spawned.sid;
    // Respawn only: character is keyed by session id and never survives a fresh
    // id, so the successor would otherwise reroll a different avatar
    // mid-handoff. A `spawn_chat` sibling is a separate chat and must NOT wear
    // the caller's face - passing `None` leaves it to the frontend's
    // `ensure_session_character`, whose `live_taken` set already holds the
    // caller's character, so the sibling picks a different one.
    let character_id = respawn
        .then(|| state.settings.snapshot().session_characters.get(caller_session_id).cloned())
        .flatten();
    let now = chrono::Utc::now().to_rfc3339();
    let auto_accept = crate::daemon::session_registration::spawned_auto_accept(
        inherited.auto_accept,
        state.settings.snapshot().spawned_chats_inherit_auto_accept(),
        respawn,
    );
    crate::daemon::session_registration::register_new_session(
        state,
        sid,
        spawned.cwd,
        spawned.model,
        spawned.effort,
        spawned.account_id,
        &now,
        auto_accept,
        character_id.as_deref(),
        false,
    );
    if let Some(n) = name {
        state.registry.set_name(sid, n.to_string());
    }
    if respawn {
        // Before the successor link is visible: following that link is what
        // re-attaches the pane, and attach reconciles the held set from this
        // store, so the queue has to be under the new id by then.
        if state.draft_store.move_held(caller_session_id, sid) > 0 {
            crate::daemon::methods::drafts::sync_held_count(state, caller_session_id);
            crate::daemon::methods::drafts::sync_held_count(state, sid);
        }
        state.registry.set_successor_of(sid, caller_session_id);
        // Durable twin of the registry link: the snapshot drops the caller the
        // moment it ends, and the successor's transcript chain must still
        // resolve after that.
        crate::sessions::chat_config::set_predecessor(sid, caller_session_id);
        // The successor stays a main chat and takes the subs, cards, queue and
        // decisions log. Before the close is armed, so a stop half way leaves the
        // predecessor open with nothing lost; the close then settles any stragglers.
        // Before the first send too, which is what tells the successor its mode is on.
        crate::daemon::subchats::closing::carry_to_successor(state, caller_session_id, sid).await;
        state.registry.set_close_requested(caller_session_id);
    } else {
        crate::sessions::chat_config::set_spawned_by(sid, caller_session_id);
    }
    if let Some(plan) = sub.as_mut() {
        crate::daemon::subchats::spawn::mark_as_sub(state, sid, plan);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    if let Err(e) = first_send.await {
        if sub.is_some() {
            end_orphaned_sub(state, sid).await;
        }
        return Err(e);
    }
    if respawn {
        // The handoff text the predecessor wrote is not a message Joe typed, and
        // the send above recorded it as one for `subchat send` to copy to a sub.
        crate::daemon::subchats::joe_message::forget(sid);
    }
    state.registry.set_awaiting(sid, None);
    state.registry.set_busy(sid, true);
    crate::sessions::chat_state::set_busy(sid, true);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(())
}

/// Closes a sub whose first message never reached its child: stops the child
/// (there may be none) and marks the row ended, so it stops counting as running.
async fn end_orphaned_sub(state: &Arc<DaemonState>, sid: &str) {
    // NotFound just means the child is already gone.
    let _ = lifecycle::end_session(&state.sessions, sid).await;
    let now = chrono::Utc::now().to_rfc3339();
    state.registry.mark_ended(sid, crate::types::EndReason::Manual, &now);
    // A writer that never started must not keep the project's slot.
    crate::daemon::subchats::writers::release(state, sid);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// Resolves `spawn_chat`'s `cwd` guard: accepts either the caller's own
/// directory or a project already in `Settings.projects`, never an arbitrary
/// path - this is what keeps an unconditional spawn tool from being a way to
/// start sessions anywhere on the machine, while still letting a chat hand
/// off to a DIFFERENT project the user has already opened before. Returns the
/// registry's own canonical path rather than the caller-supplied string, same
/// as the pre-existing own-cwd case always did.
pub(crate) fn resolve_target_cwd(
    caller_cwd: &std::path::Path,
    requested: &std::path::Path,
    known_projects: &[crate::types::ProjectConfig],
) -> Result<std::path::PathBuf, String> {
    if crate::util::same_dir(caller_cwd, requested) {
        return Ok(caller_cwd.to_path_buf());
    }
    // Rolled up through `project_key`, not a raw `same_dir`, so a worktree (or
    // plain subfolder) cwd of a registered project still resolves to that
    // project's root - the same precedent every other project-identity
    // lookup follows (`settings::identity::project_key`'s own doc: "every
    // call site must go through this"; see also `pr_review::is_known_cwd`
    // and `notifications::rules::resolve_with_lookup`). A raw path
    // comparison here would silently miss a worktree, undercutting this
    // guard's own stated purpose of letting a chat hand off to a project the
    // user already has registered.
    if let Some(root) = known_project_root(requested, known_projects) {
        return Ok(root);
    }
    Err(format!(
        "spawn_chat only spawns into the calling session's own working directory ({}) or a \
         project you've already opened - refusing {}",
        caller_cwd.display(),
        requested.display()
    ))
}

/// The registered project `requested` belongs to (itself, a worktree of it, or a
/// folder inside it), as the registry's own path. The one lookup behind both
/// `resolve_target_cwd` and the peer-facing `spawn_chat` guard, so the two cannot
/// disagree on what counts as a known project.
fn known_project_root(
    requested: &std::path::Path,
    known_projects: &[crate::types::ProjectConfig],
) -> Option<std::path::PathBuf> {
    let requested_key = project_key(requested);
    known_projects.iter().find(|p| project_key(&p.path) == requested_key).map(|p| p.path.clone())
}

/// Model and effort for a spawn forwarded from a paired machine. The caller
/// sends them only when it named them, so a missing one resolves here against
/// THIS machine's project default for `cwd`, the same as a local plain spawn.
fn peer_model_effort(state: &Arc<DaemonState>, cwd: &str, params: &Value) -> (String, String) {
    let explicit = |key: &str| params.get(key).and_then(Value::as_str);
    resolve_model_effort(
        state,
        std::path::Path::new(cwd),
        explicit("model"),
        explicit("effort"),
        &crate::sessions::chat_config::ChatConfig::default(),
        false,
    )
}

/// Registers the peer-facing half of `spawn_chat` on the shared RPC router
///: reached only via `remote_transport_table::TRANSPORT_TABLE`'s `M`-only entry,
/// so only a paired peer machine's forwarded call ever lands here. Always
/// spawns locally and unconditionally - the forwarded params never carry a
/// `machine` field (`spawn_chat_or_forward` strips it before calling out), so
/// there is nothing here that could re-forward to a third machine and loop.
pub fn register_spawn_chat_rpc(router: &mut Router, state: Arc<DaemonState>) {
    router.register("spawn_chat", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p = params.unwrap_or(Value::Null);
            let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default();
            let prompt = p.get("prompt").and_then(Value::as_str).unwrap_or_default();
            // A paired machine may start a chat only in a project registered HERE,
            // like the local tool's own cwd guard: `claude` runs with this cwd, so
            // an unchecked one would let a compromised peer pick any readable folder.
            // Deliberately narrower than `start_session`'s `is_known_cwd` (core.rs):
            // that one also accepts the cwd of any session already in the registry,
            // which can be a folder that was never a project. This guard answers only
            // "is it a registered project", so a subfolder of a registered non-git
            // project (its `project_root` is the folder itself) is refused and the
            // error tells the caller to register it here.
            if known_project_root(std::path::Path::new(cwd), &state.settings.snapshot().projects).is_none() {
                return Err(RpcError::invalid_params(format!(
                    "{cwd} is not a registered project on this machine; add it as a project here before starting a chat in it from another machine"
                )));
            }
            let (model, effort) = peer_model_effort(&state, cwd, &p);
            let name = p.get("name").and_then(Value::as_str);
            match forward::spawn_chat_for_peer(&state, cwd, prompt, &model, &effort, name, None).await {
                Ok(session_id) => Ok(json!({"ok": true, "session_id": session_id})),
                Err(e) => Err(RpcError::invalid_params(e)),
            }
        }
    });
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

    /// An unregistered caller is rejected before `spawn_session` is reached, so
    /// this test never spawns a real `claude` child.
    #[tokio::test]
    async fn spawn_chat_rejects_an_unknown_caller() {
        let state = test_state();
        let r = spawn_chat(&state, "ghost", ".", "carry on", None, None, None, false, None).await;
        let err = r.expect_err("unknown caller must be rejected");
        assert!(err.contains("unknown caller session"), "{err}");
    }

    /// The cwd guard is what keeps an unconditional spawn tool from being a
    /// way to start sessions in arbitrary directories on the machine. Checked
    /// before the turn slot is claimed, so a rejected call does not burn it.
    #[tokio::test]
    async fn spawn_chat_rejects_a_cwd_outside_the_callers_own() {
        let state = test_state();
        state.registry.upsert_interactive(
            "sess-1",
            std::path::Path::new("."),
            "proj-x",
            "2026-08-18T00:00:00Z",
        );
        let elsewhere = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let r = spawn_chat(&state, "sess-1", elsewhere, "carry on", None, None, None, false, None).await;
        let err = r.expect_err("foreign cwd must be rejected");
        assert!(err.contains("own working directory"), "{err}");
    }

    /// A caller with Use subchats on, and a plan for one sub of it.
    fn sub_plan_for(state: &Arc<DaemonState>, parent: &str) -> crate::daemon::subchats::spawn::SubPlan {
        state.registry.upsert_interactive(parent, std::path::Path::new("."), "proj-x", "2026-11-05T00:00:00Z");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = crate::daemon::subchats::SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            ..Default::default()
        };
        crate::daemon::subchats::spawn::plan(
            state, parent, &cfg, ".", None, None, None, Some("job"), &args, &[],
        )
        .unwrap()
        .expect("a sub plan")
    }

    /// A `worktree_each` project at a real scratch repo, a main chat in it with
    /// Use subchats on, and a plan for one sub of it that `writes` or not.
    fn tree_fixture(
        parent: &str,
        writes: bool,
    ) -> (tempfile::TempDir, std::path::PathBuf, Arc<DaemonState>, crate::daemon::subchats::spawn::SubPlan) {
        let (dir, root) = crate::daemon::subchats::git::test_repo::init();
        let mut settings = Settings::default();
        let raw = json!({
            "id": "p1", "path": root, "name": "p", "created_at": "2026-11-05T00:00:00Z",
            "subchat_writers": "worktree_each",
        });
        settings.projects.push(serde_json::from_value(raw).unwrap());
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        state.registry.upsert_interactive(parent, &root, "proj-x", "2026-11-05T00:00:00Z");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = crate::daemon::subchats::SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(writes),
            files: writes.then(|| vec!["a.txt".to_string()]),
            ..Default::default()
        };
        let plan = crate::daemon::subchats::spawn::plan(&state, parent, &cfg, &root.to_string_lossy(), None, None, None, Some("job"), &args, &[])
            .unwrap()
            .expect("a sub plan");
        (dir, root, state, plan)
    }

    #[tokio::test]
    async fn a_writing_sub_in_a_worktree_each_project_moves_into_its_worktree() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (_d, root, state, plan) = tree_fixture("tree-main", true);
        let mut sub = Some(plan);
        let mut cwd = root.clone();
        let tree = plan_worktree(&state, &mut sub, &mut cwd, "0123456789ab").await.unwrap().expect("a worktree");
        assert_eq!(cwd, std::path::PathBuf::from(&tree.cwd), "the sub runs in its tree");
        assert_ne!(crate::util::same_dir(&cwd, &root), true);
        let plan = sub.unwrap();
        assert_eq!(plan.brief.worktree_at.as_ref(), Some(&tree), "the path is recorded in the brief that gets stored");
        assert!(plan.first_message.contains("own git worktree") && plan.first_message.contains(&tree.branch), "{}", plan.first_message);
    }

    #[tokio::test]
    async fn a_read_only_sub_and_a_spawn_with_no_sub_plan_are_untouched() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (_d, root, state, plan) = tree_fixture("ro-main", false);
        let mut cwd = root.clone();
        let mut ro = Some(plan);
        assert!(plan_worktree(&state, &mut ro, &mut cwd, "ro0123456789").await.unwrap().is_none());
        assert_eq!(cwd, root, "a read-only sub stays on the main checkout");
        assert!(ro.unwrap().brief.worktree_at.is_none());
        // A mode-off chat and a Jarvis worker reach spawn_chat with no sub plan at all.
        assert!(plan_worktree(&state, &mut None, &mut cwd, "plain0123456").await.unwrap().is_none());
        assert_eq!(cwd, root);
        assert!(!root.join(".claude").exists(), "no worktree folder was made");
    }

    async fn adopt(
        state: &Arc<DaemonState>,
        parent: &str,
        sid: &str,
        sub: &mut Option<crate::daemon::subchats::spawn::SubPlan>,
        send: Result<(), String>,
    ) -> Result<(), String> {
        let spawned = Spawned {
            sid,
            cwd: std::path::Path::new("."),
            model: "sonnet",
            effort: "high",
            account_id: "",
        };
        let inherited = crate::sessions::chat_config::ChatConfig::default();
        adopt_spawned(state, &spawned, parent, None, false, &inherited, sub, async { send }).await
    }

    #[tokio::test]
    async fn a_spawned_sub_is_marked_as_one_and_counts_as_running() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = test_state();
        let plan = sub_plan_for(&state, "main-ok");
        let mut sub = Some(plan);
        adopt(&state, "main-ok", "sub-ok", &mut sub, Ok(())).await.unwrap();
        let inst = state.registry.get("sub-ok").unwrap();
        assert_eq!(inst.subchat_of.as_deref(), Some("main-ok"));
        assert!(inst.end_reason.is_none());
        assert!(crate::sessions::chat_config::sub_session_ids().contains("sub-ok"));
        assert_eq!(crate::daemon::subchats::spawn::running_subs(&state.registry, "main-ok").len(), 1);
    }

    #[tokio::test]
    async fn a_failed_first_send_ends_a_hidden_sub_so_it_stops_holding_a_slot() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = test_state();
        let plan = sub_plan_for(&state, "main-bad");
        let mut sub = Some(plan);
        let err = adopt(&state, "main-bad", "sub-bad", &mut sub, Err("pipe closed".into()))
            .await
            .expect_err("the send failed");
        assert_eq!(err, "pipe closed");
        let inst = state.registry.get("sub-bad").unwrap();
        assert!(inst.end_reason.is_some() && inst.ended_at.is_some(), "the orphan is ended");
        assert!(
            crate::daemon::subchats::spawn::running_subs(&state.registry, "main-bad").is_empty(),
            "an ended sub no longer counts toward the parent's five"
        );
    }

    #[tokio::test]
    async fn a_failed_first_send_leaves_an_ordinary_chat_open() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = test_state();
        state.registry.upsert_interactive("plain-caller", std::path::Path::new("."), "proj-x", "2026-11-05T00:00:00Z");
        let mut sub = None;
        adopt(&state, "plain-caller", "plain-new", &mut sub, Err("pipe closed".into())).await.expect_err("failed");
        let inst = state.registry.get("plain-new").unwrap();
        assert!(inst.end_reason.is_none(), "a visible chat is Joe's to close, as before");
    }

    fn state_with_defaults(project_model: Option<&str>, global_model: Option<&str>) -> Arc<DaemonState> {
        let mut settings = Settings::default();
        let mut p = project("C:\\proj-a");
        p.default_model = project_model.map(str::to_string);
        settings.projects = vec![p];
        if let Some(m) = global_model {
            settings.extra.insert("defaultModel".into(), json!(m));
        }
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    fn caller_config() -> crate::sessions::chat_config::ChatConfig {
        crate::sessions::chat_config::ChatConfig {
            model: "opus".into(),
            effort: "max".into(),
            ..Default::default()
        }
    }

    /// A plain sibling must not wear the caller's raised model/effort: it
    /// opens on the project default (per half), then Settings', then fallback.
    #[test]
    fn a_plain_spawn_uses_the_project_default_not_the_callers_model() {
        let state = state_with_defaults(Some("haiku"), Some("fable"));
        let cwd = std::path::Path::new("C:\\proj-a");
        let (m, e) = resolve_model_effort(&state, cwd, None, None, &caller_config(), false);
        assert_eq!((m.as_str(), e.as_str()), ("haiku", FALLBACK_EFFORT));

        let state = state_with_defaults(None, Some("fable"));
        let (m, _) = resolve_model_effort(&state, cwd, None, None, &caller_config(), false);
        assert_eq!(m, "fable");

        let state = state_with_defaults(None, None);
        let (m, e) = resolve_model_effort(&state, cwd, None, None, &caller_config(), false);
        assert_eq!((m.as_str(), e.as_str()), (FALLBACK_MODEL, FALLBACK_EFFORT));
    }

    #[test]
    fn respawn_keeps_the_callers_model_and_effort() {
        let state = state_with_defaults(Some("haiku"), None);
        let cwd = std::path::Path::new("C:\\proj-a");
        let (m, e) = resolve_model_effort(&state, cwd, None, None, &caller_config(), true);
        assert_eq!((m.as_str(), e.as_str()), ("opus", "max"));
    }

    #[test]
    fn an_explicit_model_wins_over_every_default() {
        let state = state_with_defaults(Some("haiku"), None);
        let cwd = std::path::Path::new("C:\\proj-a");
        let (m, _) = resolve_model_effort(&state, cwd, Some("sonnet"), Some("low"), &caller_config(), false);
        assert_eq!(m, "sonnet");
    }

    /// A forwarded spawn that names no model/effort opens on the TARGET
    /// machine's project default, not on the fallback and not on whatever the
    /// calling machine would have picked.
    #[test]
    fn a_forwarded_spawn_without_model_or_effort_takes_this_machines_project_default() {
        let state = state_with_defaults(Some("haiku"), None);
        let (m, e) = peer_model_effort(&state, "C:\\proj-a", &json!({"cwd": "C:\\proj-a", "prompt": "p"}));
        assert_eq!((m.as_str(), e.as_str()), ("haiku", FALLBACK_EFFORT));
    }

    #[test]
    fn a_forwarded_spawn_with_explicit_model_and_effort_keeps_them() {
        let state = state_with_defaults(Some("haiku"), None);
        let (m, e) = peer_model_effort(&state, "C:\\proj-a", &json!({"model": "opus", "effort": "high"}));
        assert_eq!((m.as_str(), e.as_str()), ("opus", "high"));
    }

    fn names(taken: &[&str]) -> Vec<String> {
        taken.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_gate_name_nobody_holds_is_the_default() {
        let (hub, admin) = (std::path::Path::new("/work/hub"), std::path::Path::new("/work/zng-admin"));
        assert_eq!(unique_gate_name(hub, hub, &[]), "Gate");
        assert_eq!(unique_gate_name(hub, admin, &names(&["gate: other-repo", "header"])), "Gate: zng-admin");
    }

    #[test]
    fn two_gates_in_repos_sharing_a_folder_name_are_told_apart_by_the_parent_folder() {
        let hub = std::path::Path::new("/work/hub");
        let (a, b) = (std::path::Path::new("/clients/a/admin"), std::path::Path::new("/clients/b/admin"));
        let first = unique_gate_name(hub, a, &[]);
        assert_eq!(first, "Gate: admin");
        let second = unique_gate_name(hub, b, &names(&[&first.to_lowercase()]));
        assert_eq!(second, "Gate: b/admin");
    }

    #[test]
    fn a_gate_name_still_taken_after_the_parent_folder_gets_a_counter() {
        let hub = std::path::Path::new("/work/hub");
        let b = std::path::Path::new("/clients/b/admin");
        assert_eq!(unique_gate_name(hub, b, &names(&["gate: admin", "gate: b/admin"])), "Gate: b/admin 2");
        assert_eq!(unique_gate_name(hub, b, &names(&["gate: admin", "gate: b/admin", "gate: b/admin 2"])), "Gate: b/admin 3");
    }

    /// A finished gate still answers to its name, so the next gate in the same
    /// project cannot reuse plain `Gate` either.
    #[test]
    fn a_taken_plain_gate_name_in_the_callers_own_project_gets_a_counter() {
        let hub = std::path::Path::new("/work/hub");
        assert_eq!(unique_gate_name(hub, hub, &names(&["gate"])), "Gate 2");
    }

    fn project(path: &str) -> crate::types::ProjectConfig {
        crate::types::ProjectConfig {
            id: "proj-known".into(),
            path: std::path::PathBuf::from(path),
            name: "Known Project".into(),
            avatar: Default::default(),
            created_at: "2026-08-18T00:00:00Z".into(),
            last_active_at: None,
            whitelist: Default::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            mcp_servers: Vec::new(),
            tracker: None,
            keep_running_in_gaming_mode: false,
            default_model: None,
            default_effort: None,
            subchat_check: Default::default(),
            subchat_writers: Default::default(),
        }
    }

    #[test]
    fn resolve_target_cwd_accepts_the_callers_own_directory() {
        let caller_cwd = std::env::current_dir().unwrap();
        let resolved = resolve_target_cwd(&caller_cwd, &caller_cwd, &[]).unwrap();
        assert_eq!(resolved, caller_cwd);
    }

    /// The whole point of the loosened guard: a `cwd` that is NOT the
    /// caller's own directory is still accepted when it matches a project the
    /// user already has registered - this is what lets a chat hand off to a
    /// different project instead of only ever spawning beside itself.
    #[test]
    fn resolve_target_cwd_accepts_a_known_project_outside_the_callers_own() {
        let caller_cwd = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-a" } else { "/proj-a" });
        let other = if cfg!(windows) { "C:\\proj-b" } else { "/proj-b" };
        let resolved =
            resolve_target_cwd(&caller_cwd, std::path::Path::new(other), &[project(other)]).unwrap();
        assert_eq!(resolved, std::path::PathBuf::from(other));
    }

    #[test]
    fn resolve_target_cwd_rejects_a_cwd_matching_no_known_project() {
        let caller_cwd = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-a" } else { "/proj-a" });
        let elsewhere = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let known = if cfg!(windows) { "C:\\proj-b" } else { "/proj-b" };
        let err = resolve_target_cwd(&caller_cwd, std::path::Path::new(elsewhere), &[project(known)])
            .expect_err("neither own cwd nor a known project must be rejected");
        assert!(err.contains("own working directory"), "{err}");
    }

    /// `<repo>/.git/worktrees/<name>` layout `git worktree add` leaves behind:
    /// a `.git` FILE in the worktree pointing back at the main repo's admin
    /// dir. Mirrors `settings::identity::tests::make_worktree` - duplicated
    /// here rather than reused since that helper is private to its own
    /// `#[cfg(test)] mod tests`.
    fn make_worktree(repo: &std::path::Path, name: &str) -> std::path::PathBuf {
        let worktree = repo.join(".worktrees").join(name);
        std::fs::create_dir_all(&worktree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join(name);
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        worktree
    }

    /// Todo 964: the known-project branch must roll a worktree cwd up to its
    /// main repo's registered root the same way every other project-identity
    /// lookup does (`project_key`, per `settings::identity`'s own "every call
    /// site must go through this"), not compare raw paths. Fails against the
    /// pre-fix `same_dir`-based branch: `worktree` is never byte-equal to
    /// `repo`, so the old code falls through to the `Err` branch and this
    /// `.expect(...)` panics on an `Err("...own working directory...")`
    /// instead of resolving.
    #[test]
    fn resolve_target_cwd_rolls_a_worktree_up_to_its_registered_main_repo() {
        let dir = crate::settings::identity::test_support::non_ephemeral_tempdir();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let worktree = make_worktree(&repo, "feature-x");

        let caller_cwd = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-a" } else { "/proj-a" });
        let resolved = resolve_target_cwd(&caller_cwd, &worktree, &[project(repo.to_str().unwrap())])
            .expect("a worktree of a registered project must resolve to that project's root");
        assert_eq!(resolved, repo);
    }

    #[test]
    fn turn_slot_is_claimable_once_per_generation() {
        let state = test_state();
        state.registry.upsert_interactive(
            "sess-gen",
            std::path::Path::new("."),
            "proj-x",
            "2026-08-18T00:00:00Z",
        );
        assert!(claim_turn_slot(&state, "sess-gen"), "first claim in a turn succeeds");
        assert!(!claim_turn_slot(&state, "sess-gen"), "second claim in the same turn is refused");
    }

    /// A notification-woken turn keeps the same `turn_gen` as the turn before
    /// it, so only the turn-end release lets it spawn again.
    #[test]
    fn turn_slot_is_claimable_again_after_the_turn_ends_without_a_gen_bump() {
        let state = test_state();
        state.registry.upsert_interactive(
            "sess-wake",
            std::path::Path::new("."),
            "proj-x",
            "2026-10-10T00:00:00Z",
        );
        assert!(claim_turn_slot(&state, "sess-wake"));
        release_turn_slot("sess-wake");
        assert!(claim_turn_slot(&state, "sess-wake"), "next turn at the same gen may spawn again");
    }

    #[test]
    fn same_dir_tolerates_a_trailing_separator() {
        let here = std::env::current_dir().unwrap();
        let mut trailing = here.clone().into_os_string();
        trailing.push(std::path::MAIN_SEPARATOR.to_string());
        assert!(crate::util::same_dir(&here, std::path::Path::new(&trailing)));
    }

    fn peer_spawn_request(cwd: &str) -> crate::daemon::rpc::Request {
        crate::daemon::rpc::Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "spawn_chat".into(),
            params: Some(json!({"cwd": cwd, "prompt": "hello"})),
        }
    }

    fn peer_ctx() -> crate::daemon::rpc::ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        crate::daemon::rpc::ConnectionContext::new(tx)
    }

    /// A forwarded spawn into a folder that is not a registered project is
    /// refused before any session is started.
    #[tokio::test]
    async fn peer_spawn_into_an_unregistered_cwd_is_refused() {
        let dir = crate::settings::identity::test_support::non_ephemeral_tempdir();
        let unregistered = dir.path().join("elsewhere");
        std::fs::create_dir_all(&unregistered).unwrap();
        let state = test_state();
        let mut router = Router::new();
        register_spawn_chat_rpc(&mut router, state.clone());

        let resp = router.dispatch(peer_spawn_request(&unregistered.to_string_lossy()), peer_ctx()).await;

        let err = resp.error.expect("an unregistered cwd must be refused");
        assert!(err.message.contains("not a registered project"), "{}", err.message);
        assert!(state.registry.list().is_empty(), "nothing may be registered for a refused spawn");
    }

    /// A registered project passes the guard: the call then fails later, on the
    /// folder not existing (so no `claude` child is spawned by this test), which
    /// is a different error from the refusal.
    #[tokio::test]
    async fn peer_spawn_into_a_registered_project_passes_the_guard() {
        let dir = crate::settings::identity::test_support::non_ephemeral_tempdir();
        let missing = dir.path().join("registered-but-gone");
        let mut settings = Settings::default();
        settings.projects.push(project(missing.to_str().unwrap()));
        let state = DaemonState::new(crate::daemon::session::new_session_map(), SettingsCache::new(settings));
        let mut router = Router::new();
        register_spawn_chat_rpc(&mut router, state);

        let resp = router.dispatch(peer_spawn_request(&missing.to_string_lossy()), peer_ctx()).await;

        let err = resp.error.expect("the missing folder still fails the spawn");
        assert!(!err.message.contains("not a registered project"), "{}", err.message);
    }
}
