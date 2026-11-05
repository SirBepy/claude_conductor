//! What happens to a main chat's subs when the main chat ends: the approval a
//! chat with running subs needs before it closes, a `respawn` handing the whole
//! family to its successor, and the orphans a chat that died without asking
//! leaves behind (spec section 9).
//!
//! Every way a chat closes goes through [`request_close`] first: the menu and
//! the phone (`end_session` and `mark_session_ended`, which `clear_session`
//! calls), the `close_session` tool that `/close` and a wrap-up end on, and the
//! backstop at [`crate::daemon::pump::close::finalize_close`]. A closing chat
//! with running subs is held, and Joe is asked on a card. Finished subs never
//! hold it. A card is never answered by a timeout: only Joe's pick, or a chat
//! that is already gone, settles it.

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use super::spawn::running_subs;
use crate::daemon::lifecycle;
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// `card_kind` of the approval card.
pub const KIND: &str = "subchat_close";
pub const WAIT_FOR_THEM: &str = "Wait for them";
pub const CLOSE_THEM_TOO: &str = "Close them too";
pub const KEEP_IT_OPEN: &str = "Keep it open";

/// What a held close says to whoever asked (the `close_session` tool result, so
/// the model does not tell Joe the chat closed).
pub const HELD_NOTE: &str = "This chat still has running subs, so it is not closing yet. Joe has been asked on a card whether to wait for them, close them too, or keep this chat open. End your turn now and do not call close_session again.";

#[derive(Default)]
struct Entry {
    /// The approval card is on screen.
    asking: bool,
    /// Joe chose "Wait for them": the chat closes when its last running sub ends.
    waiting: bool,
}

static CLOSES: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

fn with_entry<R>(parent: &str, f: impl FnOnce(&mut Entry) -> R) -> R {
    let mut guard = CLOSES.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new).entry(parent.to_string()).or_default())
}

fn forget(parent: &str) {
    if let Some(map) = CLOSES.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        map.remove(parent);
    }
}

/// Whether `parent` is waiting for its last running sub before it closes. The
/// pump reads it so a turn that ends meanwhile does not stand the `closing` row
/// state down.
pub fn is_waiting(parent: &str) -> bool {
    CLOSES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|m| m.get(parent))
        .is_some_and(|e| e.waiting)
}

/// The live row that took over from `predecessor` by `respawn`, if any. The
/// registry link is read first; `chat_config`'s durable twin covers a restart,
/// which drops the ended predecessor from the snapshot before its subs are moved.
pub fn live_successor(state: &DaemonState, predecessor: &str) -> Option<String> {
    let live = |i: &Instance| i.ended_at.is_none() && i.end_reason.is_none();
    let rows = state.registry.list();
    rows.iter()
        .find(|i| live(i) && i.successor_of.as_deref() == Some(predecessor))
        .or_else(|| {
            rows.iter()
                .find(|i| live(i) && crate::sessions::chat_config::predecessor_of(&i.session_id).as_deref() == Some(predecessor))
        })
        .map(|i| i.session_id.clone())
}

/// Whether closing `parent` needs Joe's approval: it is a live main chat with a
/// running sub and is not a `respawn` predecessor, whose subs move instead.
pub fn needs_approval(state: &DaemonState, parent: &str) -> bool {
    let Some(inst) = state.registry.get(parent) else { return false };
    if inst.ended_at.is_some() || super::is_sub(&inst) {
        return false;
    }
    if running_subs(&state.registry, parent).is_empty() {
        return false;
    }
    live_successor(state, parent).is_none()
}

/// Asks to close `parent`. Returns true when the close is held: a card is up (or
/// being raised) and the caller must not close. False means go ahead. A second
/// request while the card is up is held without a second card; one made while
/// "Wait for them" is pending asks again, so Joe can change his mind.
pub fn request_close(state: &Arc<DaemonState>, parent: &str) -> bool {
    if !needs_approval(state, parent) {
        return false;
    }
    let first = with_entry(parent, |e| {
        let first = !e.asking;
        e.asking = true;
        e.waiting = false;
        first
    });
    if first {
        // Detached: the callers include the pump's sync close path.
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                let (state, parent) = (state.clone(), parent.to_string());
                handle.spawn(async move { raise(&state, &parent).await });
            }
            Err(_) => with_entry(parent, |e| e.asking = false),
        }
    }
    true
}

fn names(subs: &[Instance]) -> String {
    subs.iter().map(|s| format!("**{}**", super::spawn::label(s))).collect::<Vec<_>>().join(", ")
}

/// Puts the approval card in `parent`'s window and waits for Joe's pick on a
/// detached task.
pub(crate) async fn raise(state: &Arc<DaemonState>, parent: &str) {
    let running = running_subs(&state.registry, parent);
    let n = running.len();
    let card = RaisedCard {
        kind: KIND,
        display_session_id: parent.to_string(),
        sub_id: None,
        header: "Close with subs running".to_string(),
        question: format!(
            "Closing this chat has {n} sub{} still running: {}.\n\nWhat should happen to {} first?",
            if n == 1 { "" } else { "s" },
            names(&running),
            if n == 1 { "it" } else { "them" },
        ),
        options: vec![
            CardOption::new(WAIT_FOR_THEM, "Close this chat when the last one finishes"),
            CardOption::new(CLOSE_THEM_TOO, "End them now, then close"),
            CardOption::new(KEEP_IT_OPEN, "Do not close"),
        ],
        domain: None,
    };
    match cards::raise_card(state, card).await {
        Ok(handle) => {
            let (state, parent) = (state.clone(), parent.to_string());
            handle.on_answer(move |answer| async move { apply_answer(&state, &parent, answer).await });
        }
        Err(e) => {
            log::warn!("subchats: could not raise the close card for {parent}: {e}");
            forget(parent);
        }
    }
}

/// What each pick does. A Skip, a card that was withdrawn and anything unknown
/// all keep the chat open: nothing is closed that Joe did not choose.
pub(crate) async fn apply_answer(state: &Arc<DaemonState>, parent: &str, answer: CardAnswer) {
    match answer {
        CardAnswer::Picked(pick) if pick == WAIT_FOR_THEM => wait(state, parent).await,
        CardAnswer::Picked(pick) if pick == CLOSE_THEM_TOO => close_them_too(state, parent).await,
        _ => keep_open(state, parent),
    }
}

async fn wait(state: &Arc<DaemonState>, parent: &str) {
    with_entry(parent, |e| {
        e.asking = false;
        e.waiting = true;
    });
    // The row reads Closing, as it does for any close in progress.
    if state.registry.set_closing(parent, true) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    complete_if_settled(state, parent).await;
}

async fn close_them_too(state: &Arc<DaemonState>, parent: &str) {
    for sub in running_subs(&state.registry, parent) {
        super::end_sub(state, &sub.session_id);
    }
    complete(state, parent).await;
}

fn keep_open(state: &Arc<DaemonState>, parent: &str) {
    forget(parent);
    if state.registry.set_closing(parent, false) {
        crate::daemon::machines::publish_instances_changed(state);
    }
}

/// Closes `parent` if it is waiting and no sub is running any more.
async fn complete_if_settled(state: &Arc<DaemonState>, parent: &str) {
    if is_waiting(parent) && running_subs(&state.registry, parent).is_empty() {
        complete(state, parent).await;
    }
}

/// A sub of `sub_id`'s main chat just finished, ended or left it. If the chat is
/// waiting on its last one, the chat closes now. Sync, because it is called from
/// the pump's result handler.
pub fn on_sub_settled(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of) else { return };
    if !is_waiting(&parent) || !running_subs(&state.registry, &parent).is_empty() {
        return;
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let state = state.clone();
        handle.spawn(async move { complete_if_settled(&state, &parent).await });
    }
}

/// The close itself, the same teardown the menu's Close performs: stop the
/// child, mark the row ended, then settle the family.
pub(crate) async fn complete(state: &Arc<DaemonState>, parent: &str) {
    forget(parent);
    // NotFound just means no child is running.
    let _ = lifecycle::end_session(&state.sessions, parent).await;
    let now = chrono::Utc::now().to_rfc3339();
    state.registry.mark_ended(parent, crate::types::EndReason::Manual, &now);
    state.registry.set_closing(parent, false);
    crate::ask::store::drop_for_chat(parent);
    settle_family(state, parent).await;
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// A sub left its main chat (moved to the sidebar, by Joe or because the chat is
/// gone). If the chat is waiting on its last running sub, it closes now. Called
/// from `reply::move_to_sidebar` with the parent the sub had before the move.
pub fn after_leaving(state: &Arc<DaemonState>, parent: &str) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let (state, parent) = (state.clone(), parent.to_string());
        // Detached: this is reached from `settle_family`, which `complete` awaits.
        handle.spawn(async move { complete_if_settled(&state, &parent).await });
    }
}

/// Settles every sub of `parent`, which is closing or gone. Re-runnable, so the
/// heal on a tick and at boot finishes whatever a crash cut short.
///
/// A `respawn` predecessor hands everything to its successor. Otherwise a
/// finished sub is closed with its parent (its record stays on disk; it was
/// frozen and only waiting to be continued, and there is no window left to
/// continue it from), and a running sub is moved to the sidebar (`reply::move_to_sidebar`), since
/// closing it would throw away work in flight.
pub async fn settle_family(state: &Arc<DaemonState>, parent: &str) {
    if let Some(successor) = live_successor(state, parent) {
        move_family(state, parent, &successor).await;
        return;
    }
    let subs: Vec<Instance> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent) && i.ended_at.is_none())
        .collect();
    for sub in subs {
        if sub.subchat_finished {
            super::end_sub(state, &sub.session_id);
        } else if super::held::is_held(&sub.session_id) {
            // Queued behind another sub and never run: promoting it would leave an
            // empty chat that cannot resume, so it is dropped with its parent.
            super::held::drop_held(state, &sub.session_id);
        } else if let Err(e) = super::move_to_sidebar(state, &sub.session_id).await {
            log::warn!("subchats: could not move {} to the sidebar: {e}", sub.session_id);
        }
    }
    cards::drop_daemon_cards_shown_in(state, parent).await;
}

/// Hands `old`'s subs, cards, one-line-back queue and decisions log to `new`.
///
/// Order, for a crash half way: first the subs (a sub left pointing at the
/// predecessor is lost, so that goes first and each step is its own write), then
/// the files, each of which merges instead of overwriting so a second run
/// completes the move. The caller closes the predecessor last, and
/// [`settle_family`] re-runs this for a predecessor that ended with subs still on
/// it.
pub async fn move_family(state: &Arc<DaemonState>, old: &str, new: &str) {
    if old == new {
        return;
    }
    let subs: Vec<Instance> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(old))
        .collect();
    for sub in &subs {
        state.registry.set_subchat_of(&sub.session_id, Some(new.to_string()));
        if let Some(mut brief) = crate::sessions::chat_config::get(&sub.session_id).and_then(|c| c.subchat) {
            brief.parent = new.to_string();
            crate::sessions::chat_config::set_subchat(&sub.session_id, Some(brief));
        }
    }
    super::decisions::move_log(old, new);
    super::card_log::move_log(old, new);
    // The one line back and its per-sub marks, then what else is keyed by the old
    // chat in memory: a `report_back` wake the predecessor would never drain, and
    // the message of Joe's it had on hand.
    super::back::move_queue(old, new);
    if crate::daemon::repo_channel_wake::move_notices(state, old, new) > 0 {
        crate::daemon::repo_channel_wake::spawn_drain(state, new);
    }
    super::joe_message::forget(old);
    cards::retarget_daemon_cards(state, old, new).await;
    if !subs.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
        crate::sessions::persistence::save_snapshot_default(&state.registry);
    }
}

/// Carries a `respawn` caller's subchats mode and family to its successor. Called
/// from the spawn path before the successor's first message is sent, so that
/// message tells it the mode is on (the mid-chat toggle note) and it stays a main
/// chat. The caller then closes at turn end; that close bypasses the approval
/// because [`live_successor`] finds the successor.
pub async fn carry_to_successor(state: &Arc<DaemonState>, predecessor: &str, successor: &str) {
    if crate::sessions::chat_config::get(predecessor).is_some_and(|c| c.subchats_on) {
        crate::sessions::chat_config::set_subchats_on(successor, true);
        // Every client keeps the set of mode-on chats in memory and lists the
        // successor under Main chats only from it; the registry row it is shown
        // from says nothing about the mode.
        super::publish_mode_changed(state);
    }
    move_family(state, predecessor, successor).await;
}

/// Heals every sub whose main chat is gone or ended: the chat crashed, got a
/// SessionEnd, was closed by a path that never asked, or ended while the daemon
/// was down (an ended row is not in the snapshot, so its subs come back pointing
/// at nothing). Runs once at boot and on the 60 second tick. Returns the parents
/// settled.
pub async fn heal_orphans(state: &Arc<DaemonState>) -> Vec<String> {
    let mut gone: Vec<String> = Vec::new();
    for sub in state.registry.list() {
        let Some(parent) = sub.subchat_of.clone() else { continue };
        if sub.ended_at.is_some() || gone.contains(&parent) {
            continue;
        }
        let alive = state.registry.get(&parent).is_some_and(|p| p.ended_at.is_none());
        if !alive {
            gone.push(parent);
        }
    }
    for parent in &gone {
        log::warn!("subchats: main chat {parent} is gone, settling its subs");
        settle_family(state, parent).await;
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::methods::permission::respond_question_inner;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::TempDataDir;
    use crate::types::Settings;
    use serde_json::json;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A main chat plus subs named by `(suffix, finished)`.
    fn family(st: &DaemonState, tag: &str, subs: &[(&str, bool)]) -> (String, Vec<String>) {
        let main = format!("{tag}-main");
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let ids = subs
            .iter()
            .map(|(n, finished)| {
                let id = format!("{tag}-{n}");
                st.registry.upsert_interactive(&id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
                st.registry.set_subchat_of(&id, Some(main.clone()));
                st.registry.set_name(&id, (*n).to_string());
                st.registry.set_subchat_finished(&id, *finished);
                id
            })
            .collect();
        (main, ids)
    }

    async fn card_id(st: &Arc<DaemonState>, kind: &str) -> Option<String> {
        for _ in 0..200 {
            let found = st
                .list_prompts()
                .await
                .into_iter()
                .find(|p| p["payload"]["card_kind"].as_str() == Some(kind))
                .and_then(|p| p["id"].as_str().map(str::to_string));
            if found.is_some() {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        None
    }

    async fn answer(st: &Arc<DaemonState>, id: &str, pick: &str) {
        let mut answers = serde_json::Map::new();
        answers.insert(
            st.list_prompts().await.iter().find(|p| p["id"].as_str() == Some(id)).unwrap()["payload"]["questions"][0]["question"]
                .as_str()
                .unwrap()
                .to_string(),
            json!(pick),
        );
        respond_question_inner(st, id, serde_json::Value::Object(answers), false).await;
    }

    async fn until(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..300 {
            if done() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }

    #[tokio::test]
    async fn a_close_with_a_running_sub_is_held_and_raises_the_three_way_card() {
        let st = state();
        let (main, _) = family(&st, "cl-held", &[("header", false)]);
        assert!(request_close(&st, &main), "held");
        let id = card_id(&st, KIND).await.expect("the approval card is raised");
        let p = st.list_prompts().await.into_iter().find(|p| p["id"] == id.as_str()).unwrap();
        assert_eq!(p["payload"]["display_session_id"], main.as_str());
        let labels: Vec<&str> =
            p["payload"]["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, [WAIT_FOR_THEM, CLOSE_THEM_TOO, KEEP_IT_OPEN]);
        assert!(p["payload"]["questions"][0]["question"].as_str().unwrap().contains("**header**"));
        assert!(st.registry.get(&main).unwrap().ended_at.is_none(), "the chat is still open");
        // A second click while the card is up asks nothing new.
        assert!(request_close(&st, &main));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(st.list_prompts().await.iter().filter(|p| p["payload"]["card_kind"] == KIND).count(), 1);
    }

    #[tokio::test]
    async fn only_finished_subs_do_not_hold_a_close() {
        let st = state();
        let (main, _) = family(&st, "cl-fin", &[("a", true), ("b", true)]);
        assert!(!request_close(&st, &main));
        assert!(!needs_approval(&st, &main));
        let (plain, _) = family(&st, "cl-plain", &[]);
        assert!(!request_close(&st, &plain), "a chat with no subs closes as it always did");
        assert!(st.list_prompts().await.is_empty());
    }

    #[tokio::test]
    async fn an_ended_sub_and_an_ended_chat_hold_nothing() {
        let st = state();
        let (main, subs) = family(&st, "cl-ended", &[("a", false)]);
        st.registry.mark_ended(&subs[0], crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(!needs_approval(&st, &main));
        let (main2, _) = family(&st, "cl-ended2", &[("a", false)]);
        st.registry.mark_ended(&main2, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(!needs_approval(&st, &main2));
        assert!(!needs_approval(&st, "ghost"));
    }

    #[tokio::test]
    async fn keep_it_open_and_skip_leave_the_chat_and_its_subs_alone() {
        for pick in [Some(KEEP_IT_OPEN), None] {
            let st = state();
            let tag = format!("cl-keep-{}", pick.is_some());
            let (main, subs) = family(&st, &tag, &[("a", false)]);
            assert!(request_close(&st, &main));
            let id = card_id(&st, KIND).await.unwrap();
            match pick {
                Some(p) => answer(&st, &id, p).await,
                None => {
                    respond_question_inner(&st, &id, json!({}), true).await;
                }
            }
            assert!(until(|| !with_entry(&main, |e| e.asking)).await, "the request settles");
            assert!(st.registry.get(&main).unwrap().ended_at.is_none());
            assert!(st.registry.get(&subs[0]).unwrap().ended_at.is_none());
            assert!(!st.registry.get(&main).unwrap().closing);
            // Closing again asks again: nothing was remembered as approved.
            assert!(request_close(&st, &main));
        }
    }

    #[tokio::test]
    async fn a_card_nobody_answers_never_closes_the_chat() {
        let st = state();
        let (main, _) = family(&st, "cl-patient", &[("a", false)]);
        assert!(request_close(&st, &main));
        card_id(&st, KIND).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(st.registry.get(&main).unwrap().ended_at.is_none());
        assert_eq!(st.list_prompts().await.len(), 1, "the card stays until it is answered");
    }

    #[tokio::test]
    async fn wait_for_them_shows_closing_and_closes_when_the_last_running_sub_finishes() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-wait", &[("a", false), ("b", false)]);
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, WAIT_FOR_THEM).await;
        assert!(until(|| st.registry.get(&main).unwrap().closing).await, "the row reads Closing");
        assert!(is_waiting(&main));
        assert!(st.registry.get(&main).unwrap().ended_at.is_none());

        st.registry.set_subchat_finished(&subs[0], true);
        on_sub_settled(&st, &subs[0]);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(st.registry.get(&main).unwrap().ended_at.is_none(), "one sub is still running");

        st.registry.set_subchat_finished(&subs[1], true);
        on_sub_settled(&st, &subs[1]);
        assert!(until(|| st.registry.get(&main).unwrap().ended_at.is_some()).await, "the last finish closes it");
        assert!(!is_waiting(&main));
        assert!(!st.registry.get(&main).unwrap().closing);
        // Closing the parent closed the finished subs with it.
        assert!(until(|| subs.iter().all(|s| st.registry.get(s).unwrap().ended_at.is_some())).await);
    }

    /// Joe picked "Wait for them", then the last running sub ends by a path that
    /// never calls into subchats: the SessionEnd hook, the `end_session` handler
    /// and the `mark_session_ended` handler all call `mark_ended` directly. The
    /// parent must still close.
    #[tokio::test]
    async fn a_waiting_parent_closes_when_its_last_sub_ends_by_any_path() {
        let _data = TempDataDir::new();
        for (i, reason) in [
            crate::types::EndReason::HookSessionEnd,
            crate::types::EndReason::Manual,
            crate::types::EndReason::ProcessGone,
        ]
        .into_iter()
        .enumerate()
        {
            let st = state();
            let (main, subs) = family(&st, &format!("cl-any-{i}"), &[("a", false), ("b", false)]);
            assert!(request_close(&st, &main));
            let id = card_id(&st, KIND).await.unwrap();
            answer(&st, &id, WAIT_FOR_THEM).await;
            assert!(until(|| is_waiting(&main)).await);

            st.registry.mark_ended(&subs[0], reason.clone(), "2026-11-05T00:00:00Z");
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            assert!(st.registry.get(&main).unwrap().ended_at.is_none(), "one sub is still running");

            st.registry.mark_ended(&subs[1], reason, "2026-11-05T00:00:00Z");
            assert!(
                until(|| st.registry.get(&main).unwrap().ended_at.is_some()).await,
                "the parent stayed Closing forever after its last sub ended ({i})"
            );
        }
    }

    #[tokio::test]
    async fn a_pending_wait_can_be_asked_again() {
        let st = state();
        let (main, _) = family(&st, "cl-wait2", &[("a", false)]);
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, WAIT_FOR_THEM).await;
        assert!(until(|| is_waiting(&main)).await);
        // Clicking Close again offers the choice again.
        assert!(request_close(&st, &main));
        assert!(card_id(&st, KIND).await.is_some());
        assert!(!is_waiting(&main), "the second ask replaced the wait");
    }

    #[tokio::test]
    async fn close_them_too_ends_the_running_subs_then_closes_with_the_finished_ones() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-all", &[("run", false), ("done", true)]);
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, CLOSE_THEM_TOO).await;
        assert!(until(|| st.registry.get(&main).unwrap().ended_at.is_some()).await);
        for s in &subs {
            assert!(until(|| st.registry.get(s).unwrap().ended_at.is_some()).await, "{s} ended with its parent");
        }
        assert!(st.list_prompts().await.is_empty(), "no card is left behind");
    }

    #[tokio::test]
    async fn closing_a_parent_with_only_finished_subs_ends_them_and_keeps_their_records() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-fin-end", &[("a", true)]);
        let root = crate::settings::paths::data_dir().unwrap();
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        let rec = root.join("subchats").join(format!("{}.finish.json", subs[0]));
        std::fs::write(&rec, "{}").unwrap();
        complete(&st, &main).await;
        assert!(st.registry.get(&main).unwrap().ended_at.is_some());
        assert!(st.registry.get(&subs[0]).unwrap().ended_at.is_some());
        assert!(rec.exists(), "the finish record is kept on disk");
    }

    #[tokio::test]
    async fn a_crash_promotes_running_subs_and_ends_finished_ones() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-crash", &[("run", false), ("done", true)]);
        crate::daemon::subchats::store_sub_brief(&subs[0], &main);
        st.add_prompt("q-run", "question-requested", json!({"session_id": subs[0], "seq": 1}), true).await;
        st.registry.mark_ended(&main, crate::types::EndReason::ProcessGone, "2026-11-05T00:00:00Z");
        assert_eq!(heal_orphans(&st).await, [main.clone()]);
        let run = st.registry.get(&subs[0]).unwrap();
        assert!(run.subchat_of.is_none() && !run.subchat_finished && run.ended_at.is_none(), "now a normal chat");
        assert!(crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.is_none(), "the brief goes too");
        assert!(!crate::sessions::chat_config::sub_session_ids().contains(&subs[0]), "History may list it now");
        assert!(st.registry.get(&subs[1]).unwrap().ended_at.is_some(), "a finished sub closes with its parent");
        let listed = crate::daemon::subchats::display_session_id(&st, &subs[0]);
        assert_eq!(listed, subs[0], "its question now shows on itself");
        assert!(heal_orphans(&st).await.is_empty(), "healed once");
    }

    #[tokio::test]
    async fn a_crash_drops_a_sub_still_queued_behind_another_instead_of_promoting_a_chat_that_never_ran() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-held", &[("run", false), ("queued", false)]);
        crate::daemon::subchats::held::hold(
            &st,
            crate::daemon::subchats::held::Held {
                sub_id: subs[1].clone(),
                reason: "waiting for run".into(),
                after: Some(subs[0].clone()),
                after_name: "run".into(),
                launch: crate::daemon::subchats::held::LaunchSpec {
                    cwd: std::path::PathBuf::from("."),
                    model: "sonnet".into(),
                    effort: "high".into(),
                    account_id: None,
                    first_message: "go".into(),
                },
            },
        )
        .unwrap();
        st.registry.mark_ended(&main, crate::types::EndReason::ProcessGone, "2026-11-05T00:00:00Z");
        heal_orphans(&st).await;
        let queued = st.registry.get(&subs[1]).unwrap();
        assert!(queued.ended_at.is_some(), "dropped: it never ran, so there is nothing to keep");
        assert!(!crate::daemon::subchats::held::is_held(&subs[1]), "and its recipe is gone");
        assert!(st.registry.get(&subs[0]).unwrap().subchat_of.is_none(), "the running sub is promoted as before");
    }

    #[tokio::test]
    async fn a_restart_with_the_parent_row_gone_heals_the_same_way() {
        let _data = TempDataDir::new();
        let st = state();
        // Only the sub is in the registry: an ended parent is not in the snapshot.
        st.registry.upsert_interactive("orphan-sub", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of("orphan-sub", Some("vanished-parent".into()));
        assert_eq!(heal_orphans(&st).await, ["vanished-parent".to_string()]);
        assert!(st.registry.get("orphan-sub").unwrap().subchat_of.is_none());
    }

    #[tokio::test]
    async fn a_healthy_family_is_left_alone_by_the_heal() {
        let st = state();
        let (main, subs) = family(&st, "cl-healthy", &[("a", false)]);
        assert!(heal_orphans(&st).await.is_empty());
        assert_eq!(st.registry.get(&subs[0]).unwrap().subchat_of.as_deref(), Some(main.as_str()));
    }

    #[tokio::test]
    async fn moving_the_last_running_sub_to_the_sidebar_closes_a_waiting_parent() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-promote-wait", &[("a", false)]);
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, WAIT_FOR_THEM).await;
        assert!(until(|| is_waiting(&main)).await);
        crate::daemon::subchats::move_to_sidebar(&st, &subs[0]).await.unwrap();
        assert!(until(|| st.registry.get(&main).unwrap().ended_at.is_some()).await);
        assert!(st.registry.get(&subs[0]).unwrap().ended_at.is_none(), "the moved chat is not closed with it");
    }

    // ---- respawn --------------------------------------------------------------

    fn successor(st: &DaemonState, old: &str, new: &str) {
        st.registry.upsert_interactive(new, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_successor_of(new, old);
    }

    #[tokio::test]
    async fn the_old_parent_of_a_respawn_closes_without_a_card_and_keeps_its_subs() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-resp", &[("run", false), ("done", true)]);
        successor(&st, &main, "cl-resp-next");
        assert!(!needs_approval(&st, &main), "a respawn predecessor needs no approval");
        assert!(!request_close(&st, &main));
        assert!(st.list_prompts().await.is_empty(), "no card is raised for it");
        // The close then settles the family onto the successor.
        complete(&st, &main).await;
        for s in &subs {
            let row = st.registry.get(s).unwrap();
            assert_eq!(row.subchat_of.as_deref(), Some("cl-resp-next"), "{s} moved");
            assert!(row.ended_at.is_none(), "{s} not ended or promoted");
        }
    }

    #[tokio::test]
    async fn respawn_moves_subs_brief_cards_pending_line_log_and_mode() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-move", &[("a", false)]);
        crate::daemon::subchats::store_sub_brief(&subs[0], &main);
        crate::sessions::chat_config::set_subchats_on(&main, true);
        let root = crate::settings::paths::data_dir().unwrap();
        let dir = root.join("subchats");
        std::fs::create_dir_all(&dir).unwrap();
        let entry = |id: &str| {
            serde_json::to_string(&crate::daemon::subchats::card_log::CardEntry {
                id: id.into(),
                ts: 1,
                parent_id: main.clone(),
                kind: "finish".into(),
                ..Default::default()
            })
            .unwrap()
        };
        std::fs::write(dir.join(format!("{main}.cards.jsonl")), format!("{}\n{}\n", entry("c1"), entry("c2"))).unwrap();
        let entry_line = r#"{"t":"entry","sub_id":"s1","round":1,"name":"header","verdict":"Done","summary":"did it","answers":[]}"#;
        let mark_line = r#"{"t":"mark","sub_id":"s1","card_id":4}"#;
        std::fs::write(dir.join(format!("{main}.pending.jsonl")), format!("{entry_line}\n{mark_line}\n")).unwrap();
        // A `report_back` wake the predecessor never got to drain, a peer's line, and Joe's last message.
        crate::daemon::repo_channel_wake::enqueue_notice(&st, &main, "Sub header has finished".to_string());
        crate::daemon::repo_channel_wake::enqueue(&st, &main, "peer-1", "peer line".to_string());
        crate::daemon::subchats::joe_message::note_sent(&main, "fix the footer", false, None);
        std::fs::write(crate::daemon::subchats::decisions::log_path(&main), "# decisions\n").unwrap();
        successor(&st, &main, "cl-move-next");
        let mut rx = st.notifier.subscribe();

        carry_to_successor(&st, &main, "cl-move-next").await;

        // First real run: the successor had the mode in chat-config, and the sidebar still
        // listed it under Input Needed until a reload, because clients are never told.
        let mut told = false;
        while let Ok(frame) = rx.try_recv() {
            told |= frame["method"] == "subchats_on_changed";
        }
        assert!(told, "clients re-read the set of mode-on chats when a successor takes the mode");
        assert_eq!(st.registry.get(&subs[0]).unwrap().subchat_of.as_deref(), Some("cl-move-next"));
        assert_eq!(
            crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.unwrap().parent,
            "cl-move-next",
            "the stored brief follows"
        );
        let cards = crate::daemon::subchats::card_log::read("cl-move-next");
        assert_eq!(cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["c1", "c2"]);
        assert!(cards.iter().all(|c| c.parent_id == "cl-move-next"), "each entry's parent_id is rewritten");
        assert!(crate::daemon::subchats::card_log::read(&main).is_empty());
        let served = crate::daemon::subchats::back::peek_in(&root, "cl-move-next").expect("the waiting line follows the chat");
        assert!(served.text.contains("header"), "{}", served.text);
        let moved = std::fs::read_to_string(dir.join("cl-move-next.pending.jsonl")).unwrap();
        assert!(moved.contains("\"t\":\"mark\"") && moved.contains("\"card_id\":4"), "the per-sub mark moves too: {moved}");
        assert!(!dir.join(format!("{main}.pending.jsonl")).exists());
        {
            let queues = st.repo_channel_wakes.lock().unwrap();
            let next: Vec<&str> =
                queues.get("cl-move-next").map(|q| q.iter().map(|l| l.text.as_str()).collect()).unwrap_or_default();
            assert_eq!(next, ["Sub header has finished"], "the report_back notice moves");
            assert_eq!(queues.get(&main).map(|q| q.len()), Some(1), "the peer's line stays behind, as on any respawn");
        }
        assert_eq!(crate::daemon::subchats::joe_message::latest(&main), None, "an old turn's message is not carried");
        assert_eq!(crate::daemon::subchats::decisions::read_log("cl-move-next").as_deref(), Some("# decisions\n"));
        assert!(crate::sessions::chat_config::get("cl-move-next").unwrap().subchats_on, "it stays a main chat");
    }

    #[tokio::test]
    async fn a_move_with_no_pending_file_and_a_second_run_are_harmless() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, _subs) = family(&st, "cl-twice", &[("a", false)]);
        successor(&st, &main, "cl-twice-next");
        move_family(&st, &main, "cl-twice-next").await;
        move_family(&st, &main, "cl-twice-next").await;
        assert!(crate::daemon::subchats::card_log::read("cl-twice-next").is_empty());
    }

    #[tokio::test]
    async fn a_move_that_stopped_half_way_finishes_without_doubling_a_card() {
        let _data = TempDataDir::new();
        let root = crate::settings::paths::data_dir().unwrap();
        let dir = root.join("subchats");
        std::fs::create_dir_all(&dir).unwrap();
        let line = |parent: &str, id: &str| {
            serde_json::to_string(&crate::daemon::subchats::card_log::CardEntry {
                id: id.into(),
                parent_id: parent.into(),
                kind: "finish".into(),
                ..Default::default()
            })
            .unwrap()
        };
        std::fs::write(dir.join("hm-old.cards.jsonl"), format!("{}\n{}\n", line("hm-old", "c1"), line("hm-old", "c2"))).unwrap();
        // c1 already reached the destination before the stop.
        std::fs::write(dir.join("hm-new.cards.jsonl"), format!("{}\n", line("hm-new", "c1"))).unwrap();
        crate::daemon::subchats::card_log::move_log("hm-old", "hm-new");
        let ids: Vec<String> = crate::daemon::subchats::card_log::read("hm-new").into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["c1", "c2"]);
        assert!(!dir.join("hm-old.cards.jsonl").exists());
    }

    #[tokio::test]
    async fn an_ended_predecessor_found_by_the_heal_moves_its_subs_instead_of_promoting_them() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-heal-resp", &[("a", false)]);
        successor(&st, &main, "cl-heal-resp-next");
        st.registry.mark_ended(&main, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        heal_orphans(&st).await;
        let row = st.registry.get(&subs[0]).unwrap();
        assert_eq!(row.subchat_of.as_deref(), Some("cl-heal-resp-next"));
        assert!(row.ended_at.is_none());
    }

    #[tokio::test]
    async fn an_open_daemon_card_follows_the_subs_to_the_successor() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-card-move", &[("a", false)]);
        successor(&st, &main, "cl-card-move-next");
        let handle = cards::raise_card(
            &st,
            RaisedCard {
                kind: "subchat_stuck",
                display_session_id: main.clone(),
                sub_id: Some(subs[0].clone()),
                header: "Sub stalled".into(),
                question: "q".into(),
                options: vec![CardOption::new("Open it", "")],
                domain: None,
            },
        )
        .await
        .unwrap();
        move_family(&st, &main, "cl-card-move-next").await;
        let p = st.list_prompts().await.into_iter().find(|p| p["id"] == handle.card_id.as_str()).unwrap();
        assert_eq!(p["payload"]["display_session_id"], "cl-card-move-next");
        assert_eq!(p["payload"]["session_id"], "cl-card-move-next");
    }

    #[tokio::test]
    async fn a_subs_question_after_a_respawn_shows_on_the_successor() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-q", &[("a", false)]);
        successor(&st, &main, "cl-q-next");
        move_family(&st, &main, "cl-q-next").await;
        // The display id is read from the registry each time, so a prompt stored
        // before the move re-stamps onto the successor.
        let mut payload = json!({"id": "q1", "session_id": subs[0]});
        crate::daemon::subchats::stamp_prompt_routing(&st, &mut payload, Some(&subs[0]));
        assert_eq!(payload["display_session_id"], "cl-q-next");
        assert_eq!(payload["session_id"], subs[0].as_str(), "the answer still goes to the sub");
    }

    #[test]
    fn live_successor_reads_the_registry_link_then_the_durable_twin() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("ls-new", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert_eq!(live_successor(&st, "ls-old"), None);
        crate::sessions::chat_config::set_predecessor("ls-new", "ls-old");
        assert_eq!(live_successor(&st, "ls-old").as_deref(), Some("ls-new"), "a restart drops the registry link");
        st.registry.mark_ended("ls-new", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert_eq!(live_successor(&st, "ls-old"), None, "an ended successor takes nothing");
    }
}
