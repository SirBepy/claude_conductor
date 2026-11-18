//! Idle freeze (docs/chat-heads-design.md, "Freeze becomes invisible"). A chat that
//! finished its work and sat for [`freeze_after`] (default [`IDLE_FREEZE_AFTER`]) has its child killed and its
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

/// How long a chat must stay quiet before it is frozen. Waking costs about 5.5 s and
/// reads the prompt from cache (docs/chat-heads-design.md, "Evidence"), so a short wait
/// is cheap.
pub const IDLE_FREEZE_AFTER: Duration = Duration::from_secs(15 * 60);

/// Overrides [`IDLE_FREEZE_AFTER`] with a number of seconds, for a live run that cannot
/// wait a quarter of an hour. Read once, on first use.
pub const FREEZE_SECS_ENV: &str = "CC_IDLE_FREEZE_SECS";

/// What `raw` (the env value) makes of the freeze delay: a positive whole number of
/// seconds, else the default (a typo must not turn the freeze into an instant one).
fn parse_freeze_secs(raw: Option<&str>) -> Duration {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map_or(IDLE_FREEZE_AFTER, Duration::from_secs)
}

/// The quiet time the sweep waits for before freezing a chat.
pub fn freeze_after() -> Duration {
    static AFTER: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *AFTER.get_or_init(|| parse_freeze_secs(std::env::var(FREEZE_SECS_ENV).ok().as_deref()))
}

fn describe(d: Duration) -> String {
    let secs = d.as_secs();
    if secs % 60 == 0 {
        format!("{} minutes", secs / 60)
    } else {
        format!("{secs} seconds")
    }
}

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
    /// Idle compaction still waits on this chat (`compaction::idle_compaction_pending`):
    /// it needs the live child, so the freeze must not kill it first.
    pub compaction_pending: bool,
    /// Unix seconds "now" for the rate-limit stamp: the stamp is never cleared on a
    /// timer, so only a stamp still in the future counts as a live window.
    pub now_ts: i64,
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
    if f.compaction_pending {
        return Some("idle compaction is still due");
    }
    if f.live_subs {
        return Some("it has subs");
    }
    if i.held_count > 0 {
        return Some("it has held messages");
    }
    if i.rate_limited_resets_at.is_some_and(|t| t > f.now_ts) {
        // The usage-limit freeze path owns this row. A stamp whose window has passed
        // is history (nothing clears it on a timer), so it must not block forever.
        return Some("rate limited");
    }
    None
}

/// The ids the idle sweep froze, on disk. `auto_frozen` also marks a usage-limit
/// freeze, and nothing else that survives a daemon restart tells the two apart: the
/// rejection's `rate_limit_refused` flag and reset stamp live in memory only, and a
/// turn finishing on the account wipes them. An id missing here (or a file that
/// cannot be read) reads as a usage-limit freeze, the side that refuses a send.
static MARKS: Mutex<()> = Mutex::new(());

fn marks_path() -> Option<std::path::PathBuf> {
    // A test's rows are made up; with no `CC_DATA_DIR` this is the live data folder.
    #[cfg(test)]
    if !crate::daemon::names_own_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref()) {
        return None;
    }
    crate::settings::paths::data_dir()
        .ok()
        .map(|d| d.join(format!("idle-frozen{}.json", crate::daemon::instance::instance_suffix())))
}

/// Why the stored marks could not be read; never read as empty, since the next write
/// would then drop every other chat's mark.
enum Unread {
    /// The file is there but is not a list of ids: kept aside by the next edit.
    Corrupt,
    /// The read failed (a sharing violation, say): the file is left as it is.
    Io,
}

fn read_marks(path: &std::path::Path) -> Result<Vec<String>, Unread> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| Unread::Corrupt),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(Unread::Io),
    }
}

/// Applies `f` to the stored ids and writes them back when it changed them. False
/// when the result is not on disk.
fn edit_marks(f: impl FnOnce(&mut Vec<String>)) -> bool {
    let Some(path) = marks_path() else { return false };
    let _guard = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    let before = match read_marks(&path) {
        Ok(ids) => ids,
        Err(Unread::Io) => return false,
        Err(Unread::Corrupt) => {
            // Kept aside like the other state files, so a bad file costs the marks
            // (those chats read as limit-frozen, the refusing side), not a silent rewrite.
            let bad = path.with_extension("json.bad");
            log::warn!("idle freeze: {} is not a list of ids, kept as {}", path.display(), bad.display());
            let _ = std::fs::rename(&path, &bad);
            Vec::new()
        }
    };
    let mut after = before.clone();
    f(&mut after);
    if after != before {
        let tmp = path.with_extension("json.tmp");
        let written = serde_json::to_string(&after)
            .map_err(std::io::Error::other)
            .and_then(|text| std::fs::write(&tmp, text))
            .and_then(|()| std::fs::rename(&tmp, &path));
        if let Err(e) = written {
            log::warn!("idle freeze: could not write {}: {e}", path.display());
            return false;
        }
    }
    true
}

pub(crate) fn is_marked(id: &str) -> bool {
    let Some(path) = marks_path() else { return false };
    let _guard = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    read_marks(&path).is_ok_and(|ids| ids.iter().any(|m| m == id))
}

/// Records that the idle sweep froze `id`. False when it could not be stored.
pub fn mark(id: &str) -> bool {
    edit_marks(|ids| {
        if !ids.iter().any(|m| m == id) {
            ids.push(id.to_string());
        }
    })
}

/// Forgets the idle freeze of `id`: its freeze was cleared by something else.
pub fn unmark(id: &str) {
    let _ = edit_marks(|ids| ids.retain(|m| m != id));
}

/// Ends the idle-freeze record of `id` (stored mark and the row's marker) once its
/// freeze was cleared by any path: a wake, a desktop unfreeze, a scheduled fire, or a
/// usage-limit freeze taking the row over. Left behind, the stored mark would read a
/// later usage-limit freeze as idle once the in-memory refusal flag is lost.
pub fn forget(state: &Arc<DaemonState>, id: &str) {
    unmark(id);
    state.registry.set_idle_frozen(id, false);
}

/// Sets the row marker for a chat restored from the snapshot as automatically frozen,
/// when the stored mark says the sweep froze it, so a restart shows the right kind
/// before the first sweep tick.
pub fn restore_marker(registry: &crate::sessions::registry::Registry, id: &str) {
    if is_marked(id) {
        registry.set_idle_frozen(id, true);
    }
}

/// Brings each row's marker in line with the stored marks: a freeze something else
/// cleared drops it, a marked freeze that lost it gets it back. True when a row changed,
/// so the caller can tell the clients.
fn sync_markers(registry: &crate::sessions::registry::Registry, rows: &[(Instance, Facts)]) -> bool {
    let mut changed = false;
    for (i, _) in rows {
        let want = i.frozen && i.auto_frozen && is_marked(&i.session_id);
        if want != (i.idle_frozen == Some(true)) {
            registry.set_idle_frozen(&i.session_id, want);
            changed = true;
        }
    }
    changed
}

/// Drops the marks of chats that are no longer frozen by an automatic freeze. An id
/// with no row is kept: the first tick can run before the snapshot restore has filled
/// the registry, and wiping the marks then would undo the restart they exist for.
fn prune(rows: &[(Instance, Facts)]) {
    let _ = edit_marks(|ids| {
        ids.retain(|m| !rows.iter().any(|(i, _)| i.session_id == *m && !(i.frozen && i.auto_frozen)));
    });
}

/// Whether `i` is frozen by the idle sweep rather than by a usage limit or by Joe.
/// The sweep's mark is required; a chat whose own turn the CLI refused for a live
/// window (`rate_limit_refused` with a future reset stamp) still reads as limit-frozen
/// even when a stale mark is left over from an earlier idle freeze.
pub fn is_idle_freeze(i: &Instance, now_ts: i64) -> bool {
    let limit_frozen = i.rate_limit_refused == Some(true) && i.rate_limited_resets_at.is_some_and(|t| t > now_ts);
    i.frozen && i.auto_frozen && !limit_frozen && is_marked(&i.session_id)
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
    forget(state, id);
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
    let mut f = Facts { now_ts: chrono::Utc::now().timestamp(), ..Facts::default() };
    if blocker(i, &f).is_some() {
        return f;
    }
    f.mirrored = crate::daemon::machines::mirrored_owner(state, &i.session_id).is_some();
    f.compacting = super::compaction::is_compacting(&i.session_id);
    // Cheap size check first: the full compaction facts read the card list and accounts.
    if super::compaction::occupancy(&i.session_id).is_some_and(|o| o >= super::compaction::IDLE_FLOOR_TOKENS) {
        let cf = super::compaction::facts(state, &i.session_id).await;
        f.compaction_pending = super::compaction::idle_compaction_pending(&cf, freeze_after());
    }
    f.live_subs = !super::family::live_subs(state, &i.session_id).is_empty();
    f.open_prompt = crate::daemon::lifecycle::has_open_prompt(state, &i.session_id).await;
    f
}

/// The watchdog tick's hook: freezes each chat that has been quiet and clear for
/// [`freeze_after`].
pub async fn sweep(state: &Arc<DaemonState>) {
    let mut rows: Vec<(Instance, Facts)> = Vec::new();
    for i in state.registry.list() {
        let f = facts_for(state, &i).await;
        rows.push((i, f));
    }
    prune(&rows);
    if sync_markers(&state.registry, &rows) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    let ids = due(&rows, &mut seen_idle(), Instant::now(), chrono::Utc::now(), freeze_after());
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
    // Frozen without a stored mark would read as a usage-limit freeze and refuse every
    // daemon-side send, so a mark that could not be written leaves the chat unfrozen
    // (the next send respawns it; the sweep tries again).
    if !mark(id) {
        seen_idle().remove(id);
        return;
    }
    state.registry.set_frozen(id, true);
    state.registry.set_auto_frozen(id, true);
    state.registry.set_idle_frozen(id, true);
    state.registry.set_frozen_needs_continue(id, false);
    seen_idle().remove(id);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    log::info!("idle freeze: session {id} was quiet for {}, child stopped", describe(freeze_after()));
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
            ("idle compaction due", Box::new(|_, f| f.compaction_pending = true)),
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
    fn a_stamp_whose_window_has_passed_no_longer_blocks_a_freeze() {
        let (mut i, mut f) = clear();
        i.rate_limited_resets_at = Some(1_000);
        f.now_ts = 999;
        assert_eq!(blocker(&i, &f), Some("rate limited"), "a live window blocks");
        f.now_ts = 1_000;
        assert_eq!(blocker(&i, &f), None, "the stamp is never cleared on a timer, so a passed one is history");
        f.now_ts = 5_000;
        assert_eq!(blocker(&i, &f), None);
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

    fn compaction_facts(occupancy: u64, idle_for: Duration) -> super::super::compaction::Facts {
        super::super::compaction::Facts {
            main_chat: true,
            live_child: true,
            threshold: Some(super::super::compaction::Threshold { on: true, tokens: 300_000 }),
            occupancy: Some(occupancy),
            idle_for: Some(idle_for),
            ..Default::default()
        }
    }

    /// Runs the sweep's decision for one quiet chat at `quiet` of silence.
    fn frozen_at(cf: &super::super::compaction::Facts, quiet: Duration) -> bool {
        let (i, mut f) = clear();
        f.compaction_pending = super::super::compaction::idle_compaction_pending(cf, freeze_after());
        let rows = vec![(i, f)];
        let wall = chrono::Utc::now();
        let t0 = Instant::now();
        let mut seen = HashMap::new();
        due(&rows, &mut seen, t0, wall, freeze_after());
        !due(&rows, &mut seen, t0 + quiet, wall + chrono::Duration::from_std(quiet).unwrap(), freeze_after()).is_empty()
    }

    #[test]
    fn the_freeze_waits_15_minutes_by_default() {
        assert_eq!(IDLE_FREEZE_AFTER, Duration::from_secs(15 * 60));
        assert_eq!(describe(IDLE_FREEZE_AFTER), "15 minutes");
        assert_eq!(describe(Duration::from_secs(90)), "90 seconds");
    }

    #[test]
    fn a_chat_past_the_compaction_floor_is_not_frozen_at_15_minutes_and_one_under_it_is() {
        use super::super::compaction::{IDLE_COMPACT_AFTER, IDLE_FLOOR_TOKENS};
        let quiet = IDLE_FREEZE_AFTER;
        let big = compaction_facts(IDLE_FLOOR_TOKENS, quiet);
        let small = compaction_facts(IDLE_FLOOR_TOKENS - 1, quiet);
        assert!(!frozen_at(&big, quiet), "idle compaction at 30 minutes still needs its child");
        assert!(frozen_at(&small, quiet), "nothing waits on a chat under the floor");
        // The compaction ran (or was skipped for good) and the chat left the floor: frozen.
        let mut compacted = big.clone();
        compacted.occupancy = Some(40_000);
        assert!(frozen_at(&compacted, quiet));
        // A compaction that cannot run for a lasting reason does not keep the child.
        for off in [
            (|f: &mut super::super::compaction::Facts| f.main_chat = false) as fn(&mut super::super::compaction::Facts),
            |f| f.api_credit = true,
            |f| f.threshold = None,
            |f| f.live_child = false,
        ] {
            let mut f = big.clone();
            off(&mut f);
            assert!(frozen_at(&f, quiet));
        }
        // A skipped compaction holds the child for a bounded stretch only.
        let late = compaction_facts(IDLE_FLOOR_TOKENS, IDLE_COMPACT_AFTER + IDLE_FREEZE_AFTER);
        assert!(frozen_at(&late, quiet));
    }

    #[test]
    fn the_freeze_delay_reads_the_env_override_and_ignores_bad_values() {
        assert_eq!(parse_freeze_secs(Some("20")), Duration::from_secs(20));
        assert_eq!(parse_freeze_secs(Some(" 45 ")), Duration::from_secs(45));
        for bad in [None, Some(""), Some("0"), Some("-5"), Some("soon")] {
            assert_eq!(parse_freeze_secs(bad), IDLE_FREEZE_AFTER, "{bad:?}");
        }
    }

    /// Holds the env lock with `CC_DATA_DIR` on a temp dir, where the marks live.
    struct OwnData {
        _lock: std::sync::MutexGuard<'static, ()>,
        _dir: tempfile::TempDir,
    }

    impl OwnData {
        fn new() -> Self {
            let lock = crate::util::env_lock();
            let dir = tempfile::tempdir().unwrap();
            std::env::set_var("CC_DATA_DIR", dir.path());
            Self { _lock: lock, _dir: dir }
        }
    }

    impl Drop for OwnData {
        fn drop(&mut self) {
            std::env::remove_var("CC_DATA_DIR");
        }
    }

    #[test]
    fn only_the_sweeps_own_freeze_reads_as_idle_and_a_live_refusal_overrides_a_stale_mark() {
        let _data = OwnData::new();
        let now = 1_000;
        let (mut i, _) = clear();
        i.frozen = true;
        i.auto_frozen = true;
        assert!(!is_idle_freeze(&i, now), "an automatic freeze nothing marked is a usage-limit one (the shape after a restart or a cleared stamp)");
        assert!(mark("a"));
        assert!(is_idle_freeze(&i, now), "marked, no stamp, no refusal: the idle sweep's own");
        i.rate_limited_resets_at = Some(now + 60);
        i.rate_limit_refused = Some(false);
        assert!(is_idle_freeze(&i, now), "a stamp from the account's limit alone does not make it a usage-limit freeze");
        i.rate_limit_refused = Some(true);
        assert!(!is_idle_freeze(&i, now), "a refusal with a live window beats a stale mark");
        assert!(is_idle_freeze(&i, now + 60), "a refusal whose window has passed is history");
        i.auto_frozen = false;
        assert!(!is_idle_freeze(&i, now + 60), "a manual freeze is never idle");
        i.auto_frozen = true;
        i.frozen = false;
        assert!(!is_idle_freeze(&i, now), "a live chat is not frozen at all");
    }

    #[test]
    fn marks_survive_a_restart_and_prune_drops_the_ones_no_longer_frozen() {
        let _data = OwnData::new();
        assert!(edit_marks(|ids| ids.extend(["a".to_string(), "b".to_string(), "c".to_string()])));
        assert!(is_marked("a") && is_marked("b"));
        let (mut a, f) = clear();
        a.frozen = true;
        a.auto_frozen = true;
        let mut b = a.clone();
        b.session_id = "b".into();
        b.auto_frozen = false; // Joe froze it by hand afterwards
        prune(&[(a, f.clone()), (b, f)]);
        assert!(is_marked("a"));
        assert!(!is_marked("b"), "no longer an automatic freeze");
        assert!(is_marked("c"), "no row yet: the registry may not be restored, so the mark stays");
        prune(&[]);
        assert!(is_marked("a") && is_marked("c"), "an empty registry (first tick at boot) wipes nothing");
    }

    #[test]
    fn an_unreadable_mark_file_is_kept_aside_and_never_read_as_empty() {
        let _data = OwnData::new();
        assert!(mark("a"));
        let path = marks_path().unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert!(!is_marked("a"), "a corrupt file marks nothing, so the chat reads as limit-frozen");
        assert!(mark("b"));
        assert!(is_marked("b"));
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bad")).unwrap(), "not json");
    }

    #[test]
    fn a_failed_read_leaves_the_file_and_the_edit_undone() {
        let _data = OwnData::new();
        assert!(mark("a"));
        let path = marks_path().unwrap();
        // A directory where the file was: reading it fails with an I/O error, not a parse error.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(!mark("b"), "an edit that cannot read the stored marks must not rewrite them");
        assert!(path.is_dir(), "and must not move the unreadable entry aside");
        assert!(!path.with_extension("json.bad").exists());
    }

    #[tokio::test]
    async fn wake_clears_an_idle_freeze_and_leaves_a_limit_one() {
        let _data = OwnData::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        for id in ["idle", "limit"] {
            state.registry.upsert_interactive(id, std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
            state.registry.set_account(id, "acct");
            state.registry.set_frozen(id, true);
            state.registry.set_auto_frozen(id, true);
        }
        assert!(mark("idle"));
        state.registry.set_rate_limited_for_account("acct", 4_000_000_000, "five_hour");
        state.registry.mark_rate_limit_refused("limit");
        assert!(wake(&state, "idle"));
        assert!(!wake(&state, "limit"));
        assert!(!wake(&state, "ghost"));
        let (idle, limit) = (state.registry.get("idle").unwrap(), state.registry.get("limit").unwrap());
        assert!(!idle.frozen && !idle.auto_frozen);
        assert!(limit.frozen && limit.auto_frozen);
        assert!(!is_marked("idle"), "a woken chat forgets its mark");
    }

    #[tokio::test]
    async fn the_freeze_leaves_needs_continue_off_and_marks_the_pair() {
        let _data = OwnData::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_awaiting("a", Some("done".into()));
        freeze(&state, "a").await;
        let i = state.registry.get("a").unwrap();
        assert!(i.frozen && i.auto_frozen);
        assert!(is_idle_freeze(&i, 0), "the sweep marks what it froze");
        assert!(!i.frozen_needs_continue, "an idle freeze cancels no turn, so unfreeze must not send continue");
    }

    #[tokio::test]
    async fn the_marker_follows_the_freeze_and_every_path_that_clears_it() {
        let _data = OwnData::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_awaiting("a", Some("done".into()));
        assert_eq!(state.registry.get("a").unwrap().idle_frozen, None);
        freeze(&state, "a").await;
        assert_eq!(state.registry.get("a").unwrap().idle_frozen, Some(true), "the sweep's own freeze carries the marker");

        assert!(wake(&state, "a"));
        let woke = state.registry.get("a").unwrap();
        assert_eq!(woke.idle_frozen, None, "a wake clears the marker with the freeze");
        assert!(!is_marked("a"));

        freeze(&state, "a").await;
        state.registry.set_frozen("a", false);
        state.registry.set_auto_frozen("a", false);
        forget(&state, "a");
        let gone = state.registry.get("a").unwrap();
        assert_eq!(gone.idle_frozen, None);
        assert!(!is_marked("a"), "forget drops the stored mark too");
    }

    #[tokio::test]
    async fn the_sweep_repairs_a_marker_that_drifted_from_the_stored_marks() {
        let _data = OwnData::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("a", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        state.registry.set_frozen("a", true);
        state.registry.set_auto_frozen("a", true);
        assert!(mark("a"));
        // Marked on disk but the row has no marker: the sync gives it back.
        let rows = vec![(state.registry.get("a").unwrap(), Facts::default())];
        assert!(sync_markers(&state.registry, &rows), "a repaired row is reported so the clients get told");
        assert_eq!(state.registry.get("a").unwrap().idle_frozen, Some(true));
        let rows = vec![(state.registry.get("a").unwrap(), Facts::default())];
        assert!(!sync_markers(&state.registry, &rows), "a row already in step reports nothing");
        // The frozen flags went by some other path: the marker goes with them.
        state.registry.set_frozen("a", false);
        state.registry.set_auto_frozen("a", false);
        let rows = vec![(state.registry.get("a").unwrap(), Facts::default())];
        assert!(sync_markers(&state.registry, &rows));
        assert_eq!(state.registry.get("a").unwrap().idle_frozen, None);
    }

    #[test]
    fn a_restored_automatic_freeze_gets_its_marker_only_when_the_sweep_marked_it() {
        let _data = OwnData::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        for id in ["idle", "limit"] {
            state.registry.upsert_interactive(id, std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        }
        assert!(mark("idle"));
        restore_marker(&state.registry, "idle");
        restore_marker(&state.registry, "limit");
        assert_eq!(state.registry.get("idle").unwrap().idle_frozen, Some(true));
        assert_eq!(state.registry.get("limit").unwrap().idle_frozen, None);
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
