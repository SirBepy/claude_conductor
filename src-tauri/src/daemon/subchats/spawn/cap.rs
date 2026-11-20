//! The cap of started subs and the slot a planned spawn holds until its registry
//! row exists. `spawn/mod.rs` decides whether a spawn may happen; this is the
//! count it is held to.

use super::super::brief::SubchatBrief;
use super::super::remote::records::{self, RemoteState, RemoteSub};
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
///
/// A soft cap on purpose: only a new `spawn_chat` and "Move into main chat"
/// check it. A queued sub (`held::launch_held`, the writer queue) starts when its
/// turn comes without re-checking, so a main chat at 10 started subs with queued
/// ones can pass 10 while they start. A queued sub was accepted while it held no
/// slot, and refusing it again at start would leave it waiting on a slot that
/// nothing announces; the overrun is bounded by the queue Joe already approved.
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
    /// The id of the sub this one carries on (`continue_from`): its worktree work
    /// is handed over once the new sub is registered.
    pub continue_from: Option<String>,
    pub(super) reservation: Option<Reservation>,
}

/// The earlier subs a held sub waits for, as `(id, name)`, still pending when the
/// plan was made. Never empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldPlan {
    pub targets: Vec<(String, String)>,
}

impl HoldPlan {
    /// The names in words, "header" or "header, footer".
    pub fn names_display(&self) -> String {
        self.targets.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")
    }
}

impl SubPlan {
    /// The plan for a sub that visits this machine from a main chat on another one
    /// (`remote::host`): the rules were checked by its home, so it holds no cap slot
    /// here, and it never waits on a sub (`after` stays on the home).
    pub fn visiting(parent: String, brief: SubchatBrief, first_message: String, model: String, effort: String) -> SubPlan {
        SubPlan { parent, brief, first_message, model, effort, hold: None, continue_from: None, reservation: None }
    }

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
    // after this head: the base its facts count from (`facts/`).
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
        .filter(|i| !held.iter().any(|h| h.sub_id == i.session_id) && !super::super::lost_hold::is_lost_hold(state, i, &held, has_transcript))
        .collect()
}

/// The main chat's subs running on other machines: the home keeps no row for
/// them, so the remote-subs record is what the cap counts. A held one (an `after`
/// chain) has no process, like a queued local sub, and a finished or ended one has
/// stopped.
fn remote_running(parent: &str) -> Vec<RemoteSub> {
    records::of_main(parent).into_iter().filter(|s| s.state == RemoteState::Running).collect()
}

fn cap_error(running: &[Instance], remote: &[RemoteSub], pending: usize) -> String {
    let mut names: Vec<String> = running.iter().map(label).collect();
    names.extend(remote.iter().map(|s| if s.name.trim().is_empty() { s.sub_id.chars().take(8).collect() } else { s.name.trim().to_string() }));
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
    let remote = remote_running(parent);
    let key = pending_key(registry, parent);
    let pending = map.get(&key).copied().unwrap_or(0);
    if running.len() + remote.len() + pending >= MAX_RUNNING {
        return Err(cap_error(&running, &remote, pending));
    }
    *map.entry(key.clone()).or_insert(0) += 1;
    Ok(Reservation { key })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap bounds the main chat's running subs wherever they run: ten on the
    /// other machine leave no slot here, and a held, finished or ended one holds none.
    #[test]
    fn the_cap_counts_running_subs_on_other_machines() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = DaemonState::new(
            crate::daemon::session::new_session_map(),
            crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
        );
        let remote = |n: usize, state| RemoteSub { sub_id: format!("r{n}"), machine_id: "mac".into(), main_id: "cap-main".into(), name: format!("job-{n}"), state, ..Default::default() };
        for n in 0..MAX_RUNNING - 1 {
            records::record(remote(n, RemoteState::Running)).unwrap();
        }
        records::record(remote(90, RemoteState::Held)).unwrap();
        records::record(remote(91, RemoteState::Finished)).unwrap();
        records::record(remote(92, RemoteState::Ended)).unwrap();
        let last = reserve(&state, "cap-main").expect("nine running, so one slot is left");
        let err = reserve(&state, "cap-main").err().expect("the reserved slot counts");
        assert!(err.contains("job-0") && err.contains("1 more being started"), "{err}");
        drop(last);
        records::record(remote(9, RemoteState::Running)).unwrap();
        let err = reserve(&state, "cap-main").err().expect("ten running on the other machine");
        assert!(err.contains("At most 10 subs") && err.contains("job-9"), "{err}");
        assert!(reserve(&state, "another-main").is_ok(), "another main chat has its own cap");
    }

    #[test]
    fn a_hold_names_every_sub_it_waits_for() {
        let plan = HoldPlan { targets: vec![("a".into(), "header".into()), ("b".into(), "footer".into())] };
        assert_eq!(plan.names_display(), "header, footer");
        assert_eq!(HoldPlan { targets: vec![("a".into(), "header".into())] }.names_display(), "header");
    }
}
