//! Rebuilding the hold of a sub that was registered and never started
//! (`held.json` lost its entry): detection, the tick's rebuild, a message or Joe's
//! nudge asking for one. The hold store itself stays in [`super::held`].

use super::held::{all, hold, is_held, launching, orphaned, production_launch, release_ready, set_parked, subs_of, Held, LaunchSpec};
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};

/// Subs whose lost hold was rebuilt this run. Once each: a sub that loses its hold
/// a second time is left to [`super::queue_watch`], which tells the main chat,
/// instead of being rebuilt and started every minute.
static RECOVERED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// A sub that was registered and never started, with no hold left to start it:
/// a live sub row with no child, no transcript and no held entry. Its hold was
/// lost (another daemon instance on the same data folder forgot it before
/// `held.json` was per instance), and without this nothing would ever start it:
/// it reads as queued for good, and `--resume` on it fails because it never had a
/// conversation. An unresolved transcript path alone is weak proof of "never ran"
/// (a moved cwd or a mirrored row hides a real one), so a recorded turn in
/// `chat_state` also rules a sub out: relaunching its brief would redo finished work.
pub(crate) fn is_lost_hold(state: &DaemonState, inst: &Instance, held: &[Held], has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> bool {
    let id = inst.session_id.as_str();
    inst.subchat_of.is_some()
        && inst.ended_at.is_none()
        && inst.end_reason.is_none()
        && !inst.subchat_finished
        && !inst.busy
        && !state.sessions.contains_key(id)
        && !launching(id)
        && !held.iter().any(|h| h.sub_id == id)
        && !has_transcript(id)
        && crate::sessions::chat_state::get(id).is_none()
}

/// How old a lost hold may be and still be rebuilt by the tick on its own. An
/// older one was most likely worked around by then (2026-11-10: the main chat
/// re-ran four lost lanes as plain chats), and starting it blind would run the job
/// twice. It is left to [`super::queue_watch`], which tells the main chat, and the
/// main chat drops it (`subchat drop`) or Joe nudges it from its card.
pub const RECOVER_WITHIN: chrono::Duration = chrono::Duration::hours(2);

/// Whether `inst` was registered recently enough for the tick to rebuild its lost
/// hold. An unreadable start time is not.
pub(crate) fn recent_enough(inst: &Instance, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(&inst.started_at)
        .is_ok_and(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)) <= RECOVER_WITHIN)
}

/// Whether `inst` is a sub that never started: held, or a lost hold.
pub(crate) fn never_started(state: &DaemonState, inst: &Instance, has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> bool {
    let held = all();
    held.iter().any(|h| h.sub_id == inst.session_id) || is_lost_hold(state, inst, &held, has_transcript)
}

/// Rebuilds the hold of every lost one ([`is_lost_hold`]) that `admit` lets in from what survives: its
/// brief (stored in chat-config, which also holds `after` by name) and its row
/// (folder, model, effort, account). The first message is composed from the brief
/// again; an extra `prompt` the main chat passed at spawn is not kept anywhere and
/// is not in it. A worktree sub is left out: its tree has its own start path.
/// Returns the subs rebuilt and whether any of them waits for the writer slot
/// rather than for a named sub.
pub(crate) fn recover_lost_with(
    state: &DaemonState,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
    admit: &(dyn Fn(&Instance) -> bool + Sync),
) -> (Vec<String>, bool) {
    let held = all();
    let mut rebuilt = Vec::new();
    let mut for_slot = false;
    for inst in state.registry.list() {
        if !is_lost_hold(state, &inst, &held, has_transcript) || !admit(&inst) || orphaned(state, &inst.session_id) {
            continue;
        }
        let id = inst.session_id.clone();
        let Some(brief) = crate::sessions::chat_config::get(&id).and_then(|c| c.subchat) else { continue };
        if brief.worktree_at.is_some() {
            continue;
        }
        if RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(&id)) {
            continue;
        }
        let Some(parent) = inst.subchat_of.as_deref() else { continue };
        let queries = brief.after.as_deref().map(super::brief::after_names).unwrap_or_default();
        let (after, after_name) = if queries.is_empty() {
            (None, String::new())
        } else {
            // `after` named subs that already existed when this one was spawned, so a
            // sub started later with the same name is never the target.
            let subs: Vec<Instance> =
                subs_of(state, parent).into_iter().filter(|s| s.session_id != id && s.started_at <= inst.started_at).collect();
            let mut targets: Vec<(String, String)> = Vec::new();
            for query in &queries {
                match super::tool::resolve(&subs, query) {
                    Ok(target) if !targets.iter().any(|(t, _)| *t == target.session_id) => {
                        targets.push((target.session_id.clone(), super::tool::label(target)));
                    }
                    Ok(_) => {}
                    // A sub it waited for cannot be named again: the watchdog
                    // tells the main chat rather than starting it out of order.
                    Err(e) => {
                        log::warn!("subchats: lost hold of {id} not rebuilt, its after {query:?} does not resolve: {e}");
                        targets.clear();
                        break;
                    }
                }
            }
            if targets.is_empty() {
                continue;
            }
            (
                Some(targets.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>().join("\n")),
                targets.iter().map(|(_, n)| n.replace('\n', " ")).collect::<Vec<_>>().join("\n"),
            )
        };
        let reason = if after.is_some() { format!("waiting for {}", after_name.lines().collect::<Vec<_>>().join(", ")) } else { super::writers::QUEUED_TEXT.to_string() };
        for_slot |= after.is_none();
        let entry = Held {
            sub_id: id.clone(),
            reason,
            after,
            after_name,
            cleared: Vec::new(),
            launch: LaunchSpec {
                cwd: inst.cwd.clone(),
                model: inst.model.clone(),
                effort: inst.effort.clone(),
                account_id: inst.account_id.clone(),
                first_message: super::brief::compose_first_message(&brief, None),
            },
        };
        if let Err(e) = hold(state, entry) {
            log::warn!("subchats: could not rebuild the lost hold of {id}: {e}");
            continue;
        }
        RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(id.clone());
        log::warn!("subchats: rebuilt the lost hold of sub {id} from its brief");
        rebuilt.push(id);
    }
    (rebuilt, for_slot)
}

/// [`recover_lost_with`] against the real transcripts, then the writer queue picks
/// up any rebuilt sub that waits for the slot.
pub(crate) fn recover_lost(state: &Arc<DaemonState>) -> Vec<String> {
    let now = chrono::Utc::now();
    let (rebuilt, for_slot) = recover_lost_with(
        state,
        &|id| crate::context_status::resolve_transcript(&state.registry, id).is_some(),
        &|inst| recent_enough(inst, now),
    );
    if !rebuilt.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    if for_slot {
        super::writers::requeue_held(state);
    }
    rebuilt
}

/// Rebuilds the lost hold of `sub_id` alone, even if it was rebuilt once already
/// (a message to the sub or Joe's nudge asked for it), and lets the writer queue
/// pick it up when it waits for the slot. Returns whether the sub is held
/// afterwards; false means nothing could rebuild it.
pub(crate) fn rebuild_lost_hold(state: &Arc<DaemonState>, sub_id: &str, has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> bool {
    if let Some(set) = RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        set.remove(sub_id);
    }
    let (rebuilt, for_slot) = recover_lost_with(state, has_transcript, &|inst| inst.session_id == sub_id);
    if !rebuilt.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    if for_slot {
        super::writers::requeue_held(state);
    }
    is_held(sub_id)
}

/// A worktree sub, an `after` that no longer names anything, a missing brief:
/// nothing here can start the sub, so the main chat is told rather than left
/// waiting on a start that will not come. Its own problem kind, not
/// `CouldNotStart`: the sub is not held, so `subchat retry` refuses it and only
/// `drop` can act, which the wake has to say.
pub(crate) async fn report_not_rebuilt(state: &Arc<DaemonState>, sub_id: &str) {
    super::plumbing::report(state, sub_id, super::plumbing::Problem::NotRebuilt, "its start instructions could not be rebuilt".to_string(), Vec::new());
}

/// Joe's "nudge" on a sub that never started. It has no conversation, so
/// `--resume` would fail with "No conversation found" and raise the same card
/// again. Instead its hold is rebuilt (even if it was rebuilt once already: Joe
/// asked) and the held pass starts it if what it waits for is done. When nothing
/// can rebuild the hold, the main chat is told it could not start. Returns false for a sub
/// that did start, which a real nudge is for.
pub(crate) async fn start_never_started_with<F, Fut>(
    state: &Arc<DaemonState>,
    sub_id: &str,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
    launch: F,
) -> bool
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let Some(inst) = state.registry.get(sub_id) else { return false };
    let held_now = all();
    let was_held = held_now.iter().any(|h| h.sub_id == sub_id);
    if !was_held && !is_lost_hold(state, &inst, &held_now, has_transcript) {
        return false;
    }
    if !was_held && !rebuild_lost_hold(state, sub_id, has_transcript) {
        report_not_rebuilt(state, sub_id).await;
        return true;
    }
    // A sub held with no `after` waits for the writer slot, and the held pass below
    // skips it: only the writer queue starts it, in order. Handing it to that queue
    // is the nudge, and a slot still held by another sub is said, not swallowed.
    if held_now.iter().any(|h| h.sub_id == sub_id && h.after.is_none()) {
        match super::writers::waiting_behind(state, sub_id) {
            Some(holder) => log::info!("subchats: nudge on {sub_id} did not start it: it is queued for the writer slot behind {holder:?} and starts by itself when the slot is free"),
            None => {
                log::info!("subchats: nudge on {sub_id}: its writer slot is free, asking the writer queue to start it");
                set_parked(sub_id, false);
                super::writers::requeue_held(state);
            }
        }
        return true;
    }
    set_parked(sub_id, false);
    release_ready(state, launch).await;
    true
}

/// [`start_never_started_with`] against the real transcripts and launcher.
pub async fn start_never_started(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    start_never_started_with(state, sub_id, &has, production_launch).await
}
