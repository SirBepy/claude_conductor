//! The stuck-sub sweep: a sub with a turn open and no new line for
//! [`STUCK_AFTER`] raises a card. Joe's row shows nothing for a working sub, so
//! a hung command would otherwise stay invisible until a ceiling (spec section 9).
//!
//! It rides `busy_watchdog`'s 60 second tick rather than a thread of its own.
//! That watchdog force-clears `busy` after 20 silent minutes, so by the 30
//! minute mark the flag is already gone; "a turn is open" is therefore read from
//! the turn gen instead (see [`super::runtime::Runtime::last_ended_gen`]).

use super::finish::has_background_work;
use super::runtime::runtime;
use super::stall::{self, Stall};
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use chrono::{DateTime, Utc};
use std::sync::Arc;

/// Silence that counts as stuck. Measured on the sub's own output: stdout lines
/// and the transcript file, whichever spoke last.
pub const STUCK_AFTER: chrono::Duration = chrono::Duration::minutes(30);

/// Everything the sweep reads from outside the registry, injected so a test can
/// run it on a fake clock with no live child and no transcript on disk.
pub struct Env<'a> {
    pub now: DateTime<Utc>,
    /// Set after the machine slept: silence counts from the resume, since a
    /// suspended child was silent through no fault of its own (same rule the
    /// busy watchdog applies).
    pub resumed_at: Option<DateTime<Utc>>,
    pub transcript_mtime: &'a (dyn Fn(&Instance) -> Option<DateTime<Utc>> + Sync),
    pub is_live: &'a (dyn Fn(&str) -> bool + Sync),
}

fn parse(ts: Option<&str>) -> Option<DateTime<Utc>> {
    ts.and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

/// A sub's transcript file's last write time.
fn file_mtime(state: &DaemonState, inst: &Instance) -> Option<DateTime<Utc>> {
    let path = crate::context_status::resolve_transcript(&state.registry, &inst.session_id)?;
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified))
}

/// Raises a card for every stuck sub that has none. Returns the ids carded.
pub async fn sweep(state: &Arc<DaemonState>, env: &Env<'_>) -> Vec<String> {
    let rt = runtime();
    let mut carded = Vec::new();
    for inst in state.registry.list() {
        let id = inst.session_id.clone();
        // Paused is not stuck: a freeze, a gaming-mode park and a rate limit each
        // leave a sub silent through no fault of its own.
        if inst.subchat_of.is_none()
            || inst.ended_at.is_some()
            || inst.subchat_finished
            || super::pause::is_paused(&inst, env.now.timestamp())
        {
            continue;
        }
        // No live child: either it exited (the EOF handler and `sweep_dead` own
        // that) or it was never started. Nothing is hung.
        if !(env.is_live)(&id) {
            continue;
        }
        let gen = state.registry.current_turn_gen(&id);
        let turn_open = inst.busy || (gen > 0 && rt.last_ended_gen(&id) != Some(gen));
        if !turn_open {
            continue;
        }
        // Exempt, as for the Stop hook: background work, and a question or
        // permission card waiting on Joe.
        if has_background_work(state.registry.turn_activity(&id))
            || crate::daemon::lifecycle::has_open_prompt(state, &id).await
        {
            continue;
        }
        let last = [parse(inst.last_event_at.as_deref()), (env.transcript_mtime)(&inst)].into_iter().flatten().max();
        // Unknown never creates a card: a restart wipes `last_event_at`, and a
        // sub with neither stamp has no silence to measure.
        let Some(last) = last else { continue };
        let since = env.resumed_at.map_or(last, |r| r.max(last));
        if env.now.signed_duration_since(since) < STUCK_AFTER {
            continue;
        }
        if rt.stuck_carded_for(&id) == Some(last) {
            continue;
        }
        if stall::raise(state, &id, Stall::Stuck).await.is_some() {
            rt.mark_stuck_carded(&id, last);
            carded.push(id);
        }
    }
    carded
}

const NO_PROCESS_NOTE: &str =
    "Its process is not running and it never called finish_subchat. The app may have been restarted while it worked.";

/// Raises a card for every sub that has no live child, never finished, was not
/// ended and has a turn open with nothing to continue it: a turn opened in this
/// daemon run that never ended (the exit handler missed the death), or a turn a
/// restart cut off whose auto-continue failed. Returns the ids carded.
///
/// A childless sub whose last turn ended is idle, not dead: the next message
/// respawns it. That is every sub a restart brings back, since the turn gen is
/// not persisted; 27 of 52 of these cards (2026-11-06 to 11-11) were idle subs
/// carded minutes after a daemon start. A sub the restart cut off mid-turn is on
/// `resume_interrupted`'s queue and is left to it, and a sub whose conversation
/// file is gone was carded once already ([`super::announced::is_unresumable`]).
///
/// A sub can be childless for good reasons for a moment (a respawn after a model
/// pick or a continue), so it must stay childless for [`DEAD_GRACE`] across two
/// sweeps first, and a sub with a send in flight (`busy`) is never judged. Its own
/// question card waiting on Joe also exempts it: the answer will wake it. The
/// card is raised only while the main chat exists, because a card needs a window
/// to show in; a sub whose main chat is gone is the orphan promotion's (spec
/// section 9, step 8).
pub async fn sweep_dead(state: &Arc<DaemonState>, env: &Env<'_>) -> Vec<String> {
    use super::turn_end::DEAD_GRACE;
    let rt = runtime();
    let mut carded = Vec::new();
    for inst in state.registry.list() {
        let id = inst.session_id.clone();
        let Some(parent) = inst.subchat_of.clone() else { continue };
        if inst.ended_at.is_some() || inst.subchat_finished {
            super::announced::forget(&id);
            super::announced::forget_unresumable(&id);
            continue;
        }
        if super::pause::is_paused(&inst, env.now.timestamp()) {
            continue;
        }
        // A sub the daemon holds without a child (the `after` queue) has not
        // started, which is not a death; `held` starts it or asks Joe.
        if super::held::is_held(&id) {
            rt.clear_childless(&id);
            continue;
        }
        // A writer queued for the slot is woken by it, and the wake respawns a
        // child that is gone, so a missing one is a wait, not a death.
        if super::writers::waiting_behind(state, &id).is_some() {
            rt.clear_childless(&id);
            continue;
        }
        if (env.is_live)(&id) {
            rt.clear_childless(&id);
            crate::daemon::resume_interrupted::forget(&id);
            continue;
        }
        if inst.busy || !matches!(inst.kind, crate::sessions::kinds::InstanceKind::Interactive) {
            continue;
        }
        if !state.registry.get(&parent).is_some_and(|p| p.ended_at.is_none()) {
            continue;
        }
        if crate::daemon::resume_interrupted::is_queued(&id) || super::announced::is_unresumable(&id) {
            continue;
        }
        let gen = state.registry.current_turn_gen(&id);
        let turn_open = (gen > 0 && rt.last_ended_gen(&id) != Some(gen))
            || crate::daemon::resume_interrupted::resume_failed(&id);
        if !turn_open {
            continue;
        }
        if rt.death_carded(&id) || crate::daemon::lifecycle::has_open_prompt(state, &id).await {
            continue;
        }
        let since = rt.note_childless(&id, env.now);
        if env.now.signed_duration_since(since) < DEAD_GRACE {
            continue;
        }
        // A death Joe was already told about (in this run or before a restart)
        // is asked again quietly: the card was lost, not his knowledge of it.
        let raised = if super::announced::was_announced(&id) {
            stall::raise_noted_quietly(state, &id, Stall::Unfinished, Some(NO_PROCESS_NOTE)).await
        } else {
            stall::raise_noted(state, &id, Stall::Unfinished, Some(NO_PROCESS_NOTE)).await
        };
        if raised.is_some() {
            rt.mark_death_carded(&id);
            carded.push(id);
        }
    }
    carded
}

/// The production sweep, called from the busy watchdog's tick.
pub async fn sweep_now(state: &Arc<DaemonState>, now: DateTime<Utc>, resumed_at: Option<DateTime<Utc>>) {
    let mtime = |i: &Instance| file_mtime(state, i);
    let live = |id: &str| state.sessions.contains_key(id);
    let env = Env { now, resumed_at, transcript_mtime: &mtime, is_live: &live };
    // First, so a sub that never started and lost its hold is held again before
    // the dead sweep below would card it as a process that died.
    super::held::recover_lost(state);
    let carded = sweep(state, &env).await;
    for id in carded {
        log::warn!("subchats: sub {id} has been silent for over {}m, raised a card", STUCK_AFTER.num_minutes());
    }
    for id in sweep_dead(state, &env).await {
        log::warn!("subchats: sub {id} has no running process and never finished, raised a card");
    }
    // The tick is also the backstop that starts a held sub whose wait ended
    // without an event reaching it.
    super::held::sweep(state).await;
    // The writer slot's safety net: a holder or waiter ended by a path that did
    // not release it stops blocking the next sub.
    super::writers::sweep(state);
    // Last, after every pass that could have started it: a sub still waiting
    // with nothing in its way is told to its main chat.
    super::queue_watch::tick(state, now);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::registry_turn::TurnActivity;
    use crate::types::Settings;

    fn no_mtime(_: &Instance) -> Option<DateTime<Utc>> {
        None
    }
    fn always_live(_: &str) -> bool {
        true
    }

    fn busy_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        st.registry.set_busy(&sub, true); // stamps last_event_at = now
        (st, sub)
    }

    async fn run(st: &Arc<DaemonState>, minutes_from_now: i64) -> Vec<String> {
        let env = Env {
            now: Utc::now() + chrono::Duration::minutes(minutes_from_now),
            resumed_at: None,
            transcript_mtime: &no_mtime,
            is_live: &always_live,
        };
        sweep(st, &env).await
    }

    #[tokio::test]
    async fn a_busy_sub_silent_past_thirty_minutes_raises_a_card_and_not_before() {
        let (st, sub) = busy_sub("stuck-clock");
        assert!(run(&st, 29).await.is_empty(), "29 minutes of silence is not stuck");
        assert!(st.list_prompts().await.is_empty());
        assert_eq!(run(&st, 31).await, [sub.clone()], "31 minutes is");
        let listed = st.list_prompts().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["payload"]["card_kind"], "subchat_stuck");
        assert_eq!(listed[0]["payload"]["display_session_id"], "stuck-clock-main");
    }

    #[tokio::test]
    async fn the_threshold_is_the_named_constant() {
        assert_eq!(STUCK_AFTER, chrono::Duration::minutes(30));
        let (st, _sub) = busy_sub("stuck-const");
        let edge = STUCK_AFTER.num_minutes();
        assert!(run(&st, edge - 1).await.is_empty());
        assert_eq!(run(&st, edge + 1).await.len(), 1);
    }

    #[tokio::test]
    async fn one_silent_stretch_raises_one_card_even_after_it_is_answered() {
        let (st, sub) = busy_sub("stuck-once");
        assert_eq!(run(&st, 40).await.len(), 1);
        assert!(run(&st, 41).await.is_empty(), "the open card is not duplicated");
        let id = st.list_prompts().await[0]["id"].as_str().unwrap().to_string();
        crate::daemon::methods::permission::respond_question_inner(&st, &id, serde_json::json!({}), true).await;
        assert!(run(&st, 42).await.is_empty(), "answering a card does not make the same silence stuck again: {sub}");
    }

    #[tokio::test]
    async fn a_turn_the_watchdog_already_cleared_busy_on_is_still_stuck() {
        let (st, sub) = busy_sub("stuck-cleared");
        st.registry.set_busy(&sub, false); // what busy_watchdog does at 20 minutes
        // The pump never saw this gen end: no result line, no note_turn_end.
        let carded = run(&st, 40).await;
        assert_eq!(carded, [sub]);
    }

    #[tokio::test]
    async fn a_sub_whose_turn_ended_is_idle_not_stuck() {
        let (st, sub) = busy_sub("stuck-idle");
        let gen = st.registry.current_turn_gen(&sub);
        st.registry.set_busy(&sub, false);
        runtime().note_turn_end(&sub, gen);
        assert!(run(&st, 90).await.is_empty());
    }

    #[tokio::test]
    async fn each_exemption_keeps_a_silent_sub_from_being_carded() {
        // Background work.
        let (st, sub) = busy_sub("stuck-ex-bg");
        for a in [TurnActivity::Working, TurnActivity::WaitingOnProcess, TurnActivity::WaitingOnSchedule] {
            st.registry.set_turn_activity(&sub, a);
            assert!(run(&st, 60).await.is_empty(), "{a:?}");
        }
        // A pending question.
        let (st, sub) = busy_sub("stuck-ex-q");
        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": sub, "seq": 1}), true).await;
        assert!(run(&st, 60).await.is_empty(), "a card waiting on Joe is not a stall");
        // A pending permission prompt.
        let (st, sub) = busy_sub("stuck-ex-p");
        st.add_prompt("p1", "permission-requested", serde_json::json!({"session_id": sub}), false).await;
        assert!(run(&st, 60).await.is_empty());
        // A freeze (user, gaming-mode park and rate limit all set it).
        let (st, sub) = busy_sub("stuck-ex-frz");
        st.registry.set_frozen(&sub, true);
        assert!(run(&st, 60).await.is_empty());
        // Finished and ended.
        let (st, sub) = busy_sub("stuck-ex-fin");
        st.registry.set_subchat_finished(&sub, true);
        assert!(run(&st, 60).await.is_empty());
        let (st, sub) = busy_sub("stuck-ex-end");
        st.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(run(&st, 60).await.is_empty());
    }

    #[tokio::test]
    async fn a_gaming_mode_park_and_a_rate_limit_are_not_a_stall() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        // Parked: gaming mode sends a message and freezes nothing.
        let (st, sub) = busy_sub("stuck-park");
        crate::daemon::gaming_mode::set_file_for_test(&[&sub]);
        assert!(!st.registry.get(&sub).unwrap().frozen);
        assert!(run(&st, 120).await.is_empty(), "a parked sub is silent on purpose");
        crate::daemon::gaming_mode::set_file_for_test(&[]);
        assert_eq!(run(&st, 121).await, [sub.clone()], "the same silence is a stall once the park is over");

        // Rate limited: every sub on the account waits, whether or not it was rejected itself.
        let (st, sub) = busy_sub("stuck-rate");
        st.registry.set_account(&sub, "acct");
        st.registry.set_rate_limited_for_account("acct", Utc::now().timestamp() + 4 * 3600, "five_hour");
        assert!(run(&st, 120).await.is_empty());
        // The dead-process sweep leaves it alone too.
        st.registry.set_busy(&sub, false);
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 300).await.is_empty());
        // Past the reset it is judged like any other sub.
        assert_eq!(run(&st, 5 * 60).await, [sub], "a window that is over pauses nothing");
    }

    #[tokio::test]
    async fn a_sub_with_no_live_child_is_not_stuck_and_a_normal_chat_never_is() {
        let (st, _sub) = busy_sub("stuck-nolive");
        let env = Env {
            now: Utc::now() + chrono::Duration::minutes(60),
            resumed_at: None,
            transcript_mtime: &no_mtime,
            is_live: &|_| false,
        };
        assert!(sweep(&st, &env).await.is_empty());
        let (st2, _s) = busy_sub("stuck-plain");
        st2.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st2.registry.set_busy("plain", true);
        let carded = run(&st2, 60).await;
        assert!(!carded.contains(&"plain".to_string()));
    }

    // ── a sub with no process ───────────────────────────────────────────────

    async fn run_dead(st: &Arc<DaemonState>, live: bool, seconds_from_now: i64) -> Vec<String> {
        let is_live = move |_: &str| live;
        let env = Env {
            now: Utc::now() + chrono::Duration::seconds(seconds_from_now),
            resumed_at: None,
            transcript_mtime: &no_mtime,
            is_live: &is_live,
        };
        sweep_dead(st, &env).await
    }

    fn idle_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let (st, sub) = busy_sub(tag);
        st.registry.set_busy(&sub, false);
        (st, sub)
    }

    #[tokio::test]
    async fn a_sub_with_no_process_that_never_finished_gets_a_card_after_the_grace() {
        let (st, sub) = idle_sub("dead-basic");
        assert!(run_dead(&st, false, 0).await.is_empty(), "first sight only starts the clock: it may be mid-respawn");
        assert!(run_dead(&st, false, 20).await.is_empty(), "still inside the grace");
        assert_eq!(run_dead(&st, false, 60).await, [sub.clone()]);
        let cards = st.list_prompts().await;
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["payload"]["card_kind"], "subchat_unfinished");
        assert_eq!(cards[0]["payload"]["display_session_id"], "dead-basic-main");
        let text = cards[0]["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("not running") && text.contains("restarted"), "{text}");
        assert!(run_dead(&st, false, 120).await.is_empty(), "one card per death, not one per tick");
    }

    /// A sub as a daemon restart restores it: a registry row with no child and no
    /// turn opened in this run (the turn gen is not persisted).
    fn restored_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        (st, sub)
    }

    /// 27 of 52 `subchat_unfinished` cards (2026-11-06 to 11-11) came within 5
    /// minutes of a daemon start: every idle sub was carded as a process that died.
    #[tokio::test]
    async fn an_idle_sub_restored_by_a_restart_gets_no_card() {
        let (st, sub) = restored_sub("dead-restored-idle");
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 300).await.is_empty(), "its last turn ended before the restart: {sub}");
        assert!(st.list_prompts().await.is_empty());
    }

    /// A sub the restart cut off mid-turn (persisted chat state busy) is on
    /// `resume_interrupted`'s list: it gets a "continue", not a card.
    #[tokio::test]
    async fn a_sub_cut_off_mid_turn_by_a_restart_is_resumed_not_carded() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = restored_sub("dead-restored-open");
        crate::sessions::chat_state::set_busy(&sub, true);
        let entry: crate::sessions::persistence::PersistedInteractive = serde_json::from_value(serde_json::json!({
            "session_id": sub,
            "cwd": ".",
            "project_id": "proj",
            "name": null,
            "model": "opus",
            "effort": "high",
            "started_at": "2026-11-05T00:00:00Z",
        }))
        .unwrap();
        let resumed = crate::daemon::resume_interrupted::interrupted_sessions(
            &[entry],
            crate::sessions::chat_state::get,
            Utc::now().timestamp_millis(),
        );
        assert_eq!(resumed, [sub.clone()], "the boot resumes it");
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 300).await.is_empty(), "and the dead sweep does not card it too");
        assert!(st.list_prompts().await.is_empty());
        // Still queued for its "continue" (the stagger), it is left to the resume
        // even with a turn open.
        st.registry.set_busy(&sub, true);
        st.registry.set_busy(&sub, false);
        crate::daemon::resume_interrupted::queue(std::slice::from_ref(&sub));
        run_dead(&st, false, 310).await;
        assert!(run_dead(&st, false, 400).await.is_empty(), "queued for its resume");
        crate::daemon::resume_interrupted::forget(&sub);
        // A resume that did not go through leaves the turn open with nothing to
        // continue it, which is what the card is for.
        let (st, sub) = restored_sub("dead-restored-failed");
        crate::daemon::resume_interrupted::queue(std::slice::from_ref(&sub));
        crate::daemon::resume_interrupted::settle(&sub, false);
        run_dead(&st, false, 0).await;
        assert_eq!(run_dead(&st, false, 300).await, [sub.clone()]);
        crate::daemon::resume_interrupted::forget(&sub);
    }

    /// f99f459a, 21197fee and 6a2623ed ("claude exited 1: No conversation found
    /// with session ID") were carded after every daemon start. One card says it
    /// cannot be resumed; after that it stays quiet.
    #[tokio::test]
    async fn a_sub_whose_conversation_is_gone_is_carded_once() {
        let (st, sub) = idle_sub("dead-noconv");
        let exit = super::super::turn_end::ExitInfo {
            code: Some(1),
            stderr_tail: format!("No conversation found with session ID: {sub}"),
        };
        let note = super::super::turn_end::died_note_if_unnoticed(&st, &sub, false, true, Some(&exit));
        assert!(note.is_some(), "the first death is carded");
        // A restart loses the in-memory death record (and Joe's Continue resets it).
        runtime().reset(&sub);
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 300).await.is_empty(), "the sweep does not card it again");
        assert!(
            super::super::turn_end::died_note_if_unnoticed(&st, &sub, false, true, Some(&exit)).is_none(),
            "nor does the next failed resume"
        );
        assert!(st.list_prompts().await.is_empty());
    }

    /// 2026-11-11: phone-ime-voice-swipe, queued for the writer slot, was carded
    /// as a process that died. A queued writer is woken by the slot, and the wake
    /// respawns it.
    #[tokio::test]
    async fn a_sub_queued_for_the_writer_slot_with_no_process_is_not_carded() {
        let (st, sub) = idle_sub("dead-queued");
        let key = std::path::PathBuf::from("/tmp/cc-test-dead-queued");
        super::super::writers::queue_behind_for_test(&key, "dead-queued-holder", &sub);
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 120).await.is_empty(), "waiting is not dying");
        assert!(st.list_prompts().await.is_empty());
        super::super::writers::forget_project_for_test(&key);
        run_dead(&st, false, 130).await;
        assert_eq!(run_dead(&st, false, 300).await, [sub], "out of the queue, a missing process is a death again");
    }

    #[tokio::test]
    async fn answering_the_card_does_not_raise_it_again_but_a_new_death_does() {
        let (st, sub) = idle_sub("dead-answered");
        run_dead(&st, false, 0).await;
        assert_eq!(run_dead(&st, false, 60).await.len(), 1);
        let id = st.list_prompts().await[0]["id"].as_str().unwrap().to_string();
        crate::daemon::methods::permission::respond_question_inner(&st, &id, serde_json::json!({}), true).await;
        assert!(run_dead(&st, false, 120).await.is_empty(), "Skip leaves the sub as it is, and the same death stays carded");
        // It was brought back (a child seen live) and died again.
        assert!(run_dead(&st, true, 130).await.is_empty());
        run_dead(&st, false, 140).await;
        assert_eq!(run_dead(&st, false, 200).await, [sub]);
    }

    /// Every daemon start re-announced the same dead subs, eight at once on
    /// 2026-11-10 18:27:52. The card is still asked again (a restart lost it),
    /// but quietly: no sound, no push, no "input needed".
    #[tokio::test(start_paused = true)]
    async fn a_death_announced_before_a_restart_is_asked_again_quietly() {
        let (st, sub) = idle_sub("dead-restart");
        // The earlier daemon run announced it; this run's in-memory record is new.
        crate::daemon::subchats::announced::mark(&sub);
        let mut rx = st.notifier.subscribe();
        run_dead(&st, false, 0).await;
        assert_eq!(run_dead(&st, false, 60).await, [sub.clone()], "the card is asked again");
        let cards = st.list_prompts().await;
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["payload"]["quiet"], true, "and does not ring or push");
        assert_ne!(
            st.registry.get("dead-restart-main").and_then(|i| i.awaiting).as_deref(),
            Some("question"),
            "the main chat is not flagged as waiting on Joe"
        );
        tokio::time::sleep(crate::daemon::notify_gate::SETTLE + std::time::Duration::from_millis(200)).await;
        while let Ok(frame) = rx.try_recv() {
            assert_ne!(frame["method"], "turn_sound", "no sound: {frame}");
        }
        // A new death after the sub came back is news again.
        assert!(run_dead(&st, true, 70).await.is_empty());
        assert!(!crate::daemon::subchats::announced::was_announced(&sub));
    }

    #[tokio::test]
    async fn a_live_child_a_send_in_flight_and_a_returning_child_are_never_dead() {
        let (st, _sub) = idle_sub("dead-live");
        assert!(run_dead(&st, true, 0).await.is_empty());
        assert!(run_dead(&st, true, 500).await.is_empty());
        // A respawn that finished inside the grace: the clock restarts.
        let (st, _sub) = idle_sub("dead-respawn");
        run_dead(&st, false, 0).await;
        run_dead(&st, true, 30).await;
        assert!(run_dead(&st, false, 70).await.is_empty(), "70s after the FIRST sighting, but only 0s childless since the child went");
        // busy means a send is in flight.
        let (st, sub) = idle_sub("dead-busy");
        st.registry.set_busy(&sub, true);
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 300).await.is_empty());
    }

    #[tokio::test]
    async fn finished_ended_frozen_waiting_and_parentless_subs_are_left_alone() {
        for (tag, mutate) in [
            ("dead-fin", 0),
            ("dead-end", 1),
            ("dead-frz", 2),
            ("dead-q", 3),
            ("dead-noparent", 4),
        ] {
            let (st, sub) = idle_sub(tag);
            match mutate {
                0 => {
                    st.registry.set_subchat_finished(&sub, true);
                }
                1 => {
                    st.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
                }
                2 => {
                    st.registry.set_frozen(&sub, true);
                }
                3 => {
                    st.add_prompt("q-dead", "question-requested", serde_json::json!({"session_id": sub, "seq": 1}), true).await;
                }
                _ => {
                    st.registry.mark_ended(&format!("{tag}-main"), crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
                }
            }
            run_dead(&st, false, 0).await;
            assert!(run_dead(&st, false, 300).await.is_empty(), "{tag}");
        }
    }

    /// A sub the daemon holds behind another has no process because it has not
    /// started. Without the exemption it would be carded as a death after the grace.
    #[tokio::test]
    async fn a_held_sub_is_not_judged_dead_stuck_or_silent_however_long_it_waits() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = idle_sub("dead-held");
        crate::daemon::subchats::held::hold(
            &st,
            crate::daemon::subchats::held::Held {
                sub_id: sub.clone(),
                reason: "waiting for header".into(),
                after: Some("dead-held-target".into()),
                after_name: "header".into(),
                launch: crate::daemon::subchats::held::LaunchSpec {
                    cwd: std::path::PathBuf::from("."),
                    model: "sonnet".into(),
                    effort: "high".into(),
                    account_id: None,
                    first_message: "go".into(),
                },
            },
        )
        .unwrap();
        run_dead(&st, false, 0).await;
        assert!(run_dead(&st, false, 3600).await.is_empty(), "an hour childless, still not dead");
        assert!(st.list_prompts().await.is_empty(), "and Joe was not asked about it");
        // The silence sweep needs a live child, which a held sub never has.
        let env = Env { now: Utc::now() + chrono::Duration::minutes(600), resumed_at: None, transcript_mtime: &no_mtime, is_live: &|_| false };
        assert!(sweep(&st, &env).await.is_empty());
        // Once it is released and still childless, the ordinary rule applies again.
        crate::daemon::subchats::held::release(&st, &sub);
        run_dead(&st, false, 3700).await;
        assert_eq!(run_dead(&st, false, 3800).await, [sub], "it was exempt because it was held, not for good");
    }

    #[tokio::test]
    async fn a_normal_chat_is_never_judged_dead() {
        let (st, _sub) = idle_sub("dead-plain");
        st.registry.upsert_interactive("plain-dead", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        run_dead(&st, false, 0).await;
        let carded = run_dead(&st, false, 300).await;
        assert!(!carded.contains(&"plain-dead".to_string()));
    }

    #[tokio::test]
    async fn silence_counts_from_a_resume_after_the_machine_slept() {
        let (st, _sub) = busy_sub("stuck-resume");
        let now = Utc::now() + chrono::Duration::minutes(40);
        let env = Env {
            now,
            resumed_at: Some(now - chrono::Duration::minutes(2)),
            transcript_mtime: &no_mtime,
            is_live: &always_live,
        };
        assert!(sweep(&st, &env).await.is_empty(), "the child was asleep, not silent");
    }

    #[tokio::test]
    async fn a_newer_transcript_line_keeps_the_sub_out_of_it() {
        let (st, _sub) = busy_sub("stuck-mtime");
        let now = Utc::now() + chrono::Duration::minutes(40);
        let recent = now - chrono::Duration::minutes(5);
        let mtime = move |_: &Instance| Some(recent);
        let env = Env { now, resumed_at: None, transcript_mtime: &mtime, is_live: &always_live };
        assert!(sweep(&st, &env).await.is_empty());
    }
}
