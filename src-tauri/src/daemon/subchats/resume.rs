//! Waking, nudging and ending a sub. [`continue_sub`] is the one door every
//! "send this to a sub that is not running" goes through: step 6's `subchat
//! send` and step 7's reply typed into a sub opened in place both call it, so a
//! finished or frozen sub comes back the same way no matter who asked.

use crate::daemon::lifecycle::{self, LifecycleError};
use crate::daemon::state::DaemonState;
use crate::sessions::kinds::InstanceKind;
use std::sync::Arc;

/// Text of the daemon's one nudge to a sub that ended a turn without finishing.
/// Built here and never from anything the sub wrote, so it is safe as `is_meta`
/// text. States each way out, because the sub has nothing else to go on.
pub const NUDGE_TEXT: &str = "You ended your turn without calling finish_subchat and without a question waiting for Joe. If the job is done, commit your own edits and call finish_subchat now. If you need Joe, call ask_user_question. If you cannot continue, call finish_subchat with the verdict Blocked and say why.";

#[derive(Debug, thiserror::Error)]
pub enum ContinueError {
    #[error("unknown session: {0}")]
    NotFound(String),
    #[error("{0} is not a sub")]
    NotASub(String),
    #[error("{0} has been ended and cannot continue")]
    Ended(String),
    #[error("{0} is not an interactive chat")]
    NotInteractive(String),
    /// A live child is mid-turn. The caller holds the message for the sub's
    /// next step instead (the held-message queue), as the desktop does.
    #[error("{0} is mid-turn")]
    Busy(String),
    /// Registered but not started: it is waiting for another sub (`after`), so
    /// there is no conversation to continue. The brief it will start with is fixed.
    #[error("{0} has not started yet: it is queued behind another sub, and a message cannot reach it until it runs. Try again once it has started.")]
    Held(String),
    #[error(transparent)]
    Send(#[from] LifecycleError),
}

/// What [`prepare_continue`] changed, so a failed send can put it back.
#[derive(Debug, Clone, Copy, Default)]
pub struct Prior {
    pub finished: bool,
    pub frozen: bool,
    pub auto_frozen: bool,
}

/// Checks `sub_id` can take a message and clears what would stop it:
/// `subchat_finished`, and a freeze (user, gaming-mode park or rate limit),
/// since `respawn_interactive` refuses frozen rows. Resets the Stop hook's
/// block-nudge-card sequence, because the sub is starting a new stretch of work.
pub fn prepare_continue(state: &Arc<DaemonState>, sub_id: &str) -> Result<Prior, ContinueError> {
    let inst = state.registry.get(sub_id).ok_or_else(|| ContinueError::NotFound(sub_id.to_string()))?;
    if !super::is_sub(&inst) {
        return Err(ContinueError::NotASub(sub_id.to_string()));
    }
    if inst.ended_at.is_some() {
        return Err(ContinueError::Ended(sub_id.to_string()));
    }
    if !matches!(inst.kind, InstanceKind::Interactive) {
        return Err(ContinueError::NotInteractive(sub_id.to_string()));
    }
    if inst.busy && state.sessions.contains_key(sub_id) {
        return Err(ContinueError::Busy(sub_id.to_string()));
    }
    // Before anything is cleared: a held sub has no transcript to resume, and a
    // respawn with `--resume` of an id that never ran would fail.
    if super::held::is_held(sub_id) {
        return Err(ContinueError::Held(sub_id.to_string()));
    }
    let prior = Prior { finished: inst.subchat_finished, frozen: inst.frozen, auto_frozen: inst.auto_frozen };
    if inst.frozen {
        state.registry.set_frozen(sub_id, false);
        state.registry.set_auto_frozen(sub_id, false);
        // The message we are about to send is the continue; the unfreeze path's
        // own "continue" would be a second turn.
        state.registry.take_frozen_needs_continue(sub_id);
    }
    if inst.subchat_finished {
        state.registry.set_subchat_finished(sub_id, false);
    }
    super::runtime::runtime().reset(sub_id);
    Ok(prior)
}

pub(crate) fn restore(state: &DaemonState, sub_id: &str, prior: Prior) {
    if prior.finished {
        state.registry.set_subchat_finished(sub_id, true);
    }
    if prior.frozen {
        state.registry.set_frozen(sub_id, true);
        state.registry.set_auto_frozen(sub_id, prior.auto_frozen);
    }
}

/// Sends `text` to a sub as Joe's own message, waking it with its context if it
/// is finished (process gone) or frozen. The caller owns the text: step 6 passes
/// Joe's words verbatim. A failed send leaves the sub as it was found.
pub async fn continue_sub(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), ContinueError> {
    // One continue per sub at a time. The `Busy` check in `prepare_continue` needs
    // a live child, and the respawn window has none, so two calls inside it both
    // pass. The loser would then fail its own send and run a `set_busy(false)` on
    // the turn the winner started: the hazard `refuse_if_busy` exists for
    // (`methods/lifecycle/core.rs`). Refused as `Busy`, the caller holds its
    // message for the sub's next step like any other busy send.
    let _claim = super::runtime::runtime()
        .begin_continue(sub_id)
        .ok_or_else(|| ContinueError::Busy(sub_id.to_string()))?;
    let prior = prepare_continue(state, sub_id)?;
    // A model or effort picked while the sub sat idle lands on this message.
    lifecycle::refresh_stale_launch(state, sub_id).await;
    // Same order as the desktop `send_message` RPC: busy is set before the
    // write because a warm child can answer before the write's `.await` resumes.
    state.registry.set_awaiting(sub_id, None);
    state.registry.set_busy(sub_id, true);
    crate::sessions::chat_state::set_busy(sub_id, true);
    let gen = state.registry.current_turn_gen(sub_id);
    match lifecycle::send_message_with_respawn(state, sub_id, text, false).await {
        Ok(()) => {
            crate::daemon::machines::publish_instances_changed(state);
            Ok(())
        }
        Err(e) => {
            // Only the turn this call opened: a newer one (a wake, a peer's
            // send) is not ours to clear.
            if state.registry.set_busy_false_if_gen(sub_id, gen) {
                crate::sessions::chat_state::set_busy(sub_id, false);
            }
            restore(state, sub_id, prior);
            Err(ContinueError::Send(e))
        }
    }
}

/// What a scheduled message may do to its target, when that target may be a sub
/// (a sub's own `this_chat` schedule, a rate-limit resume, gaming mode's resume).
/// `schedule_fire::fire_message` checks nothing about `ended_at`, and respawning
/// an ended sub would start a billed child for a row nobody can see or close.
///
/// - An ended sub, or one whose row is gone but whose brief remains (the row
///   leaves the snapshot when it ends): refused, naming why.
/// - A finished sub: continued through [`prepare_continue`], the same door
///   `continue_sub` uses, so the finished flag clears and its sequence restarts.
///   The [`Prior`] comes back so a failed send puts the sub back as it was.
/// - Anything else, a plain chat included: untouched.
pub(crate) fn before_scheduled_fire(state: &Arc<DaemonState>, target: &str) -> Result<Option<Prior>, String> {
    let Some(inst) = state.registry.get(target) else {
        let was_a_sub = crate::sessions::chat_config::get(target).is_some_and(|c| c.subchat.is_some());
        return if was_a_sub { Err(ended_sub_refusal(target)) } else { Ok(None) };
    };
    if !super::is_sub(&inst) {
        return Ok(None);
    }
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(ended_sub_refusal(target));
    }
    if !inst.subchat_finished {
        return Ok(None);
    }
    prepare_continue(state, target).map(Some).map_err(|e| e.to_string())
}

fn ended_sub_refusal(sub_id: &str) -> String {
    format!("{sub_id} is a sub that ended with its main chat; a scheduled message does not bring it back")
}

/// The daemon's own message to a sub (`NUDGE_TEXT`). `is_meta` so it reads as a
/// system note, and because the text is constant, never sub-written. Marks the
/// turn wake-opened like every daemon-injected turn.
pub async fn nudge(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), LifecycleError> {
    let inst = state.registry.get(sub_id).ok_or_else(|| LifecycleError::NotFound(sub_id.to_string()))?;
    if inst.ended_at.is_some() || inst.frozen || inst.subchat_finished {
        return Err(LifecycleError::NotFound(sub_id.to_string()));
    }
    lifecycle::send_message_with_respawn(state, sub_id, text, true).await?;
    state.registry.set_awaiting(sub_id, None);
    state.registry.set_busy_from_wake(sub_id);
    crate::sessions::chat_state::set_busy(sub_id, true);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(())
}

/// Joe's "Nudge again". An idle sub is nudged at once. A sub with a live child
/// still mid-turn (the stalled one) is interrupted and nudged when that turn's
/// result line lands, because a write into a busy child re-opens the race
/// `refuse_if_busy` exists for.
pub async fn request_nudge(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), LifecycleError> {
    let rt = super::runtime::runtime();
    // Joe has seen the card, so the next unfinished end goes straight back to him.
    rt.set_stage(sub_id, super::runtime::SubStage::Nudged);
    let live_and_busy = state.sessions.contains_key(sub_id) && lifecycle::is_busy(state, sub_id);
    if live_and_busy {
        return defer_nudge_until_turn_ends(sub_id, lifecycle::cancel_turn(&state.sessions, sub_id)).await;
    }
    nudge(state, sub_id, NUDGE_TEXT).await
}

/// Arms the nudge for the turn end the interrupt will cause. Armed before the
/// interrupt is written, because the result line can land first; disarmed when
/// the write fails, since no interrupt reached the child and the next, unrelated
/// turn end would otherwise fire "you ended your turn without finishing" at it.
async fn defer_nudge_until_turn_ends(
    sub_id: &str,
    interrupt: impl std::future::Future<Output = Result<(), LifecycleError>>,
) -> Result<(), LifecycleError> {
    let rt = super::runtime::runtime();
    rt.set_nudge_due(sub_id);
    if let Err(e) = interrupt.await {
        rt.disarm_nudge(sub_id);
        return Err(e);
    }
    Ok(())
}

/// Joe's "End it": the sub is closed for good (unlike finish, which keeps the
/// row). Returns whether it was open.
pub fn end_sub(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    let now = chrono::Utc::now().to_rfc3339();
    let ended = state.registry.mark_ended(sub_id, crate::types::EndReason::Manual, &now);
    super::writers::release(state, sub_id);
    if let Some(session) = state.sessions.get(sub_id).map(|s| s.clone()) {
        session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::util::kill::kill_tree(session.pid);
    }
    super::runtime::runtime().reset(sub_id);
    if ended {
        crate::daemon::machines::publish_instances_changed(state);
        // A main chat waiting for its last running sub may close now.
        super::closing::on_sub_settled(state, sub_id);
        // Ended while queued (a close that took its subs too, "End it"): it will
        // never start, so its recipe goes with it.
        super::held::release(state, sub_id);
        // A sub waiting for this one is now waiting on something that ended blocked.
        super::held::on_target_done(state);
        // Its cards would otherwise keep showing, and answering one would send to
        // a chat that no longer exists. Detached because dropping them is async
        // and this stays callable from sync code; with no runtime there are no
        // prompts to drop either.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let (state, sub) = (state.clone(), sub_id.to_string());
            handle.spawn(async move {
                super::cards::drop_prompts_of_sub(&state, &sub).await;
            });
        }
    }
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sub(st: &DaemonState, tag: &str) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        sub
    }

    #[test]
    fn prepare_continue_clears_the_finished_flag_and_the_freeze() {
        let st = state();
        let id = sub(&st, "prep");
        st.registry.set_subchat_finished(&id, true);
        st.registry.set_frozen(&id, true);
        st.registry.set_auto_frozen(&id, true);
        st.registry.set_frozen_needs_continue(&id, true);
        let prior = prepare_continue(&st, &id).unwrap();
        assert!(prior.finished && prior.frozen && prior.auto_frozen);
        let row = st.registry.get(&id).unwrap();
        assert!(!row.subchat_finished && !row.frozen && !row.auto_frozen);
        assert!(!st.registry.take_frozen_needs_continue(&id), "the unfreeze path's own continue must not also fire");
    }

    #[test]
    fn prepare_continue_refuses_an_ended_row_a_non_sub_and_an_unknown_one() {
        let st = state();
        let id = sub(&st, "refuse");
        st.registry.mark_ended(&id, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(matches!(prepare_continue(&st, &id), Err(ContinueError::Ended(_))));
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert!(matches!(prepare_continue(&st, "plain"), Err(ContinueError::NotASub(_))));
        assert!(matches!(prepare_continue(&st, "ghost"), Err(ContinueError::NotFound(_))));
    }

    /// Reaches `spawn_session`'s account stage, which is as far as a unit test
    /// can go without starting a real `claude`: a frozen or finished row that
    /// was not cleared first would stop earlier, as NotFound from the
    /// respawn filter.
    fn reached_the_spawn(e: &ContinueError) -> bool {
        matches!(e, ContinueError::Send(LifecycleError::NoAccounts | LifecycleError::NoDefault))
    }

    #[tokio::test]
    async fn continue_sub_resumes_a_finished_row_and_a_frozen_one() {
        let st = state();
        for (tag, finished, frozen) in [("cont-fin", true, false), ("cont-frz", false, true), ("cont-both", true, true)] {
            let id = sub(&st, tag);
            st.registry.set_subchat_finished(&id, finished);
            st.registry.set_frozen(&id, frozen);
            let err = continue_sub(&st, &id, "tweak it").await.unwrap_err();
            assert!(reached_the_spawn(&err), "{tag}: the send must reach the respawn, got {err:?}");
        }
    }

    #[tokio::test]
    async fn a_failed_continue_leaves_the_sub_as_it_was_found() {
        let st = state();
        let id = sub(&st, "restore");
        st.registry.set_subchat_finished(&id, true);
        st.registry.set_frozen(&id, true);
        st.registry.set_auto_frozen(&id, true);
        assert!(continue_sub(&st, &id, "x").await.is_err());
        let row = st.registry.get(&id).unwrap();
        assert!(row.subchat_finished && row.frozen && row.auto_frozen && !row.busy);
    }

    #[tokio::test]
    async fn nudge_refuses_a_frozen_or_finished_sub() {
        let st = state();
        let id = sub(&st, "nudge");
        st.registry.set_frozen(&id, true);
        assert!(nudge(&st, &id, NUDGE_TEXT).await.is_err());
        st.registry.set_frozen(&id, false);
        st.registry.set_subchat_finished(&id, true);
        assert!(nudge(&st, &id, NUDGE_TEXT).await.is_err());
    }

    #[tokio::test]
    async fn request_nudge_marks_the_sub_nudged_so_the_next_unfinished_end_asks_joe() {
        let st = state();
        let id = sub(&st, "reqnudge");
        let _ = request_nudge(&st, &id).await;
        assert_eq!(super::super::runtime::runtime().stage(&id), super::super::runtime::SubStage::Nudged);
        assert!(!super::super::runtime::runtime().take_nudge_due(&id), "an idle sub is nudged now, not deferred");
    }

    #[tokio::test]
    async fn a_second_continue_while_one_is_in_flight_is_refused_and_touches_nothing() {
        let st = state();
        let id = sub(&st, "claim");
        st.registry.set_subchat_finished(&id, true);
        let rt = super::super::runtime::runtime();
        let held = rt.begin_continue(&id).expect("free to claim");
        assert!(rt.begin_continue(&id).is_none(), "the claim is exclusive");
        let err = continue_sub(&st, &id, "second").await.unwrap_err();
        assert!(matches!(err, ContinueError::Busy(_)), "{err:?}");
        let row = st.registry.get(&id).unwrap();
        assert!(row.subchat_finished && !row.busy, "the refused call must not clear the flag or open a turn");
        drop(held);
        let err = continue_sub(&st, &id, "after").await.unwrap_err();
        assert!(reached_the_spawn(&err), "once the claim is released a continue goes through to the send: {err:?}");
    }

    #[tokio::test]
    async fn a_failed_continue_releases_its_claim() {
        let st = state();
        let id = sub(&st, "claim-fail");
        assert!(continue_sub(&st, &id, "x").await.is_err());
        assert!(super::super::runtime::runtime().begin_continue(&id).is_some(), "an early return must not leave the sub claimed");
    }

    #[tokio::test]
    async fn a_failed_interrupt_leaves_no_nudge_armed_for_the_next_turn_end() {
        let rt = super::super::runtime::runtime();
        let ok = defer_nudge_until_turn_ends("nd-ok", async { Ok(()) }).await;
        assert!(ok.is_ok());
        assert!(rt.take_nudge_due("nd-ok"), "a delivered interrupt leaves it armed for the result line it causes");
        let failed = defer_nudge_until_turn_ends("nd-fail", async { Err(LifecycleError::NotFound("nd-fail".into())) }).await;
        assert!(failed.is_err());
        assert!(!rt.take_nudge_due("nd-fail"), "no interrupt reached the child, so a later turn end owes it no nudge");
    }

    async fn card_ids(st: &Arc<DaemonState>) -> Vec<String> {
        let mut ids: Vec<String> = st.list_prompts().await.iter().filter_map(|p| p["id"].as_str().map(str::to_string)).collect();
        ids.sort();
        ids
    }

    async fn add_cards_for(st: &Arc<DaemonState>, sub: &str, other_sub: &str) {
        let main = st.registry.get(sub).unwrap().subchat_of.unwrap();
        // The sub's own durable question and its permission prompt.
        st.add_prompt("q-own", "question-requested", serde_json::json!({"session_id": sub, "seq": 1}), true).await;
        st.add_prompt("p-own", "permission-requested", serde_json::json!({"session_id": sub, "seq": 2}), false).await;
        // A daemon card about the sub (session_id is the main chat's) and one about its sibling.
        st.add_prompt("stall-own", "question-requested", serde_json::json!({"session_id": main, "sub_id": sub, "daemon_card": true, "seq": 3}), true).await;
        st.add_prompt("stall-other", "question-requested", serde_json::json!({"session_id": main, "sub_id": other_sub, "daemon_card": true, "seq": 4}), true).await;
        st.add_prompt("q-other", "question-requested", serde_json::json!({"session_id": other_sub, "seq": 5}), true).await;
    }

    #[tokio::test]
    async fn dropping_a_subs_prompts_takes_its_own_cards_and_cards_about_it_and_no_one_elses() {
        let st = state();
        let id = sub(&st, "drop");
        let other = "drop-other-sub".to_string();
        st.registry.upsert_interactive(&other, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&other, Some("drop-main".into()));
        add_cards_for(&st, &id, &other).await;
        assert_eq!(super::super::cards::drop_prompts_of_sub(&st, &id).await, 3);
        assert_eq!(card_ids(&st).await, ["q-other", "stall-other"]);
    }

    #[tokio::test]
    async fn ending_a_sub_drops_its_cards_so_none_is_left_to_answer_to_a_chat_that_is_gone() {
        let st = state();
        let id = sub(&st, "endcards");
        let other = "endcards-other-sub".to_string();
        st.registry.upsert_interactive(&other, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&other, Some("endcards-main".into()));
        add_cards_for(&st, &id, &other).await;
        assert!(end_sub(&st, &id));
        for _ in 0..200 {
            if card_ids(&st).await == ["q-other", "stall-other"] {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the ended sub's cards are still listed: {:?}", card_ids(&st).await);
    }

    #[test]
    fn end_sub_marks_the_row_ended() {
        let st = state();
        let id = sub(&st, "end");
        assert!(end_sub(&st, &id));
        assert!(st.registry.get(&id).unwrap().ended_at.is_some());
        assert!(!end_sub(&st, &id), "ending twice is a no-op");
    }

    #[test]
    fn the_nudge_text_names_each_way_out_and_carries_no_dash() {
        assert!(NUDGE_TEXT.contains("finish_subchat") && NUDGE_TEXT.contains("ask_user_question"));
        assert!(!NUDGE_TEXT.contains('\u{2014}'));
    }
}
