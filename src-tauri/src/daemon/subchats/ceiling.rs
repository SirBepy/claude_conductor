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

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use chrono::{DateTime, Duration, Utc};
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

fn with_entry<R>(sub_id: &str, f: impl FnOnce(&mut Entry) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_default())
}

fn forget(sub_id: &str) {
    if let Some(map) = TABLE.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        map.remove(sub_id);
    }
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
    if cursor.path.as_deref() != Some(path) {
        *cursor = Cursor { path: Some(path.to_path_buf()), ..Cursor::default() };
    }
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < cursor.offset {
        *cursor = Cursor { path: Some(path.to_path_buf()), ..Cursor::default() };
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
        // A sub waiting on Joe is not working, so his thinking time is not its busy time.
        let waiting = crate::daemon::lifecycle::has_open_prompt(state, &id).await;
        let counting = inst.busy && !waiting && !super::pause::is_paused(&inst, now_ts);
        let due = with_entry(&id, |e| {
            let elapsed = e.last_tick.map_or(Duration::zero(), |t| (env.now - t).max(Duration::zero()).min(MAX_TICK));
            e.last_tick = Some(env.now);
            if counting {
                e.busy += elapsed;
            }
            let calls = (env.calls)(&inst, &mut e.cursor).unwrap_or(e.cursor.calls);
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

    #[tokio::test]
    async fn keep_going_after_an_overshoot_clears_the_figure_instead_of_asking_again_at_once() {
        let (st, sub) = busy_sub("ceil-over");
        let base = Utc::now();
        tick(&st, base, 0, 650).await;
        apply_answer(&st, &sub, CardAnswer::Picked(KEEP_GOING.into()));
        assert!(tick(&st, base, 1, 651).await.is_empty(), "650 is past 600, so the next ceiling is 900");
    }

    #[tokio::test]
    async fn skip_keeps_the_sub_going_and_stop_ends_it() {
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
