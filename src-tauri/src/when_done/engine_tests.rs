use super::*;

// --- run_engine_with_deps integration ----------------------------------
//
// Drives the whole phase machine through recording stubs instead of the real
// AppHandle / daemon / system_control. tokio's paused clock makes the 1s
// ticks + 30s countdown resolve instantly. The Watching no-progress runaway
// guard reads `deps.now` instead of `std::time::Instant::now()` directly
// (todo 894), so a test can drive a synthetic World::clock past
// NO_PROGRESS_LIMIT without a real wall-clock wait; tests that don't care about it just leave the clock
// untouched and it never trips. The stubs RECORD calls; the terminal stub
// never actually sleeps/shuts down.

use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Mutable world the test drives between engine ticks: the live
/// `(session_id, busy)` snapshot the seams read, plus the recorded effects.
struct World {
    /// Current live sessions. The test mutates this to simulate sessions
    /// going idle.
    busy_map: Vec<(String, bool)>,
    /// Phases observed via mutate_and_emit, in order. Drives the
    /// progression assertion.
    phases: Vec<ProtocolPhase>,
    /// How many times the terminal action fired, and with what action.
    terminal_calls: Vec<TerminalAction>,
    /// Set true to make is_cancelled report cancellation from the next check.
    cancelled: bool,
    /// When true, mutate_and_emit arms `cancelled` once the countdown has
    /// ticked at least once. Lets a test cancel mid-countdown.
    cancel_on_countdown: bool,
    /// The engine's stored ProtocolState, mutated by mutate_and_emit exactly
    /// as the real AppState-held copy would be.
    state: ProtocolState,
    /// What the user-idle seam reports (seconds since last input).
    user_idle_secs: u64,
    /// How many times the engine auto-resolved prompts.
    resolved: usize,
    /// When true, mutate_and_emit simulates the user touching the mouse once
    /// the countdown has ticked (user_idle_secs drops to 0), then clears itself.
    user_returns_on_countdown: bool,
    /// Synthetic clock the `now` seam reads. Starts at the real "now" (an
    /// Instant has no zero/default value) and only moves when a test
    /// deliberately advances it - so tests that ignore it never trip the
    /// no-progress guard, matching the old un-seamed behavior.
    clock: Instant,
}

impl Default for World {
    fn default() -> Self {
        Self {
            busy_map: Vec::new(),
            phases: Vec::new(),
            terminal_calls: Vec::new(),
            cancelled: false,
            cancel_on_countdown: false,
            state: ProtocolState::disarmed(),
            user_idle_secs: 0,
            resolved: 0,
            user_returns_on_countdown: false,
            clock: Instant::now(),
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
    // to install. Lets the test stage "still busy", then "now idle".
    tick: Arc<Mutex<dyn FnMut(&mut World) + Send>>,
) -> EngineDeps {
    let w_busy = world.clone();
    let tick_busy = tick.clone();
    let w_idle = world.clone();
    let w_resolve = world.clone();
    let w_emit = world.clone();
    let w_cancel = world.clone();
    let w_term = world.clone();
    let w_user = world.clone();
    let w_now = world.clone();

    EngineDeps {
        busy_map: Box::new(move || {
            let mut g = w_busy.lock().unwrap();
            (tick_busy.lock().unwrap())(&mut g);
            g.busy_map.clone()
        }),
        all_idle: Box::new(move || w_idle.lock().unwrap().live_idle()),
        auto_resolve: Box::new(move || {
            // Records the call only; the real seam talks to the daemon.
            w_resolve.lock().unwrap().resolved += 1;
            Box::pin(async move {})
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
            if g.user_returns_on_countdown
                && phase == ProtocolPhase::CountingDown
                && g.state.countdown_remaining_secs.unwrap_or(COUNTDOWN_SECS) < COUNTDOWN_SECS
            {
                g.user_idle_secs = 0;
                g.user_returns_on_countdown = false;
            }
            g.state.clone()
        }),
        is_cancelled: Box::new(move || w_cancel.lock().unwrap().cancelled),
        terminal: Box::new(move |action| {
            w_term.lock().unwrap().terminal_calls.push(action);
            Ok(())
        }),
        user_idle_secs: Box::new(move || w_user.lock().unwrap().user_idle_secs),
        now: Box::new(move || w_now.lock().unwrap().clock),
    }
}

#[tokio::test(start_paused = true)]
async fn full_run_progresses_through_phases_and_fires_terminal_once() {
    // Start with one busy session. The tick hook walks the world through:
    //   1. busy   -> Watching keeps waiting,
    //   2. idle   -> Watching breaks, then CountingDown -> Firing.
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![("s1".to_string(), true)],
        ..Default::default()
    }));

    // Sequence of busy-flags to install on successive busy_map reads. Once
    // exhausted, the session stays idle.
    let steps = Arc::new(Mutex::new(vec![true, false]));
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
    run_engine_with_deps(deps, TerminalAction::Sleep, ArmMode::Manual).await;

    let g = world.lock().unwrap();
    // Phase progression: Watching -> CountingDown -> Firing, nothing between.
    assert_eq!(
        g.phases,
        vec![ProtocolPhase::Watching, ProtocolPhase::CountingDown, ProtocolPhase::Firing],
        "phase progression"
    );
    assert!(g.resolved > 0, "manual arm auto-resolves prompts");
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
    // No busy sessions: Watching breaks on the first idle check, so we reach
    // CountingDown immediately. `cancel_on_
    // countdown` flips `cancelled` true once the countdown has ticked at
    // least once, so the engine returns mid-countdown, before Firing.
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![], // empty -> all idle -> straight to countdown
        cancel_on_countdown: true,
        ..Default::default()
    }));

    // No-op tick: the world's busy/idle shape never changes.
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
        Arc::new(Mutex::new(|_w: &mut World| {}));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Shutdown, ArmMode::Manual).await;

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

/// A nightly run never auto-answers prompts, and it holds in Watching while the user is still at the PC even though every
/// chat is already idle.
#[tokio::test(start_paused = true)]
async fn nightly_run_skips_auto_resolve_and_waits_for_the_user_to_be_away() {
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![("s1".to_string(), false)],
        ..Default::default()
    }));

    let reads = Arc::new(Mutex::new(0u32));
    let reads_for_tick = reads.clone();
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
        Arc::new(Mutex::new(move |w: &mut World| {
            let mut n = reads_for_tick.lock().unwrap();
            *n += 1;
            if *n == 3 {
                w.user_idle_secs = NIGHTLY_AWAY_SECS;
            }
        }));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Shutdown, ArmMode::Nightly).await;

    let g = world.lock().unwrap();
    assert_eq!(
        g.phases,
        vec![ProtocolPhase::Watching, ProtocolPhase::CountingDown, ProtocolPhase::Firing],
        "phase progression"
    );
    assert_eq!(g.resolved, 0, "nightly must not auto-resolve prompts");
    assert_eq!(*reads.lock().unwrap(), 3, "held in Watching until the user was away");
    assert_eq!(g.terminal_calls, vec![TerminalAction::Shutdown]);
}

/// The user coming back mid-countdown drops a nightly run back to Watching
/// instead of shutting the PC down under them; it fires once they leave again.
#[tokio::test(start_paused = true)]
async fn nightly_countdown_returns_to_watching_when_the_user_comes_back() {
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![],
        user_idle_secs: NIGHTLY_AWAY_SECS,
        user_returns_on_countdown: true,
        ..Default::default()
    }));

    // Every Watching tick after the interruption sees the user away again.
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> =
        Arc::new(Mutex::new(|w: &mut World| w.user_idle_secs = NIGHTLY_AWAY_SECS));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Sleep, ArmMode::Nightly).await;

    let g = world.lock().unwrap();
    assert_eq!(
        g.phases,
        vec![
            ProtocolPhase::Watching,
            ProtocolPhase::CountingDown,
            ProtocolPhase::Watching,
            ProtocolPhase::CountingDown,
            ProtocolPhase::Firing,
        ],
        "interrupted countdown restarts from Watching"
    );
    assert_eq!(g.terminal_calls, vec![TerminalAction::Sleep], "fires exactly once");
}

/// todo 894: when the Watching loop's no-progress runaway guard trips (the
/// busy signature never changes for NO_PROGRESS_LIMIT), the protocol must not
/// silently collapse back to a plain Disarmed state - it persists a distinct
/// GaveUp phase carrying why and which session ids were still blocking.
#[tokio::test(start_paused = true)]
async fn no_progress_guard_gives_up_with_a_distinct_phase_and_blocking_ids() {
    let world = Arc::new(Mutex::new(World {
        // A session that never goes idle: busy_map's signature never changes.
        busy_map: vec![("stuck".to_string(), true)],
        ..Default::default()
    }));

    // Every busy_map read (once per Watching tick) advances the synthetic
    // clock past NO_PROGRESS_LIMIT (180s), so the guard trips on the second
    // tick without a real wall-clock wait.
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> = Arc::new(Mutex::new(|w: &mut World| {
        w.clock += std::time::Duration::from_secs(181);
    }));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Shutdown, ArmMode::Manual).await;

    let g = world.lock().unwrap();
    assert_eq!(
        g.phases,
        vec![ProtocolPhase::Watching, ProtocolPhase::GaveUp],
        "gives up from Watching, never reaches CountingDown/Firing"
    );
    assert!(g.terminal_calls.is_empty(), "must never fire the terminal action");
    assert_eq!(g.state.phase, ProtocolPhase::GaveUp);
    assert_eq!(g.state.action, Some(TerminalAction::Shutdown), "keeps the armed action for the UI label");
    assert_eq!(g.state.waiting_on, vec!["stuck".to_string()], "names the blocking session id");
    assert!(
        g.state.gave_up_reason.as_deref().is_some_and(|r| !r.is_empty()),
        "carries a human-readable reason, got {:?}",
        g.state.gave_up_reason
    );
}
