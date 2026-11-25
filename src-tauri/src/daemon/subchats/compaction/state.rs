use super::*;

// ---- per-child state ------------------------------------------------------

#[derive(Default)]
pub(super) struct Chat {
    /// The child the facts below describe.
    pub(super) pid: u32,
    pub(super) resumed: bool,
    /// The child was launched with `SUBCHATS_MAIN_PROMPT` in its argv. A chat
    /// that got the mode mid-chat learned it from a note in its history instead,
    /// which a summary can drop.
    pub(super) argv_main_prompt: bool,
    /// A live turn has ended on this child, so its replay window is shut.
    pub(super) live_turn_ended: bool,
    /// The newest context size: the last main-conversation assistant line, or a
    /// compaction boundary's `post_tokens` until the next assistant line.
    pub(super) occupancy: Option<u64>,
    pub(super) in_flight: Option<InFlight>,
    /// Messages Joe typed while the compaction ran, in typing order.
    pub(super) held: Vec<String>,
    /// Set when a compaction ended without a boundary: no automatic attempt
    /// below this occupancy.
    pub(super) retry_at: Option<u64>,
    /// The last stdout line or turn end of this child. The idle sweep counts
    /// [`IDLE_COMPACT_AFTER`] from here.
    pub(super) last_activity: Option<Instant>,
    /// The idle sweep already tried this quiet period; any new activity re-arms
    /// it, so one silence draws at most one compaction.
    pub(super) idle_tried: bool,
    /// The save-step turn the daemon asked for before a compaction, while it runs.
    pub(super) saving: Option<Saving>,
    /// A save-step turn just ended and the compaction it was asked for has not
    /// started yet: [`after_save`] takes it.
    pub(super) saved_for: Option<Trigger>,
    /// [`after_save`] took `saved_for` and its compaction has not started or been
    /// skipped yet (it waits [`SETTLE`] first). Between the end of the save turn and
    /// that start nothing else says the chat is mid-way, so [`in_progress`] reads this.
    pub(super) after_save_pending: bool,
    /// When the save step was last asked on this child. A fresh one is not asked
    /// again ([`save_step::SAVE_FRESH`]), so a save turn that was cut short, or a
    /// compaction skipped behind it, never repeats the turn.
    pub(super) last_save: Option<Instant>,
    /// When the daemon's own compaction (or the save turn before it) last ended on this child.
    /// The turn's end stamps the chat's `last_event_at` after the flight is cleared, so the
    /// auto-hide rule reads this to tell housekeeping from a turn Joe would care about.
    pub(super) ended_at: Option<Instant>,
    /// Compactions the CLI reported since the last live turn ended on this child (a sub
    /// compacts itself mid-turn, so one round can hold several). Read by
    /// [`round_compactions`] and logged at the turn's end, so a week of logs shows
    /// how many compactions a round costs at the sub window.
    pub(super) round_compactions: u32,
}

/// The save-step turn asked for before a compaction (see [`save_step`]).
pub(super) struct Saving {
    pub(super) pid: u32,
    pub(super) started: Instant,
    pub(super) prior_awaiting: Option<String>,
    /// What asked for the compaction this turn precedes.
    pub(super) trigger: Trigger,
    /// The idle sweep already interrupted this turn for running past
    /// [`save_step::SAVE_LIMIT`].
    pub(super) cut_off: bool,
}

pub(super) struct InFlight {
    pub(super) pid: u32,
    pub(super) started: Instant,
    pub(super) prior_awaiting: Option<String>,
    pub(super) occupancy: Option<u64>,
    /// The CLI reported a `compact_boundary`: the compaction did compact.
    pub(super) boundary_seen: bool,
}

pub(super) fn chats() -> std::sync::MutexGuard<'static, HashMap<String, Chat>> {
    static CHATS: OnceLock<Mutex<HashMap<String, Chat>>> = OnceLock::new();
    CHATS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// A new child for `session_id` was spawned. Called by `lifecycle::spawn` for
/// every spawn and respawn. Returns what Joe typed during a compaction the old
/// child never finished (it was replaced before its exit was handled); the
/// caller hands it to [`restage`] so it is not stranded on a dead compaction.
#[must_use]
pub fn note_child(session_id: &str, pid: u32, resumed: bool, argv_main_prompt: bool) -> Vec<String> {
    let mut all = chats();
    let chat = all.entry(session_id.to_string()).or_default();
    let orphaned = std::mem::take(&mut chat.held);
    let retry_at = chat.retry_at;
    *chat = Chat { pid, resumed, argv_main_prompt, retry_at, ..Chat::default() };
    orphaned
}

/// One raw stdout line of `session_id`'s child (the pump calls this per line).
pub fn note_line(session_id: &str, line: &[u8]) {
    use crate::context_status::StreamContext;
    let mut all = chats();
    let chat = all.entry(session_id.to_string()).or_default();
    chat.last_activity = Some(Instant::now());
    chat.idle_tried = false;
    let Some(seen) = crate::context_status::stream_line_context(line) else { return };
    match seen {
        StreamContext::Usage(occ) => chat.occupancy = Some(occ),
        StreamContext::Compacted { pre, post } => {
            log::info!("compaction: session {session_id} compacted {pre} -> {post} tokens");
            chat.occupancy = Some(post);
            chat.round_compactions += 1;
            chat.retry_at = None;
            if let Some(flight) = chat.in_flight.as_mut() {
                flight.boundary_seen = true;
            }
        }
    }
}

/// A live turn ended on child `pid` (pump, at a `TurnEnded` result line).
pub fn note_live_turn_end(session_id: &str, pid: u32) {
    if let Some(chat) = chats().get_mut(session_id) {
        if chat.pid == pid {
            if chat.round_compactions > 0 {
                // The measure for the sub window's quality and token cost: compare it
                // with the model of docs/architecture/subchats.md (Sub size) a week on.
                log::info!(
                    "compaction: session {session_id} round ended after {} compaction(s), context now {} tokens",
                    chat.round_compactions,
                    chat.occupancy.unwrap_or(0)
                );
            }
            chat.round_compactions = 0;
            chat.live_turn_ended = true;
            chat.last_activity = Some(Instant::now());
            chat.idle_tried = false;
        }
    }
}

/// Compactions the CLI reported in `session_id`'s current round (since its last turn end).
pub fn round_compactions(session_id: &str) -> u32 {
    chats().get(session_id).map_or(0, |c| c.round_compactions)
}

/// The newest context size the pump saw for `session_id`.
pub fn occupancy(session_id: &str) -> Option<u64> {
    chats().get(session_id).and_then(|c| c.occupancy)
}

pub(super) fn compacting_in(chat: &Chat) -> bool {
    chat.in_flight.as_ref().is_some_and(|f| f.pid == chat.pid && f.started.elapsed() < IN_FLIGHT_LIMIT)
}

/// Whether the save-step turn the daemon asked for is still plausibly running:
/// bounded by [`IN_FLIGHT_LIMIT`] like a compaction, so one whose end never
/// reached the pump (an interrupt that failed, a busy flag the watchdog cleared)
/// stops counting instead of making the chat look mid-save for ever.
pub(super) fn saving_in(chat: &Chat) -> bool {
    chat.saving.as_ref().is_some_and(|s| s.pid == chat.pid && s.started.elapsed() < IN_FLIGHT_LIMIT)
}

/// The status a chat shows after a live turn ends: the one it had before when
/// that turn was the daemon's compaction (which reports none), else what the
/// turn reported. Used by the pump.
pub fn status_after_turn(end: Option<&Finished>, reported: Option<String>) -> Option<String> {
    match end {
        Some(end) if end.was_compaction => end.prior_awaiting.clone(),
        _ => reported,
    }
}

/// Whether the daemon's own compaction of `session_id`, or the save-step turn
/// that precedes it, is running now.
pub fn is_compacting(session_id: &str) -> bool {
    chats().get(session_id).is_some_and(|c| compacting_in(c) || saving_in(c))
}

/// [`is_compacting`], plus the few seconds between a save turn's end and the
/// compaction it was asked for starting. Put-away waits on this: reading only
/// [`is_compacting`] would see a chat that is between the two as done.
pub fn in_progress(session_id: &str) -> bool {
    chats().get(session_id).is_some_and(|c| compacting_in(c) || saving_in(c) || c.after_save_pending || c.saved_for.is_some())
}

/// Whether the daemon's compaction (or its save turn) of `session_id` ended within `window`.
pub fn ended_within(session_id: &str, window: std::time::Duration) -> bool {
    chats().get(session_id).and_then(|c| c.ended_at).is_some_and(|t| t.elapsed() < window)
}

/// Holds a message Joe typed while `session_id` is compacting or saving first,
/// for delivery as his next turn once it ends. False (nothing held) when neither
/// runs, so the caller sends or refuses as usual. A save turn holds it too: the
/// chat was told to start no new work, so a request typed into it would be
/// answered inside it or ignored.
pub fn hold_typed(session_id: &str, text: &str) -> bool {
    let mut all = chats();
    let Some(chat) = all.get_mut(session_id).filter(|c| compacting_in(c) || saving_in(c)) else { return false };
    chat.held.push(text.to_string());
    log::info!("compaction: session {session_id} held a typed message until the compaction ends");
    true
}

/// What the end of the daemon's compaction hands back to the pump.
#[derive(Debug, Default, PartialEq)]
pub struct Finished {
    /// False when the compaction had outlived [`IN_FLIGHT_LIMIT`]: the turn
    /// ending now is then some later one (its own result line never came), and
    /// its own report stands.
    pub was_compaction: bool,
    /// The status the chat had before: a compaction reports none of its own.
    pub prior_awaiting: Option<String>,
    /// Messages Joe typed meanwhile, to send as his next turn.
    pub held: Vec<String>,
}

/// Called by the pump at every live turn end of `session_id`'s child `pid`:
/// `Some` when that turn was the daemon's compaction, which is then over.
pub fn take_finished(session_id: &str, pid: u32) -> Option<Finished> {
    let mut all = chats();
    let chat = all.get_mut(session_id)?;
    // A compaction in flight owns the next turn end even when a save turn's entry
    // outlived its own end (an interrupt that failed): that entry is dropped here.
    // A flight past the limit owns nothing (its own end never came), so it must not
    // wipe the entry of a save turn that began after it.
    if chat.in_flight.as_ref().is_some_and(|f| f.pid == pid && f.started.elapsed() < IN_FLIGHT_LIMIT) {
        chat.saving = None;
    }
    // The save-step turn is quiet like the compaction it precedes: it keeps the
    // chat's status and rings nothing, and its end starts that compaction
    // ([`after_save`]). What Joe typed during it goes out as his next turn. An entry
    // past the limit is dropped without being taken: the turn ending now is some
    // later one, and its own end stands.
    if let Some(saving) = chat.saving.take_if(|s| s.pid == pid) {
        if saving.started.elapsed() < IN_FLIGHT_LIMIT {
            chat.saved_for = Some(saving.trigger);
            chat.ended_at = Some(Instant::now());
            return Some(Finished {
                was_compaction: true,
                prior_awaiting: saving.prior_awaiting,
                held: std::mem::take(&mut chat.held),
            });
        }
        // What Joe typed while it still counted as running must not wait for a
        // compaction hours away: it goes out with this turn's end, which reports its own
        // status (`was_compaction` false) and starts no compaction.
        if chat.in_flight.as_ref().is_none_or(|f| f.pid != pid) && !chat.held.is_empty() {
            return Some(Finished { was_compaction: false, prior_awaiting: None, held: std::mem::take(&mut chat.held) });
        }
    }
    let flight = chat.in_flight.take_if(|f| f.pid == pid)?;
    chat.ended_at = Some(Instant::now());
    if !flight.boundary_seen {
        let at = flight.occupancy.or(chat.occupancy).unwrap_or(0) + RETRY_GROWTH_TOKENS;
        chat.retry_at = Some(at);
        log::warn!("compaction: session {session_id} /compact ended without compacting; next automatic try past {at} tokens");
    }
    Some(Finished {
        was_compaction: flight.started.elapsed() < IN_FLIGHT_LIMIT,
        prior_awaiting: flight.prior_awaiting,
        held: std::mem::take(&mut chat.held),
    })
}

/// The child of `session_id` exited. A compaction it was running is over, and
/// what Joe typed meanwhile goes to the chat's held queue, which the app sends
/// once the chat is back, instead of being lost with the child.
pub fn on_child_exit(state: &Arc<DaemonState>, session_id: &str, pid: u32) {
    let held = {
        let mut all = chats();
        let Some(chat) = all.get_mut(session_id) else { return };
        if chat.pid != pid {
            return;
        }
        chat.in_flight = None;
        chat.saving = None;
        chat.saved_for = None;
        std::mem::take(&mut chat.held)
    };
    restage(state, session_id, held);
}

/// Moves `held` to the chat's held queue, which the app sends when it can.
pub fn restage(state: &Arc<DaemonState>, session_id: &str, held: Vec<String>) {
    if held.is_empty() {
        return;
    }
    for text in held {
        state.draft_store.add_held(session_id, vec![crate::types::chat::ContentBlock::Text { text }]);
    }
    crate::daemon::methods::drafts::sync_held_count(state, session_id);
}
