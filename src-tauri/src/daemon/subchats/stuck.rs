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
        if inst.subchat_of.is_none() || inst.ended_at.is_some() || inst.subchat_finished || inst.frozen {
            continue;
        }
        // No live child: either it exited (the EOF handler owns that) or it was
        // never started. Nothing is hung.
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

/// The production sweep, called from the busy watchdog's tick.
pub async fn sweep_now(state: &Arc<DaemonState>, now: DateTime<Utc>, resumed_at: Option<DateTime<Utc>>) {
    let mtime = |i: &Instance| file_mtime(state, i);
    let live = |id: &str| state.sessions.contains_key(id);
    let env = Env { now, resumed_at, transcript_mtime: &mtime, is_live: &live };
    let carded = sweep(state, &env).await;
    for id in carded {
        log::warn!("subchats: sub {id} has been silent for over {}m, raised a card", STUCK_AFTER.num_minutes());
    }
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
