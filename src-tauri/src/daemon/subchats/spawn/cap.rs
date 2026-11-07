//! The cap of running subs and the slot a planned spawn holds until its registry
//! row exists. `spawn/mod.rs` decides whether a spawn may happen; this is the
//! count it is held to.

use super::super::brief::SubchatBrief;
use super::label;
use crate::daemon::state::DaemonState;
use crate::sessions::registry::Registry;
use crate::types::Instance;
use std::collections::HashMap;
use std::sync::Mutex;

/// Running subs one main chat may have at once (spec section 2).
pub const MAX_RUNNING: usize = 5;

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

/// Subs of `parent` that count against the cap: not ended and not finished.
pub fn running_subs(registry: &Registry, parent: &str) -> Vec<Instance> {
    registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent))
        .filter(|i| i.ended_at.is_none() && i.end_reason.is_none() && !i.subchat_finished)
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

pub(super) fn reserve(registry: &Registry, parent: &str) -> Result<Reservation, String> {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let running = running_subs(registry, parent);
    let key = pending_key(registry, parent);
    let pending = map.get(&key).copied().unwrap_or(0);
    if running.len() + pending >= MAX_RUNNING {
        return Err(cap_error(&running, pending));
    }
    *map.entry(key.clone()).or_insert(0) += 1;
    Ok(Reservation { key })
}
