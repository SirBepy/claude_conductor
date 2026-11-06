use super::*;
use std::time::Duration;

// A manual postpone (`snooze_when_done`) holds the engine in Watching, drops an
// under-way countdown back to Watching, and pushes a nightly overdue cutoff
// past its end. The `tick` hook advances the synthetic clock one step per
// Watching read, so "how long the snooze lasted" is a count of reads.

fn advancing_tick(
    step: Duration,
    reads: &Arc<Mutex<u32>>,
) -> Arc<Mutex<dyn FnMut(&mut World) + Send>> {
    let reads = reads.clone();
    Arc::new(Mutex::new(move |w: &mut World| {
        *reads.lock().unwrap() += 1;
        w.clock += step;
    }))
}

#[tokio::test(start_paused = true)]
async fn a_snooze_holds_an_idle_run_in_watching_until_it_ends() {
    let start = Instant::now();
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![],
        clock: start,
        snooze_until: Some(start + Duration::from_secs(35)),
        state: ProtocolState { snoozed_until_unix_ms: Some(1), ..ProtocolState::watching(TerminalAction::Shutdown) },
        ..Default::default()
    }));
    let reads = Arc::new(Mutex::new(0u32));

    let deps = deps_for(world.clone(), advancing_tick(Duration::from_secs(10), &reads));
    run_engine_with_deps(deps, TerminalAction::Shutdown, ArmMode::Manual, None).await;

    let g = world.lock().unwrap();
    // Reads 1-3 land at 10/20/30s (still snoozed); the 4th at 40s is past it.
    assert_eq!(*reads.lock().unwrap(), 4, "held for the whole snooze");
    assert_eq!(g.terminal_calls, vec![TerminalAction::Shutdown], "then fires once");
    assert_eq!(g.state.snoozed_until_unix_ms, None, "the display copy clears once it ends");
}

#[tokio::test(start_paused = true)]
async fn a_snooze_mid_countdown_returns_to_watching_instead_of_firing() {
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![],
        snooze_on_countdown: Some(Duration::from_secs(30)),
        ..Default::default()
    }));
    let reads = Arc::new(Mutex::new(0u32));

    // The clock only moves on a Watching read, so the snooze is still in force
    // when the countdown checks; the next Watching read steps past it.
    let deps = deps_for(world.clone(), advancing_tick(Duration::from_secs(60), &reads));
    run_engine_with_deps(deps, TerminalAction::Sleep, ArmMode::Manual, None).await;

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
        "the postponed countdown restarts from Watching"
    );
    assert_eq!(g.terminal_calls, vec![TerminalAction::Sleep], "fires exactly once, after the snooze");
}

/// A postpone longer than the 12 h no-progress limit must not trip the guard
/// while it is in force: the busy signature never changes during a postpone.
#[tokio::test(start_paused = true)]
async fn a_postpone_longer_than_the_no_progress_limit_does_not_give_up() {
    let start = Instant::now();
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![("s1".to_string(), true)],
        clock: start,
        snooze_until: Some(start + Duration::from_secs(13 * 3600)),
        ..Default::default()
    }));

    // One hour per read; the chat finishes at 14 h, after the postpone ended.
    let tick: Arc<Mutex<dyn FnMut(&mut World) + Send>> = Arc::new(Mutex::new(move |w: &mut World| {
        w.clock += Duration::from_secs(3600);
        if w.clock >= start + Duration::from_secs(14 * 3600) {
            w.busy_map = vec![("s1".to_string(), false)];
        }
    }));

    let deps = deps_for(world.clone(), tick);
    run_engine_with_deps(deps, TerminalAction::Shutdown, ArmMode::Manual, None).await;

    let g = world.lock().unwrap();
    assert!(!g.phases.contains(&ProtocolPhase::GaveUp), "phases: {:?}", g.phases);
    assert_eq!(g.terminal_calls, vec![TerminalAction::Shutdown]);
}

#[tokio::test(start_paused = true)]
async fn a_snooze_pushes_a_nightly_overdue_cutoff_past_its_end() {
    let start = Instant::now();
    let world = Arc::new(Mutex::new(World {
        busy_map: vec![],
        // Never away, so only the cutoff can end this run.
        user_idle_secs: 0,
        clock: start,
        snooze_until: Some(start + Duration::from_secs(30 * 60)),
        ..Default::default()
    }));
    let reads = Arc::new(Mutex::new(0u32));

    let deps = deps_for(world.clone(), advancing_tick(Duration::from_secs(5 * 60), &reads));
    run_engine_with_deps(
        deps,
        TerminalAction::Shutdown,
        ArmMode::Nightly,
        Some(Overdue { deadline: start, action: OverdueAction::Cancel }),
    )
    .await;

    let g = world.lock().unwrap();
    // Without the snooze this gives up on the first read (the cutoff is `start`).
    // With it the cutoff is snooze end + SNOOZE_OVERDUE_GRACE = 40 min = read 8.
    assert_eq!(*reads.lock().unwrap(), 8);
    assert_eq!(g.state.phase, ProtocolPhase::GaveUp);
    assert!(g.terminal_calls.is_empty());
}
