//! The daemon clears finished subs itself (Joe 2026-11-17: nothing waits on him, no
//! x to press, no red "Worktree kept" card).
//!
//! - A finished sub older than [`CLOSE_AFTER`] is closed the way the tray's x closes
//!   it ([`close_sub`]), unless something of Joe's is still attached to it: an open
//!   question card, a blocker the sub itself sent, a queued follow-up, a running
//!   state or a merge or start still waiting. [`due`] decides, [`tick`] acts.
//! - The same tick, once an hour, retries the worktrees of ended subs that had to
//!   stay (`worktree::sweep_ended`): a tree holding unmerged work is never carded,
//!   it is tried again until it is merged and clean.
//!
//! It rides `ceiling::sweep_now` (the 60 second tick of `busy_watchdog`) because that
//! is the one tick `subchats` owns; the throttles below keep the work to a pass every
//! ten minutes (the closes) and every hour (the trees).

use super::card_log::{self, CardEntry, KIND_BLOCKER};
use crate::daemon::state::DaemonState;
use chrono::{DateTime, Utc};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

/// How long a finished sub stays in the list before the daemon closes it.
pub const CLOSE_AFTER: chrono::Duration = chrono::Duration::hours(12);
/// Seconds between two passes that look for finished subs to close.
const CLOSE_EVERY: i64 = 10 * 60;
/// Seconds between two retries of the trees that had to stay.
const TREES_EVERY: i64 = 60 * 60;

static LAST_CLOSE_PASS: AtomicI64 = AtomicI64::new(0);
static LAST_TREE_PASS: AtomicI64 = AtomicI64::new(0);

/// Claims a pass when `every` seconds went by since the last one.
fn due_pass(last: &AtomicI64, now: i64, every: i64) -> bool {
    let before = last.load(Ordering::SeqCst);
    now - before >= every && last.compare_exchange(before, now, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}

/// A finish card the sub is still waiting on Joe about: its own latest card is a
/// `blocker` it sent itself. A blocker the app drew (a kept tree, a refused move)
/// is no word of the sub's and never holds it: the daemon no longer draws them, and
/// closing the sub retracts the ones an older build left.
fn has_own_blocker(cards: &[CardEntry], sub_id: &str) -> bool {
    cards
        .iter()
        .filter(|c| c.sub_id.as_deref() == Some(sub_id) && !c.retracted && !(c.kind == KIND_BLOCKER && c.by_app))
        .max_by_key(|c| c.ts)
        .is_some_and(|c| c.kind == KIND_BLOCKER)
}

fn finished_at(root: &Path, sub_id: &str) -> Option<DateTime<Utc>> {
    let record = super::finish::read_record_in(root, sub_id)?;
    DateTime::parse_from_rfc3339(&record.finished_at).ok().map(|t| t.with_timezone(&Utc))
}

/// The finished subs `now` is past [`CLOSE_AFTER`] for, with nothing of Joe's on
/// them. `root` is the data dir. A sub with no readable finish record is left alone:
/// nothing says how old its finish is.
pub(crate) async fn due(state: &Arc<DaemonState>, root: &Path, now: DateTime<Utc>) -> Vec<String> {
    let mut out = Vec::new();
    for inst in state.registry.list() {
        if is_due(state, root, &inst.session_id, now).await {
            out.push(inst.session_id);
        }
    }
    out
}

/// Whether one sub passes every check of [`due`] right now. [`tick`] asks it again
/// just before each close, because an earlier close in the same pass can take a while
/// and Joe may have queued a follow-up or continued the sub meanwhile.
async fn is_due(state: &Arc<DaemonState>, root: &Path, id: &str, now: DateTime<Utc>) -> bool {
    let Some(inst) = state.registry.get(id) else { return false };
    let Some(parent) = inst.subchat_of.clone() else { return false };
    if !super::is_sub(&inst)
        || inst.ended_at.is_some()
        || !inst.subchat_finished
        || inst.busy
        || inst.local_task_running
        || super::held::is_held(id)
        || super::pending_merges::contains(id)
    {
        return false;
    }
    let Some(finished) = finished_at(root, id) else { return false };
    if now.signed_duration_since(finished) < CLOSE_AFTER {
        return false;
    }
    if !super::followup::list_in(root, id).is_empty() || has_own_blocker(&card_log::read_in(root, &parent), id) {
        return false;
    }
    if crate::daemon::lifecycle::has_open_prompt(state, id).await {
        return false;
    }
    // A refused merge that is not in `pending_merges` (it lives in `plumbing`, in memory
    // only) leaves commits on the branch; ending the sub would make `subchat merge`
    // refuse it, so only a sub whose work has landed is closed.
    !super::worktree::has_unmerged(id)
}

/// The tray's x for a sub: ends it (the row is marked at once, the process stop and
/// the worktree removal run detached) and settles the rest. The same steps the
/// `mark_session_ended` RPC runs, so Joe's x and the 12 hour sweep never differ.
pub async fn close_sub(state: &Arc<DaemonState>, sub_id: &str) {
    super::end_sub(state, sub_id);
    finish_close(state, sub_id).await;
}

/// What a close does after the row is marked ended.
pub async fn finish_close(state: &Arc<DaemonState>, sub_id: &str) {
    super::closing::settle_family(state, sub_id).await;
    // An older build's red cards about this sub's tree or merge are over with it.
    card_log::retract_blockers(state, sub_id);
    crate::ask::store::drop_for_chat(sub_id);
    crate::daemon::secret_target::temporary_secrets().sweep_session(sub_id);
    crate::daemon::machines::publish_instances_changed(state);
    // A test registry must never overwrite the live snapshot file.
    #[cfg(not(test))]
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// One pass of the tick: closes what is due and retries the kept trees, each on its
/// own throttle.
pub async fn tick(state: &Arc<DaemonState>) {
    let now = Utc::now();
    if due_pass(&LAST_CLOSE_PASS, now.timestamp(), CLOSE_EVERY) {
        if let Ok(root) = crate::settings::paths::data_dir() {
            for id in due(state, &root, now).await {
                if !is_due(state, &root, &id, now).await {
                    continue;
                }
                log::info!("subchats: closing finished sub {id}, finished more than {} hours ago", CLOSE_AFTER.num_hours());
                close_sub(state, &id).await;
            }
        }
    }
    if due_pass(&LAST_TREE_PASS, now.timestamp(), TREES_EVERY) {
        super::worktree::sweep_ended(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A finished sub whose finish record says it finished `hours_ago` hours before `now`.
    fn finished_sub(st: &Arc<DaemonState>, root: &Path, tag: &str, hours_ago: i64, now: DateTime<Utc>) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        st.registry.set_subchat_finished(&sub, true);
        let record = super::super::finish::FinishRecord {
            sub_id: sub.clone(),
            finished_at: (now - chrono::Duration::hours(hours_ago)).to_rfc3339(),
            ..Default::default()
        };
        super::super::finish::write_record_in(root, &record).unwrap();
        sub
    }

    fn block(parent: &str, sub: &str, ts: i64, by_app: bool, kind: &str) -> CardEntry {
        CardEntry { id: format!("{sub}-{ts}"), ts, parent_id: parent.into(), kind: kind.into(), sub_id: Some(sub.into()), by_app, ..Default::default() }
    }

    #[tokio::test]
    async fn a_finished_sub_is_due_only_after_twelve_hours() {
        let root = tempfile::tempdir().unwrap();
        let st = state();
        let now = Utc::now();
        let old = finished_sub(&st, root.path(), "ac-old", 13, now);
        let fresh = finished_sub(&st, root.path(), "ac-fresh", 11, now);
        assert_eq!(due(&st, root.path(), now).await, [old]);
        assert!(!due(&st, root.path(), now).await.contains(&fresh));
    }

    #[tokio::test]
    async fn a_sub_with_something_of_joes_on_it_is_never_due() {
        let root = tempfile::tempdir().unwrap();
        let st = state();
        let now = Utc::now();
        let busy = finished_sub(&st, root.path(), "ac-busy", 20, now);
        st.registry.set_busy(&busy, true);
        let task = finished_sub(&st, root.path(), "ac-task", 20, now);
        st.registry.set_turn_activity(&task, crate::sessions::registry_turn::TurnActivity::WaitingOnProcess);
        let queued = finished_sub(&st, root.path(), "ac-queued", 20, now);
        super::super::followup::add_in(root.path(), &queued, "do this next").unwrap();
        let blocked = finished_sub(&st, root.path(), "ac-blocked", 20, now);
        let ended = finished_sub(&st, root.path(), "ac-ended", 20, now);
        st.registry.mark_ended(&ended, crate::types::EndReason::Manual, &now.to_rfc3339());
        let running = finished_sub(&st, root.path(), "ac-running", 20, now);
        st.registry.set_subchat_finished(&running, false);
        let norecord = finished_sub(&st, root.path(), "ac-norecord", 20, now);
        std::fs::remove_file(root.path().join("subchats").join(format!("{norecord}.finish.json"))).unwrap();
        // The sub's own blocker holds it; the app's own does not.
        let log = root.path().join("subchats").join("ac-blocked-main.cards.jsonl");
        std::fs::write(&log, format!("{}\n", serde_json::to_string(&block("ac-blocked-main", &blocked, 1, false, KIND_BLOCKER)).unwrap())).unwrap();
        let free = finished_sub(&st, root.path(), "ac-free", 20, now);
        let free_log = root.path().join("subchats").join("ac-free-main.cards.jsonl");
        std::fs::write(&free_log, format!("{}\n", serde_json::to_string(&block("ac-free-main", &free, 1, true, KIND_BLOCKER)).unwrap())).unwrap();
        assert_eq!(due(&st, root.path(), now).await, [free], "only the sub with nothing attached to it");
    }

    #[test]
    fn a_blocker_holds_a_sub_until_it_sends_a_later_card() {
        let own = block("m", "s", 1, false, KIND_BLOCKER);
        assert!(has_own_blocker(&[own.clone()], "s"));
        let later = block("m", "s", 2, false, "finish");
        assert!(!has_own_blocker(&[own.clone(), later], "s"), "a later card supersedes it");
        let retracted = CardEntry { retracted: true, ..own.clone() };
        assert!(!has_own_blocker(&[retracted], "s"));
        assert!(!has_own_blocker(&[own], "other"), "another sub's blocker is not this one's");
    }

    #[test]
    fn a_pass_runs_once_per_interval() {
        let last = AtomicI64::new(0);
        assert!(due_pass(&last, 1000, 600));
        assert!(!due_pass(&last, 1100, 600));
        assert!(due_pass(&last, 1600, 600));
    }

    /// The close the sweep and the tray share ends the row and clears the sub's leftovers.
    #[tokio::test]
    async fn closing_a_due_sub_ends_it() {
        let root = tempfile::tempdir().unwrap();
        let st = state();
        let now = Utc::now();
        let id = finished_sub(&st, root.path(), "ac-close", 13, now);
        close_sub(&st, &id).await;
        assert!(st.registry.get(&id).unwrap().ended_at.is_some());
        assert!(due(&st, root.path(), now).await.is_empty(), "an ended sub is never due again");
    }
}
