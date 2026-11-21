//! `after` chains for a sub that runs on a paired machine
//! (`docs/cross-machine-subchats.md`, step 6).
//!
//! The host registers the sub with `hold: true` and starts nothing; this home keeps
//! the wait in the sub's record (`RemoteSub.after`) and decides when to start it, with
//! the evaluation a local waiting sub gets (`held::evaluate_after`: clean when every
//! target finished clean, blocked when one ended or finished blocked, else pending).
//! A clean wait starts the sub with `sub_start`, a blocked one asks Joe on the same
//! "Queued sub" card a local sub's does, and a sub that waited five minutes with
//! nothing in its way wakes its main chat once, as `queue_watch` does for a local one.
//! The host's own `queue_watch` stays inert for a visiting sub (it has no `after`
//! there), so this is the only watch.

use super::actions;
use super::records::{self, RemoteState, RemoteSub};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::cards::{self, CardAnswer, CardOption, RaisedCard};
use crate::daemon::subchats::held::{self, AfterState};
use crate::daemon::subchats::plumbing::{self, Problem};
use crate::daemon::subchats::queue_watch::{self, QueueStall};
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

/// Remote subs a start is in flight for, so a finish event and the tick cannot both start one.
static STARTING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Remote subs Joe skipped the decision card of, or whose start the host refused: not
/// retried until a restart or a `subchat retry`, as `held`'s parked set.
static PARKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Default)]
struct Watch {
    since: HashMap<String, DateTime<Utc>>,
    woken: HashSet<String>,
}

static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

pub(crate) struct Claim(String);

/// Whether `sub_id` has a start claim now.
#[cfg(test)]
pub(crate) fn is_claimed(sub_id: &str) -> bool {
    starting(sub_id)
}

impl Drop for Claim {
    fn drop(&mut self) {
        if let Some(set) = STARTING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// The right to start `sub_id` now: the pass, a menu's Start now and `subchat retry` all take it,
/// so two of them never both send `sub_start`.
pub(crate) fn claim(sub_id: &str) -> Option<Claim> {
    let mut g = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(sub_id.to_string()).then(|| Claim(sub_id.to_string()))
}

fn starting(sub_id: &str) -> bool {
    STARTING.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

fn parked(sub_id: &str) -> bool {
    PARKED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// Parks or unparks `sub_id`: `subchat retry` and Joe's answer unpark it.
pub(crate) fn set_parked(sub_id: &str, on: bool) {
    let mut g = PARKED.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if on {
        set.insert(sub_id.to_string());
    } else {
        set.remove(sub_id);
    }
}

/// The remote subs registered on their host and waiting for other subs.
pub fn waiting() -> Vec<RemoteSub> {
    records::all().into_iter().filter(|r| r.state == RemoteState::Held && !r.after.trim().is_empty()).collect()
}

/// Whether any remote sub waits, so a caller can skip the pass.
pub fn any_waiting() -> bool {
    !waiting().is_empty()
}

fn store_cleared(sub_id: &str, add: &[String], remove: &[String]) {
    if add.is_empty() && remove.is_empty() {
        return;
    }
    let _ = records::update(sub_id, |r| {
        r.cleared.retain(|c| !remove.contains(c));
        for id in add {
            if !r.cleared.contains(id) {
                r.cleared.push(id.clone());
            }
        }
    });
}

/// One pass over the waiting remote subs: start every one whose targets finished
/// cleanly, ask Joe about every one whose target ended blocked. `start` is injected so a
/// test makes no host call; the production one is [`start_on_host`].
pub async fn release_ready<F, Fut>(state: &Arc<DaemonState>, start: F)
where
    F: Fn(Arc<DaemonState>, RemoteSub) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    for rec in waiting() {
        if parked(&rec.sub_id) {
            continue;
        }
        // Another caller is starting it; its result is the result.
        let Some(_claim) = claim(&rec.sub_id) else { continue };
        // The list above is a snapshot: a start that finished since (it holds no claim any more)
        // left the record running, and starting that sub again would be refused by its host.
        let Some(rec) = records::get(&rec.sub_id).filter(|r| r.state == RemoteState::Held) else { continue };
        let (verdict, blocked_name, add, remove) = held::evaluate_after(state, &rec.wait());
        store_cleared(&rec.sub_id, &add, &remove);
        // Recorded above, never acted on: a put-away family starts nothing (see the
        // local pass in `held::release_ready`).
        if crate::daemon::subchats::put_away::is_hidden_family(&rec.main_id) {
            continue;
        }
        match verdict {
            AfterState::Pending => {}
            AfterState::Clean => start_and_report(state, &rec, &start).await,
            AfterState::Blocked(why) => raise_decision(state, &rec, &blocked_name, &why).await,
        }
    }
}

/// Starts `rec`; a refusal is plumbing for the main chat (it retries with `subchat
/// retry`), while a host that does not answer is retried by the next pass and says
/// nothing here (the unreachable watch speaks for it).
async fn start_and_report<F, Fut>(state: &Arc<DaemonState>, rec: &RemoteSub, start: &F)
where
    F: Fn(Arc<DaemonState>, RemoteSub) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match start(state.clone(), rec.clone()).await {
        Ok(()) => plumbing::resolved(state, &rec.sub_id),
        Err(e) if e.contains(actions::UNREACHABLE) => {
            log::info!("subchats: remote sub {} cannot be started yet, its host does not answer: {e}", rec.sub_id);
        }
        // Not a failed start: the hold stays and a reopen starts it.
        Err(e) if held::is_put_away_refusal(&e) => {}
        Err(e) => {
            log::warn!("subchats: remote sub {} could not start: {e}", rec.sub_id);
            plumbing::report_here(state, &rec.sub_id, Problem::CouldNotStart, e, Vec::new());
            set_parked(&rec.sub_id, true);
        }
    }
}

/// The production start: `sub_start` on the host.
pub async fn start_on_host(state: Arc<DaemonState>, rec: RemoteSub) -> Result<(), String> {
    actions::start(&state, &rec).await
}

/// The pass the 60 second tick, a boot pass and a finish run (`held::sweep`).
pub async fn sweep(state: &Arc<DaemonState>) {
    release_ready(state, start_on_host).await;
}

/// `subchat retry` for a remote sub that waits: its start is tried now, whatever parked it.
pub async fn retry(state: &Arc<DaemonState>, rec: &RemoteSub) -> Result<(), String> {
    // Ahead of the claim and the unpark: a refused retry leaves the sub and its problem as they were.
    if crate::daemon::subchats::put_away::is_hidden_family(&rec.main_id) {
        return Err(crate::daemon::subchats::put_away::refusal(&rec.main_id));
    }
    let Some(_claim) = claim(&rec.sub_id) else { return Err(format!("{} is already starting.", actions::name_of(rec))) };
    set_parked(&rec.sub_id, false);
    let _quiet = plumbing::quiet(&rec.sub_id);
    match actions::start(state, rec).await {
        Ok(()) => {
            plumbing::resolved(state, &rec.sub_id);
            Ok(())
        }
        Err(e) => {
            plumbing::report_here(state, &rec.sub_id, Problem::CouldNotStart, e.clone(), Vec::new());
            set_parked(&rec.sub_id, true);
            Err(e)
        }
    }
}

async fn raise_decision(state: &Arc<DaemonState>, rec: &RemoteSub, target: &str, why: &str) {
    if cards::open_card_for(state, held::CARD_KIND, &rec.sub_id).await.is_some() {
        return;
    }
    let name = actions::name_of(rec);
    let question = format!("**{target}** ended blocked ({why}), and **{name}** was waiting for it.\n\nStart {name} anyway, or drop it?");
    let card = RaisedCard {
        kind: held::CARD_KIND,
        display_session_id: rec.main_id.clone(),
        sub_id: Some(rec.sub_id.clone()),
        header: "Queued sub".to_string(),
        question,
        options: vec![
            CardOption::new(held::START_ANYWAY, "Run it now, without the earlier job"),
            CardOption::new(held::DROP_IT, "Do not run it"),
        ],
        domain: None,
    };
    match cards::raise_card(state, card).await {
        Ok(handle) => {
            let (state, sub) = (state.clone(), rec.sub_id.clone());
            handle.on_answer(move |answer| async move { apply_answer(&state, &sub, answer).await });
        }
        Err(e) => log::warn!("subchats: could not raise the queued-sub card for remote sub {}: {e}", rec.sub_id),
    }
}

/// What each answer to the queued-sub card does for a remote sub: the same three as
/// `held::apply_answer`.
pub(crate) async fn apply_answer(state: &Arc<DaemonState>, sub_id: &str, answer: CardAnswer) {
    let Some(rec) = records::get(sub_id) else { return };
    match answer {
        CardAnswer::Picked(choice) if choice == held::START_ANYWAY => {
            if rec.state != RemoteState::Held || crate::daemon::subchats::put_away::is_hidden_family(&rec.main_id) {
                return;
            }
            let Some(_claim) = claim(sub_id) else { return };
            set_parked(sub_id, false);
            start_and_report(state, &rec, &start_on_host).await;
        }
        CardAnswer::Picked(choice) if choice == held::DROP_IT => {
            set_parked(sub_id, false);
            if let Err(e) = actions::drop_never_started(state, &rec).await {
                log::warn!("subchats: could not drop remote sub {sub_id} on its card's answer: {e}");
            }
        }
        CardAnswer::Picked(other) => log::info!("subchats: ignoring queued-sub card answer {other:?} for remote sub {sub_id}"),
        CardAnswer::Skipped => set_parked(sub_id, true),
        CardAnswer::Withdrawn => {}
    }
}

/// Takes down the queued-sub card of a remote sub that left its wait (started, dropped
/// or ended), on its own task: its callers are synchronous.
pub(crate) fn drop_cards(state: &Arc<DaemonState>, sub_id: &str) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (state, sub) = (state.clone(), sub_id.to_string());
    handle.spawn(async move {
        cards::drop_prompts_of_sub(&state, &sub).await;
    });
}

/// One pass of the 60 second tick: a remote sub that has waited [`queue_watch::WAKE_AFTER`]
/// with its targets done and nothing starting it wakes its main chat once. Returns the
/// subs woken now.
pub fn stalled_tick(state: &Arc<DaemonState>, now: DateTime<Utc>) -> Vec<String> {
    let mut stalled: Vec<(RemoteSub, String)> = Vec::new();
    for rec in waiting() {
        // A put-away family's start is withheld by the gate, so its wait is not a stall.
        if starting(&rec.sub_id)
            || !held::chat_live(state, &rec.main_id)
            || crate::daemon::subchats::put_away::is_hidden_family(&rec.main_id)
        {
            continue;
        }
        let entry = rec.wait();
        let (verdict, _, _, _) = held::evaluate_after(state, &entry);
        if verdict == AfterState::Clean {
            let target = entry.names_display();
            stalled.push((rec, target));
        }
    }
    let mut due: Vec<(RemoteSub, String, i64)> = Vec::new();
    {
        let mut guard = WATCH.lock().unwrap_or_else(|e| e.into_inner());
        let watch = guard.get_or_insert_with(Watch::default);
        let ids: HashSet<&str> = stalled.iter().map(|(r, _)| r.sub_id.as_str()).collect();
        // A sub that no longer stalls starts over; a record that is gone is forgotten.
        watch.since.retain(|id, _| ids.contains(id.as_str()) || records::get(id).is_none());
        watch.woken.retain(|id| ids.contains(id.as_str()) || records::get(id).is_none());
        for (rec, target) in stalled {
            let since = *watch.since.entry(rec.sub_id.clone()).or_insert(now);
            let waited = now.signed_duration_since(since);
            if waited >= queue_watch::WAKE_AFTER && watch.woken.insert(rec.sub_id.clone()) {
                due.push((rec, target, waited.num_minutes()));
            }
        }
    }
    let mut woken = Vec::new();
    for (rec, target, minutes) in due {
        log::warn!("subchats: remote sub {} has waited {minutes} min with nothing in its way, waking {}", rec.sub_id, rec.main_id);
        let text = queue_watch::notice(&actions::name_of(&rec), &rec.sub_id, &QueueStall::AfterDone { target }, minutes);
        crate::daemon::subchats::wake::wake_main_chat(state, &rec.main_id, text);
        woken.push(rec.sub_id);
    }
    woken
}

#[cfg(test)]
#[path = "after_tests.rs"]
mod tests;
