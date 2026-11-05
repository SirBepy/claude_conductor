//! A ceiling on each sub: past [`CALLS_STEP`] model calls or [`BUSY_STEP`] of busy
//! time, Joe gets a card, keep going or stop, instead of the sub being killed
//! (spec section 9). A rate limit blocks the whole account, so this is also what
//! stops a runaway sub from burning it.
//!
//! The check rides `busy_watchdog`'s 60 second tick, like the stuck sweep.
//!
//! How the two figures are counted, and how far to trust them:
//! - **Model calls** are the distinct `message.id` values on the main thread of
//!   the sub's transcript, which is one per API response however many content
//!   blocks (text, several tool calls) the response was written as. They are read
//!   incrementally: the first look reads the whole file, each later tick reads
//!   only what was appended. This is exact for the main thread, and it undercounts
//!   a sub's own built-in subagents, whose calls land in separate files. After a
//!   daemon restart the count is rebuilt from the file, so it does not reset.
//! - **Busy time** is sampled: each tick adds the time since the previous tick
//!   when the sub is busy, not paused and not waiting on a card. It is accurate to
//!   about a tick (a minute) per busy stretch, it never counts frozen, idle or
//!   waiting time, and it restarts from zero when the daemon does, so it can
//!   undercount across a restart. A gap longer than [`MAX_TICK`] (the machine
//!   slept) adds only [`MAX_TICK`].
//!
//! One card per crossing: while a sub's card is up it raises no other, and
//! answering moves the ceiling up so the same crossing never draws a second.
//!
//! What a restart must not forget is stored per sub in
//! `<data_dir>/subchats/<sub_id>.ceiling.json`: the raised limits, and where the
//! current round starts in the transcript. Without it, "Keep going" would be asked
//! again after every restart for a sub already past 300 calls.
//!
//! A round is one stretch of work between a spawn or a continue and the next
//! finish. A continued sub is a new job, so its call count starts at the continue
//! (the transcript offset recorded then), not at the sub's first message.

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Model calls before the first card, and the amount "Keep going" adds. Joe's
/// numbers, from the measured p90 of 138 calls for subagents and 360 for chats.
pub const CALLS_STEP: u64 = 300;
/// Busy time before the first card, and the amount "Keep going" adds.
pub const BUSY_STEP: Duration = Duration::hours(3);
/// The most one tick may add to the busy clock.
pub const MAX_TICK: Duration = Duration::minutes(2);

/// `card_kind` of the ceiling card.
pub const KIND: &str = "subchat_ceiling";
pub const KEEP_GOING: &str = "Keep going";
pub const STOP_IT: &str = "Stop it";

/// Where the incremental transcript read stands.
#[derive(Default, Clone, Debug)]
pub struct Cursor {
    path: Option<PathBuf>,
    /// Where this round starts in the transcript: bytes before it are not counted.
    floor: u64,
    offset: u64,
    last_id: Option<String>,
    calls: u64,
}

struct Entry {
    calls_limit: u64,
    busy_limit: Duration,
    busy: Duration,
    last_tick: Option<DateTime<Utc>>,
    /// A card for this crossing is up (or being raised).
    carded: bool,
    cursor: Cursor,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            calls_limit: CALLS_STEP,
            busy_limit: BUSY_STEP,
            busy: Duration::zero(),
            last_tick: None,
            carded: false,
            cursor: Cursor::default(),
        }
    }
}

static TABLE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

/// What survives a restart of one entry.
#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
struct Saved {
    #[serde(default)]
    calls_limit: u64,
    #[serde(default)]
    busy_limit_secs: i64,
    #[serde(default)]
    start_offset: u64,
}

fn saved_path(root: &std::path::Path, sub_id: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.ceiling.json", super::decisions::file_stem(sub_id)))
}

impl Entry {
    fn from_saved(saved: Saved) -> Self {
        let mut e = Entry::default();
        if saved.calls_limit >= CALLS_STEP {
            e.calls_limit = saved.calls_limit;
        }
        if saved.busy_limit_secs >= BUSY_STEP.num_seconds() {
            e.busy_limit = Duration::seconds(saved.busy_limit_secs);
        }
        e.cursor = Cursor { floor: saved.start_offset, offset: saved.start_offset, ..Cursor::default() };
        e
    }

    fn to_saved(&self) -> Saved {
        Saved { calls_limit: self.calls_limit, busy_limit_secs: self.busy_limit.num_seconds(), start_offset: self.cursor.floor }
    }
}

fn load(sub_id: &str) -> Entry {
    let saved = super::decisions::data_root()
        .and_then(|root| std::fs::read_to_string(saved_path(&root, sub_id)).ok())
        .and_then(|raw| serde_json::from_str::<Saved>(&raw).ok());
    saved.map_or_else(Entry::default, Entry::from_saved)
}

/// Writes the entry's limits and round start, or removes the file when they are
/// the defaults, so only a sub that has something to remember has a file.
fn save(sub_id: &str, entry: &Entry) {
    let Some(root) = super::decisions::data_root() else { return };
    let path = saved_path(&root, sub_id);
    let saved = entry.to_saved();
    let defaults = Saved { calls_limit: CALLS_STEP, busy_limit_secs: BUSY_STEP.num_seconds(), start_offset: 0 };
    if saved == defaults {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let written = serde_json::to_string(&saved).map_err(std::io::Error::other).and_then(|json| crate::util::write_json_atomic(&path, &json));
    if let Err(e) = written {
        log::warn!("subchats: could not store the ceiling for {sub_id}: {e}");
    }
}

fn with_entry<R>(sub_id: &str, f: impl FnOnce(&mut Entry) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_insert_with(|| load(sub_id)))
}

/// The sub is gone for good: its bookkeeping and its stored limits go with it.
fn forget(sub_id: &str) {
    if let Some(map) = TABLE.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        map.remove(sub_id);
    }
    if let Some(root) = super::decisions::data_root() {
        let _ = std::fs::remove_file(saved_path(&root, sub_id));
    }
}

/// [`forget`] for the other modules: the sub was ended.
pub(super) fn forget_stored(sub_id: &str) {
    forget(sub_id);
}

/// A finished sub was continued: its next stretch is a new job. The call count,
/// the busy clock and both limits start over, counting from `start_offset` (the
/// transcript's length now), so a sub continued many times does not reach the
/// ceiling on the sum of its rounds.
pub fn start_round(sub_id: &str, start_offset: u64) {
    with_entry(sub_id, |e| {
        *e = Entry::from_saved(Saved { calls_limit: CALLS_STEP, busy_limit_secs: BUSY_STEP.num_seconds(), start_offset });
        save(sub_id, e);
    });
}

/// [`start_round`] from the sub's transcript as it stands.
pub fn on_continued(state: &DaemonState, sub_id: &str) {
    let len = crate::context_status::resolve_transcript(&state.registry, sub_id)
        .and_then(|path| std::fs::metadata(path).ok())
        .map_or(0, |m| m.len());
    start_round(sub_id, len);
}

/// Counts the model calls in `appended` (whole lines of a transcript) into
/// `cursor`. Sidechain lines (a subagent's own thread, in the files that mix
/// them) are not the sub's calls. Consecutive lines with one `message.id` are one
/// API response written as several content blocks.
pub fn count_calls(appended: &str, cursor: &mut Cursor) {
    for line in appended.lines() {
        // Cheap filter before parsing: most lines are tool results and user turns.
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v["type"].as_str() != Some("assistant") || v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let Some(id) = v["message"]["id"].as_str() else { continue };
        if cursor.last_id.as_deref() != Some(id) {
            cursor.calls += 1;
            cursor.last_id = Some(id.to_string());
        }
    }
}

/// Reads what was appended to `path` since the last look and counts it. Returns
/// the running total, or `None` when the file cannot be read. A file that shrank
/// or was swapped starts over. A trailing partial line waits for the next tick.
pub fn read_calls(path: &std::path::Path, cursor: &mut Cursor) -> Option<u64> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if cursor.path.as_deref() != Some(path) || len < cursor.offset {
        // A new file, or one that shrank: start over from the round's first byte,
        // or from the top when the file is shorter than that (it was replaced).
        let floor = if len >= cursor.floor { cursor.floor } else { 0 };
        *cursor = Cursor { path: Some(path.to_path_buf()), floor, offset: floor, ..Cursor::default() };
    }
    if len > cursor.offset {
        file.seek(SeekFrom::Start(cursor.offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(len - cursor.offset).read_to_end(&mut bytes).ok()?;
        // Only up to the last newline: a half-written line is read whole next time.
        let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        count_calls(&String::from_utf8_lossy(&bytes[..whole]), cursor);
        cursor.offset += whole as u64;
    }
    Some(cursor.calls)
}

/// Everything the sweep reads from outside the registry, injected so a test runs
/// it on a fake clock with no transcript on disk.
pub struct Env<'a> {
    pub now: DateTime<Utc>,
    /// The sub's total model calls so far. Production reads its transcript.
    pub calls: &'a (dyn Fn(&Instance, &mut Cursor) -> Option<u64> + Sync),
}

/// Why a card is due, in the card's own words.
fn reasons(calls: u64, calls_limit: u64, busy: Duration, busy_limit: Duration) -> Vec<String> {
    let mut out = Vec::new();
    if calls >= calls_limit {
        out.push(format!("{calls} model calls (ceiling {calls_limit})"));
    }
    if busy >= busy_limit {
        out.push(format!("{} of work (ceiling {})", hours(busy), hours(busy_limit)));
    }
    out
}

fn hours(d: Duration) -> String {
    let m = d.num_minutes();
    if m >= 60 && m % 60 != 0 {
        format!("{}h {}m", m / 60, m % 60)
    } else if m >= 60 {
        format!("{}h", m / 60)
    } else {
        format!("{m}m")
    }
}

fn label(state: &DaemonState, sub_id: &str) -> String {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "A sub".to_string())
}

/// Counts every running sub and raises a card for each one past a ceiling that
/// has none. Returns the ids carded.
pub async fn sweep(state: &Arc<DaemonState>, env: &Env<'_>) -> Vec<String> {
    let now_ts = env.now.timestamp();
    let mut carded = Vec::new();
    for inst in state.registry.list() {
        let id = inst.session_id.clone();
        let Some(parent) = inst.subchat_of.clone() else { continue };
        if inst.ended_at.is_some() || inst.subchat_finished {
            continue;
        }
        // A sub queued behind another has not run, so there is nothing to count.
        if super::held::is_held(&id) {
            continue;
        }
        // A sub waiting on Joe is not working, so his thinking time is not its busy time.
        let waiting = crate::daemon::lifecycle::has_open_prompt(state, &id).await;
        let counting = inst.busy && !waiting && !super::pause::is_paused(&inst, now_ts);
        // The first look at a long transcript reads all of it. Do that on a copy of
        // the cursor with the table free, so no other sub's bookkeeping waits.
        let mut cursor = with_entry(&id, |e| e.cursor.clone());
        let read = (env.calls)(&inst, &mut cursor);
        let due = with_entry(&id, |e| {
            e.cursor = cursor;
            let elapsed = e.last_tick.map_or(Duration::zero(), |t| (env.now - t).max(Duration::zero()).min(MAX_TICK));
            e.last_tick = Some(env.now);
            if counting {
                e.busy += elapsed;
            }
            let calls = read.unwrap_or(e.cursor.calls);
            if e.carded || (calls < e.calls_limit && e.busy < e.busy_limit) {
                return None;
            }
            e.carded = true;
            Some((calls, e.calls_limit, e.busy, e.busy_limit))
        });
        let Some((calls, calls_limit, busy, busy_limit)) = due else { continue };
        if raise(state, &id, &parent, calls, calls_limit, busy, busy_limit).await {
            carded.push(id);
        } else {
            with_entry(&id, |e| e.carded = false);
        }
    }
    carded
}

async fn raise(
    state: &Arc<DaemonState>,
    sub_id: &str,
    parent: &str,
    calls: u64,
    calls_limit: u64,
    busy: Duration,
    busy_limit: Duration,
) -> bool {
    if cards::open_card_for(state, KIND, sub_id).await.is_some() {
        return true;
    }
    let why = reasons(calls, calls_limit, busy, busy_limit).join(" and ");
    let card = RaisedCard {
        kind: KIND,
        display_session_id: parent.to_string(),
        sub_id: Some(sub_id.to_string()),
        header: "Sub past its ceiling".to_string(),
        question: format!(
            "**{}** has used {why}. That is a lot for one job.\n\nShould it keep going?",
            label(state, sub_id)
        ),
        options: vec![
            CardOption::new(KEEP_GOING, "Raise the ceiling by the same amount"),
            CardOption::new(STOP_IT, "End it for good"),
        ],
        domain: None,
    };
    match cards::raise_card(state, card).await {
        Ok(handle) => {
            let (state, sub) = (state.clone(), sub_id.to_string());
            handle.on_answer(move |answer| async move { apply_answer(&state, &sub, answer) });
            true
        }
        Err(e) => {
            log::warn!("subchats: could not raise the ceiling card for {sub_id}: {e}");
            false
        }
    }
}

/// "Stop it" ends the sub. "Keep going" raises the ceiling that was crossed by
/// its own step again, until it is clear of the figure, so a late tick that
/// overshot by a whole step does not draw the next card at once. A Skip, or a card
/// withdrawn for any other reason, counts as keep going: nothing is stopped that
/// Joe did not choose, and the next card is a full step away instead of a minute.
pub(crate) fn apply_answer(state: &Arc<DaemonState>, sub_id: &str, answer: CardAnswer) {
    if matches!(&answer, CardAnswer::Picked(p) if p == STOP_IT) {
        super::end_sub(state, sub_id);
        forget(sub_id);
        return;
    }
    with_entry(sub_id, |e| {
        while e.cursor.calls >= e.calls_limit {
            e.calls_limit += CALLS_STEP;
        }
        while e.busy >= e.busy_limit {
            e.busy_limit = e.busy_limit + BUSY_STEP;
        }
        e.carded = false;
        save(sub_id, e);
    });
}

/// The production sweep, called from the busy watchdog's tick.
pub async fn sweep_now(state: &Arc<DaemonState>, now: DateTime<Utc>) {
    let calls = |inst: &Instance, cursor: &mut Cursor| {
        let path = crate::context_status::resolve_transcript(&state.registry, &inst.session_id)?;
        read_calls(&path, cursor)
    };
    let env = Env { now, calls: &calls };
    for id in sweep(state, &env).await {
        log::warn!("subchats: sub {id} is past its ceiling, raised a card");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn busy_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        st.registry.set_name(&sub, "header".into());
        st.registry.set_busy(&sub, true);
        (st, sub)
    }

    /// One tick at `base + minute`, with the sub reporting `calls` model calls.
    async fn tick(st: &Arc<DaemonState>, base: DateTime<Utc>, minute: i64, calls: u64) -> Vec<String> {
        let reader = AtomicU64::new(calls);
        let read = |_: &Instance, c: &mut Cursor| {
            c.calls = reader.load(Ordering::SeqCst);
            Some(c.calls)
        };
        sweep(st, &Env { now: base + Duration::minutes(minute), calls: &read }).await
    }

    async fn the_card(st: &Arc<DaemonState>) -> Option<serde_json::Value> {
        st.list_prompts().await.into_iter().find(|p| p["payload"]["card_kind"] == KIND)
    }

    #[tokio::test]
    async fn the_calls_ceiling_fires_at_the_named_count_and_not_before() {
        assert_eq!(CALLS_STEP, 300);
        let (st, sub) = busy_sub("ceil-calls");
        let base = Utc::now();
        assert!(tick(&st, base, 0, 299).await.is_empty(), "299 calls is under the ceiling");
        assert!(the_card(&st).await.is_none());
        assert_eq!(tick(&st, base, 1, 300).await, [sub], "300 is the ceiling");
        let card = the_card(&st).await.expect("a card");
        assert_eq!(card["payload"]["display_session_id"], "ceil-calls-main");
        assert_eq!(card["payload"]["sub_id"], "ceil-calls-sub");
        let q = card["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(q.contains("300 model calls"), "{q}");
        let labels: Vec<&str> =
            card["payload"]["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, [KEEP_GOING, STOP_IT]);
    }

    #[tokio::test]
    async fn a_sub_queued_behind_another_is_never_over_the_ceiling() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-held");
        crate::daemon::subchats::held::hold(
            &st,
            crate::daemon::subchats::held::Held {
                sub_id: sub.clone(),
                reason: "waiting for header".into(),
                after: Some("ceil-held-target".into()),
                after_name: "header".into(),
                launch: crate::daemon::subchats::held::LaunchSpec {
                    cwd: std::path::PathBuf::from("."),
                    model: "sonnet".into(),
                    effort: "high".into(),
                    account_id: None,
                    first_message: "go".into(),
                },
            },
        )
        .unwrap();
        let base = Utc::now();
        // Figures that would card a running sub at once: it has not run.
        assert!(tick(&st, base, 0, 10_000).await.is_empty());
        assert!(the_card(&st).await.is_none());
        crate::daemon::subchats::held::release(&st, &sub);
        assert_eq!(tick(&st, base, 1, 10_000).await, [sub], "released, the ordinary ceiling applies again");
    }

    #[tokio::test]
    async fn the_busy_time_ceiling_fires_at_three_hours_and_not_before() {
        assert_eq!(BUSY_STEP, Duration::hours(3));
        let (st, sub) = busy_sub("ceil-time");
        let base = Utc::now();
        // One tick a minute: 179 minutes busy is under, the 180th crosses.
        for m in 0..=179 {
            assert!(tick(&st, base, m, 5).await.is_empty(), "minute {m}");
        }
        assert!(the_card(&st).await.is_none(), "179 minutes of busy time is under three hours");
        assert_eq!(tick(&st, base, 180, 5).await, [sub]);
        let q = the_card(&st).await.unwrap()["payload"]["questions"][0]["question"].as_str().unwrap().to_string();
        assert!(q.contains("3h of work"), "{q}");
    }

    #[tokio::test]
    async fn frozen_idle_waiting_and_parked_time_does_not_count_as_busy_time() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let base = Utc::now();
        // Idle: not busy.
        let (st, sub) = busy_sub("ceil-idle");
        st.registry.set_busy(&sub, false);
        for m in 0..=400 {
            assert!(tick(&st, base, m, 5).await.is_empty());
        }
        // Frozen.
        let (st, sub) = busy_sub("ceil-frozen");
        st.registry.set_frozen(&sub, true);
        for m in 0..=400 {
            assert!(tick(&st, base, m, 5).await.is_empty());
        }
        // Parked by gaming mode.
        let (st, sub) = busy_sub("ceil-parked");
        crate::daemon::gaming_mode::set_file_for_test(&[&sub]);
        for m in 0..=400 {
            assert!(tick(&st, base, m, 5).await.is_empty());
        }
        crate::daemon::gaming_mode::set_file_for_test(&[]);
        // Waiting on a card of its own.
        let (st, sub) = busy_sub("ceil-waiting");
        st.add_prompt("q-ceil", "question-requested", serde_json::json!({"session_id": sub, "seq": 1}), true).await;
        for m in 0..=400 {
            assert!(tick(&st, base, m, 5).await.is_empty());
        }
        // Rate limited.
        let (st, sub) = busy_sub("ceil-rate");
        st.registry.set_account(&sub, "acct");
        st.registry.set_rate_limited_for_account("acct", base.timestamp() + 20 * 3600, "five_hour");
        for m in 0..=400 {
            assert!(tick(&st, base, m, 5).await.is_empty());
        }
    }

    #[tokio::test]
    async fn a_machine_sleep_adds_one_tick_not_the_whole_gap() {
        let (st, _sub) = busy_sub("ceil-sleep");
        let base = Utc::now();
        tick(&st, base, 0, 5).await;
        // Ten hours pass between two ticks: the machine slept.
        assert!(tick(&st, base, 600, 5).await.is_empty(), "the gap is capped at one tick");
    }

    #[tokio::test]
    async fn one_crossing_draws_one_card_however_many_ticks_see_it() {
        let (st, _sub) = busy_sub("ceil-once");
        let base = Utc::now();
        assert_eq!(tick(&st, base, 0, 301).await.len(), 1);
        for m in 1..20 {
            assert!(tick(&st, base, m, 320 + m as u64).await.is_empty(), "the open card is not repeated");
        }
        assert_eq!(st.list_prompts().await.len(), 1);
    }

    /// Joe's pick on the open ceiling card, through the card's own answer path.
    async fn answer_card(st: &Arc<DaemonState>, pick: Option<&str>) {
        let card = the_card(st).await.expect("a ceiling card is up");
        let id = card["id"].as_str().unwrap().to_string();
        match pick {
            Some(p) => {
                let mut answers = serde_json::Map::new();
                answers.insert(card["payload"]["questions"][0]["question"].as_str().unwrap().to_string(), serde_json::json!(p));
                crate::daemon::methods::permission::respond_question_inner(st, &id, serde_json::Value::Object(answers), false).await;
            }
            None => {
                crate::daemon::methods::permission::respond_question_inner(st, &id, serde_json::json!({}), true).await;
            }
        }
        // The answer task runs detached.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn keep_going_raises_the_ceiling_by_the_same_amount_and_the_next_crossing_is_a_new_card() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-keep");
        let base = Utc::now();
        tick(&st, base, 0, 300).await;
        answer_card(&st, Some(KEEP_GOING)).await;
        assert!(the_card(&st).await.is_none(), "the answered card is gone");
        assert!(tick(&st, base, 1, 301).await.is_empty(), "300 more calls are allowed");
        assert!(tick(&st, base, 2, 599).await.is_empty());
        assert_eq!(tick(&st, base, 3, 600).await, [sub], "the ceiling is now 600");
        assert!(the_card(&st).await.is_some(), "a genuinely new card, since the first was answered");
    }

    /// What a daemon restart does to the table: the in-memory entry is gone.
    fn simulate_restart(sub_id: &str) {
        if let Some(map) = TABLE.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            map.remove(sub_id);
        }
    }

    #[tokio::test]
    async fn keep_going_survives_a_daemon_restart() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-restart");
        let base = Utc::now();
        tick(&st, base, 0, 300).await;
        answer_card(&st, Some(KEEP_GOING)).await;
        simulate_restart(&sub);
        assert!(tick(&st, base, 5, 301).await.is_empty(), "Joe said keep going; a restart must not ask again at 300");
        assert!(the_card(&st).await.is_none());
        simulate_restart(&sub);
        assert_eq!(tick(&st, base, 6, 600).await, [sub], "the raised ceiling of 600 is still the one that fires");
    }

    /// A sub continued after it finished is on a new job, so its 300 calls count
    /// from the continue. Counted from its first message, a sub continued a few
    /// times would be carded for work Joe already saw finish.
    #[tokio::test]
    async fn a_continued_sub_counts_its_calls_from_the_continue_and_keeps_the_count_across_a_restart() {
        use std::io::Write;
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-round");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let append = |from: usize, n: usize| {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
            for i in from..from + n {
                writeln!(f, "{}", line(&format!("msg_{i}"), "")).unwrap();
            }
        };
        let read = |_: &Instance, c: &mut Cursor| read_calls(&path, c);
        let base = Utc::now();
        let sweep_at = |minute: i64| {
            let (st, read) = (st.clone(), &read);
            async move { sweep(&st, &Env { now: base + Duration::minutes(minute), calls: read }).await }
        };

        // Round one ran 400 calls and finished; Joe continues the sub.
        append(0, 400);
        start_round(&sub, std::fs::metadata(&path).unwrap().len());
        assert!(sweep_at(0).await.is_empty(), "400 calls from the last round are not this round's");

        append(400, 100);
        assert!(sweep_at(1).await.is_empty());
        simulate_restart(&sub);
        assert!(sweep_at(2).await.is_empty(), "after a restart the round still starts at the continue");
        assert_eq!(with_entry(&sub, |e| e.cursor.calls), 100, "the count did not fall back to 0 or jump to the lifetime 500");

        append(500, 200);
        assert_eq!(sweep_at(3).await, [sub.clone()], "300 calls into this round");
    }

    #[test]
    fn a_stopped_sub_leaves_no_stored_limits_behind() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let root = crate::daemon::subchats::decisions::data_root().unwrap();
        start_round("ceil-forget", 1234);
        assert!(saved_path(&root, "ceil-forget").exists());
        forget("ceil-forget");
        assert!(!saved_path(&root, "ceil-forget").exists());
        // A round that starts at the top with default limits has nothing to remember.
        start_round("ceil-nothing", 0);
        assert!(!saved_path(&root, "ceil-nothing").exists());
    }

    #[tokio::test]
    async fn the_transcript_is_read_without_holding_the_table_lock() {
        let (st, _sub) = busy_sub("ceil-lock");
        let free_at_some_point = std::sync::atomic::AtomicBool::new(false);
        let read = |_: &Instance, c: &mut Cursor| {
            // The first look at a long transcript reads all of it, and the tick must
            // not make every other sub's bookkeeping wait for that. Another test's
            // brief hold of the table is not ours, so try a few times.
            for _ in 0..200 {
                if TABLE.try_lock().is_ok() {
                    free_at_some_point.store(true, Ordering::SeqCst);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            c.calls = 5;
            Some(5)
        };
        sweep(&st, &Env { now: Utc::now(), calls: &read }).await;
        assert!(free_at_some_point.load(Ordering::SeqCst), "the table lock was held across the transcript read");
    }

    #[tokio::test]
    async fn keep_going_after_an_overshoot_clears_the_figure_instead_of_asking_again_at_once() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-over");
        let base = Utc::now();
        tick(&st, base, 0, 650).await;
        apply_answer(&st, &sub, CardAnswer::Picked(KEEP_GOING.into()));
        assert!(tick(&st, base, 1, 651).await.is_empty(), "650 is past 600, so the next ceiling is 900");
    }

    #[tokio::test]
    async fn skip_keeps_the_sub_going_and_stop_ends_it() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-skip");
        let base = Utc::now();
        tick(&st, base, 0, 300).await;
        answer_card(&st, None).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_none());
        assert!(tick(&st, base, 1, 301).await.is_empty(), "a Skip is not a minute-by-minute nag");

        let (st, sub) = busy_sub("ceil-stop");
        tick(&st, base, 0, 300).await;
        answer_card(&st, Some(STOP_IT)).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_some(), "Stop goes through end_sub");
        assert!(tick(&st, base, 1, 900).await.is_empty(), "an ended sub is not counted again");
    }

    #[tokio::test]
    async fn busy_time_crossing_is_re_armed_by_keep_going_too() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, _sub) = busy_sub("ceil-time-keep");
        let base = Utc::now();
        for m in 0..=180 {
            tick(&st, base, m, 5).await;
        }
        assert!(the_card(&st).await.is_some());
        answer_card(&st, Some(KEEP_GOING)).await;
        for m in 181..=359 {
            assert!(tick(&st, base, m, 5).await.is_empty(), "minute {m}");
        }
        assert_eq!(tick(&st, base, 360, 5).await.len(), 1, "another three hours on, the ceiling is crossed again");
        assert!(the_card(&st).await.is_some());
    }

    #[tokio::test]
    async fn finished_ended_and_ordinary_chats_are_never_counted() {
        let base = Utc::now();
        let (st, sub) = busy_sub("ceil-fin");
        st.registry.set_subchat_finished(&sub, true);
        assert!(tick(&st, base, 0, 900).await.is_empty());
        let (st, sub) = busy_sub("ceil-end");
        st.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(tick(&st, base, 0, 900).await.is_empty());
        let (st, _sub) = busy_sub("ceil-plain");
        st.registry.set_subchat_of("ceil-plain-sub", None);
        assert!(tick(&st, base, 0, 900).await.is_empty());
    }

    // ---- the transcript counter ----------------------------------------------

    fn line(id: &str, extra: &str) -> String {
        format!(r#"{{"type":"assistant"{extra},"message":{{"id":"{id}","role":"assistant","content":[]}}}}"#)
    }

    #[test]
    fn one_api_response_written_as_several_lines_is_one_call() {
        let mut c = Cursor::default();
        let text = [line("msg_1", ""), line("msg_1", ""), r#"{"type":"user","message":{}}"#.to_string(), line("msg_2", ""), line("msg_2", ""), line("msg_3", "")]
            .join("\n");
        count_calls(&text, &mut c);
        assert_eq!(c.calls, 3);
    }

    #[test]
    fn a_subagents_sidechain_lines_and_lines_without_an_id_are_not_the_subs_calls() {
        let mut c = Cursor::default();
        let text = [line("msg_1", ""), line("msg_x", r#","isSidechain":true"#), r#"{"type":"assistant","message":{"role":"assistant"}}"#.to_string(), "not json \"assistant\"".to_string()]
            .join("\n");
        count_calls(&text, &mut c);
        assert_eq!(c.calls, 1);
    }

    #[test]
    fn the_reader_picks_up_only_what_was_appended_and_waits_for_a_whole_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}\n", line("a", ""), line("b", ""))).unwrap();
        let mut c = Cursor::default();
        assert_eq!(read_calls(&path, &mut c), Some(2));
        assert_eq!(read_calls(&path, &mut c), Some(2), "nothing new, nothing counted twice");
        // A line half written when the tick lands.
        let full = line("c", "");
        let half = &full[..full.len() / 2];
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        write!(f, "{half}").unwrap();
        assert_eq!(read_calls(&path, &mut c), Some(2), "a partial line is left for the next tick");
        writeln!(f, "{}", &full[full.len() / 2..]).unwrap();
        assert_eq!(read_calls(&path, &mut c), Some(3));
        // The file is replaced by a shorter one: start over rather than skip it.
        std::fs::write(&path, format!("{}\n", line("z", ""))).unwrap();
        assert_eq!(read_calls(&path, &mut c), Some(1));
        assert_eq!(read_calls(&dir.path().join("missing.jsonl"), &mut c), None);
    }
}
