//! The one gate every "tell Joe about this chat" notification goes through: the
//! `turn_sound` frame (the desktop app's sound or voice line, the phone's voice
//! line) and the phone push. Nothing else in the daemon publishes `turn_sound` or
//! calls `PushManager::maybe_notify_blocked`.
//!
//! Three rules, per chat and per channel:
//! - **Changed state only.** A chat's notified state is what it waits on
//!   (`question`, `done`, `blocked`) in which turn. The same state twice is one
//!   notification: a question card and the turn end that reports `question` for
//!   it, or eight daemon cards raised in one idle main chat at once, ring once.
//!   A new turn ([`NotifyGate::turn_started`], fired for a send and a wake alike,
//!   and [`NotifyGate::turn_ending`] for a turn that ended without streaming)
//!   and Joe answering every open prompt ([`NotifyGate::reset`]) both count as a
//!   change. The registry's `turn_gen` is not used for this: it moves only on a
//!   send, so turns woken by a sub or a peer share one.
//! - **Settle.** A request waits [`SETTLE`] before it fires, and a newer request
//!   for the same chat replaces it, so a state that flaps settles first. A
//!   `done` never replaces a waiting `question` or `blocked`: an open prompt
//!   outranks a finished turn.
//! - **Floor.** At most one notification per chat per [`FLOOR`]. A request inside
//!   the floor is held to its end, not dropped, so a real question is never lost.

use crate::daemon::state::DaemonState;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::time::{Duration, Instant};

pub const SETTLE: Duration = Duration::from_millis(1500);
pub const FLOOR: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Channel {
    Sound,
    Push,
}

/// What a chat is waiting on, and in which turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatState {
    pub kind: &'static str,
    /// The chat's turn, from [`NotifyGate::turn`]. `None` for a session the
    /// daemon does not run (a hook from an outside terminal): it has no turns
    /// the daemon sees, so its every request counts as a change and only the
    /// settle and the floor apply.
    pub turn: Option<u64>,
}

impl ChatState {
    fn same_as(&self, other: &ChatState) -> bool {
        self.turn.is_some() && self.kind == other.kind && self.turn == other.turn
    }
}

/// What firing does.
#[derive(Clone, Debug)]
pub enum Action {
    /// Publish `turn_sound` with these params (`fired_at_ms` is stamped at fire time).
    Sound(Value),
    Push { name: String, prompt_id: String, show_name: bool },
}

struct Pending<T> {
    token: u64,
    state: ChatState,
    action: T,
}

struct Slot<T> {
    last_state: Option<ChatState>,
    last_at: Option<Instant>,
    pending: Option<Pending<T>>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self { last_state: None, last_at: None, pending: None }
    }
}

/// What a woken request finds.
#[derive(Debug, PartialEq)]
pub(crate) enum Taken<T> {
    /// Fire it. It is already recorded as delivered (so a request arriving while
    /// the sink runs sees it); hand `Undo` to [`NotifyGate::declined`] if the sink
    /// sent nothing.
    Fire(T, Undo),
    /// Not yet: the floor of a notification delivered since moves it to this time.
    Wait(Instant),
    /// Superseded by a newer request, cleared by a reset, or the same state as
    /// the last notification.
    Gone,
}

/// What [`NotifyGate::take_due`] overwrote, to put back if the sink declined.
#[derive(Debug, PartialEq)]
pub(crate) struct Undo {
    state: ChatState,
    at: Instant,
    prev_state: Option<ChatState>,
    prev_at: Option<Instant>,
}

type Key = (String, Channel);

/// The bookkeeping, with the clock passed in so tests need no runtime.
pub struct NotifyGate<T = Action> {
    slots: Mutex<HashMap<Key, Slot<T>>>,
    /// Per chat: the turn count, and whether the current turn was opened by
    /// [`NotifyGate::turn_started`] and has not ended yet.
    turns: Mutex<HashMap<String, (u64, bool)>>,
    next_token: AtomicU64,
}

impl<T> Default for NotifyGate<T> {
    fn default() -> Self {
        Self { slots: Mutex::new(HashMap::new()), turns: Mutex::new(HashMap::new()), next_token: AtomicU64::new(1) }
    }
}

impl<T> NotifyGate<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// The chat's current turn, as the gate counts them.
    pub fn turn(&self, session_id: &str) -> u64 {
        self.turns.lock().unwrap().get(session_id).map_or(0, |t| t.0)
    }

    /// A turn started in this chat: whatever it waits on next is a new state.
    pub fn turn_started(&self, session_id: &str) {
        let mut turns = self.turns.lock().unwrap();
        let t = turns.entry(session_id.to_string()).or_insert((0, false));
        *t = (t.0 + 1, true);
    }

    /// A live turn reached its result line; called before its sound is asked
    /// for. A turn that never streamed (a send the CLI rejected at once, a rate
    /// limit) was never opened by [`Self::turn_started`], so it counts here, or
    /// its `done` would read as the previous turn's.
    pub fn turn_ending(&self, session_id: &str) {
        let mut turns = self.turns.lock().unwrap();
        let t = turns.entry(session_id.to_string()).or_insert((0, false));
        *t = (if t.1 { t.0 } else { t.0 + 1 }, false);
    }

    /// Records a request and returns its token and when to look at it again.
    pub(crate) fn offer(&self, session_id: &str, channel: Channel, state: ChatState, action: T, now: Instant) -> (u64, Instant) {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let mut slots = self.slots.lock().unwrap();
        // A slot whose state can never match again (no turn) and whose floor is
        // over holds nothing worth keeping; one is made per session-less prompt.
        slots.retain(|_, s| {
            s.pending.is_some()
                || s.last_state.as_ref().is_some_and(|st| st.turn.is_some())
                || s.last_at.is_some_and(|at| at + FLOOR > now)
        });
        let slot = slots.entry((session_id.to_string(), channel)).or_default();
        let settled = now + SETTLE;
        let due = slot.last_at.map_or(settled, |at| settled.max(at + FLOOR));
        // The request already waiting keeps its own token, so this one's task
        // finds itself replaced and does nothing.
        // Only within one turn: a later turn's `done` is news of its own.
        let outranked = state.kind == "done"
            && slot.pending.as_ref().is_some_and(|p| p.state.kind != "done" && p.state.turn == state.turn);
        if !outranked {
            slot.pending = Some(Pending { token, state, action });
        }
        (token, due)
    }

    /// The request `token` at time `now`: fire it, wait longer, or let it go.
    pub(crate) fn take_due(&self, session_id: &str, channel: Channel, token: u64, now: Instant) -> Taken<T> {
        let mut slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get_mut(&(session_id.to_string(), channel)) else { return Taken::Gone };
        if slot.pending.as_ref().map(|p| p.token) != Some(token) {
            return Taken::Gone;
        }
        if let Some(floor_end) = slot.last_at.map(|at| at + FLOOR).filter(|end| *end > now) {
            return Taken::Wait(floor_end);
        }
        let pending = slot.pending.take().expect("checked above");
        if slot.last_state.as_ref().is_some_and(|last| pending.state.same_as(last)) {
            return Taken::Gone;
        }
        let undo = Undo {
            state: pending.state.clone(),
            at: now,
            prev_state: slot.last_state.replace(pending.state),
            prev_at: slot.last_at.replace(now),
        };
        Taken::Fire(pending.action, undo)
    }

    /// The sink sent nothing (the phone push while Joe is at the desk): put the
    /// slot back, so a later request is still a change and no floor runs. Left
    /// alone if something newer was recorded since.
    pub(crate) fn declined(&self, session_id: &str, channel: Channel, undo: Undo) {
        let mut slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get_mut(&(session_id.to_string(), channel)) else { return };
        if slot.last_at == Some(undo.at) && slot.last_state.as_ref() == Some(&undo.state) {
            slot.last_state = undo.prev_state;
            slot.last_at = undo.prev_at;
        }
    }

    /// The chat stopped waiting on Joe (every open prompt in it is answered or
    /// gone), so its next request is a change even in the same turn. A push
    /// still settling is dropped: every push is for a prompt, and one answered
    /// within the settle would leave a banner no clear removes. A pending sound
    /// stays, since a turn-end `question` has no prompt behind it. The floor
    /// stays too: it counts notifications, not states.
    pub fn reset(&self, session_id: &str) {
        let mut slots = self.slots.lock().unwrap();
        for ((sid, channel), slot) in slots.iter_mut() {
            if sid == session_id {
                slot.last_state = None;
                if *channel == Channel::Push {
                    slot.pending = None;
                }
            }
        }
    }
}

/// The turn that names a daemon-run chat's state; `None` for a session the
/// registry does not know.
pub fn turn_of(state: &DaemonState, session_id: &str) -> Option<u64> {
    state.registry.get(session_id).map(|_| state.notify_gate.turn(session_id))
}

/// Asks the gate to play a chat's sound: `params` are the `turn_sound` frame's
/// (`session_id`, `awaiting`, `cwd`). `turn` is [`turn_of`] for a daemon-run chat.
pub fn sound(state: &Arc<DaemonState>, key: &str, kind: &'static str, turn: Option<u64>, params: Value) {
    request(state, key, Channel::Sound, ChatState { kind, turn }, Action::Sound(params));
}

/// Asks the gate to buzz the phone for a prompt `prompt_id` in `session_id`.
/// No-op when push is not set up.
pub fn push_blocked(state: &Arc<DaemonState>, session_id: Option<&str>, prompt_id: &str) {
    if state.push.get().is_none() {
        return;
    }
    let name = session_id
        .and_then(|sid| state.registry.get(sid))
        .map(|inst| {
            inst.name.clone().unwrap_or_else(|| {
                inst.cwd.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "a chat".into())
            })
        })
        .unwrap_or_else(|| "a chat".into());
    let show_name = state.settings.snapshot().push_show_chat_name();
    let action = Action::Push { name, prompt_id: prompt_id.to_string(), show_name };
    // A prompt with no session has no chat to dedupe on; each is its own key.
    let (key, turn) = match session_id {
        Some(sid) => (sid.to_string(), turn_of(state, sid)),
        None => (format!("prompt:{prompt_id}"), None),
    };
    request(state, &key, Channel::Push, ChatState { kind: "blocked", turn }, action);
}

fn request(state: &Arc<DaemonState>, key: &str, channel: Channel, chat: ChatState, action: Action) {
    let (token, due) = state.notify_gate.offer(key, channel, chat, action, Instant::now());
    let (state, key) = (state.clone(), key.to_string());
    tokio::spawn(async move {
        let mut due = due;
        loop {
            tokio::time::sleep_until(due).await;
            match state.notify_gate.take_due(&key, channel, token, Instant::now()) {
                Taken::Wait(later) => due = later,
                Taken::Gone => return,
                Taken::Fire(action, undo) => {
                    if !fire(&state, &key, action).await {
                        state.notify_gate.declined(&key, channel, undo);
                    }
                    return;
                }
            }
        }
    });
}

async fn fire(state: &Arc<DaemonState>, key: &str, action: Action) -> bool {
    match action {
        Action::Sound(mut params) => {
            if let Value::Object(map) = &mut params {
                map.insert("fired_at_ms".into(), chrono::Utc::now().timestamp_millis().into());
            }
            state.notifier.publish("turn_sound", params);
            true
        }
        Action::Push { name, prompt_id, show_name } => {
            let Some(pm) = state.push.get().cloned() else { return false };
            let sid = (!key.starts_with("prompt:")).then(|| key.to_string());
            pm.maybe_notify_blocked(sid, name, prompt_id, show_name).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn q(turn: u64) -> ChatState {
        ChatState { kind: "question", turn: Some(turn) }
    }
    fn done(turn: u64) -> ChatState {
        ChatState { kind: "done", turn: Some(turn) }
    }

    /// Offers, waits until due and fires. Returns what fired.
    fn run(g: &NotifyGate<&'static str>, sid: &str, st: ChatState, tag: &'static str, at: Instant) -> Option<&'static str> {
        let (token, due) = g.offer(sid, Channel::Sound, st, tag, at);
        let mut now = due;
        loop {
            match g.take_due(sid, Channel::Sound, token, now) {
                Taken::Wait(later) => now = later,
                Taken::Gone => return None,
                Taken::Fire(action, _) => return Some(action),
            }
        }
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn the_same_state_twice_notifies_once() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        assert_eq!(run(&g, "s", q(3), "card", t0), Some("card"));
        // The turn end that reports `question` for that card, well past the floor.
        assert_eq!(run(&g, "s", q(3), "turn end", t0 + secs(60)), None);
        // A new turn is a new state.
        assert_eq!(run(&g, "s", q(4), "next turn", t0 + secs(120)), Some("next turn"));
        // A different state in the same turn is a change too.
        assert_eq!(run(&g, "s", done(4), "done", t0 + secs(180)), Some("done"));
        assert_eq!(run(&g, "s", done(4), "done again", t0 + secs(240)), None);
    }

    /// Reviewer's case: a turn woken by a sub or a peer message does not move the
    /// registry's `turn_gen`, but it is a new turn, so its `done` rings.
    #[test]
    fn a_turn_started_by_a_wake_makes_its_done_a_change() {
        let g: NotifyGate<&'static str> = NotifyGate::new();
        let t0 = Instant::now();
        assert!(run(&g, "s", done(g.turn("s")), "first", t0).is_some());
        g.turn_started("s");
        assert_eq!(run(&g, "s", done(g.turn("s")), "woken", t0 + secs(60)), Some("woken"));
    }

    #[test]
    fn answering_every_prompt_makes_the_next_question_a_change() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        assert!(run(&g, "s", q(1), "first", t0).is_some());
        g.reset("s");
        assert_eq!(run(&g, "s", q(1), "second", t0 + secs(30)), Some("second"));
    }

    #[test]
    fn a_push_answered_while_it_settles_never_fires_but_a_sound_does() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        let (token, due) = g.offer("s", Channel::Push, q(1), "push", t0);
        g.reset("s");
        assert_eq!(g.take_due("s", Channel::Push, token, due), Taken::Gone);
        // A turn-end `question` has no prompt; an unrelated answer must not eat it.
        let (token, due) = g.offer("s", Channel::Sound, q(1), "turn end", t0);
        g.reset("s");
        assert!(matches!(g.take_due("s", Channel::Sound, token, due), Taken::Fire("turn end", _)));
    }

    /// Reviewer's case: a sub's card in the main chat, then the main chat's own
    /// turn ends inside the settle. The open card still rings.
    #[test]
    fn a_done_never_replaces_a_waiting_question() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        let (card, due) = g.offer("s", Channel::Sound, q(1), "card", t0);
        let (end, _) = g.offer("s", Channel::Sound, done(1), "done", t0 + Duration::from_millis(500));
        assert!(matches!(g.take_due("s", Channel::Sound, card, due), Taken::Fire("card", _)));
        assert_eq!(g.take_due("s", Channel::Sound, end, due + secs(11)), Taken::Gone);
        // A later turn's done is not outranked by an older turn's question.
        let (old_q, _) = g.offer("u", Channel::Sound, q(1), "old", t0);
        let (next, due) = g.offer("u", Channel::Sound, done(2), "next", t0);
        assert_eq!(g.take_due("u", Channel::Sound, old_q, due), Taken::Gone);
        assert!(matches!(g.take_due("u", Channel::Sound, next, due), Taken::Fire("next", _)));
        // A question does replace a waiting done.
        let (d, _) = g.offer("t", Channel::Sound, done(1), "done", t0);
        let (qq, due) = g.offer("t", Channel::Sound, q(1), "question", t0);
        assert_eq!(g.take_due("t", Channel::Sound, d, due), Taken::Gone);
        assert!(matches!(g.take_due("t", Channel::Sound, qq, due), Taken::Fire("question", _)));
    }

    /// Reviewer's case: a send the CLI rejects at once ends a turn that never
    /// streamed, so `turn_started` never ran; its `done` is still a new turn.
    #[test]
    fn a_turn_that_never_streamed_still_counts_as_a_new_turn() {
        let g: NotifyGate<&'static str> = NotifyGate::new();
        let t0 = Instant::now();
        g.turn_started("s");
        g.turn_ending("s");
        assert!(run(&g, "s", done(g.turn("s")), "streamed", t0).is_some());
        g.turn_ending("s");
        assert_eq!(run(&g, "s", done(g.turn("s")), "rejected", t0 + secs(60)), Some("rejected"));
        // A streamed turn is counted once, not again at its end.
        g.turn_started("s");
        let opened = g.turn("s");
        g.turn_ending("s");
        assert_eq!(g.turn("s"), opened);
    }

    #[test]
    fn a_session_without_a_turn_is_never_deduped_on_state() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        let ext = ChatState { kind: "done", turn: None };
        assert!(run(&g, "ext", ext.clone(), "a", t0).is_some());
        assert!(run(&g, "ext", ext, "b", t0 + secs(30)).is_some());
    }

    #[test]
    fn a_request_waits_out_the_settle_and_a_newer_one_replaces_it() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        let (first, due) = g.offer("s", Channel::Sound, done(1), "done", t0);
        assert_eq!(due, t0 + SETTLE, "nothing fires before the state has settled");
        let (second, due2) = g.offer("s", Channel::Sound, q(1), "question", t0 + Duration::from_millis(500));
        assert_eq!(g.take_due("s", Channel::Sound, first, due), Taken::Gone, "the flapped-away state never fires");
        assert!(matches!(g.take_due("s", Channel::Sound, second, due2), Taken::Fire("question", _)));
    }

    #[test]
    fn one_notification_per_chat_per_floor_and_a_held_one_still_fires() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        assert!(run(&g, "s", done(1), "done", t0).is_some());
        let delivered_at = t0 + SETTLE;
        let (token, due) = g.offer("s", Channel::Sound, q(2), "question", delivered_at + secs(2));
        assert_eq!(due, delivered_at + FLOOR, "held to the end of the floor");
        assert_eq!(g.take_due("s", Channel::Sound, token, delivered_at + secs(4)), Taken::Wait(delivered_at + FLOOR));
        assert!(matches!(g.take_due("s", Channel::Sound, token, delivered_at + FLOOR), Taken::Fire("question", _)));
        // Another chat has a floor of its own.
        let (other, other_due) = g.offer("other", Channel::Sound, q(1), "x", delivered_at + secs(2));
        assert_eq!(other_due, delivered_at + secs(2) + SETTLE);
        assert!(matches!(g.take_due("other", Channel::Sound, other, other_due), Taken::Fire("x", _)));
    }

    /// Reviewer's case: a push is a network call, and a second request for the
    /// same state must not slip through while it is in flight.
    #[test]
    fn a_request_arriving_while_the_sink_runs_sees_it_as_delivered() {
        let g = NotifyGate::new();
        let t0 = Instant::now();
        let (token, due) = g.offer("s", Channel::Push, q(1), "push", t0);
        let Taken::Fire(_, undo) = g.take_due("s", Channel::Push, token, due) else { panic!("fires") };
        let (second, due2) = g.offer("s", Channel::Push, q(1), "again", due);
        assert_eq!(due2, due + FLOOR, "the in-flight one already holds the floor");
        assert_eq!(g.take_due("s", Channel::Push, second, due2), Taken::Gone, "same state");
        // Joe was at the desk, so nothing went out: the slot is as it was.
        g.declined("s", Channel::Push, undo);
        assert_eq!(run_push(&g, q(1), due + secs(1)), Some("third"));
    }

    fn run_push(g: &NotifyGate<&'static str>, st: ChatState, at: Instant) -> Option<&'static str> {
        let (token, due) = g.offer("s", Channel::Push, st, "third", at);
        match g.take_due("s", Channel::Push, token, due) {
            Taken::Fire(a, _) => Some(a),
            _ => None,
        }
    }

    #[test]
    fn channels_keep_their_own_state() {
        let g: NotifyGate<&'static str> = NotifyGate::new();
        let t0 = Instant::now();
        assert!(run(&g, "s", q(1), "sound", t0).is_some());
        let (token, due) = g.offer("s", Channel::Push, q(1), "push", t0);
        assert!(matches!(g.take_due("s", Channel::Push, token, due), Taken::Fire("push", _)));
    }

    #[test]
    fn spent_slots_of_sessionless_prompts_are_dropped() {
        let g: NotifyGate<&'static str> = NotifyGate::new();
        let t0 = Instant::now();
        let none = ChatState { kind: "question", turn: None };
        assert!(run(&g, "prompt:a", none.clone(), "a", t0).is_some());
        assert!(run(&g, "s", q(1), "kept", t0).is_some());
        g.offer("prompt:b", Channel::Sound, none, "b", t0 + secs(60));
        let slots = g.slots.lock().unwrap();
        assert!(!slots.contains_key(&("prompt:a".to_string(), Channel::Sound)));
        assert!(slots.contains_key(&("s".to_string(), Channel::Sound)), "a chat's state is kept");
    }

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sounds(rx: &mut tokio::sync::broadcast::Receiver<Value>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(f) = rx.try_recv() {
            if f["method"] == "turn_sound" {
                out.push(f["params"].clone());
            }
        }
        out
    }

    /// The live case from 2026-11-10 18:48: a question card at 18:48:01 and the
    /// turn end reporting `question` at 18:48:10 rang twice.
    #[tokio::test(start_paused = true)]
    async fn a_question_card_and_its_turn_end_ring_once() {
        let st = state();
        st.registry.upsert_interactive("chat", std::path::Path::new("."), "proj", "2026-11-10T00:00:00Z");
        let mut rx = st.notifier.subscribe();
        let turn = turn_of(&st, "chat");
        sound(&st, "chat", "question", turn, json!({ "session_id": "chat", "awaiting": "question" }));
        tokio::time::sleep(SETTLE + Duration::from_millis(10)).await;
        assert_eq!(sounds(&mut rx).len(), 1, "the card rings");
        tokio::time::sleep(secs(9)).await;
        sound(&st, "chat", "question", turn_of(&st, "chat"), json!({ "session_id": "chat", "awaiting": "question" }));
        tokio::time::sleep(FLOOR + SETTLE).await;
        assert!(sounds(&mut rx).is_empty(), "its turn end does not ring again");
    }

    /// The live case from 2026-11-10 18:27:52: six cards raised in one main chat
    /// in the same second rang six times.
    #[tokio::test(start_paused = true)]
    async fn a_burst_in_one_chat_rings_once_and_carries_a_fire_time() {
        let st = state();
        st.registry.upsert_interactive("main", std::path::Path::new("."), "proj", "2026-11-10T00:00:00Z");
        let mut rx = st.notifier.subscribe();
        for i in 0..6 {
            sound(&st, "main", "question", turn_of(&st, "main"), json!({ "session_id": "main", "awaiting": "question" }));
            // Spread past the settle, so only the same-state rule can hold them back.
            if i < 5 {
                tokio::time::sleep(SETTLE + secs(1)).await;
            }
        }
        tokio::time::sleep(SETTLE + FLOOR).await;
        let rang = sounds(&mut rx);
        assert_eq!(rang.len(), 1, "{rang:?}");
        assert!(rang[0]["fired_at_ms"].is_i64(), "the phone's staleness check needs the fire time");
    }
}
