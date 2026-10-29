//! Durable question cards survive a daemon restart or an app update.
//!
//! `pending_prompts` is in-memory, but the registry snapshot restores
//! `awaiting == "question"` across a restart, so without this the row reads
//! "input needed" with no card left to answer. Only durable
//! `question-requested` prompts are written: permission, secret and MCP-question
//! prompts block a live hook that dies with the daemon, so a restored copy
//! could never be answered.

use super::*;
use std::path::{Path, PathBuf};

/// `<app_data>/pending-questions[suffix].json`, suffixed per daemon instance
/// like `machines[suffix].json` so a test daemon never reads the real file.
pub(crate) fn pending_questions_path(app_data: &Path) -> PathBuf {
    let suffix = crate::daemon::instance::instance_suffix();
    app_data.join(format!("pending-questions{suffix}.json"))
}

pub(super) fn is_durable_question(v: &Value) -> bool {
    v["event"].as_str() == Some("question-requested") && v["durable"].as_bool() == Some(true)
}

fn seq_of(v: &Value) -> u64 {
    v["payload"]["seq"].as_u64().unwrap_or(0)
}

/// Entries that still look like a durable question with an id and a session;
/// a hand-edited or truncated file degrades to "no cards", never a panic.
fn read_pending_questions(path: &Path) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(list) = serde_json::from_str::<Vec<Value>>(&raw) else {
        log::warn!("pending questions: {} is not a JSON array, ignoring it", path.display());
        return Vec::new();
    };
    list.into_iter()
        .filter(|v| {
            is_durable_question(v)
                && v["id"].as_str().is_some()
                && v["payload"]["session_id"].as_str().is_some()
        })
        .collect()
}

impl DaemonState {
    /// Loads the persisted question cards into `pending_prompts` and starts
    /// persisting from here on. Runs before the hooks server and RPC router
    /// serve anything. Entries for sessions the registry no longer has are
    /// dropped later by [`Self::reconcile_pending_questions`], because the
    /// registry is not restored yet at this point.
    pub async fn init_pending_questions(&self, app_data: &Path) {
        let path = pending_questions_path(app_data);
        if self.pending_questions_path.set(path.clone()).is_err() {
            return;
        }
        let loaded = read_pending_questions(&path);
        if loaded.is_empty() {
            return;
        }
        // The frontend orders a card as stale or newer by `seq`, so new cards
        // must number above every restored one.
        if let Some(max) = loaded.iter().map(seq_of).max() {
            self.prompt_seq.fetch_max(max + 1, Ordering::Relaxed);
        }
        let mut prompts = self.pending_prompts.lock().await;
        for v in loaded {
            if let Some(id) = v["id"].as_str().map(str::to_string) {
                prompts.insert(id, v);
            }
        }
        log::info!("pending questions: restored {} card(s)", prompts.len());
    }

    /// Runs after the registry snapshot is restored. Drops cards whose session
    /// is unknown or ended (nothing could ever answer them), then makes
    /// `awaiting` agree with the cards both ways: a session with a card reads
    /// "question", and one restored as "question" with no card reads idle.
    pub async fn reconcile_pending_questions(&self) {
        let dropped = {
            let mut prompts = self.pending_prompts.lock().await;
            let before = prompts.len();
            prompts.retain(|_, v| {
                if !is_durable_question(v) {
                    return true;
                }
                let sid = v["payload"]["session_id"].as_str().unwrap_or_default();
                self.registry.get(sid).is_some_and(|i| i.ended_at.is_none())
            });
            before - prompts.len()
        };
        if dropped > 0 {
            log::info!("pending questions: dropped {dropped} card(s) for unknown or ended sessions");
            self.persist_pending_questions().await;
        }
        let with_card: std::collections::HashSet<String> = self
            .pending_prompts
            .lock()
            .await
            .values()
            .filter(|v| v["event"].as_str() == Some("question-requested"))
            .filter_map(|v| v["payload"]["session_id"].as_str().map(str::to_string))
            .collect();
        for sid in &with_card {
            self.registry.set_awaiting(sid, Some("question".to_string()));
        }
        for inst in self.registry.list() {
            if inst.awaiting.as_deref() == Some("question") && !with_card.contains(&inst.session_id) {
                self.registry.clear_awaiting_if_question(&inst.session_id);
            }
        }
    }

    /// Writes the current durable question cards. A write carries the version
    /// it was snapshotted at and a stale one is skipped, so two racing saves
    /// can never leave the older list on disk; the file IO itself runs outside
    /// the `pending_prompts` lock.
    pub(super) async fn persist_pending_questions(&self) {
        let Some(path) = self.pending_questions_path.get() else { return };
        let (version, body) = {
            let prompts = self.pending_prompts.lock().await;
            let mut cards: Vec<&Value> = prompts.values().filter(|v| is_durable_question(v)).collect();
            cards.sort_by_key(|v| seq_of(v));
            let version = self.pending_questions_version.fetch_add(1, Ordering::SeqCst) + 1;
            (version, serde_json::to_string(&cards))
        };
        let body = match body {
            Ok(b) => b,
            Err(e) => {
                log::warn!("pending questions: could not serialize: {e}");
                return;
            }
        };
        let mut written = self.pending_questions_written.lock().unwrap_or_else(|p| p.into_inner());
        if version <= *written {
            return;
        }
        *written = version;
        if let Err(e) = crate::util::write_json_atomic(path, &body) {
            log::warn!("pending questions: failed to persist {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn new_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn register(st: &DaemonState, sid: &str) {
        let settings = std::sync::Mutex::new(Settings::default());
        st.registry.record_interactive_session(sid, Path::new("/tmp/x"), &settings, "2026-10-29T00:00:00Z");
    }

    fn q(sid: &str, seq: u64) -> Value {
        json!({"session_id": sid, "seq": seq})
    }

    fn file_ids(dir: &Path) -> Vec<String> {
        read_pending_questions(&pending_questions_path(dir))
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn a_durable_question_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("q1", "question-requested", q("s1", 3), true).await;
        a.add_prompt("q2", "question-requested", q("s1", 4), true).await;
        assert_eq!(file_ids(dir.path()), ["q1", "q2"]);

        let b = new_state();
        register(&b, "s1");
        b.init_pending_questions(dir.path()).await;
        b.reconcile_pending_questions().await;
        let ids: Vec<String> = b.list_prompts().await.iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["q1", "q2"]);
        let restored = b.list_prompts().await;
        assert_eq!(restored[0]["payload"], q("s1", 3));
        assert_eq!(restored[0]["durable"], json!(true));
    }

    #[tokio::test]
    async fn answering_a_card_rewrites_the_file_without_it() {
        let dir = tempfile::tempdir().unwrap();
        let st = new_state();
        st.init_pending_questions(dir.path()).await;
        st.add_prompt("q1", "question-requested", q("s1", 1), true).await;
        st.add_prompt("q2", "question-requested", q("s1", 2), true).await;
        st.remove_prompt("q1").await;
        assert_eq!(file_ids(dir.path()), ["q2"]);
        st.remove_prompt("q2").await;
        assert!(file_ids(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn only_durable_questions_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let st = new_state();
        st.init_pending_questions(dir.path()).await;
        st.add_prompt("perm", "permission-requested", json!({"session_id": "s1"}), false).await;
        st.add_prompt("blocking", "question-requested", q("s1", 1), false).await;
        st.add_prompt("secret", "secret-requested", json!({"session_id": "s1"}), true).await;
        assert!(!pending_questions_path(dir.path()).exists(), "nothing durable, nothing written");

        st.add_prompt("q1", "question-requested", q("s1", 2), true).await;
        assert_eq!(file_ids(dir.path()), ["q1"]);
        // Removing a non-durable prompt is not a durable change.
        st.remove_prompt("perm").await;
        assert_eq!(file_ids(dir.path()), ["q1"]);
    }

    #[tokio::test]
    async fn cards_for_unknown_or_ended_sessions_are_dropped_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("live", "question-requested", q("s1", 1), true).await;
        a.add_prompt("ghost", "question-requested", q("nope", 2), true).await;
        a.add_prompt("dead", "question-requested", q("s2", 3), true).await;

        let b = new_state();
        register(&b, "s1");
        register(&b, "s2");
        b.registry.mark_ended("s2", crate::types::EndReason::Manual, "2026-10-29T01:00:00Z");
        b.init_pending_questions(dir.path()).await;
        b.reconcile_pending_questions().await;

        let ids: Vec<String> = b.list_prompts().await.iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["live"]);
        assert_eq!(file_ids(dir.path()), ["live"], "the dropped cards leave the file too");
    }

    #[tokio::test]
    async fn new_cards_number_above_every_restored_one() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("q1", "question-requested", q("s1", 41), true).await;

        let b = new_state();
        b.init_pending_questions(dir.path()).await;
        assert!(b.next_prompt_seq() > 41);
    }

    #[tokio::test]
    async fn reconcile_sets_question_for_a_card_and_clears_a_cardless_question() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("q1", "question-requested", q("with-card", 1), true).await;

        let b = new_state();
        register(&b, "with-card");
        register(&b, "cardless");
        b.registry.set_awaiting("cardless", Some("question".into()));
        b.registry.set_awaiting("with-card", None);
        b.init_pending_questions(dir.path()).await;
        b.reconcile_pending_questions().await;

        assert_eq!(b.registry.get("with-card").unwrap().awaiting.as_deref(), Some("question"));
        assert_eq!(b.registry.get("cardless").unwrap().awaiting, None);
    }

    #[tokio::test]
    async fn a_garbled_file_restores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(pending_questions_path(dir.path()), "{not json").unwrap();
        let st = new_state();
        st.init_pending_questions(dir.path()).await;
        assert!(st.list_prompts().await.is_empty());
    }
}
