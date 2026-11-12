//! What a sub's turn ending sets in motion. The pump calls [`on_turn_end`] from
//! its result-line handler and [`on_process_exit`] from its EOF handler, the two
//! places `/close` teardown is already honoured; a sub's finish and the daemon's
//! nudge are the same shape of "act once the turn is over".

use super::finish;
use super::resume;
use super::runtime::runtime;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Called once per `result` line for every session; does nothing unless the
/// session is a sub. `turn_gen` is the gen the pump was handed for this turn.
pub async fn on_turn_end(state: &Arc<DaemonState>, session: &Arc<Session>, turn_gen: u64) {
    turn_end_for(state, &session.session_id, Some(session), turn_gen).await;
}

/// [`on_turn_end`] with the live child optional, so tests can drive it without one.
pub(crate) async fn turn_end_for(state: &Arc<DaemonState>, sub_id: &str, session: Option<&Arc<Session>>, turn_gen: u64) {
    if !state.registry.get(sub_id).is_some_and(|i| super::is_sub(&i)) {
        return;
    }
    // The stuck sweep reads this: a gen the registry holds past it is a turn
    // still open.
    runtime().note_turn_end(sub_id, turn_gen);
    // A turn that ended had a conversation to run in, and is no longer a turn
    // a restart cut off.
    super::announced::forget_unresumable(sub_id);
    crate::daemon::resume_interrupted::forget(sub_id);
    if runtime().finish_pending(sub_id) {
        // Commits, or drops the request if background work started since. A
        // committed finish has stopped the process, so there is nothing to nudge.
        // The commit reads the whole transcript and runs `git status`, so it goes
        // to the blocking pool: on this thread it would stall every other task the
        // runtime schedules here. The caller still waits for it, which keeps the
        // order the pump relies on (the row is finished before its snapshot is saved).
        let (state, id, session) = (state.clone(), sub_id.to_string(), session.cloned());
        let committed = tokio::task::spawn_blocking(move || finish::commit_finish(&state, &id, session.as_ref()))
            .await
            .unwrap_or_else(|e| {
                log::warn!("subchats: the finish commit panicked: {e}");
                false
            });
        if committed {
            return;
        }
    }
    spawn_nudge_if_due(state, sub_id);
}

/// Starts the daemon's one nudge when one is due. A plain `fn`, not part of
/// [`turn_end_for`]'s future: the nudge can respawn the child, whose future leads
/// back to the pump that awaits `turn_end_for`, and an `async` body holding that
/// spawn makes the pump's future self-referential (`jarvis_wake::spawn_drain`
/// documents the cycle). Detached for the same reason.
fn spawn_nudge_if_due(state: &Arc<DaemonState>, sub_id: &str) {
    if runtime().take_nudge_due(sub_id) {
        let text = runtime().take_nudge_text(sub_id).unwrap_or_else(|| resume::NUDGE_TEXT.to_string());
        let from_joe = runtime().take_nudge_from_joe(sub_id);
        let (state, sub) = (state.clone(), sub_id.to_string());
        tokio::spawn(async move {
            fire_due_nudge(&state, &sub, &text, from_joe).await;
        });
    }
}

/// Sends a due nudge unless the sub has a question waiting for Joe or is queued
/// for the writer slot (the daemon's own nudge only; `from_joe` is his "Nudge
/// again", which he asked for and which can carry his note). A turn that ended on a card is not an unfinished one, and
/// telling it "you ended your turn without a question waiting" would be false and
/// would start a second turn under the open card. A queued writer ended its turn
/// because the write guard told it to, and is woken when the slot is its own.
/// Returns whether a nudge was attempted.
pub(crate) async fn fire_due_nudge(state: &Arc<DaemonState>, sub_id: &str, text: &str, from_joe: bool) -> bool {
    if crate::daemon::lifecycle::has_open_prompt(state, sub_id).await {
        log::info!("subchats: nudge for {sub_id} skipped, a question is waiting for Joe");
        return false;
    }
    if let Some(holder) = super::writers::waiting_behind(state, sub_id).filter(|_| !from_joe) {
        log::info!("subchats: nudge for {sub_id} skipped, it is queued for the writer slot behind {holder:?}");
        return false;
    }
    if let Err(e) = resume::send_stall_nudge(state, sub_id, text).await {
        log::warn!("subchats: nudge for {sub_id} failed: {e}");
    }
    true
}

/// Called when a session's process exits. A finish accepted in the turn that
/// died with the process (the `result` line did not flush) still counts.
pub fn on_process_exit(state: &Arc<DaemonState>, session: &Arc<Session>) {
    let sub_id = &session.session_id;
    if !state.registry.get(sub_id).is_some_and(|i| super::is_sub(&i)) {
        return;
    }
    if runtime().finish_pending(sub_id) {
        if finish::commit_finish(state, sub_id, None) {
            crate::sessions::persistence::save_snapshot_default(&state.registry);
        } else {
            // A finish dropped at commit arms a nudge for a turn end that, with
            // the process gone, never comes. Left armed it would fire at some
            // later, unrelated turn end.
            runtime().disarm_nudge(sub_id);
        }
    }
}

/// What the exit handler learned about how the process ended, for the card.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    /// Tail of the child's stderr, which is where a fatal API or login error lands.
    pub stderr_tail: String,
}

/// How long a sub may stay childless before the sweep calls it dead. Longer than
/// a respawn takes, shorter than Joe would wait.
pub const DEAD_GRACE: chrono::Duration = chrono::Duration::seconds(45);

const MAX_ERROR_CHARS: usize = 300;

/// 0xC000013A, STATUS_CONTROL_C_EXIT: Windows closed the child's console. An OS
/// shutdown or logoff does that to every child before it kills the daemon.
pub(crate) const CONSOLE_CLOSED_EXIT: i32 = 0xC000_013Au32 as i32;

/// Whether an exit is the machine or the daemon going down rather than the sub
/// dying. The turn was cut off, not lost: the exit handler keeps its persisted
/// busy flag so the next boot's `resume_interrupted` continues it, and no card
/// is raised.
pub(crate) fn is_shutdown_exit(code: Option<i32>) -> bool {
    shutdown_exit(code, crate::daemon::boot::is_shutting_down())
}

fn shutdown_exit(code: Option<i32>, daemon_shutting_down: bool) -> bool {
    daemon_shutting_down || code == Some(CONSOLE_CLOSED_EXIT)
}

/// What `claude --resume` prints when the sub's conversation file is gone.
const NO_CONVERSATION: &str = "No conversation found";

const NO_CONVERSATION_NOTE: &str =
    " Its conversation file is gone, so it cannot be resumed: start a new sub for the job.";

/// The card's sentence about a death: that the process ended mid-turn, and the
/// last error line it left, since a crash, an out-of-memory kill and an expired
/// login all look like the same silent sub otherwise.
pub(crate) fn died_note(exit: Option<&ExitInfo>) -> String {
    let code = exit
        .and_then(|e| e.code)
        .map_or_else(|| "no exit code".to_string(), |c| format!("exit code {c}"));
    let last_line = exit
        .map(|e| e.stderr_tail.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""))
        .unwrap_or("");
    let clipped: String = last_line.chars().take(MAX_ERROR_CHARS).collect();
    if clipped.is_empty() {
        format!("Its process ended in the middle of a turn ({code}) and left no error.")
    } else {
        format!("Its process ended in the middle of a turn ({code}). Last error: {clipped}")
    }
}

/// Called when a session's process has exited (after [`on_process_exit`] had its
/// chance to commit a finish). A sub whose turn was open, with no finish and no
/// exit the daemon asked for, died on its own: a crash, an out-of-memory kill or
/// a fatal API error. Nothing else would ever surface it, since the stuck sweep
/// needs a live child and the Stop hook needs a turn end.
pub fn on_process_died(state: &Arc<DaemonState>, session: &Arc<Session>, was_busy: bool, exit: Option<ExitInfo>) {
    let expected = session.expected_exit.load(std::sync::atomic::Ordering::SeqCst);
    let Some(note) = note_death(state, &session.session_id, expected, was_busy, exit.as_ref()) else {
        return;
    };
    let (state, sub) = (state.clone(), session.session_id.clone());
    // Detached for the same reason as the nudge above: the card's answers can
    // respawn this very child.
    tokio::spawn(async move {
        super::stall::raise_noted(&state, &sub, super::stall::Stall::Unfinished, Some(&note)).await;
    });
}

/// [`died_note_if_unnoticed`] plus what a death does to the sub's place in its
/// project's writer queue: a crashed writer lets the slot go, so the next sub is
/// not stuck behind a process that no longer exists. The sub takes the slot again
/// at its next write if Joe revives it.
pub(crate) fn note_death(
    state: &Arc<DaemonState>,
    sub_id: &str,
    expected_exit: bool,
    was_busy: bool,
    exit: Option<&ExitInfo>,
) -> Option<String> {
    let note = died_note_if_unnoticed(state, sub_id, expected_exit, was_busy, exit)?;
    super::writers::release(state, sub_id);
    Some(note)
}

/// The decision half of [`on_process_died`]: the card's sentence when this exit
/// is a death nobody has been told about, and `None` for every exit that is not
/// one. Marks the death as carded so the sweep does not raise a second card.
pub(crate) fn died_note_if_unnoticed(
    state: &DaemonState,
    sub_id: &str,
    expected_exit: bool,
    was_busy: bool,
    exit: Option<&ExitInfo>,
) -> Option<String> {
    let inst = state.registry.get(sub_id)?;
    // Finished and ended are done; paused covers a freeze, a gaming-mode park and a
    // rate limit, which stop the child on purpose or leave it unable to go on.
    if !super::is_sub(&inst)
        || expected_exit
        || inst.ended_at.is_some()
        || inst.subchat_finished
        || super::pause::is_paused(&inst, chrono::Utc::now().timestamp())
    {
        return None;
    }
    if is_shutdown_exit(exit.and_then(|e| e.code)) {
        return None;
    }
    let rt = runtime();
    // The child dying between turns lost nothing; the next message respawns it.
    // `busy` is read before the exit handler clears it, and the turn gen covers
    // a watchdog that already cleared it.
    let gen = state.registry.current_turn_gen(sub_id);
    let turn_open = was_busy || (gen > 0 && rt.last_ended_gen(sub_id) != Some(gen));
    if !turn_open || rt.death_carded(sub_id) {
        return None;
    }
    // A sub `--resume` cannot bring back is told once; every later attempt would
    // die the same way and card it again.
    let lost = exit.is_some_and(|e| e.stderr_tail.contains(NO_CONVERSATION));
    if lost && super::announced::is_unresumable(sub_id) {
        return None;
    }
    rt.mark_death_carded(sub_id);
    if lost {
        super::announced::mark_unresumable(sub_id);
        return Some(died_note(exit) + NO_CONVERSATION_NOTE);
    }
    Some(died_note(exit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::finish::FinishRecord;
    use crate::daemon::subchats::runtime::SubStage;
    use crate::sessions::registry_turn::TurnActivity;
    use crate::types::Settings;

    fn state_with_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        (st, sub)
    }

    #[tokio::test]
    async fn a_pending_finish_commits_at_turn_end_and_the_row_stays() {
        let (st, sub) = state_with_sub("te-commit");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        turn_end_for(&st, &sub, None, 3).await;
        let row = st.registry.get(&sub).unwrap();
        assert!(row.subchat_finished && row.ended_at.is_none());
        assert_eq!(runtime().last_ended_gen(&sub), Some(3));
    }

    /// The commit reads the whole transcript and runs `git status`. It runs inside
    /// the pump's result handler, and on a runtime worker that would stall every
    /// other task scheduled there, so it belongs on the blocking pool.
    #[tokio::test(flavor = "current_thread")]
    async fn the_finish_commit_runs_off_the_pump_thread_and_the_turn_end_still_waits_for_it() {
        let (st, sub) = state_with_sub("te-offthread");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        let pump_thread = std::thread::current().id();
        turn_end_for(&st, &sub, None, 3).await;
        assert_ne!(finish::commit_seam::thread_of(&sub), Some(pump_thread), "the commit blocked the pump's thread");
        // Same guarantee as inline: when the turn end returns, the finish is done.
        assert!(st.registry.get(&sub).unwrap().subchat_finished);
    }

    #[tokio::test]
    async fn a_finish_dropped_for_background_work_leaves_the_sub_running() {
        let (st, sub) = state_with_sub("te-bg");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        st.registry.set_turn_activity(&sub, TurnActivity::Working);
        turn_end_for(&st, &sub, None, 1).await;
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
    }

    #[tokio::test]
    async fn a_normal_chat_turn_end_touches_nothing() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        turn_end_for(&st, "plain", None, 4).await;
        assert_eq!(runtime().last_ended_gen("plain"), None, "no bookkeeping is created for a chat that is not a sub");
    }

    #[tokio::test]
    async fn a_due_nudge_is_not_sent_to_a_sub_with_a_question_waiting_for_joe() {
        let (st, sub) = state_with_sub("te-nudge-card");
        st.add_prompt("q-nudge", "question-requested", serde_json::json!({"session_id": sub, "seq": 1}), true).await;
        assert!(!fire_due_nudge(&st, &sub, resume::NUDGE_TEXT, false).await, "its turn ended on a card, not unfinished");
        st.remove_prompt("q-nudge").await;
        assert!(fire_due_nudge(&st, &sub, resume::NUDGE_TEXT, false).await, "with no card it goes out");
    }

    #[test]
    fn a_dropped_finish_nudges_with_its_own_wording_and_the_eof_path_disarms_it() {
        let (_st, sub) = state_with_sub("te-text");
        runtime().set_nudge_due(&sub);
        runtime().set_nudge_text(&sub, "custom");
        runtime().disarm_nudge(&sub);
        assert!(!runtime().take_nudge_due(&sub));
        assert_eq!(runtime().take_nudge_text(&sub), None);
    }

    fn exit(code: i32, tail: &str) -> ExitInfo {
        ExitInfo { code: Some(code), stderr_tail: tail.to_string() }
    }

    #[test]
    fn the_death_card_text_says_the_process_ended_and_quotes_the_last_error() {
        let note = died_note(Some(&exit(1, "warming up\n\nAPI Error: 529 overloaded\n")));
        assert!(note.contains("ended in the middle of a turn"), "{note}");
        assert!(note.contains("exit code 1") && note.contains("API Error: 529 overloaded"), "{note}");
        let silent = died_note(Some(&exit(137, "  \n")));
        assert!(silent.contains("exit code 137") && silent.contains("left no error"), "{silent}");
        assert!(died_note(None).contains("no exit code"));
        let long = died_note(Some(&exit(1, &"x".repeat(1000))));
        assert!(long.chars().count() < 400, "the quoted error is clipped");
    }

    #[test]
    fn a_sub_whose_process_died_mid_turn_is_reported_and_only_once() {
        let (st, sub) = state_with_sub("te-died");
        st.registry.set_busy(&sub, true);
        let note = died_note_if_unnoticed(&st, &sub, false, true, Some(&exit(1, "boom")));
        assert!(note.as_deref().is_some_and(|n| n.contains("boom")), "{note:?}");
        assert!(died_note_if_unnoticed(&st, &sub, false, true, None).is_none(), "the exit handler and the sweep share one card");
    }

    #[test]
    fn exits_that_are_not_deaths_raise_nothing() {
        // The daemon killed it: a freeze, a finish, a restart for a model pick.
        let (st, sub) = state_with_sub("te-died-expected");
        assert!(died_note_if_unnoticed(&st, &sub, true, true, None).is_none());
        // It was idle between turns, so nothing was lost.
        let (st, sub) = state_with_sub("te-died-idle");
        assert!(died_note_if_unnoticed(&st, &sub, false, false, None).is_none());
        // Frozen (user, gaming-mode park, rate limit), finished and ended.
        let (st, sub) = state_with_sub("te-died-frz");
        st.registry.set_frozen(&sub, true);
        assert!(died_note_if_unnoticed(&st, &sub, false, true, None).is_none());
        let (st, sub) = state_with_sub("te-died-fin");
        st.registry.set_subchat_finished(&sub, true);
        assert!(died_note_if_unnoticed(&st, &sub, false, true, None).is_none());
        let (st, sub) = state_with_sub("te-died-end");
        st.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(died_note_if_unnoticed(&st, &sub, false, true, None).is_none());
        // A chat that is not a sub.
        let (st, _sub) = state_with_sub("te-died-plain");
        assert!(died_note_if_unnoticed(&st, "te-died-plain-main", false, true, None).is_none());
    }

    /// An OS shutdown closes every child's console before it kills the daemon,
    /// and each one exits 0xC000013A. That is the machine going down, not the
    /// sub dying: the next boot resumes the turn.
    #[test]
    fn a_console_closed_exit_is_a_shutdown_not_a_death() {
        let (st, sub) = state_with_sub("te-died-shutdown");
        st.registry.set_busy(&sub, true);
        assert!(died_note_if_unnoticed(&st, &sub, false, true, Some(&exit(-1073741510, ""))).is_none());
        assert!(died_note_if_unnoticed(&st, &sub, false, true, Some(&exit(1, "boom"))).is_some(), "any other exit mid-turn is still a death");
    }

    /// A child the daemon kills on its way out exits with an ordinary code (1),
    /// so the daemon's own flag is what marks it as cut off.
    #[test]
    fn any_exit_while_the_daemon_shuts_down_is_a_shutdown() {
        assert!(shutdown_exit(Some(1), true));
        assert!(shutdown_exit(None, true));
        assert!(shutdown_exit(Some(CONSOLE_CLOSED_EXIT), false));
        assert!(!shutdown_exit(Some(1), false));
        assert!(!shutdown_exit(None, false));
    }

    #[test]
    fn a_turn_the_watchdog_already_cleared_busy_on_still_counts_as_open() {
        let (st, sub) = state_with_sub("te-died-gen");
        st.registry.set_busy(&sub, true);
        st.registry.set_busy(&sub, false); // busy_watchdog at 20 minutes
        assert!(died_note_if_unnoticed(&st, &sub, false, false, None).is_some(), "no result line ever ended gen 1");
    }

    /// Joe's "Nudge again" on a busy queued sub is armed, then the interrupted
    /// turn's Stop hook resets the stage (a queued sub is exempt). His nudge must
    /// still go at that turn end; the daemon's own nudge must not.
    #[tokio::test]
    async fn the_daemons_nudge_skips_a_queued_writer_but_joes_deferred_one_still_goes() {
        let (st, sub) = state_with_sub("te-queued");
        let key = std::path::PathBuf::from("/tmp/cc-test-te-queued");
        super::super::writers::queue_behind_for_test(&key, "te-queued-holder", &sub);
        runtime().set_nudge_due(&sub);
        assert!(!fire_due_nudge(&st, &sub, resume::NUDGE_TEXT, runtime().take_nudge_from_joe(&sub)).await, "the slot wakes it");
        // Joe's deferred nudge, with the stage already reset as the Stop hook leaves it.
        runtime().set_nudge_text(&sub, "with Joe's note");
        runtime().set_nudge_from_joe(&sub);
        runtime().set_stage(&sub, SubStage::Fresh);
        assert!(fire_due_nudge(&st, &sub, "with Joe's note", runtime().take_nudge_from_joe(&sub)).await, "Joe asked for this one");
        assert!(!runtime().take_nudge_from_joe(&sub), "the mark is spent with the nudge");
        // A finish dropped at commit re-arms with its own wording: no longer Joe's.
        runtime().set_nudge_from_joe(&sub);
        runtime().set_nudge_text(&sub, "finish dropped");
        assert!(!runtime().take_nudge_from_joe(&sub), "the daemon's own nudge does not inherit Joe's mark");
        super::super::writers::forget_project_for_test(&key);
    }

    /// A resume that failed marks the turn as still open for the dead sweep; a
    /// turn that later ends (Joe continued it) must clear that, or the sub is
    /// carded as dead the next time its process exits idle.
    #[tokio::test]
    async fn a_turn_end_clears_a_failed_resume_and_a_lost_conversation() {
        let (st, sub) = state_with_sub("te-clears");
        crate::daemon::resume_interrupted::queue(std::slice::from_ref(&sub));
        crate::daemon::resume_interrupted::settle(&sub, false);
        super::super::announced::mark_unresumable(&sub);
        turn_end_for(&st, &sub, None, 1).await;
        assert!(!crate::daemon::resume_interrupted::resume_failed(&sub));
        assert!(!super::super::announced::is_unresumable(&sub));
    }

    #[tokio::test]
    async fn a_due_nudge_is_taken_at_turn_end() {
        let (st, sub) = state_with_sub("te-nudge");
        runtime().set_stage(&sub, SubStage::Nudged);
        runtime().set_nudge_due(&sub);
        turn_end_for(&st, &sub, None, 2).await;
        assert!(!runtime().take_nudge_due(&sub), "the flag is consumed so the nudge goes out once");
    }
}
