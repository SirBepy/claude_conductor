//! The long-chat nudge: when an ordinary chat finishes a turn with its context
//! past a band (50, 65, 80 percent of the window), a quiet card says it is a good
//! place to stop and offers a hand-off. Every turn of a chat re-reads its whole
//! history, so a chat left to grow to 80% pays for that on each message.
//!
//! Never forced, never mid-turn: the card shows after a turn ended, and
//! "Hand off now" asks the chat to write its own handoff and call `respawn`
//! (the daemon cannot write one, it has not read the work). The chat is told in
//! the same words `/auto-respawn` uses. A chat that ran `/auto-respawn` already
//! gets a note every turn past its cap, so it is left alone here.
//!
//! One card per band: "Keep going" (or Skip) silences the chat until the next
//! band. The bands a chat was nudged at live in memory only: a daemon restart
//! drops open cards anyway, so one repeat nudge after it is the worst case, and
//! a chat that falls back under the first band (a respawn or compaction shrank
//! it) starts over.

use super::cards::{raise_quiet_card, CardAnswer, CardOption, RaisedCard};
use crate::daemon::state::DaemonState;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// Percent of the window at which a chat is nudged, lowest first. 50 is Joe's pick
/// (2026-11-13); the later two stop a chat that kept going from drifting to 80
/// unremarked.
pub const BANDS: [u8; 3] = [50, 65, 80];

/// Let the result line's bookkeeping finish and a queued message start a new
/// turn before looking at whether the chat is idle.
const SETTLE: Duration = Duration::from_secs(6);

pub const CARD_KIND: &str = "context_nudge";
const HAND_OFF: &str = "Hand off now";
const KEEP_GOING: &str = "Keep going";

/// The highest band each chat was already nudged at.
static NUDGED: LazyLock<Mutex<HashMap<String, u8>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The highest band `pct` has reached, if any.
fn band_for(pct: u8) -> Option<u8> {
    BANDS.iter().rev().copied().find(|b| pct >= *b)
}

/// The band to nudge at now: the chat is in a band above the last one it was
/// nudged at.
pub fn due(pct: u8, last: Option<u8>) -> Option<u8> {
    let band = band_for(pct)?;
    last.is_none_or(|l| band > l).then_some(band)
}

/// Whether a chat's row may be nudged: an ordinary interactive chat (a main chat
/// included), idle and still open. A sub has its own context card, and Jarvis and
/// its workers are not chats Joe reads.
fn eligible(i: &crate::types::Instance) -> bool {
    matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive)
        && !super::is_sub(i)
        && !i.jarvis
        && i.worker_of.is_none()
        && i.ended_at.is_none()
        && !i.frozen
        && !i.closing
        && !i.busy
}

fn question(pct: u8) -> String {
    format!(
        "This chat is at {pct}% of its context window, and every turn re-reads all of it. The work just paused, so this is a good place to stop: a fresh chat reads far less on each message. Hand it off now?"
    )
}

/// What the chat is told when Joe picks the hand-off.
fn hand_off_note(pct: u8) -> String {
    format!(
        "Joe chose to hand this chat off now (its context is at {pct}%). Start no new work. Read ~/.claude/skills/respawn/SKILL.md, follow its Unattended mode with the Same-work prompt, and call `respawn` with a complete handoff prompt so the successor carries on with this job."
    )
}

/// The turn-end hook, called beside `compaction::after_turn`. Detached: the pump
/// must not await a card.
pub fn after_turn(state: &Arc<DaemonState>, session_id: &str) {
    if !state.registry.get(session_id).is_some_and(|i| eligible_ignoring_busy(&i)) {
        return;
    }
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        check(&state, &session_id).await;
    });
}

/// [`eligible`] without the idle test: the pump calls it at the instant a turn
/// ends, before `busy` is certain to have cleared.
fn eligible_ignoring_busy(i: &crate::types::Instance) -> bool {
    let mut idle = i.clone();
    idle.busy = false;
    eligible(&idle)
}

async fn check(state: &Arc<DaemonState>, session_id: &str) {
    let Some(inst) = state.registry.get(session_id) else { return };
    if !eligible(&inst) || state.sessions.get(session_id).is_none() {
        return;
    }
    let Some(view) = crate::daemon::hooks_server::context_cap::view(state, session_id) else { return };
    if view.opted {
        return;
    }
    let Some(pct) = view.pct_used() else { return };
    let last = {
        let mut seen = NUDGED.lock().unwrap();
        if pct < BANDS[0] {
            seen.remove(session_id);
            return;
        }
        seen.get(session_id).copied()
    };
    let Some(band) = due(pct, last) else { return };
    if card_open(state, session_id).await {
        return;
    }
    // Recorded before the card exists, so the next turn's check cannot raise a
    // second one while this one is on its way.
    NUDGED.lock().unwrap().insert(session_id.to_string(), band);
    let card = RaisedCard {
        kind: CARD_KIND,
        display_session_id: session_id.to_string(),
        sub_id: None,
        header: "Long chat".to_string(),
        question: question(pct),
        options: vec![
            CardOption::new(HAND_OFF, "The chat writes a handoff and respawns into a fresh chat."),
            CardOption::new(KEEP_GOING, "Carry on here. Asked again at the next band."),
        ],
        domain: Some("tooling"),
    };
    match raise_quiet_card(state, card).await {
        Ok(handle) => {
            let (state, id) = (state.clone(), session_id.to_string());
            handle.on_answer(move |answer| async move {
                if answer == CardAnswer::Picked(HAND_OFF.to_string()) {
                    crate::daemon::repo_channel_wake::enqueue_notice(&state, &id, hand_off_note(pct));
                    crate::daemon::repo_channel_wake::spawn_drain(&state, &id);
                }
            });
        }
        Err(e) => log::debug!("context nudge: {session_id}: {e}"),
    }
}

/// Whether a nudge for `session_id` is still unanswered.
async fn card_open(state: &Arc<DaemonState>, session_id: &str) -> bool {
    state.list_prompts().await.iter().any(|p| {
        p["payload"]["card_kind"].as_str() == Some(CARD_KIND)
            && p["payload"]["session_id"].as_str() == Some(session_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_below_the_first_band_is_never_nudged() {
        assert_eq!(due(49, None), None);
        assert_eq!(due(0, None), None);
    }

    #[test]
    fn the_first_band_nudges_once_and_a_higher_band_nudges_again() {
        assert_eq!(due(50, None), Some(50));
        assert_eq!(due(63, Some(50)), None, "same band: already asked");
        assert_eq!(due(65, Some(50)), Some(65));
        assert_eq!(due(100, Some(65)), Some(80));
        assert_eq!(due(90, Some(80)), None);
    }

    #[test]
    fn a_jump_past_several_bands_nudges_at_the_highest() {
        assert_eq!(due(82, None), Some(80));
    }

    #[test]
    fn the_hand_off_note_names_the_level_and_the_respawn_tool() {
        let note = hand_off_note(53);
        assert!(note.contains("53%") && note.contains("`respawn`") && note.contains("respawn/SKILL.md"), "{note}");
        assert!(question(53).contains("53%"));
    }

    fn row(id: &str) -> crate::types::Instance {
        let st = crate::daemon::state::DaemonState::new(
            crate::daemon::session::new_session_map(),
            crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
        );
        st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-13T00:00:00Z");
        st.registry.get(id).unwrap()
    }

    #[test]
    fn only_an_idle_ordinary_chat_is_eligible() {
        let ok = row("plain");
        assert!(eligible(&ok));
        let mut busy = ok.clone();
        busy.busy = true;
        assert!(!eligible(&busy));
        assert!(eligible_ignoring_busy(&busy), "the pump calls it before busy is certain to have cleared");
        let mut jarvis = ok.clone();
        jarvis.jarvis = true;
        assert!(!eligible(&jarvis));
        let mut sub = ok.clone();
        sub.subchat_of = Some("main".into());
        assert!(!eligible(&sub), "a sub has its own context card");
        let mut ended = ok;
        ended.ended_at = Some("2026-11-13T00:00:00Z".into());
        assert!(!eligible(&ended));
    }
}
