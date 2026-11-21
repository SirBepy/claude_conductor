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

/// A daemon-raised card (`subchats::cards`) is `durable` so the EOF sweep leaves
/// it be, but is never written to disk: its answer is handled by a task in this
/// process, which a restart ends, so a restored copy could never be answered.
pub(super) fn is_durable_question(v: &Value) -> bool {
    v["event"].as_str() == Some("question-requested")
        && v["durable"].as_bool() == Some(true)
        && v["payload"]["daemon_card"].as_bool() != Some(true)
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

/// Whether `transcript` holds a user message whose `<auq-answer id="ID"/>` marker
/// names `id`: that card was answered, whatever the daemon still remembers of it.
/// Only lines that name the id are parsed, so a long transcript costs one pass of
/// substring checks.
fn transcript_answers_card(transcript: &Path, id: &str) -> bool {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(transcript) else { return false };
    std::io::BufReader::new(file).lines().map_while(Result::ok).any(|line| {
        if !line.contains(id) || !line.contains("auq-answer") {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { return false };
        v["type"].as_str() == Some("user") && content_names_answer(&v["message"]["content"], id)
    })
}

/// A user message's own text (a plain string, or its `text` blocks). A `tool_result`
/// block is output of a tool the chat ran, which may print a marker it only read.
fn content_names_answer(content: &Value, id: &str) -> bool {
    let names = |s: &str| crate::daemon::methods::permission::auq_answer_ids(s).contains(&id);
    match content {
        Value::String(s) => names(s),
        Value::Array(blocks) => blocks
            .iter()
            .any(|b| b["type"].as_str() == Some("text") && b["text"].as_str().is_some_and(names)),
        _ => false,
    }
}

/// The ids among `cards` (`(session id, card id)`) that something already settled
/// while the daemon did not hear of it: a Skip mark in `companion.db`, or the
/// answer's own message in the chat's transcript. Both are definite; a card with
/// neither stays, because only an answer or a Skip may clear one (a plain message
/// beside it does not, and the chat may simply be idle).
fn settled_card_ids(
    cards: &[(String, String)],
    db: Option<&Arc<std::sync::Mutex<crate::storage::StorageManager>>>,
    transcript_of: impl Fn(&str) -> Option<PathBuf>,
) -> Vec<String> {
    let mut settled = Vec::new();
    for (sid, id) in cards {
        let skipped = db.is_some_and(|db| {
            let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
            crate::storage::skipped_question_store::get_skips(mgr.conn(), sid)
                .is_ok_and(|marks| marks.iter().any(|m| m.question_id.as_deref() == Some(id)))
        });
        if skipped || transcript_of(sid).is_some_and(|p| transcript_answers_card(&p, id)) {
            settled.push(id.clone());
        }
    }
    settled
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
        self.drop_settled_questions().await;
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

    /// Drops the restored cards that were settled behind the daemon's back (see
    /// [`settled_card_ids`]): a card the screen would otherwise list under "Waiting
    /// on you" until someone opened its chat. The file reads run off the async
    /// threads, outside the `pending_prompts` lock.
    async fn drop_settled_questions(&self) {
        let cards: Vec<(String, String)> = self
            .pending_prompts
            .lock()
            .await
            .values()
            .filter(|v| is_durable_question(v))
            .filter_map(|v| Some((v["payload"]["session_id"].as_str()?.to_string(), v["id"].as_str()?.to_string())))
            .collect();
        if cards.is_empty() {
            return;
        }
        let db = self.db.clone();
        let settled = tokio::task::spawn_blocking(move || {
            settled_card_ids(&cards, db.as_ref(), crate::daemon::jsonl_tail::jsonl_path_for)
        })
        .await
        .unwrap_or_default();
        if settled.is_empty() {
            return;
        }
        {
            let mut prompts = self.pending_prompts.lock().await;
            for id in &settled {
                prompts.remove(id);
            }
        }
        log::info!("pending questions: dropped {} card(s) already answered or skipped", settled.len());
        self.persist_pending_questions().await;
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

    // A card is dropped when its session is not in the registry at reconcile
    // time, so the reconcile has to run after every source that fills the
    // registry. The same card survives when its session registers first.
    #[tokio::test]
    async fn a_card_survives_when_its_session_is_adopted_before_the_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("q1", "question-requested", q("adopted-later", 1), true).await;

        // Adopt-then-reconcile first: a reconcile that drops the card rewrites the file.
        let late = new_state();
        late.init_pending_questions(dir.path()).await;
        register(&late, "adopted-later");
        late.reconcile_pending_questions().await;
        assert_eq!(late.list_prompts().await.len(), 1);

        let early = new_state();
        early.init_pending_questions(dir.path()).await;
        early.reconcile_pending_questions().await;
        assert!(early.list_prompts().await.is_empty(), "reconciling before adoption drops the card");
    }

    #[test]
    fn boot_reconciles_after_the_external_adoption() {
        let boot = include_str!("../boot.rs");
        let adopt = boot.find("external_adopt::adopt_external_sessions(state.clone())").expect("boot adopts external sessions");
        let reconcile = boot.find("state.reconcile_pending_questions().await").expect("boot reconciles question cards");
        assert!(reconcile > adopt, "the reconcile must follow every registry source");
    }

    fn db_with_skip(dir: &Path, sid: &str, qid: &str) -> Arc<std::sync::Mutex<crate::storage::StorageManager>> {
        let db = crate::storage::StorageManager::open(&dir.join("companion.db")).unwrap();
        crate::storage::skipped_question_store::insert_skip(db.conn(), sid, 1_700_000_000_000, Some(qid)).unwrap();
        Arc::new(std::sync::Mutex::new(db))
    }

    /// One transcript line as claude writes it: the user message's text is a JSON
    /// string, so the marker's quotes are escaped.
    fn user_line(text: &str) -> String {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}).to_string()
    }

    #[tokio::test]
    async fn a_restored_card_that_was_skipped_is_dropped_at_boot() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("skipped", "question-requested", q("s1", 1), true).await;
        a.add_prompt("open", "question-requested", q("s1", 2), true).await;

        let b = DaemonState::with_db(
            crate::daemon::session::new_session_map(),
            SettingsCache::new(Settings::default()),
            Some(db_with_skip(dir.path(), "s1", "skipped")),
        );
        register(&b, "s1");
        b.init_pending_questions(dir.path()).await;
        b.reconcile_pending_questions().await;

        let ids: Vec<String> = b.list_prompts().await.iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["open"], "a Skip is final: the card must not come back after a restart");
        assert_eq!(file_ids(dir.path()), ["open"], "and it leaves the file too");
        assert_eq!(b.registry.get("s1").unwrap().awaiting.as_deref(), Some("question"), "the sibling card still holds the row");
    }

    #[tokio::test]
    async fn a_skip_of_another_chats_card_does_not_drop_this_one() {
        let dir = tempfile::tempdir().unwrap();
        let a = new_state();
        a.init_pending_questions(dir.path()).await;
        a.add_prompt("q1", "question-requested", q("s1", 1), true).await;

        let b = DaemonState::with_db(
            crate::daemon::session::new_session_map(),
            SettingsCache::new(Settings::default()),
            Some(db_with_skip(dir.path(), "other-chat", "q1")),
        );
        register(&b, "s1");
        b.init_pending_questions(dir.path()).await;
        b.reconcile_pending_questions().await;
        assert_eq!(b.list_prompts().await.len(), 1);
    }

    #[test]
    fn a_transcript_with_the_answer_message_settles_the_card_and_nothing_else_does() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        let lines = [
            // the ask itself, an assistant line quoting the marker, and a plain message beside the card
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "answered"}]}}).to_string(),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "I read <auq-answer id=\"quoted\"/> earlier"}]}}).to_string(),
            user_line("just typing next to the card, the id is beside"),
            // the answer, with the note first like the real submit
            user_line("<auq-extra/>note
<auq-answer id=\"answered\"/>User answered the question(s):
Q: x
A: y"),
            "{not json but names auq-answer id and open".to_string(),
            // a tool the chat ran printed a marker it only read
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "<auq-answer id=\"printed\"/>User answered"}]}}).to_string(),
        ];
        std::fs::write(&path, lines.join("
")).unwrap();
        assert!(transcript_answers_card(&path, "answered"));
        assert!(!transcript_answers_card(&path, "quoted"), "only a user message settles a card");
        assert!(!transcript_answers_card(&path, "open"), "a card nobody answered stays");
        assert!(!transcript_answers_card(&path, "printed"), "a tool's output is not the answer");
        assert!(!transcript_answers_card(&dir.path().join("missing.jsonl"), "answered"));
    }

    #[test]
    fn settled_card_ids_reads_each_cards_own_chat() {
        let dir = tempfile::tempdir().unwrap();
        let s1 = dir.path().join("s1.jsonl");
        std::fs::write(&s1, user_line("<auq-answer id=\"q1\"/>User answered the question(s):
Q: x
A: y")).unwrap();
        let cards = vec![
            ("s1".to_string(), "q1".to_string()),
            ("s2".to_string(), "q1".to_string()),
            ("s1".to_string(), "q2".to_string()),
        ];
        let of = |sid: &str| (sid == "s1").then(|| s1.clone());
        assert_eq!(settled_card_ids(&cards, None, of), ["q1"], "q1 of s2 has no transcript, q2 was never answered");
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
