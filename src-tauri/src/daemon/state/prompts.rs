//! Prompt lifecycle on `DaemonState`: recording, listing, and expiring the
//! reliable-delivery prompts the app polls via `list_pending_prompts` (see
//! `pending_prompts` on the struct for why this exists instead of relying on
//! the lossy `notifier` broadcast).

use super::*;

impl DaemonState {
    /// Record an open prompt for reliable poll-based delivery to the app.
    /// `event`/`payload` are the Tauri event name and body to emit. `durable`
    /// marks a fire-and-forget AskUserQuestion prompt, whose turn ends the
    /// instant the card posts, so `expire_prompts_for_session` must skip it.
    pub async fn add_prompt(&self, id: &str, event: &str, payload: Value, durable: bool) {
        let record = serde_json::json!({ "id": id, "event": event, "payload": payload, "durable": durable });
        let persist = pending_questions::is_durable_question(&record);
        self.pending_prompts.lock().await.insert(id.to_string(), record);
        if persist {
            self.persist_pending_questions().await;
        }
    }

    /// Drop an open prompt once it has been answered or timed out. The last
    /// one in its chat also clears the phone's banner for that chat.
    pub async fn remove_prompt(&self, id: &str) {
        let (resolved, was_durable_question) = {
            let mut prompts = self.pending_prompts.lock().await;
            let removed = prompts.remove(id);
            let durable = removed.as_ref().is_some_and(pending_questions::is_durable_question);
            let resolved = removed
                .and_then(|v| v["payload"]["session_id"].as_str().map(str::to_string))
                .filter(|sid| !any_prompt_for(&prompts, sid));
            (resolved, durable)
        };
        if was_durable_question {
            self.persist_pending_questions().await;
        }
        if let Some(sid) = resolved {
            self.fire_prompts_resolved(&sid);
        }
    }

    /// True if `session_id` still has an open `"question-requested"` prompt
    /// (todo 897). A session can have more than one open at once - asked out
    /// of order across turns, answered out of order - so this is the check
    /// every "a prompt just resolved, should `awaiting` clear now" call site
    /// must make before clearing, instead of assuming the one that just
    /// resolved was the only one open.
    pub async fn session_has_pending_question(&self, session_id: &str) -> bool {
        self.pending_prompts.lock().await.values().any(|v| {
            v["event"].as_str() == Some("question-requested")
                && v["payload"]["session_id"].as_str() == Some(session_id)
        })
    }

    /// True if `session_id` still has an open `"permission-requested"`
    /// prompt (todo 978). Unlike questions, permission prompts have no
    /// sibling-queue machinery at all - `pending_prompts` tracks them with
    /// zero mutual exclusion for the same session (see the
    /// `permission_prompts_are_not_sibling_questions` test above, which pins
    /// that on purpose for the `awaiting` check). This is the guard
    /// `hooks_server::permission::on_permission_request` uses to serialize a
    /// second concurrent approval request behind the first, instead of
    /// registering/publishing both at once and having the frontend's
    /// single-record permission modal silently drop the second.
    pub async fn session_has_pending_permission(&self, session_id: &str) -> bool {
        self.pending_prompts.lock().await.values().any(|v| {
            v["event"].as_str() == Some("permission-requested")
                && v["payload"]["session_id"].as_str() == Some(session_id)
        })
    }

    /// Clears `awaiting == "question"` for `session_id` ONLY IF no other
    /// question prompt is still open for it (todo 897 - a session sat in
    /// "input needed" for ~90 minutes; three call sites blindly cleared
    /// `awaiting` on ANY one prompt resolving, so answering one of several
    /// open questions could desync the registry's "needs input" flag from
    /// `list_pending_prompts`' actual open set in either direction). Callers
    /// must remove/settle the JUST-resolved prompt's own record before
    /// calling this, so the check above doesn't count it as its own sibling.
    pub async fn clear_question_awaiting_if_no_others_pending(&self, session_id: &str) -> bool {
        if self.session_has_pending_question(session_id).await {
            return false;
        }
        self.registry.clear_awaiting_if_question(session_id)
    }

    /// Reject a self-reported `awaiting: "question"` status if no question
    /// prompt is actually still open for `session_id`. Without this, a
    /// report that lands after the answer already settled (or races the
    /// model's own realization that it was answered) re-flips `awaiting` to
    /// "question" with nothing backing it - the chat reads INPUT NEEDED and
    /// re-shows the stale draft, with no card left to resolve it. Same bug
    /// class as the already-fixed todo 897 sibling race (which guarded the
    /// CLEAR side); this guards the SET side, at pump.rs's turn-end call site.
    pub async fn drop_unbacked_question_report(
        &self,
        session_id: &str,
        awaiting: Option<String>,
    ) -> Option<String> {
        if awaiting.as_deref() == Some("question") && !self.session_has_pending_question(session_id).await {
            log::warn!(
                "daemon: session {session_id} reported awaiting=question with no backing pending prompt - dropping"
            );
            return None;
        }
        awaiting
    }

    /// The `awaiting` value a turn-end writer should store for `session_id`,
    /// given the status the turn `reported`. While a question card is open the
    /// session needs Joe's input, so that outranks done/working/waiting/None -
    /// a Stop or result line for the turn that posted the card would otherwise
    /// overwrite `"question"` and the chat would read "done" over an open
    /// card. With no card open, an unbacked `"question"` report is dropped
    /// (`drop_unbacked_question_report`) and anything else passes unchanged.
    pub async fn settled_awaiting_for(&self, session_id: &str, reported: Option<String>) -> Option<String> {
        if self.session_has_pending_question(session_id).await {
            return Some("question".to_string());
        }
        self.drop_unbacked_question_report(session_id, reported).await
    }

    /// `cancel_turn`'s awaiting reset: the interrupted turn's verdict is dead
    /// so `awaiting` clears, open prompts for the session are swept, and then
    /// any question card that survived the sweep (a durable one) puts
    /// `"question"` back, because the card still waits on Joe.
    pub async fn settle_awaiting_after_cancel(&self, session_id: &str) {
        self.registry.set_awaiting(session_id, None);
        self.expire_prompts_for_session(session_id).await;
        if self.session_has_pending_question(session_id).await {
            self.registry.set_awaiting(session_id, Some("question".to_string()));
        }
    }

    /// Snapshot of all open prompts, for the app's `list_pending_prompts` poll.
    /// Sorted by `seq` (oldest first) - `pending_prompts` is a `HashMap`, whose
    /// own iteration order is not chronological.
    pub async fn list_prompts(&self) -> Vec<Value> {
        let mut prompts: Vec<Value> = self.pending_prompts.lock().await.values().cloned().collect();
        prompts.sort_by_key(|p| p["payload"]["seq"].as_u64().unwrap_or(u64::MAX));
        prompts
    }

    /// The session a recorded prompt belongs to, if it is still open.
    /// `respond_*` uses this to resolve the session BEFORE removing the record.
    pub async fn prompt_session_id(&self, id: &str) -> Option<String> {
        self.pending_prompts
            .lock()
            .await
            .get(id)
            .and_then(|v| v["payload"]["session_id"].as_str().map(str::to_string))
    }

    /// The full recorded payload for a still-open prompt, if any.
    /// `methods::secret::respond_secret_inner` uses this to re-read
    /// `file`/`key`/`session_id` from the SERVER's own copy right before
    /// writing, rather than trust whatever the RPC caller's params say.
    pub async fn prompt_payload(&self, id: &str) -> Option<Value> {
        self.pending_prompts
            .lock()
            .await
            .get(id)
            .map(|v| v["payload"].clone())
    }

    /// The recorded `event` kind for a still-open prompt (`"permission-requested"`
    /// or `"question-requested"`), if any. `jarvis::respond_worker_prompt` uses
    /// this to answer only permission prompts and refuse questions, which stay
    /// pending for Joe.
    pub async fn prompt_event(&self, id: &str) -> Option<String> {
        self.pending_prompts
            .lock()
            .await
            .get(id)
            .and_then(|v| v["event"].as_str().map(str::to_string))
    }

    /// Expire every open prompt belonging to `session_id`: drop its prompt
    /// records and pending oneshots, publishing `question_expired` per question.
    /// Called on a `claude -p` EOF, where axum drops the blocked handler on
    /// disconnect - which used to strand "Input Needed" ghost cards.
    pub async fn expire_prompts_for_session(&self, session_id: &str) -> usize {
        // Each turn is a fresh `claude -p` child, so this EOF-triggered sweep
        // is also where the builtin AskUserQuestion redirect budget resets.
        self.registry.reset_builtin_ask_attempts(session_id);
        let (expired, none_left): (Vec<(String, bool)>, bool) = {
            let mut prompts = self.pending_prompts.lock().await;
            let ids: Vec<(String, bool)> = prompts
                .iter()
                // Skip durable (fire-and-forget AskUserQuestion) prompts: their
                // turn ends on purpose when the card posts, so this EOF is
                // normal, not a crash - cleared only by an explicit answer/skip.
                // Non-durable (blocking permission/MCP-question) prompts still expire.
                .filter(|(_, v)| {
                    v["payload"]["session_id"].as_str() == Some(session_id)
                        && v["durable"].as_bool() != Some(true)
                })
                .map(|(id, v)| (id.clone(), v["event"].as_str() == Some("question-requested")))
                .collect();
            for (id, _) in &ids {
                prompts.remove(id);
            }
            (ids, !any_prompt_for(&prompts, session_id))
        };
        if expired.is_empty() {
            return 0;
        }
        // A durable question can outlive the sweep; then the banner still applies.
        if none_left {
            self.fire_prompts_resolved(session_id);
        }
        let mut pending = self.pending.lock().await;
        for (id, is_question) in &expired {
            pending.remove(id);
            if *is_question {
                self.notifier.publish(
                    "question_expired",
                    serde_json::json!({ "session_id": session_id, "id": id }),
                );
            }
        }
        expired.len()
    }
}

fn any_prompt_for(prompts: &HashMap<String, Value>, session_id: &str) -> bool {
    prompts.values().any(|v| v["payload"]["session_id"].as_str() == Some(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::types::Settings;

    /// Waits for `mock` to be hit by a spawned send, failing after 3s.
    async fn wait_matched(mock: &mockito::Mock) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !mock.matched_async().await {
            assert!(std::time::Instant::now() < deadline, "the /clear never went out");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// The phone's banner for a chat goes once its LAST open prompt is
    /// answered, not while a sibling still waits.
    #[tokio::test]
    async fn the_last_answered_prompt_in_a_buzzed_chat_clears_the_phone_banner() {
        let mut server = mockito::Server::new_async().await;
        let clear = server
            .mock("POST", "/clear")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({"chatId": "s1"})))
            .with_status(204)
            .expect(1)
            .create_async()
            .await;
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let dir = tempfile::tempdir().unwrap();
        let pm = crate::daemon::push::PushManager::load_with_relay(dir.path().to_path_buf(), &server.url());
        pm.register_fcm_handle(crate::daemon::push::FcmHandle {
            handle: "h".into(),
            secret: "s".into(),
            device_id: None,
        });
        pm.note_fired_for_test("s1", "p2");
        let _ = st.push.set(pm);
        st.add_prompt("p1", "permission-requested", serde_json::json!({"session_id": "s1"}), false).await;
        st.add_prompt("p2", "question-requested", serde_json::json!({"session_id": "s1"}), true).await;

        st.remove_prompt("p1").await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!clear.matched_async().await, "p2 still waits, the banner stays");

        st.remove_prompt("p2").await;
        wait_matched(&clear).await;
    }

    /// Regression: `list_prompts()` must sort by `seq`, not by `pending_prompts`'
    /// HashMap iteration order (which carries no chronological meaning).
    #[tokio::test]
    async fn list_prompts_sorts_by_seq_regardless_of_insertion_order() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        // Insert newest first, oldest last (opposite of insertion order).
        st.add_prompt("newer", "question-requested", serde_json::json!({"seq": 5}), true).await;
        st.add_prompt("older", "question-requested", serde_json::json!({"seq": 1}), true).await;
        let prompts = st.list_prompts().await;
        let ids: Vec<&str> = prompts.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["older", "newer"], "must be seq-ascending, not insertion order");
    }

    /// A `seq`-less prompt (permission requests) must sort after every question.
    #[tokio::test]
    async fn list_prompts_sorts_seqless_prompts_after_seq_ed_ones() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.add_prompt("no-seq", "permission-requested", serde_json::json!({}), false).await;
        st.add_prompt("has-seq", "question-requested", serde_json::json!({"seq": 1}), true).await;
        let prompts = st.list_prompts().await;
        let ids: Vec<&str> = prompts.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["has-seq", "no-seq"]);
    }

    /// Todo 897: with two question prompts open on one session, resolving the
    /// FIRST one to answer must not clear `awaiting` while its sibling is
    /// still genuinely open - only the last one resolving may clear it. The
    /// pre-fix code called `registry.clear_awaiting_if_question` directly at
    /// every resolve site with no sibling check, so the first answer (in
    /// either order) always cleared the flag regardless of what remained open.
    #[tokio::test]
    async fn clear_question_awaiting_is_gated_on_sibling_prompts() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        st.registry.record_interactive_session(
            "s1", std::path::Path::new("/tmp/x"), &settings, "2026-08-18T00:00:00Z",
        );
        st.registry.set_awaiting("s1", Some("question".into()));

        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": "s1", "seq": 1}), true).await;
        st.add_prompt("q2", "question-requested", serde_json::json!({"session_id": "s1", "seq": 2}), true).await;

        // Resolve q1 first: its own record is removed BEFORE the clear check,
        // mirroring the real call order at every settle site.
        st.remove_prompt("q1").await;
        let cleared_after_first = st.clear_question_awaiting_if_no_others_pending("s1").await;
        assert!(!cleared_after_first, "q2 is still open - awaiting must not clear yet");
        assert_eq!(
            st.registry.get("s1").unwrap().awaiting.as_deref(),
            Some("question"),
            "a sibling question is still unanswered"
        );

        // Resolve q2: no siblings remain, so the clear now goes through.
        st.remove_prompt("q2").await;
        let cleared_after_second = st.clear_question_awaiting_if_no_others_pending("s1").await;
        assert!(cleared_after_second, "the last open question resolving must clear awaiting");
        assert!(st.registry.get("s1").unwrap().awaiting.is_none());
    }

    /// A permission-requested prompt must never count as a sibling question -
    /// it never sets `awaiting` in the first place (see `settle_prompt`'s
    /// `clear_awaiting: false` for permission answers), so it must not be
    /// able to BLOCK a genuine question's clear either.
    #[tokio::test]
    async fn permission_prompts_are_not_sibling_questions() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        st.registry.record_interactive_session(
            "s1", std::path::Path::new("/tmp/x"), &settings, "2026-08-18T00:00:00Z",
        );
        st.registry.set_awaiting("s1", Some("question".into()));
        st.add_prompt("perm1", "permission-requested", serde_json::json!({"session_id": "s1"}), false).await;

        assert!(!st.session_has_pending_question("s1").await);
        assert!(st.clear_question_awaiting_if_no_others_pending("s1").await);
    }

    /// The pump.rs re-ask race this exists to close: the model self-reports
    /// `awaiting: "question"` at turn end with no open question prompt for
    /// the session (e.g. the answer already settled it, or the report raced
    /// that settle) - the report must be dropped, not applied.
    #[tokio::test]
    async fn question_report_with_no_backing_prompt_is_dropped() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let dropped = st.drop_unbacked_question_report("s1", Some("question".into())).await;
        assert_eq!(dropped, None, "no prompt is open for s1, so the report must not apply");
    }

    /// A question report backed by a real open prompt must pass through.
    #[tokio::test]
    async fn question_report_with_a_backing_prompt_passes_through() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": "s1", "seq": 1}), true).await;
        let kept = st.drop_unbacked_question_report("s1", Some("question".into())).await;
        assert_eq!(kept.as_deref(), Some("question"));
    }

    /// While a question card is open the settled status is "question", whatever
    /// the turn reported.
    #[tokio::test]
    async fn an_open_question_card_overrides_every_reported_status() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": "s1", "seq": 1}), true).await;
        for reported in [Some("done"), Some("working"), Some("waiting"), Some("question"), None] {
            let settled = st.settled_awaiting_for("s1", reported.map(String::from)).await;
            assert_eq!(settled.as_deref(), Some("question"), "reported {reported:?}");
        }
        // Another chat's card does not count.
        assert_eq!(st.settled_awaiting_for("s2", Some("done".into())).await.as_deref(), Some("done"));
    }

    /// With no card open the report is unchanged, except that a "question"
    /// with nothing backing it is still dropped.
    #[tokio::test]
    async fn with_no_open_card_the_reported_status_is_unchanged() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert_eq!(st.settled_awaiting_for("s1", Some("done".into())).await.as_deref(), Some("done"));
        assert_eq!(st.settled_awaiting_for("s1", None).await, None);
        assert_eq!(st.settled_awaiting_for("s1", Some("question".into())).await, None);
        st.add_prompt("p1", "permission-requested", serde_json::json!({"session_id": "s1"}), false).await;
        assert_eq!(st.settled_awaiting_for("s1", Some("done".into())).await.as_deref(), Some("done"));
    }

    fn state_with_session(sid: &str) -> Arc<DaemonState> {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        st.registry.record_interactive_session(sid, std::path::Path::new("/tmp/x"), &settings, "2026-10-29T00:00:00Z");
        st
    }

    /// Interrupt with a durable card open: the sweep skips it, so the status
    /// goes back to "question" instead of staying cleared.
    #[tokio::test]
    async fn cancel_keeps_question_awaiting_for_a_surviving_durable_card() {
        let st = state_with_session("s1");
        st.registry.set_awaiting("s1", Some("question".into()));
        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": "s1"}), true).await;

        st.settle_awaiting_after_cancel("s1").await;

        assert_eq!(st.registry.get("s1").unwrap().awaiting.as_deref(), Some("question"));
        assert_eq!(st.list_prompts().await.len(), 1, "the durable card survives the cancel");
    }

    /// A blocking (non-durable) question dies with the cancel, and so does
    /// the status that pointed at it.
    #[tokio::test]
    async fn cancel_clears_awaiting_when_no_card_survives() {
        let st = state_with_session("s1");
        st.registry.set_awaiting("s1", Some("question".into()));
        st.add_prompt("q1", "question-requested", serde_json::json!({"session_id": "s1"}), false).await;

        st.settle_awaiting_after_cancel("s1").await;
        assert_eq!(st.registry.get("s1").unwrap().awaiting, None);

        st.registry.set_awaiting("s1", Some("waiting".into()));
        st.settle_awaiting_after_cancel("s1").await;
        assert_eq!(st.registry.get("s1").unwrap().awaiting, None);
    }

    /// Non-"question" reports (and None) are never touched by this guard.
    #[tokio::test]
    async fn non_question_reports_pass_through_unchanged() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert_eq!(st.drop_unbacked_question_report("s1", Some("waiting".into())).await.as_deref(), Some("waiting"));
        assert_eq!(st.drop_unbacked_question_report("s1", None).await, None);
    }
}
