use super::*;
use crate::types::Instance;
use serde_json::json;

// --- Fixtures -----------------------------------------------------------

/// Minimal `Instance` for the pure decision tests. `Instance` has no
/// `Default`, so build it explicitly; only `session_id`, `busy`, `ended_at`,
/// and `awaiting` drive the logic under test, the rest are inert fillers.
fn instance_awaiting(session_id: &str, busy: bool, ended: bool, awaiting: Option<&str>) -> Instance {
    let mut i = instance(session_id, busy, ended);
    i.awaiting = awaiting.map(str::to_string);
    i
}

fn instance(session_id: &str, busy: bool, ended: bool) -> Instance {
    Instance {
        session_id: session_id.into(),
        pid: 0,
        cwd: std::path::PathBuf::from("C:/x"),
        project_id: "proj".into(),
        kind: crate::sessions::kinds::InstanceKind::External,
        is_remote: false,
        started_at: "2026-06-05T00:00:00Z".into(),
        transcript_path: None,
        bridge_session_id: None,
        name: None,
        ended_at: if ended {
            Some("2026-06-05T01:00:00Z".into())
        } else {
            None
        },
        end_reason: None,
        busy,
        model: String::new(),
        effort: String::new(),
        awaiting: None,
        autopilot: false,
        jarvis: false,
        worker_of: None,
        closing: false,
        turn_gen: 0,
        channel_epoch: 0,
        account_id: None,
        rate_limited_resets_at: None,
        rate_limited_type: None,
    }
}

// --- all_sessions_idle --------------------------------------------------

#[test]
fn all_sessions_idle_true_when_every_live_instance_not_busy() {
    let live = vec![instance("a", false, false), instance("b", false, false)];
    assert!(all_sessions_idle(&live));
}

#[test]
fn all_sessions_idle_false_when_any_live_instance_busy() {
    let mixed = vec![instance("a", false, false), instance("b", true, false)];
    assert!(!all_sessions_idle(&mixed));
}

#[test]
fn all_sessions_idle_ignores_ended_sessions() {
    // A busy session that has already ended must not block: only live
    // (ended_at == None) sessions count toward the idle check.
    let with_ended_busy = vec![
        instance("live-idle", false, false),
        instance("ended-busy", true, true),
    ];
    assert!(all_sessions_idle(&with_ended_busy));
}

#[test]
fn all_sessions_idle_false_while_a_session_reports_background_work() {
    // awaiting == "working" = own background subagents/tasks still running
    // (will re-invoke the session). Sleeping now would kill that work, so the
    // engine must keep Watching even though busy is false.
    let with_working = vec![
        instance("idle", false, false),
        instance_awaiting("bg", false, false, Some("working")),
    ];
    assert!(!all_sessions_idle(&with_working));
}

#[test]
fn all_sessions_idle_true_for_waiting_and_question_verdicts() {
    // Only "working" blocks: "waiting" (parked on an external process) and
    // "question"/"done" verdicts are idle for sleep purposes (questions are
    // handled by the prompt auto-resolve poll, not the idle check).
    let live = vec![
        instance_awaiting("w", false, false, Some("waiting")),
        instance_awaiting("q", false, false, Some("question")),
        instance_awaiting("d", false, false, Some("done")),
    ];
    assert!(all_sessions_idle(&live));
}

#[test]
fn all_sessions_idle_ignores_ended_working_sessions() {
    let ended_working = vec![
        instance("live-idle", false, false),
        instance_awaiting("ended-bg", false, true, Some("working")),
    ];
    assert!(all_sessions_idle(&ended_working));
}

#[test]
fn all_sessions_idle_true_for_empty_and_all_ended() {
    // Empty list -> nothing to wait on -> idle.
    assert!(all_sessions_idle(&[]));
    // All sessions ended (even if busy) -> no live sessions -> idle.
    let all_ended = vec![instance("x", true, true), instance("y", true, true)];
    assert!(all_sessions_idle(&all_ended));
}

// --- waiting_on_ids -----------------------------------------------------

#[test]
fn waiting_on_ids_returns_only_busy_ids_in_order() {
    let busy_map = vec![
        ("a".to_string(), true),
        ("b".to_string(), false),
        ("c".to_string(), true),
    ];
    assert_eq!(waiting_on_ids(&busy_map), vec!["a".to_string(), "c".to_string()]);
}

#[test]
fn waiting_on_ids_empty_when_all_idle() {
    let busy_map = vec![("a".to_string(), false), ("b".to_string(), false)];
    assert!(waiting_on_ids(&busy_map).is_empty());
    assert!(waiting_on_ids(&[]).is_empty());
}

// --- next_countdown -----------------------------------------------------

#[test]
fn next_countdown_decrements_until_zero_then_fires() {
    assert_eq!(next_countdown(30), Some(29));
    assert_eq!(next_countdown(29), Some(28));
    assert_eq!(next_countdown(2), Some(1));
    assert_eq!(next_countdown(1), Some(0));
    // Zero -> None: the terminal action should fire.
    assert_eq!(next_countdown(0), None);
}

#[test]
fn next_countdown_full_sequence_emits_29_down_to_0() {
    // Drive it the way the loop does and collect every emitted value.
    let mut remaining = COUNTDOWN_SECS;
    let mut emitted = Vec::new();
    while let Some(next) = next_countdown(remaining) {
        remaining = next;
        emitted.push(remaining);
    }
    let expected: Vec<u32> = (0..COUNTDOWN_SECS).rev().collect(); // 29,28,...,0
    assert_eq!(emitted, expected);
    assert_eq!(emitted.len(), COUNTDOWN_SECS as usize);
}

// --- close_turn_complete ------------------------------------------------

#[test]
fn close_turn_complete_busy_then_idle_yields_complete() {
    // Sequence: present+idle (no busy yet) -> not done; present+busy ->
    // latch saw_busy, not done; present+idle again -> done.
    let mut saw_busy = false;
    assert!(!close_turn_complete(Some(false), &mut saw_busy)); // idle, never busy
    assert!(!saw_busy);
    assert!(!close_turn_complete(Some(true), &mut saw_busy)); // went busy
    assert!(saw_busy);
    assert!(close_turn_complete(Some(false), &mut saw_busy)); // busy -> idle = done
}

#[test]
fn close_turn_complete_vanished_session_yields_complete() {
    // Session gone from the live list -> done immediately, regardless of
    // whether it was ever seen busy.
    let mut saw_busy = false;
    assert!(close_turn_complete(None, &mut saw_busy));

    let mut saw_busy2 = true;
    assert!(close_turn_complete(None, &mut saw_busy2));
}

#[test]
fn close_turn_complete_idle_without_prior_busy_keeps_waiting() {
    // A session that is present and idle but never went busy is NOT done:
    // its /close turn has not started yet, so keep waiting.
    let mut saw_busy = false;
    assert!(!close_turn_complete(Some(false), &mut saw_busy));
    assert!(!close_turn_complete(Some(false), &mut saw_busy));
    assert!(!saw_busy);
}

// default_question_answers builds the `{ question_text: first_option_label }`
// map the auto-resolver hands to respond_question. It is fully pure over a
// serde_json::Value, so it can be unit-tested without the engine task,
// AppState, or the daemon. The rest of the engine is integration-only
// (async tokio task driven by AppState + the daemon client).

#[test]
fn picks_the_first_option_label_per_question() {
    let questions = json!([
        {
            "question": "Proceed with the risky thing?",
            "options": [
                { "label": "Yes, proceed" },
                { "label": "No, abort" }
            ]
        }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(
        answers,
        json!({ "Proceed with the risky thing?": "Yes, proceed" })
    );
}

#[test]
fn maps_every_question_independently() {
    let questions = json!([
        { "question": "Q1", "options": [{ "label": "A1" }, { "label": "B1" }] },
        { "question": "Q2", "options": [{ "label": "A2" }] }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(answers, json!({ "Q1": "A1", "Q2": "A2" }));
}

#[test]
fn handles_missing_options_and_blank_questions() {
    // No options -> empty-string answer; blank question text -> skipped;
    // None payload -> empty object. Never panics on malformed input.
    let questions = json!([
        { "question": "No options here" },
        { "question": "", "options": [{ "label": "ignored" }] }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(answers, json!({ "No options here": "" }));

    assert_eq!(default_question_answers(None), json!({}));
    assert_eq!(default_question_answers(Some(&json!("not-an-array"))), json!({}));
}

// --- run_engine_with_deps integration ----------------------------------
//
// Drives the whole phase machine through recording stubs instead of the real
// AppHandle / daemon / system_control. tokio's paused clock makes the 1s
// ticks + 30s countdown resolve instantly (the std::time::Instant runaway and
// per-session timeout guards use wall-clock, so they stay un-tripped). The
// stubs RECORD calls; the terminal stub never actually sleeps/shuts down.

use std::sync::{Arc, Mutex};

/// Mutable world the test drives between engine ticks: the live
/// `(session_id, busy)` snapshot the seams read, plus the recorded effects.
struct World {
    /// Current live sessions. The test mutates this to simulate sessions
    /// going idle and /close turns running.
    busy_map: Vec<(String, bool)>,
    /// Phases observed via mutate_and_emit, in order. Drives the
    /// progression assertion.
    phases: Vec<ProtocolPhase>,
    /// How many times the terminal action fired, and with what action.
    terminal_calls: Vec<TerminalAction>,
    /// How many /close injections happened, by session id.
    closed: Vec<String>,
    /// Set true to make is_cancelled report cancellation from the next check.
    cancelled: bool,
    /// When true, mutate_and_emit arms `cancelled` once the countdown has
    /// ticked at least once. Lets a test cancel mid-countdown.
    cancel_on_countdown: bool,
    /// The engine's stored ProtocolState, mutated by mutate_and_emit exactly
    /// as the real AppState-held copy would be.
    state: ProtocolState,
}

impl Default for World {
    fn default() -> Self {
        Self {
            busy_map: Vec::new(),
            phases: Vec::new(),
            terminal_calls: Vec::new(),
            closed: Vec::new(),
            cancelled: false,
            cancel_on_countdown: false,
            state: ProtocolState::disarmed(),
        }
    }
}

impl World {
    fn live_idle(&self) -> bool {
        self.busy_map.iter().all(|(_, busy)| !*busy)
    }
}

/// Build EngineDeps backed by a shared `World`. A `tick` hook lets the test
/// mutate the world each time the engine reads the busy map, so the
/// simulation advances in lock-step with the phase machine.
fn deps_for(
    world: Arc<Mutex<World>>,
    // Called every time the engine reads busy_map; returns the next snapshot
    // to install. Lets the test stage "now everything is idle", then "the
    // close turn went busy", then "idle again".
    tick: Arc<Mutex<dyn FnMut(&mut World) + Send>>,
) -> EngineDeps {
    let w_busy = world.clone();
    let tick_busy = tick.clone();
    let w_idle = world.clone();
    let w_ids = world.clone();
    let w_resolve = world.clone();
    let w_close = world.clone();
    let w_emit = world.clone();
    let w_cancel = world.clone();
    let w_term = world.clone();

    EngineDeps {
        busy_map: Box::new(move || {
            let mut g = w_busy.lock().unwrap();
            (tick_busy.lock().unwrap())(&mut g);
            g.busy_map.clone()
        }),
        all_idle: Box::new(move || w_idle.lock().unwrap().live_idle()),
        live_ids: Box::new(move || {
            w_ids
                .lock()
                .unwrap()
                .busy_map
                .iter()
                .map(|(id, _)| id.clone())
                .collect()
        }),
        auto_resolve: Box::new(move || {
            let _w = w_resolve.clone();
            Box::pin(async move {
                // No-op for the test; the real seam talks to the daemon.
            })
        }),
        inject_close: Box::new(move |session_id| {
            let w = w_close.clone();
            Box::pin(async move {
                w.lock().unwrap().closed.push(session_id);
                true
            })
        }),
        mutate_and_emit: Box::new(move |f| {
            let mut g = w_emit.lock().unwrap();
            f(&mut g.state);
            let phase = g.state.phase;
            if g.phases.last() != Some(&phase) {
                g.phases.push(phase);
            }
            // Self-cancel hook: once the countdown is under way and at least
            // one second has ticked off, arm cancellation. Lets a test prove
            // the CountingDown loop short-circuits BEFORE Firing without
            // needing the busy_map tick (which the countdown loop never
            // reads).
            if g.cancel_on_countdown
                && phase == ProtocolPhase::CountingDown
                && g.state.countdown_remaining_secs.unwrap_or(COUNTDOWN_SECS) < COUNTDOWN_SECS
            {
                g.cancelled = true;
            }
            g.state.clone()
        }),
        is_cancelled: Box::new(move || w_cancel.lock().unwrap().cancelled),
        terminal: Box::new(move |action| {
            w_term.lock().unwrap().terminal_calls.push(action);
            Ok(())
        }),
    }
}

#[tokio::test(start_paused = true)]
async fn full_run_progresses_through_phases_and_fires_terminal_once() {
    // Start with one busy session. The tick hook walks the world through:
    //   1. busy   -> Watching keeps waiting,
    //   2. idle   -> Watching breaks, Closing injects /close,
    //   3. busy   -> close turn started (saw_busy latches),
    //   4. idle   -> close turn complete, then CountingDown -> Firing.
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![("s1".to_string(), true)],
        ..Default::default()
    }));

    // Sequence of busy-flags to install on successive busy_map reads. Once
    // exhausted, the session stays idle.
    let steps = Arc::new(Mutex::new(vec![true, false, true, false]));
    let steps_for_tick = steps.clone();
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
        Arc::new(Mutex::new(move |w: &mut World| {
            if let Some(next) = {
                let mut s = steps_for_tick.lock().unwrap();
                if s.is_empty() {
                    None
                } else {
                    Some(s.remove(0))
                }
            } {
                w.busy_map = vec![("s1".to_string(), next)];
            }
        }));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Sleep).await;

    let g = world.lock().unwrap();
    // Phase progression: Watching -> Closing -> CountingDown -> Firing.
    assert_eq!(
        g.phases,
        vec![
            ProtocolPhase::Watching,
            ProtocolPhase::Closing,
            ProtocolPhase::CountingDown,
            ProtocolPhase::Firing,
        ],
        "phase progression"
    );
    // /close was injected exactly once, into the live session.
    assert_eq!(g.closed, vec!["s1".to_string()], "close injection");
    // Terminal action fired EXACTLY ONCE, with the armed action.
    assert_eq!(
        g.terminal_calls,
        vec![TerminalAction::Sleep],
        "terminal fires exactly once"
    );
    // Countdown ran to completion.
    assert_eq!(g.state.countdown_remaining_secs, Some(0));
}

#[tokio::test(start_paused = true)]
async fn cancel_mid_countdown_short_circuits_and_terminal_never_fires() {
    // No busy sessions: Watching breaks on the first idle check, Closing has
    // nothing to inject, so we reach CountingDown immediately. `cancel_on_
    // countdown` flips `cancelled` true once the countdown has ticked at
    // least once, so the engine returns mid-countdown, before Firing.
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![], // empty -> all idle -> straight to closing/countdown
        cancel_on_countdown: true,
        ..Default::default()
    }));

    // No-op tick: the world's busy/idle shape never changes.
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
        Arc::new(Mutex::new(|_w: &mut World| {}));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Shutdown).await;

    let g = world.lock().unwrap();
    // The countdown was entered (proving this is a mid-countdown cancel, not
    // an early abort).
    assert!(
        g.phases.contains(&ProtocolPhase::CountingDown),
        "should have reached CountingDown before cancel, phases: {:?}",
        g.phases
    );
    // Terminal action MUST NOT have fired.
    assert!(
        g.terminal_calls.is_empty(),
        "cancel must short-circuit before Firing, got {:?}",
        g.terminal_calls
    );
    // Firing must never have been entered.
    assert!(
        !g.phases.contains(&ProtocolPhase::Firing),
        "Firing phase must not be reached after cancel, phases: {:?}",
        g.phases
    );
}
