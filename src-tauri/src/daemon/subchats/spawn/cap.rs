//! The cap of started subs and the slot a planned spawn holds until its registry
//! row exists. `spawn/mod.rs` decides whether a spawn may happen; this is the
//! count it is held to.

use super::super::brief::SubchatBrief;
use super::label;
use crate::daemon::state::DaemonState;
use crate::sessions::registry::Registry;
use crate::types::Instance;
use std::collections::HashMap;
use std::sync::Mutex;

/// Started subs one main chat may have at once. The cap bounds concurrent
/// `claude` processes (each ~280 MB; 2026-11-10 measure: 13 running used 3.6 GB
/// of 31.7 GB), so the real limits are subscription rate limits and how many subs
/// Joe can follow in one window; Joe set 10 on 2026-11-10.
pub const MAX_RUNNING: usize = 10;

/// Everything the spawn needs once the rules have passed. Holding it keeps the
/// parent's cap slot reserved, so parallel `spawn_chat` calls in one turn
/// cannot all slip past the count before any row exists.
pub struct SubPlan {
    pub parent: String,
    pub brief: SubchatBrief,
    pub first_message: String,
    pub model: String,
    pub effort: String,
    /// Set when the sub must wait for another sub (`after`): `spawn_chat`
    /// registers its row and holds it instead of launching a child.
    pub hold: Option<HoldPlan>,
    pub(super) reservation: Option<Reservation>,
}

/// The earlier sub a held sub waits for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldPlan {
    pub target_id: String,
    pub target_name: String,
}

impl SubPlan {
    /// Releases the reserved cap slot. Called once the sub's registry row
    /// exists, because from then on the row is what counts.
    pub fn release_slot(&mut self) {
        self.reservation = None;
    }
}

/// Marks the freshly spawned `sid` as the planned parent's sub: the registry row
/// every client reads, and the stored brief later steps read. The row is set
/// before the cap slot is released, so the sub is never uncounted in between.
pub fn mark_as_sub(state: &DaemonState, sid: &str, plan: &mut SubPlan) {
    state.registry.set_subchat_of(sid, Some(plan.parent.clone()));
    // Before the sub's first message is sent, so every commit it makes lands
    // after this head: the base its facts count from (`facts.rs`).
    if let Some(inst) = state.registry.get(sid) {
        plan.brief.git_head_at_spawn = super::super::git::head(&inst.cwd);
        // A gate's push is read as the upstream moving past this.
        if plan.brief.gate {
            plan.brief.upstream_at_spawn = super::super::git::upstream(&inst.cwd);
        }
    }
    crate::sessions::chat_config::set_subchat(sid, Some(plan.brief.clone()));
    plan.release_slot();
}

/// (registry, parent) -> spawns that passed the cap check but have no registry
/// row yet. Keyed by the registry too: the count only means something next to
/// the rows of the registry it was taken against, and a daemon has exactly one,
/// so in production this is the parent alone. It also keeps two registries in
/// one process (parallel tests) from counting each other's reservations.
static PENDING: Mutex<Option<HashMap<(usize, String), usize>>> = Mutex::new(None);

pub(super) struct Reservation {
    key: (usize, String),
}

fn pending_key(registry: &Registry, parent: &str) -> (usize, String) {
    (registry as *const Registry as usize, parent.to_string())
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_mut() {
            if let Some(n) = map.get_mut(&self.key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    map.remove(&self.key);
                }
            }
        }
    }
}

/// Unfinished subs of `parent`, queued and never-started rows included. The cap
/// counts [`started_subs`], not this.
pub fn running_subs(registry: &Registry, parent: &str) -> Vec<Instance> {
    registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent))
        .filter(|i| i.ended_at.is_none() && i.end_reason.is_none() && !i.subchat_finished)
        .collect()
}

/// Subs of `parent` that hold a cap slot: unfinished and actually started. A
/// queued sub (held behind another sub or the writer slot) and a ghost (a live row
/// with no child, no transcript and no hold, e.g. its hold was wiped) have no
/// process, so they do not count; otherwise five dead rows refuse every new spawn
/// forever (2026-11-10).
pub fn started_subs(state: &DaemonState, parent: &str) -> Vec<Instance> {
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    started_subs_with(state, parent, &has)
}

pub(crate) fn started_subs_with(state: &DaemonState, parent: &str, has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> Vec<Instance> {
    let held = super::super::held::all();
    running_subs(&state.registry, parent)
        .into_iter()
        .filter(|i| !held.iter().any(|h| h.sub_id == i.session_id) && !super::super::held::is_lost_hold(state, i, &held, has_transcript))
        .collect()
}

fn cap_error(running: &[Instance], pending: usize) -> String {
    let mut names: Vec<String> = running.iter().map(label).collect();
    if pending > 0 {
        names.push(format!("{pending} more being started"));
    }
    format!(
        "At most {MAX_RUNNING} subs can run at once and these are running: {}. Wait for one to finish, or hand this job to one of them with the subchat tool.",
        names.join(", ")
    )
}

pub(super) fn reserve(state: &DaemonState, parent: &str) -> Result<Reservation, String> {
    let registry = &state.registry;
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let running = started_subs(state, parent);
    let key = pending_key(registry, parent);
    let pending = map.get(&key).copied().unwrap_or(0);
    if running.len() + pending >= MAX_RUNNING {
        return Err(cap_error(&running, pending));
    }
    *map.entry(key.clone()).or_insert(0) += 1;
    Ok(Reservation { key })
}
