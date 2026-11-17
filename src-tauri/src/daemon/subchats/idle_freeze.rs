//! Idle freeze (docs/chat-heads-design.md, "Freeze becomes invisible"). A chat that
//! finished its work and sat for [`IDLE_FREEZE_AFTER`] has its child killed and its
//! row marked `frozen` + `auto_frozen`, so a stack of old chats costs no processes. The
//! chat heads show nothing for it: Joe opens the head, the front end calls
//! `unfreeze_session`, and the next send respawns the child (a scheduled message
//! clears the same pair before it fires, `schedule_fire.rs`).
//!
//! Nothing is lost by this kind of freeze, so [`blocker`] refuses it for anything that
//! has work in flight or that something is waiting on. `frozen_needs_continue` is never
//! set: there is no cancelled turn to continue. A usage-limit freeze (the existing
//! `auto_frozen` writer) is a different thing and is left alone.
//!
//! The sweep rides on the compaction idle sweep (`compaction::idle_sweep`), which the
//! busy watchdog already runs every 60 seconds, so it adds no timer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::state::DaemonState;
use crate::sessions::kinds::InstanceKind;
use crate::types::Instance;

/// How long a chat must stay quiet before it is frozen.
pub const IDLE_FREEZE_AFTER: Duration = Duration::from_secs(30 * 60);

/// What the registry row cannot say by itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// A question, permission or secret card of this chat is open.
    pub open_prompt: bool,
    /// The chat has a sub that has not ended (local or on a paired machine).
    pub live_subs: bool,
    /// A compaction is running on this chat.
    pub compacting: bool,
    /// A peer machine owns this chat (it is mirrored here).
    pub mirrored: bool,
}

/// Why a chat may not be frozen now; `None` means it may.
pub fn blocker(i: &Instance, f: &Facts) -> Option<&'static str> {
    if !matches!(i.kind, InstanceKind::Interactive) {
        return Some("not an interactive chat");
    }
    if i.jarvis || i.worker_of.is_some() {
        return Some("Jarvis or a Jarvis worker");
    }
    if i.subchat_of.is_some() {
        return Some("a sub");
    }
    if i.machine.is_some() || f.mirrored {
        return Some("lives on another machine");
    }
    if i.frozen {
        return Some("already frozen");
    }
    if i.ended_at.is_some() || i.end_reason.is_some() {
        return Some("ended");
    }
    if i.closing {
        return Some("closing");
    }
    if i.busy || f.compacting {
        return Some("working");
    }
    // `none` and `done` are the only states with nothing owed to Joe or to the chat:
    // question, permission, waiting, working and the rest mean a turn is still open.
    if !matches!(i.awaiting.as_deref(), None | Some("done")) {
        return Some("a turn is open");
    }
    if i.local_task_running {
        return Some("a background task runs");
    }
    if f.open_prompt {
        return Some("a card is open");
    }
    if f.live_subs {
        return Some("it has subs");
    }
    if i.held_count > 0 {
        return Some("it has held messages");
    }
    if i.rate_limited_resets_at.is_some() {
        // The usage-limit freeze path owns this row.
        return Some("rate limited");
    }
    None
}

/// Whether `i` is frozen by the idle sweep rather than by a usage limit or by Joe.
/// Both automatic freezes set `auto_frozen`. The usage-limit one is the chat whose own
/// turn the CLI refused (`rate_limit_refused`, set by `rate_limit.rs` together with a
/// future reset stamp); a chat that only carries its account's stamp was not refused
/// and is idle-frozen, and a refusal whose window has passed is history, so it reads
/// as idle too (the rule `isIdleFrozen` applies on the chat heads).
pub fn is_idle_freeze(i: &Instance, now_ts: i64) -> bool {
    let limit_frozen = i.rate_limit_refused == Some(true) && i.rate_limited_resets_at.is_some_and(|t| t > now_ts);
    i.frozen && i.auto_frozen && !limit_frozen
}

/// Clears an idle freeze so a send can respawn the chat. Returns whether it did;
/// a usage-limit or manual freeze is left alone. Nothing was cancelled by the idle
/// freeze, so no "continue" is owed.
pub fn wake(state: &Arc<DaemonState>, id: &str) -> bool {
    let Some(row) = state.registry.get(id) else { return false };
    if !is_idle_freeze(&row, chrono::Utc::now().timestamp()) {
        return false;
    }
    state.registry.set_frozen(id, false);
    state.registry.set_auto_frozen(id, false);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    true
}

/// When each chat was first seen with nothing blocking it. A chat that blocks again
/// drops out, so its quiet time starts over. The registry's `last_event_at` is also
/// required to be old (it is only stamped at turn ends), but it is unset on a row
/// restored from a snapshot, so this clock is the one that always exists.
fn seen_idle() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static SEEN: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `last_event_at` leaves room for a freeze at `now`.
fn event_is_old(last_event_at: Option<&str>, now: chrono::DateTime<chrono::Utc>, after: Duration) -> bool {
    match last_event_at.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        Some(t) => now.signed_duration_since(t.with_timezone(&chrono::Utc)).to_std().is_ok_and(|d| d >= after),
        None => true,
    }
}

/// The ids to freeze at this tick: blocker-free for a full `after`, by both clocks.
fn due(rows: &[(Instance, Facts)], seen: &mut HashMap<String, Instant>, now: Instant, wall: chrono::DateTime<chrono::Utc>, after: Duration) -> Vec<String> {
    let mut out = Vec::new();
    let mut keep: Vec<&str> = Vec::new();
    for (i, f) in rows {
        if blocker(i, f).is_some() {
            continue;
        }
        keep.push(&i.session_id);
        let first = *seen.entry(i.session_id.clone()).or_insert(now);
        if now.duration_since(first) >= after && event_is_old(i.last_event_at.as_deref(), wall, after) {
            out.push(i.session_id.clone());
        }
    }
    seen.retain(|id, _| keep.contains(&id.as_str()));
    out
}

/// The blocking facts of one row. Cheap row checks run first so the card and sub reads
/// only happen for a possible freeze.
async fn facts_for(state: &Arc<DaemonState>, i: &Instance) -> Facts {
    let mut f = Facts::default();
    if blocker(i, &f).is_some() {
        return f;
    }
    f.mirrored = crate::daemon::machines::mirrored_owner(state, &i.session_id).is_some();
    f.compacting = super::compaction::is_compacting(&i.session_id);
    f.live_subs = !super::family::live_subs(state, &i.session_id).is_empty();
    f.open_prompt = crate::daemon::lifecycle::has_open_prompt(state, &i.session_id).await;
    f
}

/// The watchdog tick's hook: freezes each chat that has been quiet and clear for
/// [`IDLE_FREEZE_AFTER`].
pub async fn sweep(state: &Arc<DaemonState>) {
    let mut rows: Vec<(Instance, Facts)> = Vec::new();
    for i in state.registry.list() {
        let f = facts_for(state, &i).await;
        rows.push((i, f));
    }
    let ids = due(&rows, &mut seen_idle(), Instant::now(), chrono::Utc::now(), IDLE_FREEZE_AFTER);
    for id in ids {
        freeze(state, &id).await;
    }
}

/// Kills the child and marks the row. The sweep freezes due chats one by one and each
/// kill waits for its teardown, so the blockers are read again from the live row right
/// before the kill (a send or a card that arrived while an earlier chat tore down must
/// keep its child), and once more after it for a message that lands during the wait.
async fn freeze(state: &Arc<DaemonState>, id: &str) {
    let Some(row) = state.registry.get(id) else { return };
    let f = facts_for(state, &row).await;
    if row.frozen || blocker(&row, &f).is_some() {
        seen_idle().remove(id);
        return;
    }
    crate::daemon::lifecycle::kill_and_wait_for_teardown(state, id).await;
    let Some(now) = state.registry.get(id) else { return };
    if now.busy || now.frozen {
        return;
    }
    state.registry.set_frozen(id, true);
    state.registry.set_auto_frozen(id, true);
    state.registry.set_frozen_needs_continue(id, false);
    seen_idle().remove(id);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    log::info!("idle freeze: session {id} was quiet for 30 minutes, child stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;

    fn row(id: &str) -> Instance {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive(id, std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.get(id).unwrap()
    }

    fn clear() -> (Instance, Facts) {
        let mut i = row("a");
        i.awaiting = Some("done".into());
        (i, Facts::default())
    }

    #[test]
    fn a_quiet_finished_chat_may_freeze() {
        let (i, f) = clear();
        assert_eq!(blocker(&i, &f), None);
        let mut none = i.clone();
        none.awaiting = None;
        assert_eq!(blocker(&none, &f), None);
    }

    #[test]
    fn every_listed_exclusion_blocks() {
        let (base, f) = clear();
        let cases: Vec<(&str, Box<dyn Fn(&mut Instance, &mut Facts)>)> = vec![
            ("external", Box::new(|i, _| i.kind = InstanceKind::External)),
            ("jarvis", Box::new(|i, _| i.jarvis = true)),
            ("worker", Box::new(|i, _| i.worker_of = Some("j".into()))),
            ("sub", Box::new(|i, _| i.subchat_of = Some("m".into()))),
            ("machine row", Box::new(|i, _| i.machine = Some(crate::types::MachineRef { id: "m".into(), label: "m".into(), online: true }))),
            ("mirrored", Box::new(|_, f| f.mirrored = true)),
            ("already frozen", Box::new(|i, _| i.frozen = true)),
            ("ended", Box::new(|i, _| i.ended_at = Some("2026-11-16T10:00:00Z".into()))),
            ("closing", Box::new(|i, _| i.closing = true)),
            ("busy", Box::new(|i, _| i.busy = true)),
            ("compacting", Box::new(|_, f| f.compacting = true)),
            ("question", Box::new(|i, _| i.awaiting = Some("question".into()))),
            ("permission", Box::new(|i, _| i.awaiting = Some("permission".into()))),
            ("waiting", Box::new(|i, _| i.awaiting = Some("waiting".into()))),
            ("working status", Box::new(|i, _| i.awaiting = Some("working".into()))),
            ("local task", Box::new(|i, _| i.local_task_running = true)),
            ("open card", Box::new(|_, f| f.open_prompt = true)),
            ("live sub", Box::new(|_, f| f.live_subs = true)),
            ("held message", Box::new(|i, _| i.held_count = 1)),
            ("rate limited", Box::new(|i, _| i.rate_limited_resets_at = Some(1_900_000_000))),
        ];
        for (name, mutate) in cases {
            let (mut i, mut f2) = (base.clone(), f.clone());
            mutate(&mut i, &mut f2);
            assert!(blocker(&i, &f2).is_some(), "{name} must block an idle freeze");
        }
    }

    #[test]
    fn freezes_only_after_a_full_quiet_stretch_and_a_block_restarts_it() {
        let (i, f) = clear();
        let rows = vec![(i.clone(), f.clone())];
        let wall = chrono::Utc::now();
        let t0 = Instant::now();
        let after = Duration::from_secs(1800);
        let mut seen = HashMap::new();
        assert!(due(&rows, &mut seen, t0, wall, after).is_empty(), "first sight starts the clock");
        assert!(due(&rows, &mut seen, t0 + after - Duration::from_secs(1), wall, after).is_empty());
        assert_eq!(due(&rows, &mut seen, t0 + after, wall, after), vec!["a".to_string()]);

        let mut busy = i.clone();
        busy.busy = true;
        due(&[(busy, f.clone())], &mut seen, t0 + after, wall, after);
        assert!(seen.is_empty(), "a blocked chat loses its clock");
        assert!(due(&rows, &mut seen, t0 + after, wall, after).is_empty(), "and starts over");
    }

    #[test]
    fn a_recent_event_keeps_the_chat_awake_even_with_an_old_clock() {
        let (mut i, f) = clear();
        let wall = chrono::Utc::now();
        i.last_event_at = Some((wall - chrono::Duration::minutes(5)).to_rfc3339());
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        let after = Duration::from_secs(1800);
        let rows = vec![(i, f)];
        due(&rows, &mut seen, t0, wall, after);
        assert!(due(&rows, &mut seen, t0 + after, wall, after).is_empty());
        let later = wall + chrono::Duration::minutes(40);
        assert_eq!(due(&rows, &mut seen, t0 + after, later, after).len(), 1);
    }

    #[test]
    fn only_a_refused_chat_with_a_live_window_is_limit_frozen() {
        let now = 1_000;
        let (mut i, _) = clear();
        i.frozen = true;
        i.auto_frozen = true;
        assert!(is_idle_freeze(&i, now), "no stamp, no refusal: the idle sweep's own");
        i.rate_limited_resets_at = Some(now + 60);
        i.rate_limit_refused = Some(false);
        assert!(is_idle_freeze(&i, now), "a stamp from the account's limit alone does not make it a usage-limit freeze");
        i.rate_limit_refused = Some(true);
        assert!(!is_idle_freeze(&i, now), "the chat whose turn was refused is limit-frozen");
        assert!(is_idle_freeze(&i, now + 60), "a refusal whose window has passed is history");
        i.auto_frozen = false;
        assert!(!is_idle_freeze(&i, now + 60), "a manual freeze is never idle");
        i.auto_frozen = true;
        i.frozen = false;
        assert!(!is_idle_freeze(&i, now), "a live chat is not frozen at all");
    }

    #[tokio::test]
    async fn wake_clears_an_idle_freeze_and_leaves_a_limit_one() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        for id in ["idle", "limit"] {
            state.registry.upsert_interactive(id, std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
            state.registry.set_account(id, "acct");
            state.registry.set_frozen(id, true);
            state.registry.set_auto_frozen(id, true);
        }
        state.registry.set_rate_limited_for_account("acct", 4_000_000_000, "five_hour");
        state.registry.mark_rate_limit_refused("limit");
        assert!(wake(&state, "idle"));
        assert!(!wake(&state, "limit"));
        assert!(!wake(&state, "ghost"));
        let (idle, limit) = (state.registry.get("idle").unwrap(), state.registry.get("limit").unwrap());
        assert!(!idle.frozen && !idle.auto_frozen);
        assert!(limit.frozen && limit.auto_frozen);
    }

    #[tokio::test]
    async fn the_freeze_leaves_needs_continue_off_and_marks_the_pair() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_awaiting("a", Some("done".into()));
        freeze(&state, "a").await;
        let i = state.registry.get("a").unwrap();
        assert!(i.frozen && i.auto_frozen);
        assert!(!i.frozen_needs_continue, "an idle freeze cancels no turn, so unfreeze must not send continue");
    }

    #[tokio::test]
    async fn a_chat_that_turned_busy_before_its_turn_in_the_sweep_is_not_frozen() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_busy("a", true);
        freeze(&state, "a").await;
        assert!(!state.registry.get("a").unwrap().frozen);
    }

    #[tokio::test]
    async fn a_chat_that_started_asking_after_the_sweep_read_it_keeps_its_child() {
        // The sweep freezes due chats one by one and each kill waits for teardown, so a
        // question that opens in that wait must be seen by the re-check before the kill.
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_awaiting("a", Some("question".into()));
        freeze(&state, "a").await;
        let i = state.registry.get("a").unwrap();
        assert!(!i.frozen && !i.auto_frozen);
    }
}
