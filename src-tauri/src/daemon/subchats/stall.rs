//! The card Joe gets when a sub stalls, and what each of its answers does.
//! Two causes share it: a sub that ended turns without finishing even after the
//! Stop hook's block and the daemon's nudge (`Unfinished`), and a sub that has
//! written nothing for [`super::stuck::STUCK_AFTER`] (`Stuck`). Each sub has at
//! most one open card per cause. When Joe's own "Nudge again" fails too, the
//! card he gets says so ([`raise_nudge_failed`]) rather than asking again.

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

/// Said on the card for a sub whose MCP transport is down. It cannot call
/// `finish_subchat` or ask a question, which is why it ended its turn silent, and
/// a nudge asks for what it cannot do.
pub const NO_TRANSPORT_NOTE: &str =
    "Its link to the daemon's tools is down, so it cannot call finish_subchat or ask you anything. Nudging it will not help.";

/// What the daemon itself knows is in the sub's way, said on every stall card.
fn known_blocker(state: &DaemonState, sub_id: &str) -> Option<String> {
    super::writers::waiting_behind(state, sub_id)
        .map(|holder| format!("It is waiting for the edit slot, which \"{holder}\" holds; it is woken when the slot is free."))
}

/// How much of the transcript's end is read for the sub's last words.
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_WORDS_CHARS: usize = 300;

/// The sub's own last text, which is the best account of why it stopped when
/// nothing the daemon tracks explains it.
fn last_words_in(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let words = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find_map(|v| crate::tokens::assistant_text(&v))?;
    let flat = words.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut clipped: String = flat.chars().take(MAX_WORDS_CHARS).collect();
    if flat.chars().count() > MAX_WORDS_CHARS {
        clipped.push_str("...");
    }
    (!clipped.is_empty()).then_some(clipped)
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
    raise_with(state, sub_id, stall, note, false).await
}

/// [`raise_noted`] as a quiet card (see `cards::raise_quiet_card`): for a stall
/// Joe was already told about, asked again only because a restart lost the card.
pub async fn raise_noted_quietly(state: &Arc<DaemonState>, sub_id: &str, stall: Stall, note: Option<&str>) -> Option<String> {
    raise_with(state, sub_id, stall, note, true).await
}

async fn raise_with(state: &Arc<DaemonState>, sub_id: &str, stall: Stall, note: Option<&str>, quiet: bool) -> Option<String> {
    let mut question = stall.question(&label(state, sub_id), note);
    if let Some(blocker) = known_blocker(state, sub_id) {
        question = question.replacen("\n\nWhat should happen to it?", &format!("\n\n{blocker}\n\nWhat should happen to it?"), 1);
    }
    let options = vec![
        CardOption::new(OPEN_IT, "Read it where it stopped"),
        CardOption::new(NUDGE_AGAIN, "Remind it how to finish"),
        CardOption::new(END_IT, "Stop it for good"),
    ];
    put_up(state, sub_id, stall, stall.header(), question, options, quiet).await
}

/// The card for a sub that ended its turn unfinished again right after Joe's own
/// "Nudge again". Asking him the same question would only repeat a nudge that
/// already failed twice, so it says what is known instead: a blocker the daemon
/// tracks, the transport note, and the sub's own last words. No nudge option.
pub async fn raise_nudge_failed(state: &Arc<DaemonState>, sub_id: &str, note: Option<&str>) -> Option<String> {
    let who = label(state, sub_id);
    let words = crate::context_status::resolve_transcript(&state.registry, sub_id).and_then(|p| last_words_in(&p));
    let mut known: Vec<String> = Vec::new();
    known.extend(known_blocker(state, sub_id));
    known.extend(note.map(str::to_string));
    known.extend(words.map(|w| format!("Its last words: \"{w}\"")));
    if known.is_empty() {
        known.push("It said nothing about why.".to_string());
    }
    let question = format!(
        "**{who}** still ended its turn without finishing after your nudge, so another nudge did not help and will not.\n\n{}\n\nWhat should happen to it?",
        known.join("\n\n")
    );
    let options = vec![
        CardOption::new(OPEN_IT, "Read it and reply to it yourself"),
        CardOption::new(END_IT, "Stop it for good"),
    ];
    put_up(state, sub_id, Stall::Unfinished, "Nudge did not help", question, options, false).await
}

/// Takes down this sub's open card for `stall`, if one is up. For a sub found to
/// be waiting on something the daemon tracks: the card is about a stall that is
/// not one.
pub async fn withdraw(state: &Arc<DaemonState>, sub_id: &str, stall: Stall) {
    if let Some(id) = cards::open_card_for(state, stall.card_kind(), sub_id).await {
        cards::withdraw_card(state, &id).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn put_up(
    state: &Arc<DaemonState>,
    sub_id: &str,
    stall: Stall,
    header: &str,
    question: String,
    options: Vec<CardOption>,
    quiet: bool,
) -> Option<String> {
    let parent = state.registry.get(sub_id)?.subchat_of?;
    if cards::open_card_for(state, stall.card_kind(), sub_id).await.is_some() {
        return None;
    }
    let card = RaisedCard {
        kind: stall.card_kind(),
        display_session_id: parent.clone(),
        sub_id: Some(sub_id.to_string()),
        header: header.to_string(),
        question,
        options,
        domain: None,
    };
    let raised = if quiet { cards::raise_quiet_card(state, card).await } else { cards::raise_card(state, card).await };
    let handle = match raised {
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

/// Splits a picked option from the note Joe typed beside it. The card sends both
/// in one string, `<label> (note: <text>)` (`withOptionNote` in the webview).
fn split_note(choice: &str) -> (&str, Option<&str>) {
    const MARK: &str = " (note: ";
    if let Some(inner) = choice.strip_suffix(')') {
        if let Some(at) = inner.find(MARK) {
            let note = inner[at + MARK.len()..].trim();
            return (&inner[..at], (!note.is_empty()).then_some(note));
        }
    }
    (choice, None)
}

/// What each answer to a stalled-sub card does. Nothing is sent to a model but
/// the daemon's own nudge text and Joe's own note on "Nudge again".
pub(crate) async fn apply_answer(state: &Arc<DaemonState>, sub_id: &str, parent: &str, answer: CardAnswer) {
    let CardAnswer::Picked(picked) = answer else { return };
    let (choice, note) = split_note(&picked);
    // The window to open belongs to the sub's parent now, which is not the one
    // that raised the card when a `respawn` moved the sub since.
    let live_parent = state.registry.get(sub_id).and_then(|i| i.subchat_of).unwrap_or_else(|| parent.to_string());
    let parent = live_parent.as_str();
    match choice {
        OPEN_IT => {
            // Opening a sub in place is the main chat window's job (step 7); this
            // is the seam it listens on.
            state.notifier.publish(
                "subchat_open_requested",
                json!({ "display_session_id": parent, "sub_id": sub_id }),
            );
        }
        NUDGE_AGAIN => {
            // A queued writer is started or woken when the slot is its own; a nudge
            // now opens a turn whose every edit is refused. Joe's note still goes.
            if note.is_none() {
                if let Some(holder) = super::writers::waiting_behind(state, sub_id) {
                    log::info!("subchats: {sub_id} is queued for the writer slot behind {holder:?}, not nudged");
                    return;
                }
            }
            // A sub that never started has no conversation to resume; it is
            // started from its brief instead.
            if super::held::start_never_started(state, sub_id).await {
                return;
            }
            if let Err(e) = resume::request_nudge(state, sub_id, note).await {
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

    /// 2026-11-11: Joe typed a note beside "Nudge again" twice ("tell it now it
    /// can continue") and both picks were logged as unknown answers and dropped.
    #[test]
    fn a_pick_with_a_note_is_read_as_its_option() {
        assert_eq!(split_note("Nudge again (note: go on, the gate is gone)"), (NUDGE_AGAIN, Some("go on, the gate is gone")));
        assert_eq!(split_note("Nudge again"), (NUDGE_AGAIN, None));
        assert_eq!(split_note("End it (note:  )"), (END_IT, None));
        assert_eq!(split_note("Open it (note: a (nested) aside)"), (OPEN_IT, Some("a (nested) aside")));
    }

    #[tokio::test]
    async fn a_pick_with_a_note_is_acted_on_instead_of_ignored() {
        let (st, main, sub) = state_with_sub("stall-noted");
        apply_answer(&st, &sub, &main, CardAnswer::Picked("End it (note: it is done, leave it)".into())).await;
        assert!(st.registry.get(&sub).unwrap().ended_at.is_some(), "the noted pick reached its option");
    }

    #[tokio::test]
    async fn a_plain_nudge_again_leaves_a_writer_queued_for_the_slot_alone() {
        use super::super::runtime::{runtime, SubStage};
        let (st, main, sub) = state_with_sub("stall-queued");
        let key = std::path::PathBuf::from("/tmp/cc-test-stall-queued");
        super::super::writers::queue_behind_for_test(&key, "stall-queued-holder", &sub);
        apply_answer(&st, &sub, &main, CardAnswer::Picked(NUDGE_AGAIN.into())).await;
        assert_eq!(runtime().stage(&sub), SubStage::Fresh, "not nudged: the slot wakes it");
        assert!(st.list_prompts().await.is_empty(), "and not started from its brief either");
        super::super::writers::forget_project_for_test(&key);
    }

    #[tokio::test]
    async fn a_stall_card_names_the_writer_slot_holder_when_the_sub_is_queued() {
        let (st, _main, sub) = state_with_sub("stall-names");
        let key = std::path::PathBuf::from("/tmp/cc-test-stall-names");
        super::super::writers::queue_behind_for_test(&key, "stall-names-holder", &sub);
        st.registry.upsert_interactive("stall-names-holder", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_name("stall-names-holder", "waiting-on-grouping".to_string());
        st.registry.set_subchat_of("stall-names-holder", Some("stall-names-main".to_string()));
        raise(&st, &sub, Stall::Stuck).await.expect("raised");
        let q = st.list_prompts().await[0]["payload"]["questions"][0]["question"].as_str().unwrap().to_string();
        assert!(q.contains("edit slot") && q.contains("waiting-on-grouping"), "{q}");
        super::super::writers::forget_project_for_test(&key);
    }

    #[test]
    fn the_last_words_are_the_newest_assistant_text_flattened_and_clipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let line = |role: &str, text: &str| {
            serde_json::json!({"type": role, "message": {"role": role, "content": [{"type": "text", "text": text}]}}).to_string()
        };
        let body = [
            line("assistant", "older words"),
            line("assistant", "Still queued behind
Gate 2."),
            line("user", "a later user line"),
        ]
        .join("
");
        std::fs::write(&path, body).unwrap();
        assert_eq!(last_words_in(&path).as_deref(), Some("Still queued behind Gate 2."));
        std::fs::write(&path, line("assistant", &"x".repeat(1000))).unwrap();
        assert!(last_words_in(&path).unwrap().chars().count() <= MAX_WORDS_CHARS + 3);
        assert_eq!(last_words_in(&dir.path().join("missing.jsonl")), None);
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
