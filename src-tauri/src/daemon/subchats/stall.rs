//! The card Joe gets when a sub stalls, and what each of its answers does.
//! Two causes share it: a sub that ended turns without finishing even after the
//! Stop hook's block and the daemon's nudge (`Unfinished`), and a sub that has
//! written nothing for [`super::stuck::STUCK_AFTER`] (`Stuck`). Each sub has at
//! most one open card per cause.

use super::cards::{self, CardAnswer, CardOption, RaisedCard, END_IT, NUDGE_AGAIN, OPEN_IT};
use super::resume;
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stall {
    Unfinished,
    Stuck,
}

impl Stall {
    pub fn card_kind(self) -> &'static str {
        match self {
            Stall::Unfinished => "subchat_unfinished",
            Stall::Stuck => "subchat_stuck",
        }
    }

    fn header(self) -> &'static str {
        match self {
            Stall::Unfinished => "Sub stopped",
            Stall::Stuck => "Sub stalled",
        }
    }

    fn question(self, who: &str, note: Option<&str>) -> String {
        match (self, note) {
            // The process is gone, so no nudge was ever involved: say what is known.
            (Stall::Unfinished, Some(note)) => format!(
                "**{who}** stopped before it finished.\n\n{note}\n\nWhat should happen to it?"
            ),
            (Stall::Unfinished, None) => format!(
                "**{who}** ended its turn without finishing, and a nudge did not get it to.\n\nWhat should happen to it?"
            ),
            (Stall::Stuck, _) => format!(
                "**{who}** has written nothing for a while and is not waiting on a question or a background job.\n\nWhat should happen to it?"
            ),
        }
    }

}

/// How the card names the sub. Its title is the best label the registry has;
/// the real task line arrives with the spawn brief (a later step).
fn label(state: &DaemonState, sub_id: &str) -> String {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "A sub".to_string())
}

/// Raises the stalled-sub card in the main chat's window unless this sub
/// already has one open for the same cause. Returns the card id when one went up.
pub async fn raise(state: &Arc<DaemonState>, sub_id: &str, stall: Stall) -> Option<String> {
    raise_noted(state, sub_id, stall, None).await
}

/// [`raise`] with a sentence of what is known, for a stall whose cause the
/// daemon saw itself (a process that died, with its last error).
pub async fn raise_noted(state: &Arc<DaemonState>, sub_id: &str, stall: Stall, note: Option<&str>) -> Option<String> {
    let parent = state.registry.get(sub_id)?.subchat_of?;
    if cards::open_card_for(state, stall.card_kind(), sub_id).await.is_some() {
        return None;
    }
    let card = RaisedCard {
        kind: stall.card_kind(),
        display_session_id: parent.clone(),
        sub_id: Some(sub_id.to_string()),
        header: stall.header().to_string(),
        question: stall.question(&label(state, sub_id), note),
        options: vec![
            CardOption::new(OPEN_IT, "Read it where it stopped"),
            CardOption::new(NUDGE_AGAIN, "Remind it how to finish"),
            CardOption::new(END_IT, "Stop it for good"),
        ],
        domain: None,
    };
    let handle = match cards::raise_card(state, card).await {
        Ok(h) => h,
        Err(e) => {
            log::warn!("subchats: could not raise the {stall:?} card for {sub_id}: {e}");
            return None;
        }
    };
    let id = handle.card_id.clone();
    let (state, sub) = (state.clone(), sub_id.to_string());
    handle.on_answer(move |answer| async move { apply_answer(&state, &sub, &parent, answer).await });
    Some(id)
}

/// What each answer to a stalled-sub card does. Nothing here is sent to a model
/// except the daemon's own nudge text.
pub(crate) async fn apply_answer(state: &Arc<DaemonState>, sub_id: &str, parent: &str, answer: CardAnswer) {
    let CardAnswer::Picked(choice) = answer else { return };
    match choice.as_str() {
        OPEN_IT => {
            // Opening a sub in place is the main chat window's job (step 7); this
            // is the seam it listens on.
            state.notifier.publish(
                "subchat_open_requested",
                json!({ "display_session_id": parent, "sub_id": sub_id }),
            );
        }
        NUDGE_AGAIN => {
            if let Err(e) = resume::request_nudge(state, sub_id).await {
                log::warn!("subchats: nudge for {sub_id} failed: {e}");
            }
        }
        END_IT => {
            resume::end_sub(state, sub_id);
        }
        other => log::info!("subchats: ignoring stalled-sub card answer {other:?} for {sub_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state_with_sub(tag: &str) -> (Arc<DaemonState>, String, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main.clone()));
        (st, main, sub)
    }

    #[tokio::test]
    async fn the_card_lands_in_the_main_chat_with_the_three_actions() {
        let (st, main, sub) = state_with_sub("stall-card");
        let id = raise(&st, &sub, Stall::Unfinished).await.expect("raised");
        let listed = st.list_prompts().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], id.as_str());
        assert_eq!(listed[0]["payload"]["display_session_id"], main.as_str());
        assert_eq!(listed[0]["payload"]["sub_id"], sub.as_str());
        assert_eq!(listed[0]["payload"]["card_kind"], "subchat_unfinished");
        let labels: Vec<&str> = listed[0]["payload"]["questions"][0]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, [OPEN_IT, NUDGE_AGAIN, END_IT]);
    }

    #[tokio::test]
    async fn a_sub_never_has_two_open_cards_for_the_same_cause_but_may_for_two() {
        let (st, _main, sub) = state_with_sub("stall-dedupe");
        assert!(raise(&st, &sub, Stall::Stuck).await.is_some());
        assert!(raise(&st, &sub, Stall::Stuck).await.is_none(), "same cause, same sub: one card");
        assert!(raise(&st, &sub, Stall::Unfinished).await.is_some(), "a different cause is its own card");
    }

    #[tokio::test]
    async fn a_chat_that_is_not_a_sub_gets_no_card() {
        let (st, main, _sub) = state_with_sub("stall-plain");
        assert!(raise(&st, &main, Stall::Stuck).await.is_none());
    }

    #[tokio::test]
    async fn end_it_ends_the_sub_and_open_it_publishes_the_seam_event() {
        let (st, main, sub) = state_with_sub("stall-answers");
        let mut rx = st.notifier.subscribe();
        apply_answer(&st, &sub, &main, CardAnswer::Picked(OPEN_IT.into())).await;
        let mut seen = false;
        while let Ok(ev) = rx.try_recv() {
            seen |= ev["method"] == "subchat_open_requested" && ev["params"]["sub_id"] == sub.as_str();
        }
        assert!(seen, "step 7 listens on subchat_open_requested");
        assert!(st.registry.get(&sub).unwrap().ended_at.is_none());

        apply_answer(&st, &sub, &main, CardAnswer::Picked(END_IT.into())).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_some());
    }

    #[tokio::test]
    async fn skip_and_withdrawn_do_nothing() {
        let (st, main, sub) = state_with_sub("stall-skip");
        apply_answer(&st, &sub, &main, CardAnswer::Skipped).await;
        apply_answer(&st, &sub, &main, CardAnswer::Withdrawn).await;
        let row = st.registry.get(&sub).unwrap();
        assert!(row.ended_at.is_none() && !row.subchat_finished);
    }
}
