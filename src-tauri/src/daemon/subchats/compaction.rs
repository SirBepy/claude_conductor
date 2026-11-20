//! The compaction manager (docs/forever-chat-plan.md phase B1, built on the
//! measurements in docs/research/compact-spike.md). A main chat that runs for
//! weeks fills its context; the CLI can compact it in place when it is sent
//! `/compact <focus>` as an ordinary user line (same session id, same child, no
//! respawn). This module decides when, writes the focus text, and handles what
//! the spike found the rest of the daemon does wrong around a compaction.
//!
//! - **When.** The pump reports each main-conversation assistant line's usage
//!   ([`note_line`]); a few seconds after a live turn ends ([`after_turn`]) the
//!   chat is compacted if it is past its threshold and idle: not busy, no card
//!   in its window, no held message, no line back waiting for Joe's next
//!   message, no scheduled message due within [`SCHEDULE_MARGIN_SECS`]. On by
//!   default for main chats at 300K ([`DEFAULT_ON`]); plain chats and subs are
//!   never compacted by the daemon. Jarvis counts as a main chat. A second
//!   trigger, [`idle_sweep`] on the watchdog tick, compacts a chat quiet for
//!   [`IDLE_COMPACT_AFTER`] once it is past [`IDLE_FLOOR_TOKENS`], never on an
//!   API-credit account. `compact_now` is the manual trigger.
//! - **The save step first.** Before any trigger sends `/compact`, a main chat gets one
//!   ordinary turn to run its save step and write its retro ([`save_step`], [`begin_save`]);
//!   that turn's end starts the compaction ([`after_save`]), and a turn that runs past
//!   [`save_step::SAVE_LIMIT`] is interrupted by the idle sweep, so it never holds the
//!   compaction off.
//! - **The send.** `lifecycle::send_bare_command`: no meta sentinel (the CLI only
//!   runs a command at the very start of the text), and it is not Joe's message.
//! - **The focus text** quotes Joe's recent typed messages itself: "Joe's last two
//!   messages" was read as the command plus one message (spike e2). Sub-written
//!   text (a finish row, a sub's card question) never goes in it; that reaches the
//!   chat afterwards as hook context framed as data ([`session_start_context`]).
//! - **During.** `busy` is set before the write, so every sender sees the chat
//!   mid-turn. A message Joe types now is held here ([`hold_typed`]) and sent as
//!   his next turn once the compaction ends, instead of the 409 the spike saw.
//! - **The end.** The result line of a compaction carries no status, so the pump
//!   keeps the status the chat had before ([`take_finished`]) and rings nothing:
//!   the end of a compaction is idle, not a new "done".
//! - **After.** The `SessionStart` hook with `source: "compact"` answers with the
//!   family state ([`session_start_context`]).
//!
//! A `--resume` child is never compacted before one of its own turns has ended:
//! its opening history replay makes the pump read an eventless result as a
//! replayed one (`pump/turn_boundary.rs`), and a compaction streams no
//! `stream_event`, so `busy` would stay set until the watchdog (spike section 2).
//!
//! All state here is in memory: it describes the live child, and a restart ends
//! that child.

use crate::daemon::state::DaemonState;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

mod state;
mod decide;
mod context;
pub use state::*;
pub use decide::*;
pub use context::*;

/// Whether a main chat is compacted automatically when no setting says
/// otherwise. Joe's pick on a question card, 2026-11-12: on, at 300K. His
/// 2026-10-14 opt-in rule (`hooks_server/context_cap.rs`) was about a respawn,
/// which drops the conversation; a compaction keeps a summary in the same chat.
pub const DEFAULT_ON: bool = true;
/// The threshold used when compaction is on and no number is set. Spike S1:
/// a compacted chat restarts at about 35K of system prompt and tools plus about
/// 10K of summary, so 300K leaves plenty of room between compactions.
pub const DEFAULT_THRESHOLD_TOKENS: u64 = 300_000;
/// Key in settings.json's passthrough map: `{"on": bool, "tokens": n,
/// "projects": {"<project id>": {"on": bool, "tokens": n}}}`. A project entry
/// overrides the global one field by field.
pub const SETTINGS_KEY: &str = "autoCompact";
/// A scheduled message due this soon keeps the chat from being compacted: a
/// fire that lands mid-compaction finds the chat busy.
pub const SCHEDULE_MARGIN_SECS: i64 = 5 * 60;
/// Wait after a turn ends before judging idleness, so a card, a held message or
/// a repo-channel wake the end of the turn set off (its coalesce window is 3s)
/// is already visible.
const SETTLE: Duration = Duration::from_secs(5);
/// A compaction that never reported an end is forgotten after this, so a lost
/// result line cannot hold Joe's typed messages for ever. Spike S1: 20 to 22s.
const IN_FLIGHT_LIMIT: Duration = Duration::from_secs(10 * 60);
/// After a compaction that did not compact (no boundary came back), the chat
/// is tried again automatically only once it has grown this much past the size
/// it had then, so a failing `/compact` is not paid for on every turn.
const RETRY_GROWTH_TOKENS: u64 = 50_000;
/// One of Joe's messages is quoted up to this many characters.
const JOE_MESSAGE_CAP: usize = 1500;
/// A chat silent this long and past [`IDLE_FLOOR_TOKENS`] is compacted by the
/// watchdog tick. Joe's pick 2026-11-16, from the forever-chat review: compact
/// in place while the 1h prompt cache is still warm (a warm read costs about a
/// tenth of a cold one) instead of swapping the chat for a fresh session, which
/// keeps the id, schedules and window and needs no re-keying.
pub const IDLE_COMPACT_AFTER: Duration = Duration::from_secs(30 * 60);
/// Below this a fresh start costs about what resuming does (a new session opens
/// at about 56K), so compacting an idle chat saves nothing. Joe's pick 2026-11-16.
pub const IDLE_FLOOR_TOKENS: u64 = 150_000;
const FOCUS_JOBS_MAX: usize = 12;
const FOCUS_DECISIONS_MAX: usize = 8;

// ---- settings -------------------------------------------------------------

/// Whether a chat is compacted automatically, and at what occupancy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Threshold {
    pub on: bool,
    pub tokens: u64,
}

/// The threshold for a chat in `project_id`, from settings.json's passthrough
/// map. Missing or malformed values fall back to [`DEFAULT_ON`] and
/// [`DEFAULT_THRESHOLD_TOKENS`].
pub fn threshold_for(extra: &Map<String, Value>, project_id: &str) -> Threshold {
    let root = extra.get(SETTINGS_KEY);
    let on_of = |v: Option<&Value>| v.and_then(|v| v.get("on")).and_then(Value::as_bool);
    let tokens_of = |v: Option<&Value>| v.and_then(|v| v.get("tokens")).and_then(Value::as_u64).filter(|n| *n > 0);
    let project = root.and_then(|r| r.get("projects")).and_then(|p| p.get(project_id));
    Threshold {
        on: on_of(project).or(on_of(root)).unwrap_or(DEFAULT_ON),
        tokens: tokens_of(project).or(tokens_of(root)).unwrap_or(DEFAULT_THRESHOLD_TOKENS),
    }
}

// ---- running a compaction -------------------------------------------------

/// The turn-end trigger: a few seconds after a live turn of `session_id` ends,
/// compact it if it qualifies. Detached, because the pump must not await a
/// send (`jarvis_wake::spawn_drain` documents why).
pub fn after_turn(state: &Arc<DaemonState>, session_id: &str) {
    // Cheap test first: a chat with the mode off never starts a task.
    if !crate::sessions::chat_config::get(session_id).is_some_and(|c| c.subchats_on) && !is_jarvis(state, session_id) {
        return;
    }
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        match start(&state, &session_id, true).await {
            Ok(()) => {}
            Err(skip @ (Skip::Off | Skip::BelowThreshold | Skip::NotMainChat | Skip::NoUsageYet)) => {
                log::debug!("compaction: session {session_id} not compacted: {}", skip.reason());
            }
            Err(skip) => log::info!("compaction: session {session_id} past threshold, not compacted now: {}", skip.reason()),
        }
    });
}

/// Compacts `session_id` now if [`decide`] allows it. `auto` is the turn-end
/// trigger; `compact_now` passes false.
pub async fn start(state: &Arc<DaemonState>, session_id: &str, auto: bool) -> Result<(), Skip> {
    run(state, session_id, if auto { Trigger::Threshold } else { Trigger::Manual }).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    Threshold,
    Idle,
    Manual,
}

/// The idle trigger, one call per chat the watchdog tick found quiet. A chat
/// skipped for a passing reason goes back in the pool for the next tick.
async fn start_idle(state: &Arc<DaemonState>, session_id: &str) -> Result<(), Skip> {
    let outcome = run(state, session_id, Trigger::Idle).await;
    if let Err(skip) = outcome {
        settle_idle_try(state, session_id, skip);
    }
    outcome
}

/// Chats silent for [`IDLE_COMPACT_AFTER`] and past [`IDLE_FLOOR_TOKENS`] that
/// have not been tried in this silence yet. Marks each one tried, so a chat that
/// was judged and skipped for good is not re-judged every tick; its next turn
/// re-arms it, and [`settle_idle_try`] re-arms a chat skipped for something that
/// clears by itself (a main chat idle behind an open question card would otherwise
/// never be compacted: the card is why it is quiet).
fn take_idle_candidates() -> Vec<String> {
    let mut all = chats();
    all.iter_mut()
        .filter(|(_, c)| {
            !c.idle_tried
                && c.in_flight.is_none()
                && c.occupancy.is_some_and(|o| o >= IDLE_FLOOR_TOKENS)
                && c.last_activity.is_some_and(|t| t.elapsed() >= IDLE_COMPACT_AFTER)
        })
        .map(|(id, c)| {
            c.idle_tried = true;
            id.clone()
        })
        .collect()
}

/// A skipped chat the idle sweep can drop for good: ended, or frozen with no child left.
fn is_gone(ended: bool, frozen: bool, live_child: bool) -> bool {
    ended || (frozen && !live_child)
}

/// Puts a chat the idle sweep skipped for a passing reason back in the pool, so the
/// next tick judges it again.
fn settle_idle_try(state: &DaemonState, session_id: &str, skip: Skip) {
    // `Unavailable` also covers a chat that ended or has no row: neither comes back without a new
    // child, and `note_child` re-arms the chat then, so re-judging them every tick is a pass over
    // the accounts for nothing. A closing chat can still be kept open, and a chat frozen by a
    // usage limit keeps its child and wakes on Unfreeze with no new one to re-arm it, so both
    // stay in the pool. An idle freeze kills the child, so that chat is gone like an ended one.
    let live_child = state.sessions.contains_key(session_id);
    let gone = skip == Skip::Unavailable && state.registry.get(session_id).is_none_or(|i| is_gone(i.ended_at.is_some(), i.frozen, live_child));
    if skip.clears_by_itself() && !gone {
        if let Some(chat) = chats().get_mut(session_id) {
            chat.idle_tried = false;
        }
    }
}

/// The watchdog tick's hook: compacts each chat that has been quiet for
/// [`IDLE_COMPACT_AFTER`]. Runs on the existing 60s sweep, so it adds no timer.
pub async fn idle_sweep(state: &Arc<DaemonState>) {
    cut_off_overdue_saves(state).await;
    for id in take_idle_candidates() {
        match start_idle(state, &id).await {
            Ok(()) => log::info!("compaction: session {id} idle for 30 minutes, compacting while its cache is warm"),
            Err(skip) => log::debug!("compaction: session {id} idle but not compacted: {}", skip.reason()),
        }
    }
    // The same tick freezes chats that stayed quiet; it runs after the compaction start
    // above, which sets `busy` and so keeps a chat that is being compacted awake.
    super::idle_freeze::sweep(state).await;
}

async fn run(state: &Arc<DaemonState>, session_id: &str, trigger: Trigger) -> Result<(), Skip> {
    run_after(state, session_id, trigger, false).await
}

/// [`run`], or with `after_save` the compaction a save-step turn was asked for
/// ([`after_save`]). A run that is not after a save and finds the save step due
/// starts that turn instead and compacts when it ends.
async fn run_after(state: &Arc<DaemonState>, session_id: &str, trigger: Trigger, after_save: bool) -> Result<(), Skip> {
    let auto = trigger != Trigger::Manual;
    let f = facts(state, session_id).await;
    match trigger {
        _ if after_save => save_step::decide_after_save(&f, trigger)?,
        Trigger::Idle => decide_idle(&f)?,
        _ => decide(&f, auto)?,
    }
    let session = state.sessions.get(session_id).map(|s| s.clone()).ok_or(Skip::NoLiveChild)?;
    if !after_save && f.save_step {
        return begin_save(state, session_id, &session, trigger).await;
    }
    let focus = focus_text(state, session_id).await;
    // From the busy re-read to `set_busy` nothing awaits, so another sender that
    // passed its own busy check before this point is the only race left, the
    // same one any two senders have.
    let prior_awaiting = {
        let inst = state.registry.get(session_id).ok_or(Skip::Unavailable)?;
        if inst.busy {
            return Err(Skip::Busy);
        }
        let mut all = chats();
        let chat = all.entry(session_id.to_string()).or_default();
        if chat.pid != session.pid {
            return Err(Skip::FirstAfterRestart);
        }
        if compacting_in(chat) {
            return Err(Skip::AlreadyCompacting);
        }
        chat.in_flight = Some(InFlight {
            pid: session.pid,
            started: Instant::now(),
            prior_awaiting: inst.awaiting.clone(),
            occupancy: chat.occupancy,
            boundary_seen: false,
        });
        chat.last_save = None;
        chat.saving = None;
        state.registry.set_busy(session_id, true);
        inst.awaiting
    };
    crate::sessions::chat_state::set_busy(session_id, true);
    crate::daemon::machines::publish_instances_changed(state);
    log::info!(
        "compaction: session {session_id} compacting ({}, occupancy {:?}, status before {:?})",
        match trigger {
            Trigger::Threshold => "past threshold",
            Trigger::Idle => "idle",
            Trigger::Manual => "asked",
        },
        f.occupancy,
        prior_awaiting,
    );
    if let Err(e) = crate::daemon::lifecycle::send_bare_command(&session, &focus).await {
        log::warn!("compaction: session {session_id} /compact write failed: {e}");
        let held = take_finished(session_id, session.pid).map(|f| f.held).unwrap_or_default();
        state.registry.set_busy(session_id, false);
        crate::sessions::chat_state::set_busy(session_id, false);
        crate::daemon::machines::publish_instances_changed(state);
        restage(state, session_id, held);
        return Err(Skip::NoLiveChild);
    }
    Ok(())
}

/// Sends what Joe typed during the compaction as his next turn, once, through
/// the same steps the desktop send takes. Detached for the pump's sake.
pub fn deliver_held(state: &Arc<DaemonState>, session_id: &str, held: Vec<String>) {
    if held.is_empty() {
        return;
    }
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let live = state.sessions.get(&session_id).map(|s| s.clone());
        let Some(session) = live.filter(|_| !crate::daemon::lifecycle::is_busy(&state, &session_id)) else {
            // Busy again already (a wake won the race) or gone: the held queue
            // delivers it into that turn, or once the chat is back.
            restage(&state, &session_id, held);
            return;
        };
        state.registry.set_awaiting(&session_id, None);
        state.registry.set_busy(&session_id, true);
        crate::sessions::chat_state::set_busy(&session_id, true);
        match crate::daemon::lifecycle::send_typed_messages(&session, &held).await {
            Ok(()) => log::info!("compaction: session {session_id} delivered {} held message(s)", held.len()),
            Err(e) => {
                log::warn!("compaction: session {session_id} held message send failed: {e}");
                state.registry.set_busy(&session_id, false);
                crate::sessions::chat_state::set_busy(&session_id, false);
                restage(&state, &session_id, held);
            }
        }
        crate::daemon::machines::publish_instances_changed(&state);
    });
}

// ---- the save step ----------------------------------------------------------

/// Gives `session_id` its save-step turn ([`save_step`]) before the compaction
/// `trigger` asked for. The chat is busy for it like for any turn, so every
/// sender sees it mid-turn; what Joe types is held ([`hold_typed`]) and goes out as
/// his next turn at its end, since the chat was told to start no new work. That end
/// then starts the compaction ([`after_save`]), unless the delivered message made the
/// chat busy again, in which case the next trigger compacts without another save.
async fn begin_save(
    state: &Arc<DaemonState>,
    session_id: &str,
    session: &Arc<crate::daemon::session::Session>,
    trigger: Trigger,
) -> Result<(), Skip> {
    let retro = crate::sessions::chat_config::get(session_id).is_some_and(|c| c.subchats_on);
    // The same race as `run_after`'s busy re-read: nothing awaits from here to the
    // busy flag.
    {
        let inst = state.registry.get(session_id).ok_or(Skip::Unavailable)?;
        if inst.busy {
            return Err(Skip::Busy);
        }
        let mut all = chats();
        let chat = all.entry(session_id.to_string()).or_default();
        if chat.pid != session.pid {
            return Err(Skip::FirstAfterRestart);
        }
        if compacting_in(chat) || saving_in(chat) {
            return Err(Skip::AlreadyCompacting);
        }
        // A flight past the limit never ended; its entry would make this save turn's
        // end look like a compaction's.
        chat.in_flight = None;
        chat.saving = Some(Saving { pid: session.pid, started: Instant::now(), prior_awaiting: inst.awaiting, trigger, cut_off: false });
        chat.last_save = Some(Instant::now());
        // Opened by the daemon, not by Joe: the Stop hook then asks no send_message of a
        // turn that was told to send Joe nothing.
        state.registry.set_busy_from_wake(session_id);
    }
    crate::sessions::chat_state::set_busy(session_id, true);
    crate::daemon::machines::publish_instances_changed(state);
    log::info!("compaction: session {session_id} asked to run its save step first ({trigger:?} trigger)");
    // `send_message` stores its text as the prompt a rate-limit replay resends; the ask must
    // never be replayed hours later on a chat that was not compacted. Joe's previous prompt
    // was answered long ago, so it is no better: blank, the replay says "continue".
    let sent = crate::daemon::lifecycle::send_message(session, &save_step::ask_text(retro), true).await;
    if let Ok(mut prompt) = session.last_prompt.lock() {
        prompt.clear();
    }
    if let Err(e) = sent {
        log::warn!("compaction: session {session_id} save-step ask failed: {e}");
        abandon_save(state, session_id, session.pid);
        return Err(Skip::NoLiveChild);
    }
    Ok(())
}

/// Undoes [`begin_save`]'s bookkeeping when the ask could not be written. What Joe
/// typed while the write was in flight was held ([`hold_typed`] counts the save as
/// running from the moment it is set), so it goes out the usual way instead of
/// waiting on a turn that never started.
fn abandon_save(state: &Arc<DaemonState>, session_id: &str, pid: u32) {
    let held = {
        let mut all = chats();
        // A respawn meanwhile replaced the chat's state and already handed its held list
        // back; what is there now belongs to the new child.
        let Some(chat) = all.get_mut(session_id).filter(|c| c.pid == pid) else { return };
        chat.saving = None;
        chat.last_save = None;
        std::mem::take(&mut chat.held)
    };
    state.registry.set_busy(session_id, false);
    crate::sessions::chat_state::set_busy(session_id, false);
    crate::daemon::machines::publish_instances_changed(state);
    restage(state, session_id, held);
}

/// The pump's hook at a quiet turn end: when it was a save-step turn, the
/// compaction it was asked for goes ahead a few seconds later, unless the chat
/// is no longer ready for one (a card opened, the CLI compacted it meanwhile);
/// then the next trigger takes it, without another save turn
/// ([`save_step::SAVE_FRESH`]). Detached, as [`after_turn`] is.
pub fn after_save(state: &Arc<DaemonState>, session_id: &str) {
    let Some(trigger) = chats().get_mut(session_id).and_then(|c| c.saved_for.take()) else { return };
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        match run_after(&state, &session_id, trigger, true).await {
            Ok(()) => {}
            Err(skip) => log::info!("compaction: session {session_id} saved, not compacted now: {}", skip.reason()),
        }
    });
}

/// Interrupts each save-step turn that has run past [`save_step::SAVE_LIMIT`], once.
/// The interrupt ends the turn, and that end starts the compaction, so a chat that
/// cannot finish its save never holds the compaction off.
async fn cut_off_overdue_saves(state: &Arc<DaemonState>) {
    let overdue: Vec<String> = chats()
        .iter_mut()
        .filter_map(|(id, c)| {
            let saving = c.saving.as_mut()?;
            let age = saving.started.elapsed();
            // A turn past [`IN_FLIGHT_LIMIT`] is [`saving_in`]'s stale case: nothing to interrupt.
            (!saving.cut_off && age >= save_step::SAVE_LIMIT && age < IN_FLIGHT_LIMIT).then(|| {
                saving.cut_off = true;
                id.clone()
            })
        })
        .collect();
    for id in overdue {
        log::warn!("compaction: session {id} save step ran past {:?}, interrupting it", save_step::SAVE_LIMIT);
        if let Err(e) = crate::daemon::lifecycle::cancel_turn(&state.sessions, &id).await {
            log::warn!("compaction: session {id} save step interrupt failed: {e}");
            // Tried again on the next tick, until the turn ends or goes stale.
            if let Some(saving) = chats().get_mut(&id).and_then(|c| c.saving.as_mut()) {
                saving.cut_off = false;
            }
        }
    }
}

mod save_step;

#[cfg(test)]
mod tests;
