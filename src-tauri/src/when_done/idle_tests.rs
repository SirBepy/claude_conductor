use super::*;
use crate::types::Instance;

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
        last_notified_awaiting: None,
        autopilot: false,
        jarvis: false,
        worker_of: None,
        subchat_of: None,
        subchat_finished: false,
        closing: false,
        turn_gen: 0,
        last_event_at: None,
        channel_epoch: 0,
        account_id: None,
        rate_limited_resets_at: None,
        rate_limited_type: None,
        frozen: false,
        frozen_needs_continue: false,
        auto_frozen: false,
        held_count: 0,
        progress: Default::default(),
        local_task_running: false,
        successor_of: None,
        machine: None,
    }
}

fn instance_with_local_task(session_id: &str, awaiting: Option<&str>) -> Instance {
    let mut i = instance_awaiting(session_id, false, false, awaiting);
    i.local_task_running = true;
    i
}

// --- instance_is_idle: sleep safety -------------------------------------

/// A chat parked on `gh run watch` reports `waiting`, not `working`, so the
/// awaiting check alone would let the machine sleep and kill the poll.
#[test]
fn a_waiting_session_with_a_live_poller_is_not_idle() {
    assert!(!instance_is_idle(&instance_with_local_task("a", Some("waiting"))));
}

/// The other kind of waiting: a scheduled wake is daemon-owned, nothing local
/// dies, so it must NOT hold the machine awake.
#[test]
fn a_waiting_session_with_only_a_scheduled_wake_is_idle() {
    assert!(instance_is_idle(&instance_awaiting("a", false, false, Some("waiting"))));
}

#[test]
fn a_done_session_with_a_live_task_is_still_not_idle() {
    assert!(!instance_is_idle(&instance_with_local_task("a", Some("done"))));
}

// --- queued subs ---------------------------------------------------------

fn queued_sub(session_id: &str) -> Instance {
    let mut i = instance(session_id, false, false);
    i.subchat_of = Some("main".into());
    i.progress.waiting_for = Some("waiting for header".into());
    i
}

/// A held sub has no child yet, so it is not busy, but its job is still ahead:
/// shutting down would drop it unrun.
#[test]
fn a_sub_the_daemon_holds_without_a_child_is_not_idle() {
    assert!(!instance_is_idle(&queued_sub("sub")));
}

#[test]
fn a_finished_sub_is_idle_even_with_a_stale_waiting_mark() {
    let mut i = queued_sub("sub");
    i.subchat_finished = true;
    assert!(instance_is_idle(&i));
}

/// The waiting mark only means "queued, unstarted" on a sub; elsewhere it is
/// not a reason to hold the machine awake.
#[test]
fn a_waiting_mark_on_a_non_sub_does_not_hold_the_run() {
    let mut i = queued_sub("chat");
    i.subchat_of = None;
    assert!(instance_is_idle(&i));
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
    use super::super::engine::COUNTDOWN_SECS;
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

fn mirrored(session_id: &str, busy: bool) -> Instance {
    let mut i = instance(session_id, busy, false);
    i.machine = Some(crate::types::MachineRef { id: "mac".into(), label: "Mac Mini".into(), online: true });
    i
}

#[test]
fn a_busy_chat_on_the_other_machine_does_not_hold_this_one_awake() {
    assert!(all_sessions_idle(&[instance("local", false, false), mirrored("peer", true)]));
    assert!(!all_sessions_idle(&[instance("local", true, false), mirrored("peer", false)]));
}

#[test]
fn a_mirrored_prompt_is_never_auto_resolved_by_this_machine() {
    use super::super::actions::is_mirrored_prompt;
    let instances = [instance("local", false, false), mirrored("peer", false)];
    assert!(is_mirrored_prompt(&instances, &serde_json::json!({"id": "r1", "session_id": "peer"})));
    assert!(!is_mirrored_prompt(&instances, &serde_json::json!({"id": "r2", "session_id": "local"})));
    assert!(!is_mirrored_prompt(&instances, &serde_json::json!({"id": "r3"})));
}

fn sub(session_id: &str, busy: bool) -> Instance {
    let mut i = instance(session_id, busy, false);
    i.subchat_of = Some("main".into());
    i
}

/// A running sub holds the sleep back like any busy chat. A finished one does not,
/// even if its last turn left a "working" status or a task flag on the row: it has
/// no process, so there is no work in flight to protect.
#[test]
fn a_running_sub_holds_the_run_and_a_finished_one_does_not() {
    let main = instance("main", false, false);
    assert!(!all_sessions_idle(&[main.clone(), sub("running", true)]), "a busy sub is work in flight");

    let mut finished = sub("done", false);
    finished.subchat_finished = true;
    assert!(all_sessions_idle(&[main.clone(), finished.clone()]));

    finished.awaiting = Some("working".into());
    finished.local_task_running = true;
    assert!(instance_is_idle(&finished), "a stale status on a finished sub is not work");
    assert!(all_sessions_idle(&[main, finished]));
}

/// The same row, running: that status does hold the run.
#[test]
fn the_same_status_on_a_sub_that_has_not_finished_still_holds_the_run() {
    let mut running = sub("run", false);
    running.awaiting = Some("working".into());
    assert!(!instance_is_idle(&running));
    running.awaiting = None;
    running.local_task_running = true;
    assert!(!instance_is_idle(&running));
}

/// A card the daemon raised in the main chat (ceiling, stuck, close approval) puts
/// that chat in `awaiting == "question"` and nothing else. Idle ignores that status,
/// so a card nobody answered cannot hold the sleep forever. Not red before the
/// change: it pins the property the daemon-card fix relies on.
#[test]
fn a_main_chat_waiting_on_a_card_it_did_not_ask_is_idle() {
    let mut main = instance("main", false, false);
    main.awaiting = Some("question".into());
    assert!(instance_is_idle(&main));
    let mut done = sub("done", false);
    done.subchat_finished = true;
    assert!(all_sessions_idle(&[main, done]));
}
