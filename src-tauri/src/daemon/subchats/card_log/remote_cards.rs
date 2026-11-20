//! The cards of a sub that runs on another machine, drawn here from what its host sent.

use super::*;

/// What a visiting sub's host sent for a card, already cut by the home.
pub(crate) struct RemoteCard {
    /// The number of the `sub_event` that carried it, which names the card from now on
    /// ([`remote_card_id`]); a replay of the same event cannot draw it twice.
    pub seq: u64,
    pub kind: String,
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
    pub details: Vec<CardDetail>,
    pub visuals: Vec<serde_json::Value>,
    pub question: Option<String>,
    /// The card is one the host's app drew (see `CardEvent::by_app`); only a blocker keeps it.
    pub by_app: bool,
}

/// Draws a remote sub's `blocker`, `answer` or `rating` in its main chat: the same card a
/// local sub draws, with the sub's name from the home's record and the machine it ran on.
/// `None` when it was already stored or the kind is not one that draws.
pub(crate) fn draw_remote_card_at(
    root: &Path,
    state: &Arc<DaemonState>,
    rec: &crate::daemon::subchats::remote::records::RemoteSub,
    card: RemoteCard,
) -> Option<CardEntry> {
    let kind = match card.kind.as_str() {
        KIND_BLOCKER => KIND_BLOCKER,
        KIND_RATING => KIND_RATING,
        KIND_ANSWER => KIND_ANSWER,
        _ => return None,
    };
    let answer = kind != KIND_BLOCKER;
    let entry = CardEntry {
        id: remote_card_id(&rec.sub_id, card.seq),
        ts: now_ms(),
        parent_id: rec.main_id.clone(),
        kind: kind.into(),
        sub_id: Some(rec.sub_id.clone()),
        sub_name: Some(remote_sub_name(rec)),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: if answer { card.details } else { Vec::new() },
        visuals: if answer { card.visuals } else { Vec::new() },
        question: if answer { card.question } else { None },
        machine: crate::daemon::subchats::remote::machine_label(state, &rec.machine_id),
        by_app: card.by_app && !answer,
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}

/// What a visiting sub's host sent to revise a card it sent earlier, already cut by the home.
pub(crate) struct RemoteUpdate {
    pub text: Option<String>,
    pub details: Option<Vec<CardDetail>>,
    pub visuals: Option<Vec<serde_json::Value>>,
    pub retract: bool,
}

/// Revises the card `card_seq` names in `rec`'s main chat, as an `update_message` revises a
/// local sub's. Only a card of this sub that is an `answer` or `rating` can be revised (a
/// blocker is never one, and the app's own cards are not the sub's to change); anything else,
/// including a number the home never drew, is `None` and changes nothing.
pub(crate) fn update_remote_card_at(
    root: &Path,
    state: &Arc<DaemonState>,
    rec: &crate::daemon::subchats::remote::records::RemoteSub,
    card_seq: u64,
    update: RemoteUpdate,
) -> Option<CardEntry> {
    let id = remote_card_id(&rec.sub_id, card_seq);
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut entries = read_in(root, &rec.main_id);
    let entry = entries
        .iter_mut()
        .find(|e| e.id == id && e.sub_id.as_deref() == Some(rec.sub_id.as_str()) && matches!(e.kind.as_str(), KIND_ANSWER | KIND_RATING) && !e.by_app)?;
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
    if let Err(e) = replace_line(root, &rec.main_id, &changed) {
        log::warn!("subchats: could not rewrite card {id} for {}: {e}", rec.main_id);
        return None;
    }
    state.notifier.publish(NOTIFY, json!({ "session_id": rec.main_id, "card": changed, "replace": true }));
    Some(changed)
}
