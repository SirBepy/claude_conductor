//! The idle rule (docs/architecture/chat-dashboard.md, "Idle chats hide themselves"): a chat that
//! has done nothing for [`hide_after`] moves into the hidden window by itself, so the heads show
//! only chats that are working or waiting on Joe. It uses the same hidden list every client draws
//! (`sessions::hidden_chats`), so the desktop and the phone move together, and keeps its own
//! record of what it hid (`sessions::auto_hidden`) so it only ever brings back its own.
//!
//! A chat is idle when [`blocker`] finds nothing: it and its subs are not working, no card is
//! open, nothing waits on Joe, no draft is unsent, Joe has viewed its latest result (the
//! daemon's `viewed_at_ms` mark, so he sees a result before the chat can go quiet), and it is not
//! pinned. The clock restarts whenever any of that stops being true, and starts no earlier than
//! Joe's last view of the chat. A chat he has open stays awake because his window renews its
//! viewed mark every minute while the chat is on screen (`chat-seen.ts`, `startViewedHeartbeat`).
//!
//! The rule never overrules Joe. A chat he hid by hand is not the rule's and stays hidden. A chat
//! the rule hid and he showed by hand stays shown until its `last_event_at` moves (a new turn),
//! which is when the rule may hide it again. Both are recorded by `note_hand_change`, the one
//! hook the `update_hidden_chats` method calls.
//!
//! A hidden chat comes back by itself the moment its state changes: a new turn, a card, a sub
//! starting, a queued message. [`reconcile`] checks that on every `instances_changed`, so a card
//! never waits for the next sweep tick. The daemon's own idle compaction (30 quiet minutes) is
//! housekeeping, not a turn, and brings nothing back.
//!
//! The hide itself rides the same 60-second tick as the idle freeze (`busy_watchdog`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::machines::hidden::{merged_lists, update_local, view};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{compaction, family};
use crate::sessions::hidden_chats::HiddenDelta;
use crate::sessions::kinds::InstanceKind;
use crate::sessions::message_drafts::{self as drafts_store, DraftState, MessageDraft};
use crate::sessions::{auto_hidden, chat_config};
use crate::types::Instance;

/// How long a chat must stay idle before it hides.
pub const AUTO_HIDE_AFTER: Duration = Duration::from_secs(10 * 60);

/// Overrides [`AUTO_HIDE_AFTER`] with a number of seconds, for a live run that cannot wait ten
/// minutes. Read once, on first use.
pub const HIDE_SECS_ENV: &str = "CC_AUTO_HIDE_SECS";

/// A draft this old is stale and holds nothing back (the heads' pencil ignores it too).
const DRAFT_STALE: chrono::Duration = chrono::Duration::days(7);

/// How long after the daemon's compaction ends its last turn stamp still counts as part of it.
const COMPACTION_TAIL: Duration = Duration::from_secs(60);

fn parse_secs(raw: Option<&str>) -> Duration {
    raw.and_then(|v| v.trim().parse::<u64>().ok()).filter(|s| *s > 0).map_or(AUTO_HIDE_AFTER, Duration::from_secs)
}

pub fn hide_after() -> Duration {
    static AFTER: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *AFTER.get_or_init(|| parse_secs(std::env::var(HIDE_SECS_ENV).ok().as_deref()))
}

/// What the registry row cannot say by itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Any card of this chat is open (permission, question, secret, plan, ...).
    pub open_prompt: bool,
    /// A compaction (or its save turn) is running on this chat.
    pub compacting: bool,
    /// A peer machine owns this chat.
    pub mirrored: bool,
    /// A sub of this chat has not finished (local or on a paired machine).
    pub subs_working: bool,
    /// A sub of this chat finished after Joe last viewed the chat or the sub.
    pub subs_unviewed: bool,
    /// The chat holds a draft still to send.
    pub draft: bool,
    /// When Joe last had this chat on screen (epoch ms, 0 = never).
    pub viewed_ms: i64,
}

fn ms_of(t: Option<&str>) -> Option<i64> {
    t.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp_millis())
}

/// The stamp that moves when the chat's busy state flips and on any line its child prints (so a
/// spawn banner moves it too); "" for a row that has none yet.
fn stamp(i: &Instance) -> String {
    i.last_event_at.clone().unwrap_or_default()
}

/// Nothing is owed to Joe or to the chat's own work: `none` and `done`.
fn is_settled(awaiting: Option<&str>) -> bool {
    matches!(awaiting, None | Some("done"))
}

/// Why `i` may not hide now; `None` means it may. The checks that read the row alone run first,
/// so the card, sub and draft reads only happen for a chat that could hide.
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
    if i.pinned_to_sidebar {
        return Some("pinned");
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
    // A question, permission or waiting state all mean it waits on someone; only `none` and
    // `done` mean the turn is over and nothing is owed.
    if !is_settled(i.awaiting.as_deref()) {
        return Some("waiting");
    }
    if i.local_task_running {
        return Some("a background task runs");
    }
    if i.held_count > 0 {
        return Some("it has held messages");
    }
    if f.open_prompt {
        return Some("a card is open");
    }
    if f.subs_working {
        return Some("a sub is working");
    }
    if f.draft {
        return Some("it holds a draft");
    }
    if ms_of(i.last_event_at.as_deref()).is_some_and(|t| t > f.viewed_ms) {
        return Some("its latest result is unviewed");
    }
    if f.subs_unviewed {
        return Some("a sub finished unviewed");
    }
    None
}

/// What the rule does about a chat it hid, given its row now.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing changed that matters.
    Stay,
    /// The stamp moved only because the daemon compacted the chat: keep it hidden, and remember
    /// the new stamp so the next real change is still a change.
    Refresh,
    /// The chat's state changed: it comes back.
    Back(&'static str),
}

/// Whether a chat the rule hid at stamp `at` should come back. Pure over its inputs.
pub fn comes_back(i: &Instance, subs_working: bool, compacting: bool, compacted_recently: bool, at: &str) -> Verdict {
    // A chat that ended stays where it is, and the daemon's own compaction is not Joe's business.
    if i.ended_at.is_some() || i.end_reason.is_some() || compacting {
        return Verdict::Stay;
    }
    if i.busy {
        // The compaction's own turn clears its flight before the registry's busy flag drops, so a
        // `reconcile` in that gap sees a busy chat nobody typed to. The next one, past the tail,
        // judges a turn that really runs.
        return if compacted_recently { Verdict::Stay } else { Verdict::Back("a turn started") };
    }
    if !is_settled(i.awaiting.as_deref()) {
        return Verdict::Back("it waits on something");
    }
    if i.local_task_running {
        return Verdict::Back("a background task runs");
    }
    if i.held_count > 0 {
        return Verdict::Back("a message is queued");
    }
    if subs_working {
        return Verdict::Back("a sub is working");
    }
    if stamp(i) != at {
        return if compacted_recently { Verdict::Refresh } else { Verdict::Back("a turn ended") };
    }
    Verdict::Stay
}

/// When each chat was first seen with nothing blocking it. A chat that blocks again drops out,
/// so its quiet time starts over. The wall clock (`last_event_at`, Joe's last view) is also
/// required to be old, but a restored row has neither, so this clock is the one that always exists.
fn seen_idle() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static SEEN: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the last thing that happened to `i` (a result, or Joe looking at it) is old enough.
fn quiet_for(i: &Instance, viewed_ms: i64, wall: chrono::DateTime<chrono::Utc>, after: Duration) -> bool {
    let last = ms_of(i.last_event_at.as_deref()).unwrap_or(0).max(viewed_ms);
    last == 0 || wall.timestamp_millis().saturating_sub(last) >= after.as_millis() as i64
}

/// The ids to hide at this tick: blocker-free for a full `after` by both clocks.
fn due(rows: &[(Instance, Facts)], seen: &mut HashMap<String, Instant>, now: Instant, wall: chrono::DateTime<chrono::Utc>, after: Duration) -> Vec<String> {
    let mut out = Vec::new();
    let mut keep: Vec<&str> = Vec::new();
    for (i, f) in rows {
        if blocker(i, f).is_some() {
            continue;
        }
        keep.push(&i.session_id);
        let first = *seen.entry(i.session_id.clone()).or_insert(now);
        if now.duration_since(first) >= after && quiet_for(i, f.viewed_ms, wall, after) {
            out.push(i.session_id.clone());
        }
    }
    seen.retain(|id, _| keep.contains(&id.as_str()));
    out
}

/// Whether a draft still waits to be sent from `id`, the chat that wrote it or the main chat of
/// the sub that did (the dashboard lists a sub's drafts too). Copied, archived, stale and fully
/// posted drafts hold nothing.
fn draft_owner(drafts: &[MessageDraft], id: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    drafts.iter().any(|d| {
        if !matches!(d.state, DraftState::NeedsYou) {
            return false;
        }
        let stale = chrono::DateTime::parse_from_rfc3339(&d.updated_at).is_ok_and(|t| now.signed_duration_since(t) >= DRAFT_STALE);
        if stale || (!d.variants.is_empty() && d.variants.iter().all(|v| v.sent)) {
            return false;
        }
        d.origin_session_id == id || d.origin_main_session_id.as_deref() == Some(id)
    })
}

/// A project's drafts, read once per sweep.
#[derive(Default)]
struct Drafts(HashMap<String, Vec<MessageDraft>>);

impl Drafts {
    fn owns(&mut self, project_id: &str, id: &str) -> bool {
        if project_id.is_empty() {
            return false;
        }
        let list = self.0.entry(project_id.to_string()).or_insert_with(|| drafts_store::list(project_id));
        draft_owner(list, id, chrono::Utc::now())
    }
}

fn viewed_ms_of(id: &str) -> i64 {
    chat_config::get(id).map_or(0, |c| c.viewed_at_ms)
}

/// Whether any sub of `main` is still working, and whether one finished after Joe last looked.
/// A finished sub on a paired machine carries no finish time here, so it never counts as unviewed.
fn sub_facts(state: &DaemonState, main: &str, main_viewed: i64) -> (bool, bool) {
    let (mut working, mut unviewed) = (false, false);
    for m in family::live_subs(state, main) {
        if !m.finished {
            working = true;
            continue;
        }
        if m.remote {
            continue;
        }
        let Some(row) = state.registry.get(&m.sub_id) else { continue };
        let seen = main_viewed.max(viewed_ms_of(&m.sub_id));
        if ms_of(row.last_event_at.as_deref()).is_some_and(|t| t > seen) {
            unviewed = true;
        }
    }
    (working, unviewed)
}

async fn facts_for(state: &Arc<DaemonState>, i: &Instance, drafts: &mut Drafts) -> Facts {
    let mut f = Facts::default();
    if blocker(i, &f).is_some() {
        return f;
    }
    f.mirrored = crate::daemon::machines::mirrored_owner(state, &i.session_id).is_some();
    f.compacting = compaction::is_compacting(&i.session_id);
    f.viewed_ms = viewed_ms_of(&i.session_id);
    f.open_prompt = crate::daemon::lifecycle::has_open_prompt(state, &i.session_id).await;
    (f.subs_working, f.subs_unviewed) = sub_facts(state, &i.session_id, f.viewed_ms);
    f.draft = drafts.owns(&i.project_id, &i.session_id);
    f
}

/// Puts `id` back in the shown stack and tells every client.
fn bring_back(state: &DaemonState, id: &str, why: &str) {
    auto_hidden::forget_hidden(id);
    let delta = HiddenDelta { remove: vec![id.to_string()], ..Default::default() };
    let (_, changed) = update_local(state, &delta);
    if changed {
        state.notifier.publish("hidden_chats_changed", view(&merged_lists(state)));
        log::info!("auto hide: session {id} is back in the stack: {why}");
    }
}

/// Brings back every chat the rule hid whose state changed, or all of them when the switch is
/// off. Synchronous and cheap (it only walks the chats the rule hid), so it runs on every
/// `instances_changed` and a card or a new turn never waits for the sweep tick.
pub fn reconcile(state: &DaemonState) {
    let auto = auto_hidden::list();
    if auto.hidden.is_empty() {
        return;
    }
    let on = state.settings.snapshot().auto_hide_idle_chats();
    for (id, at) in &auto.hidden {
        if !on {
            bring_back(state, id, "the switch is off");
            continue;
        }
        let Some(row) = state.registry.get(id) else { continue };
        let compacting = compaction::is_compacting(id);
        let subs_working = !compacting && family::live_subs(state, id).iter().any(|m| !m.finished);
        let tail = compaction::ended_within(id, COMPACTION_TAIL);
        match comes_back(&row, subs_working, compacting, tail, at) {
            Verdict::Stay => {}
            Verdict::Refresh => {
                auto_hidden::hide(id, &stamp(&row));
            }
            Verdict::Back(why) => bring_back(state, id, why),
        }
    }
}

/// Records what Joe did by hand through `update_hidden_chats`, so the rule never overrules it.
/// A chat he shows is his until its stamp moves; a chat he hides (even one the rule hid) is his
/// for good, since the rule only ever brings back chats it hid itself.
pub fn note_hand_change(state: &DaemonState, add: &[String], remove: &[String]) {
    for id in add {
        auto_hidden::forget_hidden(id);
    }
    for id in remove {
        if let Some(row) = state.registry.get(id) {
            auto_hidden::shown_by_hand(id, &stamp(&row));
        }
    }
}

/// The chats that could hide this tick, with their facts: not hidden already, and not shown by
/// hand since their state last changed.
async fn candidates(state: &Arc<DaemonState>) -> Vec<(Instance, Facts)> {
    let hidden: HashSet<String> = merged_lists(state).sessions.into_iter().collect();
    let auto = auto_hidden::list();
    let mut drafts = Drafts::default();
    let mut rows = Vec::new();
    for i in state.registry.list() {
        if hidden.contains(&i.session_id) {
            continue;
        }
        // Joe showed this chat by hand: the rule waits for its state to change.
        if let Some(at) = auto.shown.get(&i.session_id) {
            if *at == stamp(&i) {
                continue;
            }
            auto_hidden::clear_shown(&i.session_id);
        }
        let f = facts_for(state, &i, &mut drafts).await;
        rows.push((i, f));
    }
    rows
}

/// The watchdog tick: brings back what changed, then hides each chat that has been idle for
/// [`hide_after`].
pub async fn sweep(state: &Arc<DaemonState>) {
    reconcile(state);
    if !state.settings.snapshot().auto_hide_idle_chats() {
        seen_idle().clear();
        return;
    }
    let rows = candidates(state).await;
    let ids = due(&rows, &mut seen_idle(), Instant::now(), chrono::Utc::now(), hide_after());
    for id in ids {
        hide(state, &id).await;
    }
}

/// Hides `id` after reading its blockers once more from the live row: a card or a message that
/// arrived since the tick's read keeps the chat where it is.
async fn hide(state: &Arc<DaemonState>, id: &str) {
    let Some(row) = state.registry.get(id) else { return };
    let mut drafts = Drafts::default();
    let f = facts_for(state, &row, &mut drafts).await;
    if blocker(&row, &f).is_some() {
        seen_idle().remove(id);
        return;
    }
    // The rule's record first: a crash between the two leaves a record of a chat that is still
    // shown, which `reconcile` clears, never a hidden chat nobody owns.
    auto_hidden::hide(id, &stamp(&row));
    let delta = HiddenDelta { add: vec![id.to_string()], ..Default::default() };
    let (_, changed) = update_local(state, &delta);
    seen_idle().remove(id);
    if changed {
        state.notifier.publish("hidden_chats_changed", view(&merged_lists(state)));
        log::info!("auto hide: session {id} was idle for {}s, moved into the hidden window", hide_after().as_secs());
    }
}

#[cfg(test)]
mod tests;
