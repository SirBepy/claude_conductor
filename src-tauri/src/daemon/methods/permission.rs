//! Permission/question responder RPC methods. The app calls these to resolve
//! the pending oneshot channels that the hooks server is blocking on while it
//! waits for a user decision.
//!
//! Both responders tolerate GHOST prompts: if the session's `claude -p` child
//! died while the prompt was open, its hook `curl` died with it and axum
//! dropped the blocked handler future on client disconnect - so the handler's
//! own post-await cleanup (remove_prompt + awaiting clear) never ran. The
//! prompt record then kept resurrecting the card on every
//! `list_pending_prompts` poll, and answering it hit "unknown request_id" and
//! changed nothing: the row sat on "Input Needed" forever. Answering any
//! prompt - live or ghost - now always tears the record down and settles the
//! registry state.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Shared tail of both responders: drop the prompt record (ghost or live) and,
/// for question prompts, clear a lingering `awaiting == "question"` and tell
/// every window. `clear_awaiting` is false for permission prompts - they never
/// set `awaiting`, and a coincident real question from another prompt must
/// survive a permission answer.
async fn settle_prompt(state: &Arc<DaemonState>, request_id: &str, clear_awaiting: bool) {
    let session_id = state.prompt_session_id(request_id).await;
    state.remove_prompt(request_id).await;
    if !clear_awaiting {
        return;
    }
    if let Some(sid) = session_id.as_deref() {
        // Gated on no OTHER open question for this session (todo 897): the
        // record for `request_id` was already removed above, so this check
        // only sees genuine siblings, not itself.
        if state.clear_question_awaiting_if_no_others_pending(sid).await {
            crate::daemon::machines::publish_instances_changed(&state);
        }
    }
}

/// Opening of the marker the question card's answer message leads with:
/// `<auq-answer id="<prompt id>"/>` (`auqAnswerSentinel` in
/// `chat-event-to-message.ts`). A bare `<auq-answer/>` from old transcripts has
/// no id and never matches.
const AUQ_ANSWER_ID_OPEN: &str = "<auq-answer id=\"";

/// Every prompt id named by an `<auq-answer id="..."/>` marker in `text`.
fn auq_answer_ids(text: &str) -> Vec<&str> {
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(AUQ_ANSWER_ID_OPEN) {
        let after = &rest[start + AUQ_ANSWER_ID_OPEN.len()..];
        let Some(end) = after.find("\"/>") else { break };
        let id = &after[..end];
        if !id.is_empty() && !id.contains('"') {
            ids.push(id);
            rest = &after[end..];
        } else {
            // A malformed marker's "\"/>" may belong to the real marker that
            // follows it; resume right after the opening so that one is found.
            rest = after;
        }
    }
    ids
}

/// Settles the question card(s) a user message answers. The card's answer
/// travels as an ordinary user message, and its `respond_question` call is a
/// separate request that can fail (a phone transport blip) while the message
/// still lands - leaving the daemon holding a card the transcript shows as
/// answered. So every send path calls this before the turn starts: each
/// `<auq-answer id="X"/>` whose X is a question still open for THIS session is
/// settled like a non-skipped `respond_question` (record dropped, `question`
/// awaiting cleared unless a sibling is open), minus delivering the answers
/// in-band, because the message itself is the delivery. An id that is not
/// pending, or belongs to another session, is a no-op.
pub(crate) async fn settle_answered_questions(state: &Arc<DaemonState>, session_id: &str, text: &str) {
    for id in auq_answer_ids(text) {
        if state.prompt_session_id(id).await.as_deref() != Some(session_id) {
            continue;
        }
        if state.prompt_event(id).await.as_deref() != Some("question-requested") {
            continue;
        }
        // The answer message outran (or lost) its `respond_question`; this is the
        // only place the decisions log can still hear the answer.
        crate::daemon::subchats::decisions::record_card_message(state, id, text).await;
        settle_prompt(state, id, true).await;
    }
}

/// How long the answered-question bridge may stand before it is withdrawn.
/// Covers the desktop's respawn-and-retry send (a dead child is revived before
/// `send_message` ever runs), which takes seconds, not minutes.
const FOLLOWUP_BRIDGE: std::time::Duration = std::time::Duration::from_secs(45);

/// A fire-and-forget answer reaches the model as a separate follow-up message,
/// and `send_message` only marks the chat busy once it runs. Between the
/// settle's awaiting clear and that send the row would read Done, so show
/// In Progress (`working`) until the send takes over; withdrawn after
/// `FOLLOWUP_BRIDGE` if no turn ever started (answer dropped, send failed).
fn bridge_to_followup_turn(state: &Arc<DaemonState>, session_id: &str) {
    let Some(inst) = state.registry.get(session_id) else { return };
    if inst.busy || inst.awaiting.is_some() {
        return;
    }
    let gen = inst.turn_gen;
    state.registry.set_awaiting(session_id, Some("working".into()));
    crate::daemon::machines::publish_instances_changed(state);
    let state = state.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(FOLLOWUP_BRIDGE).await;
        let stale = state
            .registry
            .get(&sid)
            .is_some_and(|i| !i.busy && i.turn_gen == gen && i.awaiting.as_deref() == Some("working"));
        if stale {
            state.registry.set_awaiting(&sid, None);
            crate::daemon::machines::publish_instances_changed(&state);
        }
    });
}

/// Core of `respond_permission`, factored out so the Jarvis `respond_worker_prompt`
/// route (`daemon::methods::jarvis::respond_worker_prompt`) can answer a
/// worker's permission prompt without going through the RPC `Router` (the
/// hooks-server handlers that route works don't have a `Router`/`ConnectionContext`
/// to dispatch through - see `hooks_server::jarvis`). Returns whether a live
/// waiter was actually resolved (`false` for a ghost/unknown request_id, same
/// as the RPC handler below).
pub(crate) async fn respond_permission_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    allow: bool,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
) -> bool {
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let payload = if allow {
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": updated_input.unwrap_or(serde_json::Value::Object(Default::default())),
                })
            } else {
                serde_json::json!({
                    "behavior": "deny",
                    "message": message.unwrap_or_default(),
                })
            };
            let _ = tx.send(payload);
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, false).await;
    delivered
}

/// Records a Skip in `companion.db` so scrollback can still show the card as
/// dismissed after a reopen. Nothing is ever written to Claude's transcript
/// JSONL for a skip (by design - the model's context stays clean), so this row
/// is the only durable trace. `question_id` is the prompt/tool_use id, so the
/// mark lands on the card that was actually dismissed even with several open.
/// Warn-and-skip on any failure, never fatal.
fn record_skip(state: &Arc<DaemonState>, session_id: &str, question_id: &str) {
    let Some(db) = state.db.as_ref() else {
        log::warn!("daemon: companion.db unavailable; dropping skipped-question mark");
        return;
    };
    let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
    let ts = chrono::Utc::now().timestamp_millis();
    if let Err(e) = crate::storage::skipped_question_store::insert_skip(
        mgr.conn(), session_id, ts, Some(question_id),
    ) {
        log::warn!("daemon: insert_skip failed: {e:#}");
    }
}

/// Core of `respond_question`, factored out for the same reason as
/// `respond_permission_inner` above.
///
/// `skipped` distinguishes a real Skip from an empty-but-real answer. Nothing
/// reaches the model, so the live notification below is paired with a durable
/// `skipped_questions` row for scrollback (todo 661).
#[cfg(test)]
pub(crate) async fn respond_question_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    answers: serde_json::Value,
    skipped: bool,
) -> bool {
    respond_question_as(state, request_id, answers, skipped, false).await
}

/// The `auto_by` value that marks an answer as when-done's.
pub(crate) const AUTO_BY_WHEN_DONE: &str = "when_done";

/// [`respond_question_inner`] with who answered. `auto` is when-done picking the
/// first option while Joe is away: that is not his decision, so the decisions log
/// does not record it as one, and a sub's question it answered is announced in the
/// main chat by a card instead (the answer would otherwise leave no trace there).
pub(crate) async fn respond_question_as(
    state: &Arc<DaemonState>,
    request_id: &str,
    answers: serde_json::Value,
    skipped: bool,
    auto: bool,
) -> bool {
    let session_id = state.prompt_session_id(request_id).await;
    // Before the prompt record is dropped below: it holds the question text, and
    // a Skip is never a decision.
    let asked = if auto { state.prompt_payload(request_id).await } else { None };
    if !skipped && !auto {
        crate::daemon::subchats::decisions::record_card_answer(state, request_id, &answers).await;
    }
    // A card the daemon raised for its own code (stuck sub, close approval)
    // shows in a main chat that never asked it: the answer belongs to daemon
    // code alone. Read before `settle_prompt` removes the payload.
    let daemon_card = state
        .list_prompts()
        .await
        .iter()
        .any(|p| p["id"].as_str() == Some(request_id) && p["payload"]["daemon_card"].as_bool() == Some(true));
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let _ = tx.send(serde_json::json!({"answers": answers}));
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, true).await;
    if let (Some(payload), false) = (asked, skipped) {
        announce_auto_answer(state, &payload, &answers);
    }
    // A daemon card that was withdrawn first must not wake the chat it showed in
    // (the answer would have no model to go to), and a Skip leaves no mark or
    // `question_skipped` row in a transcript that never held the card.
    if !skipped && !delivered && !daemon_card {
        if let Some(sid) = session_id.as_deref() {
            bridge_to_followup_turn(state, sid);
        }
    }
    if skipped && !daemon_card {
        if let Some(sid) = session_id.as_deref() {
            record_skip(state, sid, request_id);
        }
        if let Some(session) = session_id.as_deref().and_then(|sid| state.sessions.get(sid).map(|s| s.clone())) {
            crate::daemon::broadcast::publish(&session, crate::types::chat::ChatEvent::Notification {
                kind: "question_skipped".into(),
                body: request_id.to_string(),
            });
        }
    }
    delivered
}

/// Draws the main-chat card for a sub's question that when-done answered. Only a
/// question card asked by a sub: a chat's own question is shown where it is asked,
/// and a daemon card has no asker. The question text comes from the stored card,
/// the answer from the map when-done sent back (`{question: first option}`).
fn announce_auto_answer(state: &Arc<DaemonState>, payload: &serde_json::Value, answers: &serde_json::Value) {
    let Some(sub_id) = payload["session_id"].as_str() else { return };
    if payload["daemon_card"].as_bool() == Some(true) || !crate::daemon::subchats::is_sub_session(state, sub_id) {
        return;
    }
    let Some((asked, answer)) = answers.as_object().and_then(|m| m.iter().next()) else { return };
    let question = payload["questions"][0]["question"].as_str().unwrap_or(asked.as_str());
    let answer = answer.as_str().unwrap_or_default();
    if !answer.is_empty() {
        crate::daemon::subchats::card_log::on_when_done_answer(state, sub_id, question, answer);
    }
}

pub fn register_responders(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("respond_permission", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    request_id: String,
                    allow: bool,
                    #[serde(default)] updated_input: Option<serde_json::Value>,
                    #[serde(default)] message: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let delivered = respond_permission_inner(&state, &b.request_id, b.allow, b.updated_input, b.message).await;
                Ok(serde_json::json!({"ok": true, "delivered": delivered}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("list_pending_prompts", move |_params, ctx| {
            let state = state.clone();
            // Reliable poll path: the app fetches open prompts over RPC instead
            // of relying on the lossy notifier broadcast (which silently dropped
            // question_request frames and hung AskUserQuestion turns).
            async move {
                let mut prompts = state.list_prompts().await;
                // Re-read each prompt's display chat from the registry, so a reload
                // or the phone sees where a sub's card belongs now (the stored copy
                // was stamped when the prompt posted, before any respawn, rename or
                // promotion to the sidebar).
                for p in prompts.iter_mut() {
                    let sid = p["payload"]["session_id"].as_str().map(str::to_string);
                    crate::daemon::subchats::stamp_prompt_routing(&state, &mut p["payload"], sid.as_deref());
                }
                // Merge in every paired peer's mirrored prompts - EXCEPT
                // when the caller is itself a peer machine (`Transport::PeerMachine`).
                // One-hop rule, same guard `MirrorState::instances`/`set_instances`
                // already enforce for session rows: a peer must only ever see
                // OUR own local prompts, never a prompt we ourselves mirrored
                // from a third machine, or two paired peers could echo the
                // same prompt back and forth past one hop.
                if !matches!(ctx.transport, crate::daemon::rpc::Transport::PeerMachine(_)) {
                    // Exclude `secret-requested` prompts from the mirrored
                    // merge: `respond_secret` is
                    // desktop-pipe-only in `remote_transport_table.rs`, so a secret
                    // card mirrored onto a peer machine would render there
                    // with no way to ever answer it. Joe answers it on the
                    // machine (or phone) where the chat actually runs.
                    prompts.extend(
                        crate::daemon::machines::mirrored_prompts(&state)
                            .into_iter()
                            .filter(|p| p["event"].as_str() != Some("secret-requested")),
                    );
                }
                Ok(serde_json::Value::Array(prompts))
            }
        });
    }
    {
        let state = state.clone();
        // Deliberately NOT folded into the paginated history stream (todo 661
        // decision): a cheap point query the client fetches once per session
        // attach, so `history_page.rs`'s byte-offset cursor math is untouched.
        router.register("get_skipped_question_marks", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    session_id: String,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let marks = match state.db.as_ref() {
                    Some(db) => {
                        let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                        crate::storage::skipped_question_store::get_skips(mgr.conn(), &b.session_id)
                            .unwrap_or_else(|e| {
                                log::warn!("daemon: get_skips failed: {e:#}");
                                Vec::new()
                            })
                    }
                    None => Vec::new(),
                };
                Ok(serde_json::json!(marks))
            }
        });
    }
    {
        let state = state.clone();
        // Resolves the render-confirmation waiter `on_question_request`
        // races against a timeout (todo 735) - DISTINCT from `respond_question`
        // below, which only resolves once the user submits a real answer.
        router.register("confirm_question_rendered", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    id: String,
                    // A mirrored-chat client has no other way to name
                    // which session this prompt id belongs to; unused for
                    // local routing (`confirm_question_rendered` keys on
                    // `id` alone), but present so `forward.rs::extract_session_id`
                    // can read it generically off the raw params and route
                    // the call to the owning peer for a mirrored chat.
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                log::trace!("confirm_question_rendered: id={} session_id={:?}", b.id, b.session_id);
                state.confirm_question_rendered(&b.id).await;
                Ok(serde_json::json!({"ok": true}))
            }
        });
    }
    router.register("respond_question", move |params, ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct Body {
                request_id: String,
                answers: serde_json::Value,
                #[serde(default)]
                skipped: bool,
                /// `"when_done"` when the app's when-done engine answered with the
                /// first option. Honoured only on the desktop pipe: a phone or a
                /// paired machine must not be able to mark its answer as automatic.
                #[serde(default)]
                auto_by: Option<String>,
                /// The chat the card shows in, as the client knows it.
                #[serde(default)]
                session_id: Option<String>,
            }
            let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let auto = b.auto_by.as_deref() == Some(AUTO_BY_WHEN_DONE) && ctx.transport == crate::daemon::rpc::Transport::Local;
            let held = state.prompt_session_id(&b.request_id).await.is_some();
            let delivered = respond_question_as(&state, &b.request_id, b.answers, b.skipped, auto).await;
            // A card the daemon no longer holds (lost to a restart before cards
            // were saved, or its chat ended) is drawn from the transcript alone.
            // Its Skip still needs the durable mark, or the card reads as open
            // again on the next reload. Only for a card's own tool_use id: a
            // random daemon id names no card, and is also what a withdrawn daemon
            // card sends, which is not a Skip. A settle of an already answered
            // card (answered-gate.ts) also lands here; its mark changes nothing,
            // since an answered card never takes a Skip mark (matchSkipMarks).
            if b.skipped && !held && uuid::Uuid::parse_str(&b.request_id).is_err() {
                if let Some(sid) = b.session_id.as_deref().filter(|s| !s.is_empty()) {
                    record_skip(&state, sid, &b.request_id);
                }
            }
            Ok(serde_json::json!({"ok": true, "delivered": delivered}))
        }
    });
}

#[cfg(test)]
mod answer_bridge_tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;
    use std::path::Path;
    use std::sync::Mutex;

    fn state_with_idle_session(sid: &str) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = Mutex::new(Settings::default());
        state.registry.record_interactive_session(sid, Path::new("/tmp/x"), &settings, "2026-10-26T00:00:00Z");
        state
    }

    /// A fire-and-forget answer must never leave a Done gap before the
    /// follow-up send_message marks the chat busy.
    #[tokio::test]
    async fn answering_a_card_reads_in_progress_until_the_followup_send() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s"}), true).await;

        assert!(!respond_question_inner(&state, "q1", json!({}), false).await);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("working"));
    }

    fn sub_question_payload(sub: &str) -> serde_json::Value {
        json!({
            "session_id": sub,
            "display_session_id": "wd-main",
            "seq": 1,
            "questions": [{"question": "Which header colour?", "options": [{"label": "Teal"}, {"label": "Navy"}]}],
        })
    }

    /// When-done answers a sub's question with its first option while Joe is
    /// away. The main chat gets one card naming what it answered, and the
    /// decisions log (Joe's word for word record) does not take it as his.
    #[tokio::test]
    async fn when_done_answering_a_subs_question_draws_one_card_naming_the_answer_and_logs_no_decision() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = state_with_idle_session("wd-main");
        state.registry.upsert_interactive("wd-sub", Path::new("/tmp/x"), "proj", "2026-11-05T00:00:00Z");
        state.registry.set_name("wd-sub", "header".to_string());
        state.registry.set_subchat_of("wd-sub", Some("wd-main".into()));
        state.add_prompt("wd-q", "question-requested", sub_question_payload("wd-sub"), true).await;

        respond_question_as(&state, "wd-q", json!({"Which header colour?": "Teal"}), false, true).await;

        let cards = crate::daemon::subchats::card_log::read("wd-main");
        assert_eq!(cards.len(), 1, "{cards:?}");
        let card = &cards[0];
        assert_eq!(card.kind, crate::daemon::subchats::card_log::KIND_WHEN_DONE);
        assert_eq!(card.sub_name.as_deref(), Some("header"), "it names the sub");
        assert!(card.text.contains("Which header colour?") && card.text.contains("Teal"), "it names the answer: {}", card.text);
        assert!(crate::daemon::subchats::decisions::read_log("wd-main").is_none(), "a machine's pick is not Joe's decision");
    }

    #[tokio::test]
    async fn joes_own_answer_to_a_subs_question_draws_no_when_done_card_and_is_logged() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = state_with_idle_session("wd2-main");
        state.registry.upsert_interactive("wd2-sub", Path::new("/tmp/x"), "proj", "2026-11-05T00:00:00Z");
        state.registry.set_subchat_of("wd2-sub", Some("wd2-main".into()));
        state.add_prompt("wd2-q", "question-requested", sub_question_payload("wd2-sub"), true).await;

        respond_question_inner(&state, "wd2-q", json!({"Which header colour?": "Navy"}), false).await;

        assert!(crate::daemon::subchats::card_log::read("wd2-main").is_empty());
        assert!(crate::daemon::subchats::decisions::read_log("wd2-main").is_some_and(|l| l.contains("Navy")));
    }

    /// A card drawn from the transcript after the daemon lost its prompt (a
    /// restart before cards were saved, an ended chat) must still keep its Skip
    /// across a reload; a held card's Skip is marked once, not twice, and a
    /// random daemon id the daemon no longer holds leaves no mark.
    #[tokio::test]
    async fn skipping_a_card_the_daemon_no_longer_holds_still_leaves_a_durable_mark() {
        use crate::daemon::rpc::{ConnectionContext, Request, Router};
        let dir = tempfile::tempdir().unwrap();
        let db = crate::storage::StorageManager::open(&dir.path().join("companion.db")).unwrap();
        let state = DaemonState::with_db(new_session_map(), SettingsCache::new(Settings::default()), Some(Arc::new(Mutex::new(db))));
        let mut router = Router::new();
        register_responders(&mut router, state.clone());
        state.add_prompt("toolu_held", "question-requested", json!({"session_id": "lost-s"}), true).await;
        let lost_daemon_id = "799df8a4-9d30-4294-bbb1-36b05a4b6949";
        for id in ["toolu_lost", "toolu_held", lost_daemon_id] {
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            let req = Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "respond_question".into(),
                params: Some(json!({"request_id": id, "session_id": "lost-s", "answers": {}, "skipped": true})),
            };
            assert!(router.dispatch(req, ConnectionContext::new(tx)).await.error.is_none());
        }
        let marks = {
            let mgr = state.db.as_ref().unwrap().lock().unwrap();
            crate::storage::skipped_question_store::get_skips(mgr.conn(), "lost-s").unwrap()
        };
        let ids: Vec<_> = marks.iter().map(|m| m.question_id.clone().unwrap_or_default()).collect();
        assert_eq!(ids, vec!["toolu_lost".to_string(), "toolu_held".to_string()], "a random daemon id no longer held names no card: no mark");
    }

    /// `auto_by: "when_done"` makes an answer count as the machine's: no decision is
    /// logged and a card announces it. Only the desktop pipe may say so, since a phone
    /// or a paired machine claiming it would make Joe's own answer vanish from the log.
    #[tokio::test]
    async fn only_the_desktop_pipe_can_mark_an_answer_as_when_dones() {
        use crate::daemon::rpc::{ConnectionContext, Request, Router, Transport};
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = state_with_idle_session("tg-main");
        let mut router = Router::new();
        register_responders(&mut router, state.clone());
        let cases = [
            ("local", Transport::Local, true),
            ("phone", Transport::Phone, false),
            ("peer", Transport::PeerMachine("m1".into()), false),
        ];
        for (tag, transport, counts_as_auto) in cases {
            let (main, sub, q) = (format!("tg-main-{tag}"), format!("tg-sub-{tag}"), format!("tg-q-{tag}"));
            state.registry.upsert_interactive(&main, Path::new("/tmp/x"), "proj", "2026-11-05T00:00:00Z");
            state.registry.upsert_interactive(&sub, Path::new("/tmp/x"), "proj", "2026-11-05T00:00:00Z");
            state.registry.set_subchat_of(&sub, Some(main.clone()));
            state.add_prompt(&q, "question-requested", sub_question_payload(&sub), true).await;
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            let mut ctx = ConnectionContext::new(tx);
            ctx.remote = matches!(transport, Transport::Phone);
            ctx.transport = transport;
            let req = Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "respond_question".into(),
                params: Some(json!({"request_id": q, "answers": {"Which header colour?": "Teal"}, "auto_by": "when_done"})),
            };
            let resp = router.dispatch(req, ctx).await;
            assert!(resp.error.is_none(), "{tag}: {resp:?}");
            let logged = crate::daemon::subchats::decisions::read_log(&main).is_some_and(|l| l.contains("Teal"));
            let carded = !crate::daemon::subchats::card_log::read(&main).is_empty();
            assert_eq!((logged, carded), (!counts_as_auto, counts_as_auto), "{tag}: when-done's mark honoured only on the desktop pipe");
        }
    }

    #[tokio::test]
    async fn when_done_answering_an_ordinary_chats_question_or_skipping_draws_nothing() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = state_with_idle_session("wd3-plain");
        state.add_prompt("wd3-q", "question-requested", sub_question_payload("wd3-plain"), true).await;
        respond_question_as(&state, "wd3-q", json!({"Which header colour?": "Teal"}), false, true).await;
        assert!(crate::daemon::subchats::card_log::read("wd3-plain").is_empty());

        state.registry.upsert_interactive("wd3-sub", Path::new("/tmp/x"), "proj", "2026-11-05T00:00:00Z");
        state.registry.set_subchat_of("wd3-sub", Some("wd3-plain".into()));
        state.add_prompt("wd3-q2", "question-requested", sub_question_payload("wd3-sub"), true).await;
        respond_question_as(&state, "wd3-q2", json!({}), true, true).await;
        assert!(crate::daemon::subchats::card_log::read("wd3-plain").is_empty(), "a skip answers nothing");
    }

    fn sentinel(id: &str) -> String {
        format!("<auq-answer id=\"{id}\"/>User answered the question(s):\nQ: pick one\nA: first")
    }

    /// The respond_question call can fail while the answer message still
    /// lands; the send path must then drop the card itself.
    #[tokio::test]
    async fn a_send_carrying_an_answer_marker_settles_the_open_card() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s"}), true).await;

        settle_answered_questions(&state, "s", &sentinel("q1")).await;

        assert!(state.list_prompts().await.is_empty(), "the answered card must be gone");
        assert_eq!(state.registry.get("s").unwrap().awaiting, None);
    }

    #[tokio::test]
    async fn an_answer_marker_keeps_question_awaiting_while_a_sibling_card_is_open() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s", "seq": 1}), true).await;
        state.add_prompt("q2", "question-requested", json!({"session_id": "s", "seq": 2}), true).await;

        settle_answered_questions(&state, "s", &sentinel("q1")).await;

        let left: Vec<String> =
            state.list_prompts().await.iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(left, ["q2"]);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("question"));
    }

    #[tokio::test]
    async fn an_answer_marker_for_an_unknown_id_is_a_no_op() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s"}), true).await;

        settle_answered_questions(&state, "s", &sentinel("ghost")).await;

        assert_eq!(state.list_prompts().await.len(), 1);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("question"));
    }

    /// A plain composer message never drops an open card, and neither does a
    /// bare marker from an old transcript.
    #[tokio::test]
    async fn a_message_without_an_answer_marker_leaves_the_card_alone() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s"}), true).await;

        settle_answered_questions(&state, "s", "just a normal message").await;
        settle_answered_questions(&state, "s", "<auq-answer/>User answered the question(s)").await;

        assert_eq!(state.list_prompts().await.len(), 1);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("question"));
    }

    /// A marker naming another chat's card must not settle it from here.
    #[tokio::test]
    async fn an_answer_marker_cannot_settle_another_sessions_card() {
        let state = state_with_idle_session("s");
        state.add_prompt("q1", "question-requested", json!({"session_id": "other"}), true).await;

        settle_answered_questions(&state, "s", &sentinel("q1")).await;

        assert_eq!(state.list_prompts().await.len(), 1);
    }

    #[test]
    fn answer_marker_ids_are_read_from_anywhere_in_the_text() {
        assert_eq!(auq_answer_ids(&sentinel("abc-1")), ["abc-1"]);
        assert_eq!(auq_answer_ids("x <auq-answer id=\"a\"/> y <auq-answer id=\"b\"/>"), ["a", "b"]);
        assert!(auq_answer_ids("<auq-answer/>").is_empty());
        assert!(auq_answer_ids("<auq-answer id=\"\"/>").is_empty());
        assert!(auq_answer_ids("<auq-answer id=\"unterminated").is_empty());
    }

    #[test]
    fn a_malformed_marker_does_not_hide_the_real_one_after_it() {
        assert_eq!(auq_answer_ids("<auq-answer id=\"abc <auq-answer id=\"real\"/>"), ["real"]);
        assert_eq!(auq_answer_ids("<auq-answer id=\"\"/> <auq-answer id=\"b\"/>"), ["b"]);
    }

    /// A daemon card shows in a main chat that never asked it. Its answer going
    /// undelivered (the card was withdrawn first) must not open a follow-up turn
    /// on that chat, which would wake the main agent.
    #[tokio::test]
    async fn an_undelivered_daemon_card_never_bridges_to_the_chat_it_shows_in() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state
            .add_prompt("d1", "question-requested", json!({"session_id": "s", "daemon_card": true}), true)
            .await;
        assert!(!respond_question_inner(&state, "d1", json!({"q": "End it"}), false).await);
        assert_ne!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("working"), "no turn was bridged");
        // The same undelivered answer on a model's card still bridges, as before.
        state.add_prompt("m1", "question-requested", json!({"session_id": "s"}), true).await;
        assert!(!respond_question_inner(&state, "m1", json!({}), false).await);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("working"));
    }

    #[tokio::test]
    async fn skipping_a_card_does_not_bridge() {
        let state = state_with_idle_session("s");
        state.registry.set_awaiting("s", Some("question".into()));
        state.add_prompt("q1", "question-requested", json!({"session_id": "s"}), true).await;

        respond_question_inner(&state, "q1", json!({}), true).await;
        assert_eq!(state.registry.get("s").unwrap().awaiting, None);
    }
}

#[cfg(test)]
mod list_pending_prompts_tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request, Router, Transport, TRANSPORT};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    async fn dispatch_with(state: Arc<DaemonState>, transport: Transport) -> serde_json::Value {
        let mut r = Router::new();
        register_responders(&mut r, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = TRANSPORT.scope(transport, async { ConnectionContext::new(tx) }).await;
        let resp = r
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "list_pending_prompts".into(), params: None },
                ctx,
            )
            .await;
        resp.result.expect("list_pending_prompts must not error")
    }

    /// A session mirrored from a paired peer has its question/permission
    /// cards cached in `MirrorState` (by `peer_link`) rather than in this
    /// daemon's own `pending_prompts` - `list_pending_prompts` must merge
    /// both so a client never needs to know which machine actually hosts a
    /// prompt it's polling for.
    #[tokio::test]
    async fn merges_local_and_mirrored_prompts() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        state.mirror.set_instances("mach-b", "Mac Mini", vec![]);
        state.mirror.set_prompts("mach-b", vec![json!({"id": "mirrored-1", "event": "question-requested", "payload": {"session_id": "s-remote"}, "durable": true})]);

        let result = dispatch_with(state, Transport::Local).await;
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 2, "expected both the local and the mirrored prompt: {ids:?}");
        assert!(ids.contains(&"local-1"));
        assert!(ids.contains(&"mirrored-1"));
    }

    /// A reload or the phone reads cards only from the listing, so it must
    /// carry where a sub's card belongs, read from the registry now rather than
    /// from the copy stamped when the prompt posted.
    #[tokio::test]
    async fn listing_names_a_subs_display_chat_even_when_the_stored_copy_predates_it() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        for id in ["main", "sub", "solo"] {
            state.registry.record_interactive_session(id, std::path::Path::new("/tmp/x"), &settings, "2026-11-05T00:00:00Z");
        }
        state.registry.set_subchat_of("sub", Some("main".into()));
        state.registry.set_name("sub", "Fix login test".to_string());
        state.add_prompt("q-sub", "question-requested", json!({"session_id": "sub"}), true).await;
        state.add_prompt("q-solo", "question-requested", json!({"session_id": "solo"}), true).await;

        let result = dispatch_with(state, Transport::Local).await;
        let list = result.as_array().unwrap();
        let payload = |id: &str| list.iter().find(|p| p["id"] == id).unwrap()["payload"].clone();
        assert_eq!(payload("q-sub")["display_session_id"], "main");
        assert_eq!(payload("q-sub")["sub_name"], "Fix login test");
        assert_eq!(payload("q-solo")["display_session_id"], "solo");
        assert!(payload("q-solo").get("sub_name").is_none());
    }

    /// One-hop rule: a peer machine calling `list_pending_prompts` on
    /// us (e.g. because IT mirrors a session WE host) must see only our own
    /// local prompts - re-exporting a prompt we ourselves mirrored from a
    /// THIRD machine would let two paired peers echo it back and forth.
    #[tokio::test]
    async fn excludes_mirrored_prompts_for_a_peer_machine_caller() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        state.mirror.set_instances("mach-b", "Mac Mini", vec![]);
        state.mirror.set_prompts("mach-b", vec![json!({"id": "mirrored-1", "event": "question-requested", "payload": {"session_id": "s-remote"}, "durable": true})]);

        let result = dispatch_with(state, Transport::PeerMachine("mach-c".into())).await;
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["local-1"], "a peer caller must never see a prompt we mirrored from someone else");
    }

    /// A mirrored `secret-requested` prompt must never reach a
    /// local (desktop) caller either - `respond_secret` is desktop-pipe-only
    /// in `remote_transport_table.rs`, so a secret card mirrored in from a peer
    /// would render on this machine with no transport able to answer it.
    #[tokio::test]
    async fn excludes_mirrored_secret_requested_prompts() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        state.mirror.set_instances("mach-b", "Mac Mini", vec![]);
        state.mirror.set_prompts(
            "mach-b",
            vec![json!({"id": "secret-1", "event": "secret-requested", "payload": {"session_id": "s-remote"}, "durable": false})],
        );

        let result = dispatch_with(state, Transport::Local).await;
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["local-1"], "a mirrored secret-requested prompt must never surface, even locally");
    }
}
