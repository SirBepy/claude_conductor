//! The home's half of a visiting sub's events: `sub_event` from the host
//! (`docs/cross-machine-subchats.md`, "Wire" and "Identity and trust").
//!
//! The host is a paired machine, not a trusted one. An event is applied only when
//! the remote-subs record names that sub id AND the machine of the transport the
//! call came in on (`ctx.transport`, never a payload field), so a peer cannot speak
//! for a sub it does not host or for a local chat. A number the home has already
//! seen is dropped, so a resent or replayed event does nothing, and a finish round
//! it already stored is never run twice. Every text in an event is cut to size
//! before it is stored or drawn (`events::clean_record`, `clean_facts`), and every
//! notice the home writes is built from ids and fixed words.
//!
//! A `finished` event runs the same family steps a local sub's finish does
//! (decisions log, the card, the one line back, the `report_back` wake, the close
//! a main chat was waiting on, the `after` queue), from the record the host sent
//! stored as `<sub>.finish.json`.

use super::events::{self, Event, Notice, SubEvent};
use super::land;
use super::records::{self, RemoteState, RemoteSub};
use crate::daemon::rpc::{ConnectionContext, Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::worktree::Landing;
use crate::daemon::subchats::{back, card_log, card_watch, ceiling, closing, decisions, finish, held, plumbing, wake};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// The problems a host may raise about a visiting sub: it could not start, or
/// could not be rebuilt. The merge problems are the home's own.
const HOST_PROBLEMS: [plumbing::Problem; 2] = [plumbing::Problem::CouldNotStart, plumbing::Problem::NotRebuilt];

/// Registers `sub_event`.
pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    router.register("sub_event", move |params, ctx| {
        let state = state.clone();
        async move { handle(&state, &ctx, params) }
    });
}

fn handle(state: &Arc<DaemonState>, ctx: &ConnectionContext, params: Option<Value>) -> Result<Value, RpcError> {
    let machine = super::host::peer_of(ctx, "sub_event")?;
    let req: SubEvent = serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))?;
    let outcome = apply(state, &machine, req)?;
    Ok(json!({ "ok": true, "outcome": outcome.word() }))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The event was applied.
    Applied,
    /// A number or a finish round the home already has: nothing was done.
    Duplicate,
    /// Valid, and for a sub that has nothing left to say (it already ended) or a
    /// kind of event the home does not act on: nothing was done.
    Ignored,
}

impl Outcome {
    fn word(&self) -> &'static str {
        match self {
            Outcome::Applied => "applied",
            Outcome::Duplicate => "duplicate",
            Outcome::Ignored => "ignored",
        }
    }
}

/// Sub ids being applied right now: two events for one sub at once (a replay racing
/// the original) must not both run the family steps.
static APPLYING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct Applying(String);

impl Applying {
    fn claim(sub_id: &str) -> Option<Applying> {
        let mut g = APPLYING.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(Default::default).insert(sub_id.to_string()).then(|| Applying(sub_id.to_string()))
    }
}

impl Drop for Applying {
    fn drop(&mut self) {
        if let Some(set) = APPLYING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Applies one event from `machine_id`, the machine the call arrived from.
pub(crate) fn apply(state: &Arc<DaemonState>, machine_id: &str, req: SubEvent) -> Result<Outcome, RpcError> {
    // The one trust check: the record names this sub AND this machine.
    if !records::accepts(&req.sub_id, machine_id) {
        return Err(RpcError::invalid_params("this machine does not host a sub with that id for a chat here"));
    }
    let Some(_applying) = Applying::claim(&req.sub_id) else { return Ok(Outcome::Duplicate) };
    let Some(rec) = records::get(&req.sub_id).filter(|r| r.machine_id == machine_id) else {
        return Err(RpcError::invalid_params("this machine does not host a sub with that id for a chat here"));
    };
    if req.seq <= rec.last_seq {
        return Ok(Outcome::Duplicate);
    }
    let seq = req.seq;
    let outcome = match req.event {
        Event::Finished { round, record, facts, model, effort } => finished(state, &rec, seq, round, record, facts, model, effort)?,
        Event::Ended => ended(state, &rec, seq)?,
        Event::Wake { problem, detail } => wake_main(state, &rec, seq, &problem, &detail)?,
        Event::Notice { notice } => notice_main(state, &rec, seq, notice)?,
        Event::OpenRequested => open_requested(state, &rec, seq)?,
        Event::Card { card } => card_main(state, &rec, seq, card)?,
    };
    Ok(outcome)
}

/// Remembers `seq` and that the host just spoke (so it is not unreachable), plus
/// whatever `edit` changes in the same write.
fn note(rec: &RemoteSub, seq: u64, edit: impl FnOnce(&mut RemoteSub)) -> Result<(), RpcError> {
    records::update(&rec.sub_id, |r| {
        r.last_seq = r.last_seq.max(seq);
        r.unreachable_since = None;
        r.woke_unreachable = false;
        edit(r);
    })
    .map(|_| ())
    .map_err(|e| RpcError::internal(format!("could not record the event: {e}")))
}

#[allow(clippy::too_many_arguments)]
fn finished(
    state: &Arc<DaemonState>,
    rec: &RemoteSub,
    seq: u64,
    round: u32,
    record: finish::FinishRecord,
    facts: crate::daemon::subchats::facts::Facts,
    model: String,
    effort: String,
) -> Result<Outcome, RpcError> {
    let Some(root) = decisions::data_root() else { return Err(RpcError::internal("no data folder to store the finish record in")) };
    let round = round.max(1);
    // A round already applied is the same finish arriving again under a new number.
    if round <= rec.finished_round {
        note(rec, seq, |_| {})?;
        return Ok(Outcome::Duplicate);
    }
    // Marked before the finish record or the Finished state can be read: whatever waits for this
    // sub reads "landing" as not done yet, until the merge has happened.
    // The wait mark comes first: a refused claim is then never followed by a moment in which neither
    // a landing nor a waiter is recorded.
    let lands = land::lands(rec);
    let waiting = lands.then(|| crate::daemon::subchats::merge_followup::Waiting::mark(&rec.sub_id));
    let landing_mark = lands.then(|| crate::daemon::subchats::merge_followup::claim_landing(&rec.sub_id)).flatten();
    let waiting = waiting.filter(|_| landing_mark.is_none());
    let mut clean = events::clean_record(&record, &rec.sub_id, &rec.main_id);
    clean.round = round;
    finish::write_record_in(&root, &clean).map_err(|e| RpcError::internal(format!("could not store the finish record: {e}")))?;
    // The host builds a finish on a thread (git facts) while the end of the same chat
    // is queued at once, so `ended` can carry the lower number: the finish still counts
    // (`finished_round` says so to `subchat merge` and the tick), and a sub that has
    // ended stays ended.
    note(rec, seq, |r| {
        if r.state == RemoteState::Ended {
            r.finished_after_end = true;
        } else {
            r.state = RemoteState::Finished;
        }
        r.finished_round = round;
    })?;
    plumbing::clear(&rec.sub_id);
    log::info!("subchats: remote sub {} finished (round {round}) on {}", rec.sub_id, rec.machine_id);
    let steps = FinishSteps { facts: events::clean_facts(&facts), model: events::clean_name(&model), effort: events::clean_name(&effort) };
    // A writing sub's commits are fetched and merged first, so the card, the line back
    // and whatever waits for this sub see what landed, as for a local sub; the host is
    // asked over the link, which takes the runtime. Without one (a test) it runs inline.
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if land::lands(rec) => {
            let (state, rec) = (state.clone(), records::get(&rec.sub_id).unwrap_or_else(|| rec.clone()));
            handle.spawn(async move {
                // A landing of this sub is running already (the tick's retry, `subchat merge`): this
                // one waits its turn, so the sub never reads as landed while one still runs.
                let landing_mark = match (landing_mark, waiting) {
                    (Some(mark), _) => Some(mark),
                    (None, Some(waiting)) => crate::daemon::subchats::merge_followup::claim_landing_wait(&rec.sub_id, waiting).await,
                    (None, None) => None,
                };
                // Never landed without the claim: another landing that has run five minutes is
                // stuck or slow, and two at once would race on the checkout. The tick's retry
                // (`merge_followup::retry_pending`) takes it up when that one is done.
                let Some(landing_mark) = landing_mark else {
                    let blocked = crate::daemon::subchats::worktree::Blocked {
                        verdict: "Merge waiting",
                        text: "Another merge of this sub has been running for more than five minutes, so this one waits. It lands by itself when that one is done.".to_string(),
                        points: Vec::new(),
                        cause: crate::daemon::subchats::worktree::Cause::DirtyOverlap,
                    };
                    crate::daemon::subchats::merge_followup::on_blocked_remote(&state, &rec, &blocked);
                    steps.run(&state, &rec.sub_id, Some(&Landing::Blocked(blocked)));
                    return;
                };
                let landing = land::land_and_report(&state, &rec).await;
                // Released before the steps: they start whatever waited for this sub.
                drop(landing_mark);
                steps.run(&state, &rec.sub_id, Some(&landing));
            });
        }
        _ => steps.run(state, &rec.sub_id, None),
    }
    Ok(Outcome::Applied)
}

/// What the finish steps need of the event, kept while the landing runs.
struct FinishSteps {
    facts: crate::daemon::subchats::facts::Facts,
    model: String,
    effort: String,
}

impl FinishSteps {
    /// The family steps of a local finish, in its order. `landing` is `None` when no
    /// merge was tried here (a reader, or no runtime to ask the host on).
    fn run(self, state: &Arc<DaemonState>, sub_id: &str, landing: Option<&Landing>) {
        let merged = match landing {
            Some(Landing::Merged) => Some(true),
            Some(Landing::Nothing) => None,
            _ => (self.facts.commits.unwrap_or(0) > 0).then_some(false),
        };
        decisions::on_finished(state, sub_id);
        card_log::on_remote_finished(state, sub_id, self.facts, self.model, self.effort, merged);
        back::on_finished(state, sub_id);
        wake::on_finished(state, sub_id);
        closing::on_sub_settled(state, sub_id);
        held::on_target_done(state);
    }
}

fn ended(state: &Arc<DaemonState>, rec: &RemoteSub, seq: u64) -> Result<Outcome, RpcError> {
    if rec.state == RemoteState::Ended {
        note(rec, seq, |_| {})?;
        return Ok(Outcome::Duplicate);
    }
    note(rec, seq, |r| r.state = RemoteState::Ended)?;
    plumbing::clear(&rec.sub_id);
    log::info!("subchats: remote sub {} ended on {}", rec.sub_id, rec.machine_id);
    closing::on_sub_settled(state, &rec.sub_id);
    held::on_target_done(state);
    Ok(Outcome::Applied)
}

fn wake_main(state: &Arc<DaemonState>, rec: &RemoteSub, seq: u64, problem: &str, detail: &str) -> Result<Outcome, RpcError> {
    let known = HOST_PROBLEMS.into_iter().find(|p| p.word() == problem);
    note(rec, seq, |_| {})?;
    let Some(known) = known else {
        log::warn!("subchats: {} reported a problem this build does not take from a host: {problem:?}", rec.machine_id);
        return Ok(Outcome::Ignored);
    };
    plumbing::report_here(state, &rec.sub_id, known, events::clean_detail(detail), Vec::new());
    Ok(Outcome::Applied)
}

/// Longest a card is said to have waited, so a number from a host cannot make the
/// line say something absurd.
const MAX_MINUTES: i64 = 100_000;

/// A host watcher's finding, worded here from the kind and its numbers.
fn notice_main(state: &Arc<DaemonState>, rec: &RemoteSub, seq: u64, notice: Notice) -> Result<Outcome, RpcError> {
    note(rec, seq, |_| {})?;
    if rec.state == RemoteState::Ended || !held::chat_live(state, &rec.main_id) {
        return Ok(Outcome::Ignored);
    }
    let name = decisions::sub_name(state, &rec.sub_id);
    let text = match notice {
        Notice::CardUnanswered { cause, minutes } => card_watch::notice(&name, &rec.sub_id, cause, minutes.clamp(0, MAX_MINUTES)),
        Notice::ContextBand { pct } => ceiling::context_notice(&name, &rec.sub_id, pct.min(100)),
    };
    crate::daemon::repo_channel_wake::enqueue_notice(state, &rec.main_id, text);
    if tokio::runtime::Handle::try_current().is_ok() {
        crate::daemon::repo_channel_wake::spawn_drain(state, &rec.main_id);
    }
    Ok(Outcome::Applied)
}

/// A card the sub's `send_message` drew: the same card a local sub draws, shown in the
/// main chat's window with the name the main chat gave the sub and the machine it runs
/// on. Dropped for an ended sub or a main chat that is gone, like a notice.
fn card_main(state: &Arc<DaemonState>, rec: &RemoteSub, seq: u64, card: events::CardEvent) -> Result<Outcome, RpcError> {
    note(rec, seq, |_| {})?;
    if rec.state == RemoteState::Ended || !held::chat_live(state, &rec.main_id) {
        return Ok(Outcome::Ignored);
    }
    let Some(clean) = events::clean_card(&card) else {
        log::warn!("subchats: {} sent a card of a kind that does not draw: {:?}", rec.machine_id, card.kind);
        return Ok(Outcome::Ignored);
    };
    let Some(root) = decisions::data_root() else { return Ok(Outcome::Ignored) };
    Ok(match crate::daemon::subchats::card_log::draw_remote_card_at(&root, state, rec, clean) {
        Some(_) => Outcome::Applied,
        None => Outcome::Ignored,
    })
}

/// Joe picked "Open it" on a card of this sub: the seam the main chat window
/// listens on, as for a local sub.
fn open_requested(state: &Arc<DaemonState>, rec: &RemoteSub, seq: u64) -> Result<Outcome, RpcError> {
    note(rec, seq, |_| {})?;
    if rec.state == RemoteState::Ended {
        return Ok(Outcome::Ignored);
    }
    state.notifier.publish("subchat_open_requested", json!({ "display_session_id": rec.main_id, "sub_id": rec.sub_id }));
    Ok(Outcome::Applied)
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod tests;
