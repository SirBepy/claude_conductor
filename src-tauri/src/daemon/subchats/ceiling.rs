//! Two cards about a running sub, both read from its transcript on `busy_watchdog`'s
//! 60 second tick, like the stuck sweep:
//!
//! - **A ceiling of [`CALLS_STEP`] model calls**: Joe gets a card, keep going or
//!   stop, instead of the sub being killed (spec section 9). A rate limit blocks
//!   the whole account, so this is also what stops a runaway sub from burning it.
//! - **Context nearly full** (at [`CONTEXT_WARN_PERCENT`] of the window): the one
//!   thing that makes a long job go wrong.
//!
//! How long a sub has been working is deliberately NOT a trigger. A "running for 3
//! hours" card told Joe nothing he could act on (2026-11-12): a sub on a long job
//! with room left in its context is fine.
//!
//! How the figures are counted, and how far to trust them:
//! - **Model calls** are the distinct `message.id` values on the main thread of
//!   the sub's transcript, which is one per API response however many content
//!   blocks (text, several tool calls) the response was written as. They are read
//!   incrementally: the first look reads the whole file, each later tick reads
//!   only what was appended. This is exact for the main thread, and it undercounts
//!   a sub's own built-in subagents, whose calls land in separate files. After a
//!   daemon restart the count is rebuilt from the file, so it does not reset.
//! - **Context** is the latest main-thread usage line (input plus cache read plus
//!   cache creation) scored by `context_status::score_parts`, the same window
//!   heuristic the status chip uses, so the card and the chip agree. It is read by
//!   the same incremental pass as the calls.
//!
//! One card per crossing: while a sub's card is up it raises no other, and
//! answering moves the ceiling up (or, for context, marks the sub warned) so the
//! same crossing never draws a second.
//!
//! What a restart must not forget is stored per sub in
//! `<data_dir>/subchats/<sub_id>.ceiling.json`: the raised call limit, whether the
//! context warning was given, and where the current round starts in the
//! transcript. Without it, "Keep going" would be asked again after every restart
//! for a sub already past 300 calls.
//!
//! A round is one stretch of work between a spawn or a continue and the next
//! finish. A continued sub is a new job, so its call count starts at the continue
//! (the transcript offset recorded then), not at the sub's first message, and its
//! context warning is armed again.

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Model calls before the first card, and the amount "Keep going" adds. Joe's
/// numbers, from the measured p90 of 138 calls for subagents and 360 for chats.
pub const CALLS_STEP: u64 = 300;
/// The share of the context window a sub may fill before Joe is told, in percent.
pub const CONTEXT_WARN_PERCENT: u64 = 90;

/// `card_kind` of the ceiling card.
pub const KIND: &str = "subchat_ceiling";
/// `card_kind` of the context warning.
pub const CONTEXT_KIND: &str = "subchat_context_low";
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
    /// The newest main-thread context size read, and the largest one (the window
    /// heuristic's sticky correction needs it), with the model of that line.
    occupancy: u64,
    max_occupancy: u64,
    model: String,
}

struct Entry {
    calls_limit: u64,
    /// A card for this sub is up (or being raised).
    carded: bool,
    /// The context warning was given this round, so it is not given again.
    context_warned: bool,
    cursor: Cursor,
}

impl Default for Entry {
    fn default() -> Self {
        Self { calls_limit: CALLS_STEP, carded: false, context_warned: false, cursor: Cursor::default() }
    }
}

static TABLE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

/// What survives a restart of one entry. A file an older build wrote may still
/// carry `busy_limit_secs`; it is ignored.
#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
struct Saved {
    #[serde(default)]
    calls_limit: u64,
    #[serde(default)]
    start_offset: u64,
    #[serde(default)]
    context_warned: bool,
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
        e.context_warned = saved.context_warned;
        e.cursor = Cursor { floor: saved.start_offset, offset: saved.start_offset, ..Cursor::default() };
        e
    }

    fn to_saved(&self) -> Saved {
        Saved { calls_limit: self.calls_limit, start_offset: self.cursor.floor, context_warned: self.context_warned }
    }
}

fn load(sub_id: &str) -> Entry {
    // A missing file is the defaults; a damaged one is kept aside, not overwritten blind.
    let saved = super::decisions::data_root().map(|root| super::jsonfile::read_or_keep::<Saved>(&saved_path(&root, sub_id)));
    saved.map_or_else(Entry::default, Entry::from_saved)
}

/// Writes the entry's limit, warning flag and round start, or removes the file
/// when they are the defaults, so only a sub that has something to remember has a
/// file.
fn save(sub_id: &str, entry: &Entry) {
    let Some(root) = super::decisions::data_root() else { return };
    let path = saved_path(&root, sub_id);
    let saved = entry.to_saved();
    let defaults = Saved { calls_limit: CALLS_STEP, start_offset: 0, context_warned: false };
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

/// A finished sub was continued: its next stretch is a new job. The call count and
/// the call limit start over, and the context warning is armed again, counting
/// from `start_offset` (the transcript's length now), so a sub continued many
/// times does not reach the ceiling on the sum of its rounds.
pub fn start_round(sub_id: &str, start_offset: u64) {
    with_entry(sub_id, |e| {
        *e = Entry::from_saved(Saved { calls_limit: CALLS_STEP, start_offset, context_warned: false });
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
/// `cursor`, and keeps the newest context size. Sidechain lines (a subagent's own
/// thread, in the files that mix them) are neither the sub's calls nor its
/// context. Consecutive lines with one `message.id` are one API response written
/// as several content blocks.
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
        // A zero usage row is the CLI's synthetic error line, not a real request.
        if let Some((occupancy, model)) = crate::context_status::usage_from_line(&v).filter(|(o, _)| *o > 0) {
            cursor.occupancy = occupancy;
            cursor.max_occupancy = cursor.max_occupancy.max(occupancy);
            if let Some(model) = model {
                cursor.model = model;
            }
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
/// it with no transcript on disk.
pub struct Env<'a> {
    /// Reads the sub's transcript into the cursor and returns its total model
    /// calls so far. Production reads the file.
    pub calls: &'a (dyn Fn(&Instance, &mut Cursor) -> Option<u64> + Sync),
}

/// The sub's context as the cursor last saw it: `(used, window)` in tokens. `None`
/// until a main-thread usage line with a model has been read.
fn context_of(cursor: &Cursor) -> Option<(u64, u64)> {
    if cursor.occupancy == 0 || cursor.model.is_empty() {
        return None;
    }
    let status = crate::context_status::score_parts(cursor.occupancy, cursor.max_occupancy, &cursor.model);
    Some((status.occupancy, status.window))
}

/// Whether `used` of `window` tokens is at or past the warning share. Integer
/// arithmetic, since a rounded percentage would warn a point early.
fn context_is_low(used: u64, window: u64) -> bool {
    window > 0 && used.saturating_mul(100) >= window.saturating_mul(CONTEXT_WARN_PERCENT)
}

/// What is due for one sub, with the figures its card shows.
enum Due {
    Calls { calls: u64, limit: u64 },
    Context { used: u64, window: u64 },
}

fn tokens(n: u64) -> String {
    if n >= 1_000_000 && n % 1_000_000 == 0 {
        format!("{}M", n / 1_000_000)
    } else {
        format!("{}K", n / 1000)
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

/// Reads every running sub's transcript and raises a card for each one past its
/// call ceiling or nearly out of context that has none. Returns the ids carded.
pub async fn sweep(state: &Arc<DaemonState>, env: &Env<'_>) -> Vec<String> {
    let mut carded = Vec::new();
    for inst in state.registry.list() {
        let id = inst.session_id.clone();
        let Some(parent) = inst.subchat_of.clone() else { continue };
        if inst.ended_at.is_some() || inst.subchat_finished {
            continue;
        }
        // A sub queued behind another has not run, so there is nothing to read.
        if super::held::is_held(&id) {
            continue;
        }
        // The first look at a long transcript reads all of it. Do that on a copy of
        // the cursor with the table free, so no other sub's bookkeeping waits.
        let mut cursor = with_entry(&id, |e| e.cursor.clone());
        let read = (env.calls)(&inst, &mut cursor);
        let due = with_entry(&id, |e| {
            e.cursor = cursor;
            // One card at a time per sub.
            if e.carded {
                return None;
            }
            let calls = read.unwrap_or(e.cursor.calls);
            if calls >= e.calls_limit {
                e.carded = true;
                return Some(Due::Calls { calls, limit: e.calls_limit });
            }
            let (used, window) = context_of(&e.cursor).filter(|(u, w)| !e.context_warned && context_is_low(*u, *w))?;
            // Marked in memory only: a raised card is dropped by a restart, and the
            // file must not claim a warning Joe never saw. The answer stores it.
            e.carded = true;
            e.context_warned = true;
            Some(Due::Context { used, window })
        });
        let Some(due) = due else { continue };
        if raise(state, &id, &parent, &due).await {
            carded.push(id);
        } else {
            with_entry(&id, |e| {
                e.carded = false;
                // A card that could not be drawn was not a warning given.
                if matches!(due, Due::Context { .. }) {
                    e.context_warned = false;
                }
            });
        }
    }
    carded
}

async fn raise(state: &Arc<DaemonState>, sub_id: &str, parent: &str, due: &Due) -> bool {
    let kind = match due {
        Due::Calls { .. } => KIND,
        Due::Context { .. } => CONTEXT_KIND,
    };
    if cards::open_card_for(state, kind, sub_id).await.is_some() {
        return true;
    }
    let name = label(state, sub_id);
    let (header, question, options) = match due {
        Due::Calls { calls, limit } => (
            "Sub past its ceiling",
            format!("**{name}** has used {calls} model calls (ceiling {limit}). That is a lot for one job.\n\nShould it keep going?"),
            vec![
                CardOption::new(KEEP_GOING, "Raise the ceiling by the same amount"),
                CardOption::new(STOP_IT, "End it for good"),
            ],
        ),
        Due::Context { used, window } => (
            "Sub is nearly out of context",
            format!(
                "**{name}** has filled {}% of its context window ({} of {} tokens). A sub that runs out of room can lose track of its earlier work.\n\nShould it keep going?",
                used.saturating_mul(100) / window.max(&1),
                tokens(*used),
                tokens(*window)
            ),
            vec![
                CardOption::new(KEEP_GOING, "It carries on, and you are not warned about it again"),
                CardOption::new(STOP_IT, "End it for good"),
            ],
        ),
    };
    let card = RaisedCard {
        kind,
        display_session_id: parent.to_string(),
        sub_id: Some(sub_id.to_string()),
        header: header.to_string(),
        question,
        options,
        domain: None,
    };
    let context = matches!(due, Due::Context { .. });
    match cards::raise_card(state, card).await {
        Ok(handle) => {
            let (state, sub) = (state.clone(), sub_id.to_string());
            handle.on_answer(move |answer| async move {
                if context {
                    apply_context_answer(&state, &sub, answer);
                } else {
                    apply_answer(&state, &sub, answer);
                }
            });
            true
        }
        Err(e) => {
            log::warn!("subchats: could not raise the {kind} card for {sub_id}: {e}");
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
        e.carded = false;
        save(sub_id, e);
    });
}

/// The context card's answer. "Stop it" ends the sub; anything else leaves it
/// running and stores that the warning was given, so the same sub is never warned
/// twice in a round, restarts included. A card still open at a restart is not
/// stored: it is gone, so the next tick raises it again.
pub(crate) fn apply_context_answer(state: &Arc<DaemonState>, sub_id: &str, answer: CardAnswer) {
    if matches!(&answer, CardAnswer::Picked(p) if p == STOP_IT) {
        super::end_sub(state, sub_id);
        forget(sub_id);
        return;
    }
    with_entry(sub_id, |e| {
        e.carded = false;
        e.context_warned = true;
        save(sub_id, e);
    });
}

/// The production sweep, called from the busy watchdog's tick.
pub async fn sweep_now(state: &Arc<DaemonState>) {
    let calls = |inst: &Instance, cursor: &mut Cursor| {
        let path = crate::context_status::resolve_transcript(&state.registry, &inst.session_id)?;
        read_calls(&path, cursor)
    };
    let env = Env { calls: &calls };
    for id in sweep(state, &env).await {
        log::warn!("subchats: sub {id} is past a ceiling or short of context, raised a card");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A 1M-window model, so 900K is the warning line.
    const BIG: &str = "claude-opus-4-8";

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

    /// One tick with the sub reporting `calls` model calls and a context of `used`
    /// tokens on `model` (0 for none read yet).
    async fn tick_ctx(st: &Arc<DaemonState>, calls: u64, used: u64, model: &str) -> Vec<String> {
        let reader = AtomicU64::new(calls);
        let read = |_: &Instance, c: &mut Cursor| {
            c.calls = reader.load(Ordering::SeqCst);
            c.occupancy = used;
            c.max_occupancy = c.max_occupancy.max(used);
            c.model = model.to_string();
            Some(c.calls)
        };
        sweep(st, &Env { calls: &read }).await
    }

    /// One tick with `calls` model calls and no context read.
    async fn tick(st: &Arc<DaemonState>, calls: u64) -> Vec<String> {
        tick_ctx(st, calls, 0, "").await
    }

    async fn the_card(st: &Arc<DaemonState>) -> Option<serde_json::Value> {
        st.list_prompts().await.into_iter().find(|p| p["payload"]["card_kind"] == KIND)
    }

    async fn the_context_card(st: &Arc<DaemonState>) -> Option<serde_json::Value> {
        st.list_prompts().await.into_iter().find(|p| p["payload"]["card_kind"] == CONTEXT_KIND)
    }

    #[tokio::test]
    async fn the_calls_ceiling_fires_at_the_named_count_and_not_before() {
        assert_eq!(CALLS_STEP, 300);
        let (st, sub) = busy_sub("ceil-calls");
        assert!(tick(&st, 299).await.is_empty(), "299 calls is under the ceiling");
        assert!(the_card(&st).await.is_none());
        assert_eq!(tick(&st, 300).await, [sub], "300 is the ceiling");
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
        // Figures that would card a running sub at once: it has not run.
        assert!(tick_ctx(&st, 10_000, 990_000, BIG).await.is_empty());
        assert!(the_card(&st).await.is_none() && the_context_card(&st).await.is_none());
        crate::daemon::subchats::held::release(&st, &sub);
        assert_eq!(tick(&st, 10_000).await, [sub], "released, the ordinary ceiling applies again");
    }

    /// Joe 2026-11-12: "this subchat has been running for 3 hours" is not a problem
    /// by itself. A sub busy for a day, with calls and context well under their
    /// lines, draws nothing.
    #[tokio::test]
    async fn a_sub_busy_for_many_hours_with_room_left_draws_no_card() {
        let (st, _sub) = busy_sub("ceil-long");
        for _ in 0..(24 * 60) {
            assert!(tick_ctx(&st, 5, 100_000, BIG).await.is_empty());
        }
        assert!(st.list_prompts().await.is_empty(), "a long run alone is never a card");
    }

    #[tokio::test]
    async fn one_crossing_draws_one_card_however_many_ticks_see_it() {
        let (st, _sub) = busy_sub("ceil-once");
        assert_eq!(tick(&st, 301).await.len(), 1);
        for m in 1..20 {
            assert!(tick(&st, 320 + m).await.is_empty(), "the open card is not repeated");
        }
        assert_eq!(st.list_prompts().await.len(), 1);
    }

    /// Joe's pick on the open card of `kind`, through the card's own answer path.
    async fn answer_card_of(st: &Arc<DaemonState>, kind: &str, pick: Option<&str>) {
        let card = st
            .list_prompts()
            .await
            .into_iter()
            .find(|p| p["payload"]["card_kind"] == kind)
            .expect("the card is up");
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

    async fn answer_card(st: &Arc<DaemonState>, pick: Option<&str>) {
        answer_card_of(st, KIND, pick).await;
    }

    #[tokio::test]
    async fn keep_going_raises_the_ceiling_by_the_same_amount_and_the_next_crossing_is_a_new_card() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-keep");
        tick(&st, 300).await;
        answer_card(&st, Some(KEEP_GOING)).await;
        assert!(the_card(&st).await.is_none(), "the answered card is gone");
        assert!(tick(&st, 301).await.is_empty(), "300 more calls are allowed");
        assert!(tick(&st, 599).await.is_empty());
        assert_eq!(tick(&st, 600).await, [sub], "the ceiling is now 600");
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
        tick(&st, 300).await;
        answer_card(&st, Some(KEEP_GOING)).await;
        simulate_restart(&sub);
        assert!(tick(&st, 301).await.is_empty(), "Joe said keep going; a restart must not ask again at 300");
        assert!(the_card(&st).await.is_none());
        simulate_restart(&sub);
        assert_eq!(tick(&st, 600).await, [sub], "the raised ceiling of 600 is still the one that fires");
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
        let sweep_once = || {
            let (st, read) = (st.clone(), &read);
            async move { sweep(&st, &Env { calls: read }).await }
        };

        // Round one ran 400 calls and finished; Joe continues the sub.
        append(0, 400);
        start_round(&sub, std::fs::metadata(&path).unwrap().len());
        assert!(sweep_once().await.is_empty(), "400 calls from the last round are not this round's");

        append(400, 100);
        assert!(sweep_once().await.is_empty());
        simulate_restart(&sub);
        assert!(sweep_once().await.is_empty(), "after a restart the round still starts at the continue");
        assert_eq!(with_entry(&sub, |e| e.cursor.calls), 100, "the count did not fall back to 0 or jump to the lifetime 500");

        append(500, 200);
        assert_eq!(sweep_once().await, [sub.clone()], "300 calls into this round");
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

    #[test]
    fn a_file_an_older_build_wrote_with_a_busy_limit_still_loads() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let root = crate::daemon::subchats::decisions::data_root().unwrap();
        let path = saved_path(&root, "ceil-old");
        crate::util::write_json_atomic(&path, r#"{"calls_limit":600,"busy_limit_secs":21600,"start_offset":42}"#).unwrap();
        let e = load("ceil-old");
        assert_eq!((e.calls_limit, e.cursor.floor, e.context_warned), (600, 42, false));
        assert!(!path.with_extension("json.bad").exists(), "an old file is not a damaged one");
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
        sweep(&st, &Env { calls: &read }).await;
        assert!(free_at_some_point.load(Ordering::SeqCst), "the table lock was held across the transcript read");
    }

    #[tokio::test]
    async fn keep_going_after_an_overshoot_clears_the_figure_instead_of_asking_again_at_once() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-over");
        tick(&st, 650).await;
        apply_answer(&st, &sub, CardAnswer::Picked(KEEP_GOING.into()));
        assert!(tick(&st, 651).await.is_empty(), "650 is past 600, so the next ceiling is 900");
    }

    #[tokio::test]
    async fn skip_keeps_the_sub_going_and_stop_ends_it() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ceil-skip");
        tick(&st, 300).await;
        answer_card(&st, None).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_none());
        assert!(tick(&st, 301).await.is_empty(), "a Skip is not a minute-by-minute nag");

        let (st, sub) = busy_sub("ceil-stop");
        tick(&st, 300).await;
        answer_card(&st, Some(STOP_IT)).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_some(), "Stop goes through end_sub");
        assert!(tick(&st, 900).await.is_empty(), "an ended sub is not counted again");
    }

    #[tokio::test]
    async fn finished_ended_and_ordinary_chats_are_never_counted() {
        let (st, sub) = busy_sub("ceil-fin");
        st.registry.set_subchat_finished(&sub, true);
        assert!(tick_ctx(&st, 900, 990_000, BIG).await.is_empty());
        let (st, sub) = busy_sub("ceil-end");
        st.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(tick_ctx(&st, 900, 990_000, BIG).await.is_empty());
        let (st, _sub) = busy_sub("ceil-plain");
        st.registry.set_subchat_of("ceil-plain-sub", None);
        assert!(tick_ctx(&st, 900, 990_000, BIG).await.is_empty());
    }

    // ---- context nearly full -------------------------------------------------

    #[tokio::test]
    async fn the_context_warning_fires_at_ninety_percent_of_the_window_and_not_before() {
        assert_eq!(CONTEXT_WARN_PERCENT, 90);
        let (st, sub) = busy_sub("ctx-line");
        assert!(tick_ctx(&st, 5, 899_999, BIG).await.is_empty(), "899,999 of 1,000,000 is under the line");
        assert!(the_context_card(&st).await.is_none());
        assert_eq!(tick_ctx(&st, 5, 900_000, BIG).await, [sub], "900,000 is 90%");
        let card = the_context_card(&st).await.expect("a context card");
        assert_eq!(card["payload"]["display_session_id"], "ctx-line-main");
        assert_eq!(card["payload"]["sub_id"], "ctx-line-sub");
        let q = card["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(q.contains("**header**") && q.contains("90%") && q.contains("900K of 1M"), "{q}");
        let labels: Vec<&str> =
            card["payload"]["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, [KEEP_GOING, STOP_IT]);
        assert!(the_card(&st).await.is_none(), "it is not the calls ceiling card");
    }

    /// A small window is judged by its own size: 180K of a 200K model is the line.
    #[tokio::test]
    async fn a_small_window_model_is_warned_by_its_own_size() {
        let (st, sub) = busy_sub("ctx-small");
        assert!(tick_ctx(&st, 5, 179_000, "claude-sonnet-4-5").await.is_empty());
        assert_eq!(tick_ctx(&st, 5, 180_000, "claude-sonnet-4-5").await, [sub]);
        let q = the_context_card(&st).await.unwrap()["payload"]["questions"][0]["question"].as_str().unwrap().to_string();
        assert!(q.contains("180K of 200K"), "{q}");
    }

    /// No usage line read yet is no information, not a full window.
    #[tokio::test]
    async fn an_unread_context_or_an_unknown_model_never_warns() {
        let (st, _sub) = busy_sub("ctx-none");
        assert!(tick_ctx(&st, 5, 0, BIG).await.is_empty());
        assert!(tick_ctx(&st, 5, 990_000, "").await.is_empty(), "a window cannot be judged without a model");
        assert!(st.list_prompts().await.is_empty());
    }

    #[tokio::test]
    async fn the_context_warning_is_given_once_whatever_the_answer_and_across_a_restart() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ctx-once");
        assert_eq!(tick_ctx(&st, 5, 950_000, BIG).await.len(), 1);
        for _ in 0..5 {
            assert!(tick_ctx(&st, 5, 960_000, BIG).await.is_empty(), "the open card is not repeated");
        }
        answer_card_of(&st, CONTEXT_KIND, Some(KEEP_GOING)).await;
        assert!(the_context_card(&st).await.is_none(), "the answered card is gone");
        assert!(tick_ctx(&st, 5, 970_000, BIG).await.is_empty(), "keep going means not warned again");
        simulate_restart(&sub);
        assert!(tick_ctx(&st, 5, 980_000, BIG).await.is_empty(), "a restart does not warn a second time");
        // A Skip is the same.
        let (st, _sub) = busy_sub("ctx-skip");
        tick_ctx(&st, 5, 950_000, BIG).await;
        answer_card_of(&st, CONTEXT_KIND, None).await;
        assert!(tick_ctx(&st, 5, 960_000, BIG).await.is_empty());
        assert!(st.registry.get("ctx-skip-sub").unwrap().ended_at.is_none(), "a skip stops nothing");
    }

    /// A restart drops an open card, so a warning Joe never saw is raised again
    /// rather than lost: the file only learns of it from his answer.
    #[tokio::test]
    async fn a_restart_with_the_context_card_unanswered_raises_it_again() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ctx-lost");
        assert_eq!(tick_ctx(&st, 5, 950_000, BIG).await.len(), 1);
        // The restart: the table entry and the in-memory card are gone.
        simulate_restart(&sub);
        let (st, sub) = busy_sub("ctx-lost");
        assert_eq!(tick_ctx(&st, 5, 955_000, BIG).await, [sub], "nothing was stored, so the warning comes again");
    }

    #[tokio::test]
    async fn stop_it_on_the_context_card_ends_the_sub() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ctx-stop");
        tick_ctx(&st, 5, 950_000, BIG).await;
        answer_card_of(&st, CONTEXT_KIND, Some(STOP_IT)).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_some());
    }

    /// A continued sub is a new job, so it is warned again if its context fills again.
    #[tokio::test]
    async fn continuing_a_sub_arms_the_context_warning_again() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ctx-continue");
        tick_ctx(&st, 5, 950_000, BIG).await;
        answer_card_of(&st, CONTEXT_KIND, Some(KEEP_GOING)).await;
        start_round(&sub, 0);
        assert_eq!(tick_ctx(&st, 5, 950_000, BIG).await, [sub], "a new round, a new warning");
    }

    /// Both lines crossed at once: one card at a time, calls first. The context
    /// warning is not lost, it waits for the sub's open card to be answered.
    #[tokio::test]
    async fn two_crossings_at_once_draw_one_card_and_the_context_one_follows() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = busy_sub("ctx-both");
        assert_eq!(tick_ctx(&st, 300, 950_000, BIG).await, [sub.clone()]);
        assert!(the_card(&st).await.is_some() && the_context_card(&st).await.is_none());
        assert!(tick_ctx(&st, 301, 951_000, BIG).await.is_empty());
        answer_card(&st, Some(KEEP_GOING)).await;
        assert_eq!(tick_ctx(&st, 302, 952_000, BIG).await, [sub]);
        assert!(the_context_card(&st).await.is_some());
    }

    #[test]
    fn a_stored_warning_flag_survives_in_the_file_and_the_defaults_leave_none() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let root = crate::daemon::subchats::decisions::data_root().unwrap();
        with_entry("ctx-file", |e| {
            e.context_warned = true;
            save("ctx-file", e);
        });
        assert!(saved_path(&root, "ctx-file").exists());
        assert!(load("ctx-file").context_warned);
        start_round("ctx-file", 0);
        assert!(!saved_path(&root, "ctx-file").exists(), "a fresh round with defaults has nothing to remember");
    }

    // ---- the transcript counter ----------------------------------------------

    fn line(id: &str, extra: &str) -> String {
        format!(r#"{{"type":"assistant"{extra},"message":{{"id":"{id}","role":"assistant","content":[]}}}}"#)
    }

    /// An assistant line carrying a usage block, as the CLI writes it.
    fn usage_line(id: &str, extra: &str, input: u64, cache_read: u64, cache_creation: u64, model: &str) -> String {
        format!(
            r#"{{"type":"assistant"{extra},"message":{{"id":"{id}","model":"{model}","role":"assistant","content":[],"usage":{{"input_tokens":{input},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_creation},"output_tokens":5}}}}}}"#
        )
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

    /// The context is the newest main-thread request's size: input plus both cache
    /// figures. A subagent's smaller context and a synthetic zero row are not it.
    #[test]
    fn the_context_is_the_newest_main_thread_usage_and_ignores_subagents_and_zero_rows() {
        let mut c = Cursor::default();
        let text = [
            usage_line("msg_1", "", 10, 500_000, 20_000, BIG),
            usage_line("msg_2", "", 12, 640_000, 10_000, BIG),
            usage_line("msg_sub", r#","isSidechain":true"#, 5, 30_000, 0, "claude-haiku-5-5"),
            usage_line("msg_err", "", 0, 0, 0, "<synthetic>"),
        ]
        .join("\n");
        count_calls(&text, &mut c);
        assert_eq!((c.occupancy, c.max_occupancy, c.model.as_str()), (650_012, 650_012, BIG));
        assert_eq!(context_of(&c), Some((650_012, 1_000_000)));
        // It follows the conversation down too (after a compaction), while the
        // largest size seen is kept for the window's sticky correction.
        count_calls(&usage_line("msg_3", "", 10, 90_000, 0, BIG), &mut c);
        assert_eq!((c.occupancy, c.max_occupancy), (90_010, 650_012));
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

    /// End to end through the real transcript reader: a sub whose transcript ends
    /// at 92% of a 1M window is warned, and one at 40% is not.
    #[tokio::test]
    async fn a_real_transcript_near_the_window_raises_the_context_card() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", usage_line("msg_1", "", 10, 400_000, 0, BIG)).unwrap();
        drop(f);
        let read = |_: &Instance, c: &mut Cursor| read_calls(&path, c);
        let (st, sub) = busy_sub("ctx-real");
        assert!(sweep(&st, &Env { calls: &read }).await.is_empty(), "40% is fine");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", usage_line("msg_2", "", 10, 920_000, 0, BIG)).unwrap();
        assert_eq!(sweep(&st, &Env { calls: &read }).await, [sub]);
        assert!(the_context_card(&st).await.is_some());
    }
}
