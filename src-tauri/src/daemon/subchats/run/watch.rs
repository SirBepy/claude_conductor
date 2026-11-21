//! A main step that waits too long (pc-1804 step 3).
//!
//! A sub step needs no watching: the daemon starts it and reads its sub. A MAIN step
//! (review triage, release) is the main chat's own work, so only the main chat can
//! move it, and the run stalls when it does not. Two things keep that from being
//! silent:
//!
//! - The main chat is woken once more after it has sat IDLE for [`REWAKE_AFTER_MS`]
//!   with the step ready, and Joe gets a `blocker` card after another such stretch.
//!   Idle means a live chat with no turn open that did not end on a question for Joe;
//!   a chat that works on the step, or waits on his answer, is not neglecting it, so
//!   its clock restarts every tick. The first wake is `advance.rs`'s `ready:` alert.
//! - [`refuse_done_once`]: a `report_turn_status(done)` is refused once per turn while
//!   a step is ready, the way `plan_close` refuses a done over an open plan. A turn
//!   that ends without the step is what makes a chat idle with it in the first place.
//!
//! The clocks live in memory (a restart starts them over); what was done about a step
//! (`Run.watch`: woken again, card drawn) is stored, so a restart never wakes or cards
//! twice, and the card can be taken down when the step is done or skipped.

use super::*;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::card_log::{self, BlockerCard};
use crate::daemon::subchats::wake;
use std::sync::Arc;

/// How long the main chat may sit idle with a step ready before it is woken again,
/// and again before Joe is told. The same ten minutes `card_watch` gives Joe to
/// answer a stall card.
pub const REWAKE_AFTER_MS: i64 = 10 * 60 * 1000;

/// `<run id>:<step>` -> when the chat was last seen busy, or the step was first seen
/// ready: the start of the idle stretch.
static CLOCKS: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);

/// The turn each main chat was last refused a `done` in, so a second `done` of the
/// same turn goes through.
static REFUSED: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Due {
    /// Wake the main chat again for these steps.
    Rewake(Vec<String>),
    /// Draw the card `id` for this step. One card per step, so closing one step takes down
    /// only its own.
    Card { id: String, step: String },
}

/// Takes the stored mark and the card of every watched step that is not ready any
/// more (done, skipped, or its run stopped); the ids of the cards to take down.
pub(super) fn drop_unready(run: &mut Run) -> Vec<String> {
    let ready: HashSet<String> = if run.status == RunStatus::Stopped {
        HashSet::new()
    } else {
        run.steps.iter().filter(|s| s.owner == Owner::Main && s.status == StepStatus::Ready).map(|s| s.id.clone()).collect()
    };
    let mut cards = Vec::new();
    run.watch.retain(|w| {
        if ready.contains(&w.step) {
            return true;
        }
        cards.extend(w.card.clone());
        false
    });
    cards
}

/// One pass over `run` at `now_ms`: what is due, with the stored marks already set
/// (the caller saves them before it acts, so a failed save acts on nothing). `idle` is
/// whether the main chat has been left alone, see the module doc. `retract` collects
/// the cards of steps that are no longer ready.
pub(super) fn plan(run: &mut Run, now_ms: i64, idle: bool, clocks: &mut HashMap<String, i64>, retract: &mut Vec<String>) -> Vec<Due> {
    retract.extend(drop_unready(run));
    let ready: Vec<String> = run.steps.iter().filter(|s| s.owner == Owner::Main && s.status == StepStatus::Ready).map(|s| s.id.clone()).collect();
    // Keyed by run id, so a later run of the same chat never inherits a clock (default
    // step ids repeat from run to run).
    let run_id = run.id.clone();
    let key = |step: &str| format!("{run_id}:{step}");
    clocks.retain(|k, _| k.strip_prefix(&format!("{run_id}:")).is_none_or(|step| ready.iter().any(|r| r == step)));
    let (mut rewake, mut card): (Vec<String>, Vec<Due>) = (Vec::new(), Vec::new());
    for step in ready {
        let since = clocks.entry(key(&step)).or_insert(now_ms);
        if !idle {
            *since = now_ms;
            continue;
        }
        if now_ms - *since < REWAKE_AFTER_MS {
            continue;
        }
        if !run.watch.iter().any(|w| w.step == step) {
            run.watch.push(Watch { step: step.clone(), ..Default::default() });
        }
        let w = run.watch.iter_mut().find(|w| w.step == step).expect("pushed above");
        if !w.rewoken {
            w.rewoken = true;
            // The next stretch starts now, so the card is a full one after the wake.
            *since = now_ms;
            rewake.push(step);
        } else if w.card.is_none() {
            let id = format!("blocker-run-{}", uuid::Uuid::new_v4());
            w.card = Some(id.clone());
            card.push(Due::Card { id, step });
        }
    }
    let mut due = Vec::new();
    if !rewake.is_empty() {
        due.push(Due::Rewake(rewake));
    }
    due.extend(card);
    due
}

fn titled(run: &Run, steps: &[String]) -> String {
    steps.iter().map(|id| format!("{id} \"{}\"", run.step(id).map(|s| wake::safe_name(&s.title)).unwrap_or_default())).collect::<Vec<_>>().join(", ")
}

/// The second wake. Ids and the main chat's own titles only, like `advance::notice`.
pub(super) fn rewake_notice(run: &Run, steps: &[String]) -> String {
    format!(
        "Run {} \"{}\": your step {} has been waiting for you for over 10 minutes while you were idle. Read it with run_plan status and do it, then close it with run_plan done (or skip it). If it cannot be done, tell Joe why.",
        run.id,
        wake::safe_name(&run.title),
        titled(run, steps),
    )
}

pub(super) fn card_text(run: &Run, steps: &[String]) -> BlockerCard {
    BlockerCard {
        verdict: "Run step waiting".to_string(),
        text: format!(
            "Run \"{}\" is stuck on a step that is the main chat's own: {}. The chat was woken for it and has not done it in 20 minutes. Open the chat and tell it to carry on.",
            wake::safe_name(&run.title),
            titled(run, steps),
        ),
        tone: None,
        points: Vec::new(),
    }
}

fn clocks_locked<T>(f: impl FnOnce(&mut HashMap<String, i64>) -> T) -> T {
    let mut g = CLOCKS.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/// Whether the main chat is being left alone: live, no turn open, and not parked on a
/// question of Joe's or on a background job it reported (`waiting`, `working`: the done
/// refusal itself tells it to report those).
fn idle(state: &DaemonState, main: &str) -> Option<bool> {
    let inst = state.registry.get(main)?;
    if inst.ended_at.is_some() {
        return None;
    }
    Some(!inst.busy && !matches!(inst.awaiting.as_deref(), Some("question" | "waiting" | "working")))
}

/// The tick's pass over the run of `main`: wakes it again, or draws the card, for a
/// main step that waited too long. `None` for a chat that is gone: a run whose main
/// chat ended has nobody to wake (and its clocks are dropped).
pub fn watch_at(state: &Arc<DaemonState>, root: &Path, main: &str, now_ms: i64) {
    let Some(idle) = idle(state, main) else {
        if let Some(run) = load_in(root, main) {
            clocks_locked(|c| c.retain(|k, _| !k.starts_with(&format!("{}:", run.id))));
        }
        return;
    };
    let mut retract = Vec::new();
    let planned = {
        let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut run) = try_load_in(root, main).ok().flatten() else { return };
        if run.status == RunStatus::Stopped {
            // `stop` already took the cards down; nothing here is left to watch.
            return;
        }
        let before = run.clone();
        let due = clocks_locked(|clocks| plan(&mut run, now_ms, idle, clocks, &mut retract));
        if run != before {
            if let Err(e) = save_in(root, &run) {
                // Nothing is acted on for a state that was not stored: the next tick tries again.
                log::warn!("subchats: could not save run {}: {e}", run.id);
                return;
            }
        }
        (run, due)
    };
    for card in retract {
        card_log::retract_card_in(root, state, main, &card);
    }
    let (run, due) = planned;
    for d in due {
        match d {
            Due::Rewake(steps) => {
                log::warn!("subchats: run {} has waited over 10 min for the main chat on {steps:?}, waking {main}", run.id);
                wake::wake_main_chat(state, main, rewake_notice(&run, &steps));
            }
            Due::Card { id, step } => {
                log::warn!("subchats: run {} still waits for the main chat on {step}, drawing a blocker card in {main}", run.id);
                if card_log::on_run_blocker_in(root, state, main, &id, card_text(&run, std::slice::from_ref(&step))).is_none() {
                    log::warn!("subchats: could not draw the blocker card of run {} in {main}", run.id);
                    forget_card(root, main, &id);
                    continue;
                }
                // The chat may have closed the step between the save and the draw: its
                // retraction found no card then, so this one would stay for good. Only a
                // run that was read and lacks the mark counts; an unreadable file keeps the card.
                // The read takes FILE_LOCK so it waits out a `done` that is mid-way through
                // dropping the mark; the retraction runs after the guard is gone, so the
                // lock order stays FILE_LOCK then LOG_LOCK.
                let gone = {
                    let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                    matches!(try_load_in(root, main), Ok(Some(r)) if !r.watch.iter().any(|w| w.card.as_deref() == Some(id.as_str())))
                };
                if gone {
                    card_log::retract_card_in(root, state, main, &id);
                }
            }
        }
    }
}

/// Takes back the stored mark of a card that was never drawn, so the next tick draws it
/// (the mark is saved before the draw, and `plan` skips a step whose mark is set).
fn forget_card(root: &Path, main: &str, id: &str) {
    let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut run) = try_load_in(root, main).ok().flatten() else { return };
    let mut changed = false;
    for w in run.watch.iter_mut().filter(|w| w.card.as_deref() == Some(id)) {
        w.card = None;
        changed = true;
    }
    if changed {
        if let Err(e) = save_in(root, &run) {
            log::warn!("subchats: could not save run {}: {e}", run.id);
        }
    }
}

/// Takes down the cards of steps `run` no longer waits on, for a caller that already
/// changed the run (the tool's `done`, `skip` and `stop`). Marks are dropped from `run`
/// itself, so the caller saves them.
pub(super) fn settle_cards(state: &Arc<DaemonState>, root: &Path, run: &mut Run) -> bool {
    let main = run.main_id.clone();
    let cards = drop_unready(run);
    for card in &cards {
        card_log::retract_card_in(root, state, &main, card);
    }
    !cards.is_empty()
}

/// `report_turn_status(done)` of main chat `main`, in turn `turn_gen`: the refusal to
/// send back, or `None` to let it through. Refused once per turn while a step of its
/// run is ready; the model reads the text and does the step. A `question`, `waiting`
/// or `working` status never reaches this.
pub fn refuse_done_once(main: &str, turn_gen: u64) -> Option<String> {
    let root = decisions::data_root()?;
    refuse_done_in(&root, main, turn_gen)
}

pub(super) fn refuse_done_in(root: &Path, main: &str, turn_gen: u64) -> Option<String> {
    let run = load_in(root, main)?;
    if run.status != RunStatus::Open {
        return None;
    }
    let ready: Vec<String> = run.steps.iter().filter(|s| s.owner == Owner::Main && s.status == StepStatus::Ready).map(|s| s.id.clone()).collect();
    if ready.is_empty() {
        return None;
    }
    {
        let mut g = REFUSED.lock().unwrap_or_else(|p| p.into_inner());
        let map = g.get_or_insert_with(HashMap::new);
        if map.get(main) == Some(&turn_gen) {
            return None;
        }
        map.insert(main.to_string(), turn_gen);
    }
    Some(format!(
        "Not ended yet: run {} \"{}\" has {} of your own waiting: {}. The daemon does not do a main step for you. Do it now, then close it with run_plan done (or run_plan skip with a note if it is dropped), then call report_turn_status again. \
         If you are really waiting on Joe or on something running, report status question or waiting instead.",
        run.id,
        wake::safe_name(&run.title),
        if ready.len() == 1 { "a step" } else { "steps" },
        titled(&run, &ready),
    ))
}
