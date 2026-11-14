//! Cards the daemon itself raises for Joe: a stalled sub, a parent that cannot
//! close with subs running, a sub past its ceiling or short of context. One
//! function, [`raise_card`], so every later step uses the same path.
//!
//! A raised card is an ordinary question card to everything that renders and
//! lists it: it goes through `DaemonState::add_prompt`, so it shows in the
//! pending-prompt listing, survives a chat switch and a frontend reload through
//! the parked store, and drives the same ring and push as a model's question.
//! What differs is who answers. A model's `ask_user_question` parks an
//! `ask_user_question` hook on `DaemonState::pending`; this registers a oneshot
//! in the same map, so `respond_question_inner` resolves it exactly as it
//! resolves a model's, returns `delivered: true`, and the card's submit path
//! then sends no answer message. Daemon code awaits [`CardHandle::answer`]; no
//! model is woken and nothing enters any transcript.
//!
//! Restart: a raised card is never persisted (`pending_questions::is_durable_question`
//! skips it), because its responder is a task in this process and could not be
//! rebuilt. A card raised before a restart is therefore DROPPED, and each
//! raising site re-derives it from state on its next tick (the stuck sweep
//! still sees the stalled sub, a close attempt asks again). Re-raising from the
//! store would hand Joe a card whose answer no code is waiting for.

use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::oneshot;

/// The three actions Joe gets on a stalled or unfinished sub.
pub const OPEN_IT: &str = "Open it";
pub const NUDGE_AGAIN: &str = "Nudge again";
pub const END_IT: &str = "End it";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardOption {
    pub label: String,
    pub description: String,
}

impl CardOption {
    pub fn new(label: &str, description: &str) -> Self {
        Self { label: label.to_string(), description: description.to_string() }
    }
}

/// What to put in front of Joe. `kind` names the raising site (`subchat_stuck`,
/// `subchat_unfinished`, later `close_approval` ...) and rides the payload so a
/// site can find its own open card again.
#[derive(Clone, Debug)]
pub struct RaisedCard {
    pub kind: &'static str,
    /// The main chat whose window shows the card. Also the payload's
    /// `session_id`: a daemon card has no asking model, so there is no separate
    /// answer target, and every layer keyed on `session_id` (ring, awaiting
    /// state, parked store) already lands on the chat Joe is reading.
    pub display_session_id: String,
    /// The sub the card is about, when there is one.
    pub sub_id: Option<String>,
    /// Short label on the card (the chip beside the domain), a few words.
    pub header: String,
    pub question: String,
    pub options: Vec<CardOption>,
    pub domain: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardAnswer {
    /// The label of the option Joe chose, or his free text for "Other".
    Picked(String),
    /// Joe skipped the card. Nothing is done, and the raising site decides
    /// whether to ask again.
    Skipped,
    /// The card left without an answer: withdrawn by code, or its prompt was
    /// swept. The sender dropped, so no answer will ever come.
    Withdrawn,
}

/// Reads the `{"answers": {question: label | [labels]}}` the responder sends.
/// An empty answer set is a skip: the card's Skip button sends `{}`.
pub fn parse_answer(resolved: &Value) -> CardAnswer {
    let Some(answers) = resolved["answers"].as_object().filter(|a| !a.is_empty()) else {
        return CardAnswer::Skipped;
    };
    let first = answers.values().next().cloned().unwrap_or(Value::Null);
    match first {
        Value::String(s) if !s.trim().is_empty() => CardAnswer::Picked(s),
        Value::Array(items) => {
            let joined: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if joined.is_empty() {
                CardAnswer::Skipped
            } else {
                CardAnswer::Picked(joined.join(", "))
            }
        }
        _ => CardAnswer::Skipped,
    }
}

/// The way back from a raised card. Awaiting it is optional: a site that does
/// not care about the answer can drop the handle, and the card still shows.
pub struct CardHandle {
    pub card_id: String,
    rx: oneshot::Receiver<Value>,
}

impl CardHandle {
    pub async fn answer(self) -> CardAnswer {
        match self.rx.await {
            Ok(resolved) => parse_answer(&resolved),
            Err(_) => CardAnswer::Withdrawn,
        }
    }

    /// Runs `act` with the answer on a detached task. The card is already on
    /// screen when this returns, and the task ends when Joe answers or the card
    /// is withdrawn.
    pub fn on_answer<F, Fut>(self, act: F)
    where
        F: FnOnce(CardAnswer) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        tokio::spawn(async move {
            let answer = self.answer().await;
            act(answer).await;
        });
    }
}

fn question_json(card: &RaisedCard) -> Value {
    let options: Vec<Value> = card
        .options
        .iter()
        .map(|o| json!({"label": o.label, "description": o.description}))
        .collect();
    let mut q = json!({
        "question": card.question,
        "header": card.header,
        "multiSelect": false,
        "options": options,
    });
    if let Some(d) = card.domain {
        q["domain"] = json!(d);
    }
    q
}

/// Posts `card` to Joe in `display_session_id`'s window and returns the handle
/// its answer arrives on. `Err` when that chat is unknown or has ended, since a
/// card for it would have nowhere to show.
pub async fn raise_card(state: &Arc<DaemonState>, card: RaisedCard) -> Result<CardHandle, String> {
    raise(state, card, false).await
}

/// [`raise_card`] for a card that must not ask for Joe's attention: no red dot, no
/// "input needed" state, no sound and no push. It is still a card in the chat's
/// window, shown when he opens the chat and behind every other card there (the
/// client sorts it last). For a finding that matters only if he looks, such as a
/// stall card for a sub the restart lost. The prompt carries `quiet: true`, which also keeps
/// it out of [`DaemonState::session_has_pending_question`], the test the rest of
/// the daemon uses for "this chat is waiting on Joe".
pub async fn raise_quiet_card(state: &Arc<DaemonState>, card: RaisedCard) -> Result<CardHandle, String> {
    raise(state, card, true).await
}

async fn raise(state: &Arc<DaemonState>, card: RaisedCard, quiet: bool) -> Result<CardHandle, String> {
    let display = card.display_session_id.clone();
    match state.registry.get(&display) {
        Some(inst) if inst.ended_at.is_none() => {}
        _ => return Err(format!("cannot raise a card: chat {display} is unknown or has ended")),
    }
    let card_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    // Registered before the prompt is visible, so an answer that races in
    // right away finds its responder.
    state.pending.lock().await.insert(card_id.clone(), tx);

    // A card about a sub names it, so the card can say whose it is. Absent when the
    // sub has no name yet; the card then falls back to the sub's row, then "Subchat".
    let sub_name = card
        .sub_id
        .as_deref()
        .and_then(|id| state.registry.get(id))
        .and_then(|i| i.name)
        .map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|n| !n.is_empty());
    let mut payload = json!({
        "id": card_id,
        "questions": [question_json(&card)],
        "session_id": display,
        // Where the card shows. Equal to `session_id` for every card raised
        // here; the field exists so the frontend's routing reads one name for
        // a sub's own question (display = parent) and for these.
        "display_session_id": display,
        "sub_id": card.sub_id,
        "card_kind": card.kind,
        // Tells the card its answer is handled by the daemon: it has no model
        // to hand a free-text note to, so it renders without the extras box.
        "daemon_card": true,
        "seq": state.next_prompt_seq(),
    });
    if let Some(name) = sub_name {
        payload["sub_name"] = json!(name);
    }
    // An older card still open in this chat: same hint a model's question
    // gets, so a second card reads as a newer one rather than a duplicate.
    if state.session_has_pending_question(&display).await {
        payload["has_older_pending"] = json!(true);
    }
    if quiet {
        payload["quiet"] = json!(true);
    }
    // `durable` keeps `expire_prompts_for_session` from sweeping it at the next
    // EOF of the chat; persistence is separately refused for a daemon card.
    state.add_prompt(&card_id, "question-requested", payload.clone(), true).await;
    if !quiet {
        crate::daemon::notify_gate::push_blocked(state, Some(&display), &card_id);
        state.registry.set_awaiting(&display, Some("question".into()));
        crate::daemon::machines::publish_instances_changed(state);
    }
    state.notifier.publish("question_request", payload);
    if !quiet {
        crate::daemon::notify_gate::sound(
            state,
            &display,
            "question",
            crate::daemon::notify_gate::turn_of(state, &display),
            json!({ "session_id": display, "awaiting": "question" }),
        );
    }
    log::info!(
        "subchats: raised {} card {card_id} in {display} for sub {:?}",
        card.kind,
        card.sub_id
    );
    Ok(CardHandle { card_id, rx })
}

/// Takes a still-open raised card down without an answer (the stall resolved on
/// its own). Its handle resolves as [`CardAnswer::Withdrawn`]. Returns whether
/// the card was open.
pub async fn withdraw_card(state: &Arc<DaemonState>, card_id: &str) -> bool {
    let Some(session_id) = state.prompt_session_id(card_id).await else { return false };
    // Dropping the sender is what resolves the handle.
    state.pending.lock().await.remove(card_id);
    state.remove_prompt(card_id).await;
    if state.clear_question_awaiting_if_no_others_pending(&session_id).await {
        crate::daemon::machines::publish_instances_changed(state);
    }
    state
        .notifier
        .publish("question_expired", json!({ "session_id": session_id, "id": card_id }));
    true
}

/// Takes down every open prompt that belongs to a sub that has ended: its own
/// question and permission cards (durable ones included, which an EOF sweep
/// leaves alone on purpose) and every daemon card about it. Nothing is left to
/// answer them to, and an answer would be sent to a chat that is gone. Returns
/// how many came down.
pub async fn drop_prompts_of_sub(state: &Arc<DaemonState>, sub_id: &str) -> usize {
    drop_matching(state, |payload| {
        payload["session_id"].as_str() == Some(sub_id)
            || (payload["daemon_card"].as_bool() == Some(true) && payload["sub_id"].as_str() == Some(sub_id))
    })
    .await
}

/// Takes down every daemon card shown in `display`'s window. Used when that
/// chat is gone: nothing can render them and no one is left to answer.
pub async fn drop_daemon_cards_shown_in(state: &Arc<DaemonState>, display: &str) -> usize {
    drop_matching(state, |payload| {
        payload["daemon_card"].as_bool() == Some(true) && payload["display_session_id"].as_str() == Some(display)
    })
    .await
}

/// Points every open daemon card shown in `old`'s window at `new`'s instead
/// (`respawn` moved the subs there). The card keeps its id, so the answer task
/// waiting on it is undisturbed. Returns how many moved.
pub async fn retarget_daemon_cards(state: &Arc<DaemonState>, old: &str, new: &str) -> usize {
    let mut moved = 0;
    for p in state.list_prompts().await {
        let payload = &p["payload"];
        if payload["daemon_card"].as_bool() != Some(true) || payload["display_session_id"].as_str() != Some(old) {
            continue;
        }
        let (Some(id), Some(event)) = (p["id"].as_str(), p["event"].as_str()) else { continue };
        let mut payload = payload.clone();
        payload["session_id"] = json!(new);
        payload["display_session_id"] = json!(new);
        state.add_prompt(id, event, payload, true).await;
        moved += 1;
    }
    if moved > 0 {
        crate::daemon::machines::publish_instances_changed(state);
    }
    moved
}

async fn drop_matching(state: &Arc<DaemonState>, matches: impl Fn(&Value) -> bool) -> usize {
    let mine: Vec<(String, String)> = state
        .list_prompts()
        .await
        .into_iter()
        .filter(|p| matches(&p["payload"]))
        .filter_map(|p| Some((p["id"].as_str()?.to_string(), p["payload"]["session_id"].as_str()?.to_string())))
        .collect();
    for (card_id, session_id) in &mine {
        // Dropping the sender is what resolves a daemon card's handle.
        state.pending.lock().await.remove(card_id);
        state.remove_prompt(card_id).await;
        state.clear_question_awaiting_if_no_others_pending(session_id).await;
        state
            .notifier
            .publish("question_expired", json!({ "session_id": session_id, "id": card_id }));
    }
    if !mine.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    mine.len()
}

/// The id of an open raised card of `kind` about `sub_id`, if there is one. A
/// site calls it before raising so a sub never has two of the same card.
pub async fn open_card_for(state: &Arc<DaemonState>, kind: &str, sub_id: &str) -> Option<String> {
    state
        .list_prompts()
        .await
        .into_iter()
        .find(|p| {
            p["payload"]["daemon_card"].as_bool() == Some(true)
                && p["payload"]["card_kind"].as_str() == Some(kind)
                && p["payload"]["sub_id"].as_str() == Some(sub_id)
        })
        .and_then(|p| p["id"].as_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::methods::permission::respond_question_inner;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state_with_chat(id: &str) -> Arc<DaemonState> {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st
    }

    fn card(display: &str, sub: Option<&str>) -> RaisedCard {
        RaisedCard {
            kind: "subchat_stuck",
            display_session_id: display.to_string(),
            sub_id: sub.map(str::to_string),
            header: "Sub stalled".into(),
            question: "The header sub has gone quiet. What now?".into(),
            options: vec![
                CardOption::new(OPEN_IT, "Read it where it stopped"),
                CardOption::new(NUDGE_AGAIN, "Send it a reminder"),
                CardOption::new(END_IT, "Stop it for good"),
            ],
            domain: None,
        }
    }

    #[tokio::test]
    async fn a_raised_card_is_listed_as_a_question_card_with_the_display_field() {
        let st = state_with_chat("main");
        let h = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        let listed = st.list_prompts().await;
        assert_eq!(listed.len(), 1);
        let p = &listed[0];
        assert_eq!(p["event"], "question-requested", "the normal question path renders it");
        assert_eq!(p["id"], h.card_id.as_str());
        assert_eq!(p["payload"]["display_session_id"], "main");
        assert_eq!(p["payload"]["session_id"], "main");
        assert_eq!(p["payload"]["sub_id"], "sub-1");
        assert_eq!(p["payload"]["daemon_card"], true);
        let q = &p["payload"]["questions"][0];
        assert_eq!(q["question"], "The header sub has gone quiet. What now?");
        assert_eq!(q["options"].as_array().unwrap().len(), 3);
        assert_eq!(st.registry.get("main").unwrap().awaiting.as_deref(), Some("question"), "the ring shows needs input");
    }

    /// C5: a card about a sub says whose it is. The payload carries the sub's row
    /// name, and none for a card about no sub or a sub without a name.
    #[tokio::test]
    async fn a_card_about_a_sub_carries_the_sub_name() {
        let st = state_with_chat("main");
        st.registry.upsert_interactive("sub-1", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_name("sub-1", "Fix  login\ntest".to_string());
        st.registry.upsert_interactive("sub-2", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let _named = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        let _unnamed = raise_card(&st, card("main", Some("sub-2"))).await.unwrap();
        let _none = raise_card(&st, card("main", None)).await.unwrap();
        let by_sub = |sub: Option<&str>, listed: &[Value]| -> Value {
            listed
                .iter()
                .find(|p| p["payload"]["sub_id"].as_str() == sub)
                .map(|p| p["payload"].clone())
                .expect("card listed")
        };
        let listed = st.list_prompts().await;
        assert_eq!(by_sub(Some("sub-1"), &listed)["sub_name"], "Fix login test");
        assert!(by_sub(Some("sub-2"), &listed).get("sub_name").is_none(), "no row name, no sub_name");
        assert!(by_sub(None, &listed).get("sub_name").is_none(), "a card about no sub names none");
    }

    /// First real run: a quiet card raised a red dot and "input needed" on a chat with
    /// nothing wrong, and sat in front of a real card. A quiet card is listed and
    /// answerable like any other, but nothing waits on it.
    #[tokio::test]
    async fn a_quiet_card_is_listed_and_answerable_but_asks_for_no_attention() {
        let st = state_with_chat("main");
        let mut rx = st.notifier.subscribe();
        let h = raise_quiet_card(&st, card("main", None)).await.unwrap();
        let listed = st.list_prompts().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["payload"]["quiet"], true, "the client keeps it out of every dot");
        assert_eq!(listed[0]["event"], "question-requested", "it still renders as a card");
        assert_ne!(st.registry.get("main").unwrap().awaiting.as_deref(), Some("question"), "no input-needed state");
        assert!(!st.session_has_pending_question("main").await, "nothing in the daemon reads the chat as waiting");
        assert!(!crate::daemon::lifecycle::has_open_prompt(&st, "main").await, "a turn is not parked on it");
        let mut frames = Vec::new();
        while let Ok(f) = rx.try_recv() {
            frames.push(f["method"].as_str().unwrap_or("").to_string());
        }
        assert!(frames.contains(&"question_request".to_string()), "the card reaches the client: {frames:?}");
        assert!(!frames.contains(&"turn_sound".to_string()), "no sound: {frames:?}");

        // A real card beside it is still a question that waits on Joe, and is not 'older'.
        let loud = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        assert!(st.session_has_pending_question("main").await);
        assert_eq!(st.registry.get("main").unwrap().awaiting.as_deref(), Some("question"));
        let listed = st.list_prompts().await;
        assert_eq!(listed[1]["payload"].get("has_older_pending"), None);
        // Answering the real one clears the state although the quiet one is still open.
        assert!(respond_question_inner(&st, &loud.card_id, json!({}), true).await);
        assert_ne!(st.registry.get("main").unwrap().awaiting.as_deref(), Some("question"));
        assert_eq!(st.list_prompts().await.len(), 1);

        assert!(respond_question_inner(&st, &h.card_id, json!({}), true).await);
        assert_eq!(h.answer().await, CardAnswer::Skipped);
    }

    #[tokio::test]
    async fn the_answer_reaches_daemon_code_and_no_model_is_involved() {
        let st = state_with_chat("main");
        let h = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        let id = h.card_id.clone();
        let question = "The header sub has gone quiet. What now?";
        // The card's submit path: respond_question, then (only when not
        // delivered) a send_message carrying the answer to a model.
        let mut answers = serde_json::Map::new();
        answers.insert(question.to_string(), json!(NUDGE_AGAIN));
        let delivered = respond_question_inner(&st, &id, Value::Object(answers), false).await;
        assert!(delivered, "delivered: true is what stops the card sending an answer message to a chat");
        assert_eq!(h.answer().await, CardAnswer::Picked(NUDGE_AGAIN.to_string()));
        assert!(st.list_prompts().await.is_empty(), "the card is settled");
        let row = st.registry.get("main").unwrap();
        assert_ne!(row.awaiting.as_deref(), Some("working"), "no follow-up turn was bridged for a model");
        assert!(st.sessions.is_empty(), "no session received anything");
    }

    #[tokio::test]
    async fn skip_resolves_as_skipped() {
        let st = state_with_chat("main");
        let h = raise_card(&st, card("main", None)).await.unwrap();
        assert!(respond_question_inner(&st, &h.card_id, json!({}), true).await);
        assert_eq!(h.answer().await, CardAnswer::Skipped);
    }

    #[tokio::test]
    async fn withdrawing_a_card_takes_it_down_and_resolves_its_handle() {
        let st = state_with_chat("main");
        let h = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        assert!(withdraw_card(&st, &h.card_id).await);
        assert!(st.list_prompts().await.is_empty());
        assert_ne!(st.registry.get("main").unwrap().awaiting.as_deref(), Some("question"));
        assert_eq!(h.answer().await, CardAnswer::Withdrawn);
        assert!(!withdraw_card(&st, "nope").await);
    }

    #[tokio::test]
    async fn raising_for_an_unknown_or_ended_chat_is_an_error() {
        let st = state_with_chat("main");
        assert!(raise_card(&st, card("ghost", None)).await.is_err());
        st.registry.mark_ended("main", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(raise_card(&st, card("main", None)).await.is_err());
    }

    #[tokio::test]
    async fn open_card_for_finds_only_the_same_kind_and_sub() {
        let st = state_with_chat("main");
        let h = raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        assert_eq!(open_card_for(&st, "subchat_stuck", "sub-1").await.as_deref(), Some(h.card_id.as_str()));
        assert_eq!(open_card_for(&st, "subchat_stuck", "sub-2").await, None);
        assert_eq!(open_card_for(&st, "subchat_unfinished", "sub-1").await, None);
    }

    #[tokio::test]
    async fn a_second_card_in_the_chat_is_marked_as_having_an_older_one() {
        let st = state_with_chat("main");
        raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        raise_card(&st, card("main", Some("sub-2"))).await.unwrap();
        let listed = st.list_prompts().await;
        assert_eq!(listed[0]["payload"].get("has_older_pending"), None);
        assert_eq!(listed[1]["payload"]["has_older_pending"], true);
        assert!(listed[0]["payload"]["seq"].as_u64() < listed[1]["payload"]["seq"].as_u64());
    }

    #[test]
    fn parse_answer_reads_a_label_a_multi_pick_and_a_skip() {
        assert_eq!(parse_answer(&json!({"answers": {"q": "End it"}})), CardAnswer::Picked("End it".into()));
        assert_eq!(parse_answer(&json!({"answers": {"q": ["a", "b"]}})), CardAnswer::Picked("a, b".into()));
        assert_eq!(parse_answer(&json!({"answers": {}})), CardAnswer::Skipped);
        assert_eq!(parse_answer(&json!({"answers": {"q": ""}})), CardAnswer::Skipped);
        assert_eq!(parse_answer(&json!({})), CardAnswer::Skipped);
    }

    #[tokio::test]
    async fn a_raised_card_is_not_persisted_so_a_restart_drops_it() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_with_chat("main");
        st.init_pending_questions(dir.path()).await;
        raise_card(&st, card("main", Some("sub-1"))).await.unwrap();
        // A model's durable question in the same chat is persisted; ours is not.
        st.add_prompt("model-q", "question-requested", json!({"session_id": "main", "seq": 99}), true).await;
        let file = dir.path().join(format!("pending-questions{}.json", crate::daemon::instance::instance_suffix()));
        let raw = std::fs::read_to_string(file).unwrap();
        let ids: Vec<String> = serde_json::from_str::<Vec<Value>>(&raw)
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["model-q"], "only the model's card is on disk");
    }
}
