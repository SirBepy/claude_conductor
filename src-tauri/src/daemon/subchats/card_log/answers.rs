//! A sub's `answer` and `rating` cards, their `update_message` revisions, and the card
//! when-done draws when it answers for Joe.

use super::*;

/// What a sub's `answer` or `rating` message carries into the main chat.
#[derive(Clone, Debug, Default)]
pub struct AnswerCard {
    /// [`KIND_ANSWER`] or [`KIND_RATING`].
    pub kind: String,
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
    pub details: Vec<CardDetail>,
    pub visuals: Vec<serde_json::Value>,
    /// The sub's clear rewrite of what Joe asked, when it sent one.
    pub question: Option<String>,
}

/// Every `send_message` a sub made this turn, in send order: the id of the card
/// the daemon drew for it, or `None` for a kind that draws none. `update_message`
/// addresses a message by its 1-based ordinal, newest first, counting the sub's
/// own non-retracted messages (`resolveOrdinalIn` in the frontend); this list lets
/// the daemon resolve the same ordinal for the current turn. An ordinal past the
/// turn's own sends names a message of an earlier turn, which the daemon cannot
/// place, so it is not mirrored.
static TURN_SENDS: Mutex<Option<std::collections::HashMap<String, (u64, Vec<Option<String>>)>>> = Mutex::new(None);

/// Records one passed send of `sub_id` (with the card it drew, if any). A chat that
/// is not a sub is not tracked.
pub fn note_send(state: &DaemonState, sub_id: &str, card_id: Option<String>) {
    if state.registry.get(sub_id).and_then(|i| i.subchat_of).is_none() {
        return;
    }
    let gen = state.registry.current_turn_gen(sub_id);
    let mut map = TURN_SENDS.lock().unwrap_or_else(|p| p.into_inner());
    let slot = map.get_or_insert_with(Default::default).entry(sub_id.to_string()).or_insert((gen, Vec::new()));
    if slot.0 != gen {
        *slot = (gen, Vec::new());
    }
    slot.1.push(card_id);
}

/// Draws a sub's `answer` or `rating` into its main chat. The question is the
/// one the send carried, else the one the main chat handed the sub, which is
/// then spent (the same rule `finish` follows) so the sub's later finish is not a
/// second answer to it. `None` when `sub_id` is not a sub.
pub fn on_answer(state: &Arc<DaemonState>, sub_id: &str, card: AnswerCard) -> Option<CardEntry> {
    if crate::daemon::subchats::is_visiting(sub_id) {
        let _ = send_answer(state, sub_id, card);
        return None;
    }
    let root = crate::settings::paths::data_dir().ok()?;
    let parent = state.registry.get(sub_id).and_then(|i| i.subchat_of.clone())?;
    on_answer_in(&root, state, &parent, sub_id, card)
}

/// A sub's `answer` or `rating`, drawn (here, or on its home for a visiting sub): the id its
/// card goes by in this turn's send list, which a later `update_message` finds it with. For a
/// visiting sub that is [`remote_card_id`] of the event it queued, since the card lives in the
/// home's log; `Err` when that event could not be queued, so the sub can be told.
pub fn send_answer(state: &Arc<DaemonState>, sub_id: &str, card: AnswerCard) -> Result<Option<String>, CardLost> {
    // A visiting sub's main chat is on its home: the card is drawn there, with the
    // question this host's brief holds when the send carried none, spent once queued.
    if crate::daemon::subchats::is_visiting(sub_id) {
        let seq = queue_remote_answer(state, sub_id, card);
        return lost_unless(seq.is_some(), sub_id).map(|()| seq.map(|s| remote_card_id(sub_id, s)));
    }
    let Ok(root) = crate::settings::paths::data_dir() else { return Ok(None) };
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of.clone()) else { return Ok(None) };
    Ok(on_answer_in(&root, state, &parent, sub_id, card).map(|e| e.id))
}

/// The id a visiting sub's card has in its home's log: the number of the event that carried it,
/// which the host knows when the card is queued and the home knows when it is drawn, so a later
/// revision of the card can name it without either side sending an id. It names the sub as well,
/// so a host can only ever name a card of its own sub.
pub(crate) fn remote_card_id(sub_id: &str, seq: u64) -> String {
    format!("remote-{sub_id}-{seq}")
}

/// The event number in a [`remote_card_id`] of `sub_id`.
fn remote_card_seq(sub_id: &str, id: &str) -> Option<u64> {
    id.strip_prefix(&format!("remote-{sub_id}-"))?.parse().ok()
}

pub(crate) fn on_answer_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    card: AnswerCard,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let handed = answerable_question(sub_id, brief.as_ref());
    let question = card.question.filter(|q| !q.trim().is_empty()).or(handed.clone());
    let kind = if card.kind == KIND_RATING { KIND_RATING } else { KIND_ANSWER };
    let entry = CardEntry {
        id: format!("{kind}-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: kind.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        model: Some(inst.model.clone()).filter(|m| !m.is_empty()),
        effort: Some(inst.effort.clone()).filter(|e| !e.is_empty()),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: card.details,
        visuals: card.visuals,
        question,
        ..CardEntry::default()
    };
    if !store_and_announce(state, root, &entry) {
        return None;
    }
    // Spent only once the card is stored: a failed append leaves the question for the finish to carry.
    spend_question(sub_id, brief, handed.is_some());
    Some(entry)
}

/// The question the main chat handed `sub_id` that a message it sends now can answer: none
/// while the follow-up text carrying it is still held for the sub (it has not read it, so
/// whatever it sends this turn answers the earlier work). `finish::commit_finish_at` reads
/// the same rule, so a question is never claimed by a card of the round before it.
fn answerable_question(sub_id: &str, brief: Option<&crate::daemon::subchats::SubchatBrief>) -> Option<String> {
    brief.and_then(|b| b.question.clone()).filter(|q| !crate::daemon::subchats::followup::holds_question(sub_id, q))
}

/// Takes the handed question off the brief once a card has carried or passed it, so the
/// sub's later finish is not a second answer to it. `answerable` is false while the question
/// still waits for its round: it stays on the brief.
fn spend_question(sub_id: &str, brief: Option<crate::daemon::subchats::SubchatBrief>, answerable: bool) {
    if let Some(mut b) = brief.filter(|b| answerable && b.question.is_some()) {
        b.question = None;
        crate::sessions::chat_config::set_subchat(sub_id, Some(b));
    }
}

/// A visiting sub's `answer` or `rating`: queued for its home, which draws the card. Like
/// the local path, the question is the one the send carried, else the one the brief
/// holds, which is spent only once the event is queued.
fn queue_remote_answer(state: &Arc<DaemonState>, sub_id: &str, card: AnswerCard) -> Option<u64> {
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let handed = answerable_question(sub_id, brief.as_ref());
    let question = card.question.filter(|q| !q.trim().is_empty()).or(handed.clone());
    let kind = if card.kind == KIND_RATING { KIND_RATING } else { KIND_ANSWER };
    let event = crate::daemon::subchats::remote::events::CardEvent {
        kind: kind.into(),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: card.details,
        visuals: card.visuals,
        question,
        by_app: false,
    };
    let queued = crate::daemon::subchats::remote::events::queue_card_seq(state, sub_id, event);
    if queued.is_some() {
        spend_question(sub_id, brief, handed.is_some());
    }
    queued
}

/// What an `update_message` changes on the card: new text and details, or a retract.
#[derive(Clone, Debug, Default)]
pub struct AnswerUpdate {
    pub text: Option<String>,
    /// `Some` replaces the details (an empty list clears them); `None` keeps them.
    pub details: Option<Vec<CardDetail>>,
    /// `Some` replaces the visuals (an empty list clears them); `None` keeps them.
    pub visuals: Option<Vec<serde_json::Value>>,
    pub retract: bool,
    /// The `message` ordinal the `update_message` carried: 1 is the sub's newest message.
    pub ordinal: u64,
}

/// Rewrites the card the update's ordinal names among `sub_id`'s sends this turn
/// and announces it again. `None` when that message drew no card or belongs to an
/// earlier turn, which the daemon cannot place.
pub fn on_answer_update(state: &Arc<DaemonState>, sub_id: &str, update: AnswerUpdate) -> Option<CardEntry> {
    send_answer_update(state, sub_id, update).ok().flatten()
}

/// [`on_answer_update`] that also says when a visiting sub's revision was lost on the way to
/// its home. A visiting sub's card sits in its home's log, so the revision goes there as an
/// event naming the card by [`remote_card_id`]; `Ok(None)` for it, like the other visiting paths.
pub fn send_answer_update(state: &Arc<DaemonState>, sub_id: &str, update: AnswerUpdate) -> Result<Option<CardEntry>, CardLost> {
    if crate::daemon::subchats::is_visiting(sub_id) {
        let Some(id) = take_turn_send(state, sub_id, &update) else { return Ok(None) };
        // A card the host never drew a ref for (a blocker, a report, a lost send) has nothing to revise.
        let Some(card_seq) = remote_card_seq(sub_id, &id) else { return Ok(None) };
        let event = crate::daemon::subchats::remote::events::Event::CardUpdate {
            card_seq,
            text: update.text,
            details: update.details,
            visuals: update.visuals,
            retract: update.retract,
        };
        return lost_unless(crate::daemon::subchats::remote::events::queue(state, sub_id, &event), sub_id).map(|()| None);
    }
    let Ok(root) = crate::settings::paths::data_dir() else { return Ok(None) };
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of.clone()) else { return Ok(None) };
    Ok(on_answer_update_in(&root, state, &parent, sub_id, update))
}

/// The card kind (`answer` or `rating`) of the message `ordinal` names among
/// `sub_id`'s sends this turn, or `None` when it drew no card, is not this turn's, or
/// `sub_id` is no sub. A blocker is never a target (`draw_sub_card` records no card id for it),
/// and a visiting sub's answer sits in its home's log, not here, so its revision is uncapped.
/// The same ordinal walk as [`on_answer_update`], read only.
pub fn update_target_kind(state: &Arc<DaemonState>, sub_id: &str, ordinal: u64) -> Option<String> {
    let root = crate::settings::paths::data_dir().ok()?;
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    let gen = state.registry.current_turn_gen(sub_id);
    let id = {
        let map = TURN_SENDS.lock().unwrap_or_else(|p| p.into_inner());
        let (at, sends) = map.as_ref()?.get(sub_id)?;
        if *at != gen || ordinal < 1 || ordinal as usize > sends.len() {
            return None;
        }
        sends[sends.len() - ordinal as usize].clone()?
    };
    read_in(&root, &parent).into_iter().find(|e| e.id == id).map(|e| e.kind)
}

/// The card id the update's ordinal names among `sub_id`'s sends this turn. A retract also
/// takes the send out of the list, since a retracted message no longer counts toward the ordinal.
fn take_turn_send(state: &Arc<DaemonState>, sub_id: &str, update: &AnswerUpdate) -> Option<String> {
    let gen = state.registry.current_turn_gen(sub_id);
    let mut map = TURN_SENDS.lock().unwrap_or_else(|p| p.into_inner());
    let (at, sends) = map.as_mut()?.get_mut(sub_id)?;
    if *at != gen || update.ordinal < 1 || update.ordinal as usize > sends.len() {
        return None;
    }
    let i = sends.len() - update.ordinal as usize;
    let id = sends[i].clone();
    if update.retract {
        sends.remove(i);
    }
    id
}

pub(crate) fn on_answer_update_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    update: AnswerUpdate,
) -> Option<CardEntry> {
    let id = take_turn_send(state, sub_id, &update)?;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut entries = read_in(root, parent);
    let entry = entries.iter_mut().find(|e| e.id == id)?;
    if update.retract {
        entry.retracted = true;
    }
    if let Some(t) = update.text {
        entry.text = t;
    }
    if let Some(d) = update.details {
        entry.details = d;
    }
    if let Some(v) = update.visuals {
        entry.visuals = v;
    }
    let changed = entry.clone();
    if let Err(e) = replace_line(root, parent, &changed) {
        log::warn!("subchats: could not rewrite card {id} for {parent}: {e}");
        return None;
    }
    state.notifier.publish(NOTIFY, json!({ "session_id": parent, "card": changed, "replace": true }));
    Some(changed)
}

/// Draws the card that tells Joe when-done answered a sub's question for him.
/// When-done auto-answers with the first option so the machine can sleep, and
/// the answer would otherwise leave no trace in the window Joe reads. Goes
/// through the card log rather than `raise_card`, since a question card waits
/// for an answer that never comes. `None` when `sub_id` is not a sub.
pub fn on_when_done_answer(state: &Arc<DaemonState>, sub_id: &str, question: &str, answer: &str) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_when_done_answer_at(&root, state, sub_id, question, answer)
}

pub(crate) fn on_when_done_answer_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    question: &str,
    answer: &str,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let parent = inst.subchat_of.clone()?;
    let entry = CardEntry {
        id: format!("when-done-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent,
        kind: KIND_WHEN_DONE.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        verdict: "When-done answered".into(),
        tone: Some("neutral".into()),
        text: format!("While you were away, when-done answered the question \"{question}\" with its first option: {answer}."),
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}
