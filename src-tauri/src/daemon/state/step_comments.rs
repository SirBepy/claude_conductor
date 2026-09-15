//! Step-comment lifecycle on `DaemonState` (todo 898): Joe leaves a note on a
//! still-`pending` `write_plan` step from the checklist UI; the daemon holds
//! it until that step's own `write_plan` call marks it `active`, then hands
//! it straight back in THAT call's response
//! (`hooks_server::plan::on_write_plan`) instead of writing anywhere near the
//! session's stdin (todo 743's forbidden path stays closed). Keyed by step
//! `text`, matching `plan.rs::validate_steps`'s identity rule and the
//! checklist renderer's own row key (`turn-todo-checklist.ts`'s `rows` map).

use super::*;

impl DaemonState {
    /// Record (or overwrite) a comment for `step_text` on `session_id`. A
    /// second call for the same still-pending step replaces the first: only
    /// the latest note Joe left before the step activated is worth delivering.
    pub async fn add_step_comment(&self, session_id: &str, step_text: &str, comment: &str) {
        self.step_comments
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default()
            .insert(step_text.to_string(), comment.to_string());
    }

    /// Take (remove) a queued comment for `step_text`, if any. Called the
    /// instant `on_write_plan` sees that step go `active`, so a LATER call
    /// that still reports the same step `active` (e.g. only `detail` changed)
    /// finds nothing left to redeliver - a comment is handed over exactly once.
    pub async fn take_step_comment(&self, session_id: &str, step_text: &str) -> Option<String> {
        let mut all = self.step_comments.lock().await;
        let for_session = all.get_mut(session_id)?;
        let comment = for_session.remove(step_text);
        if for_session.is_empty() {
            all.remove(session_id);
        }
        comment
    }

    /// Drop every undelivered comment for a session. Called on turn exit
    /// (`pump::exit`, matching `expire_prompts_for_session`'s call site):
    /// `write_plan`'s step-text keys are only meaningful within the turn that
    /// declared them, so a comment still unclaimed when the turn's `claude -p`
    /// process exits belongs to a plan that is over, not to whatever unrelated
    /// step a FUTURE turn might happen to reuse the same text for. The
    /// checklist row itself is where an undelivered comment stays visible
    /// (todo 898's "not silently lost" rule) - this only prevents stale
    /// cross-turn leakage in the backend store.
    pub async fn clear_step_comments(&self, session_id: &str) {
        self.step_comments.lock().await.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::types::Settings;

    fn st() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn a_recorded_comment_is_taken_exactly_once() {
        let state = st();
        state.add_step_comment("s1", "Read the spec", "skip this one").await;
        assert_eq!(
            state.take_step_comment("s1", "Read the spec").await,
            Some("skip this one".to_string())
        );
        assert_eq!(state.take_step_comment("s1", "Read the spec").await, None);
    }

    #[tokio::test]
    async fn taking_an_unknown_step_or_session_is_none() {
        let state = st();
        assert_eq!(state.take_step_comment("ghost", "x").await, None);
        state.add_step_comment("s1", "a", "note").await;
        assert_eq!(state.take_step_comment("s1", "b").await, None);
    }

    #[tokio::test]
    async fn a_second_comment_on_the_same_step_overwrites_the_first() {
        let state = st();
        state.add_step_comment("s1", "a", "first").await;
        state.add_step_comment("s1", "a", "second").await;
        assert_eq!(state.take_step_comment("s1", "a").await, Some("second".to_string()));
    }

    #[tokio::test]
    async fn comments_are_isolated_per_session() {
        let state = st();
        state.add_step_comment("s1", "a", "for s1").await;
        assert_eq!(state.take_step_comment("s2", "a").await, None);
        assert_eq!(state.take_step_comment("s1", "a").await, Some("for s1".to_string()));
    }

    #[tokio::test]
    async fn clear_drops_every_undelivered_comment_for_the_session() {
        let state = st();
        state.add_step_comment("s1", "a", "one").await;
        state.add_step_comment("s1", "b", "two").await;
        state.add_step_comment("s2", "a", "other session").await;
        state.clear_step_comments("s1").await;
        assert_eq!(state.take_step_comment("s1", "a").await, None);
        assert_eq!(state.take_step_comment("s1", "b").await, None);
        assert_eq!(
            state.take_step_comment("s2", "a").await,
            Some("other session".to_string()),
            "clearing s1 must not touch s2's comments"
        );
    }
}
