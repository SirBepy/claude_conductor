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
        self.pending_prompts.lock().await.insert(
            id.to_string(),
            serde_json::json!({ "id": id, "event": event, "payload": payload, "durable": durable }),
        );
    }

    /// Drop an open prompt once it has been answered or timed out.
    pub async fn remove_prompt(&self, id: &str) {
        self.pending_prompts.lock().await.remove(id);
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

    /// The recorded `event` kind for a still-open prompt (`"permission-requested"`
    /// or `"question-requested"`), if any. `jarvis::respond_worker_prompt` uses
    /// this to route an answer to the right `respond_*_inner` without the
    /// caller needing to know which kind of prompt it's answering.
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
        let expired: Vec<(String, bool)> = {
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
            ids
        };
        if expired.is_empty() {
            return 0;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::types::Settings;

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
}
