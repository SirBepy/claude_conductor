//! What happens to a main chat's subs when the main chat ends: the approval a
//! chat with running subs needs before it closes, a `respawn` handing the whole
//! family to its successor, and the orphans a chat that died without asking
//! leaves behind (spec section 9).
//!
//! Every way a chat closes goes through [`request_close`] first: the menu and
//! the phone (`end_session` and `mark_session_ended`, which `clear_session`
//! calls), the `close_session` tool a finished chat ends on, and the
//! backstop at [`crate::daemon::pump::close::finalize_close`]. A closing chat
//! with running subs is held, and Joe is asked on a card. Finished subs never
//! hold it. A card is never answered by a timeout: only Joe's pick, or a chat
//! that is already gone, settles it.
//!
//! A project's main chat is the exception (pc-1806): closing it is not a close but a
//! put-away ([`CloseOutcome::PutAway`], `put_away::flow`). It asks no card, ends
//! nothing and deletes nothing, and the subs are paused instead of ended or moved.

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use super::remote::records::{self, RemoteState, RemoteSub};
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
/// The close pick when no sub is running and only unmerged worktree commits are at stake.
pub const CLOSE_ANYWAY: &str = "Close anyway";
pub const KEEP_IT_OPEN: &str = "Keep it open";

/// What a held close says to whoever asked (the `close_session` tool result, so
/// the model does not tell Joe the chat closed).
pub const HELD_NOTE: &str = "This chat still has running subs or subs with unmerged commits, so it is not closing yet. Joe has been asked on a card whether to wait, close anyway, or keep this chat open. End your turn now and do not call close_session again.";

#[derive(Default)]
struct Entry {
    /// The approval card is on screen.
    asking: bool,
    /// Joe chose "Wait for them": the chat closes when its last running sub ends.
    waiting: bool,
}

static CLOSES: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

/// Chats whose close Joe approved and that [`complete`] is still tearing down.
/// A count, not a set: two `complete` calls for one chat can overlap (the last
/// sub settling and a sub leaving), and the first to finish must not drop the
/// other's approval.
static APPROVED: Mutex<std::collections::BTreeMap<String, usize>> = Mutex::new(std::collections::BTreeMap::new());

pub(super) fn is_approved(parent: &str) -> bool {
    APPROVED.lock().unwrap_or_else(|p| p.into_inner()).contains_key(parent)
}

/// Holds `parent`'s approval until the returned guard drops.
fn approve(parent: &str) -> Unapprove {
    *APPROVED.lock().unwrap_or_else(|p| p.into_inner()).entry(parent.to_string()).or_insert(0) += 1;
    Unapprove(parent.to_string())
}

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
/// running sub, or with a worktree sub (finished or not) whose commits are not
/// merged, and is not a `respawn` predecessor, whose subs move instead. The second
/// case is the one a finished sub used to slip through: closing ends it, its tree
/// is kept, and the "Worktree kept" card lands in a window that is closing.
///
/// A project's main chat (the one `ProjectConfig.main_chat_id` names) is not asked
/// here: [`close_outcome`] puts it away before this question is reached.
pub fn needs_approval(state: &DaemonState, parent: &str) -> bool {
    let Some(inst) = state.registry.get(parent) else { return false };
    if inst.ended_at.is_some() || super::is_sub(&inst) || is_approved(parent) {
        return false;
    }
    if running_subs(&state.registry, parent).is_empty()
        && !super::family::has_remote_running(parent)
        && super::worktree::unmerged_subs(state, parent).is_empty()
    {
        return false;
    }
    live_successor(state, parent).is_none()
}

/// What a request to close a chat comes to.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CloseOutcome {
    /// Nothing holds the close: the caller tears the chat down.
    Proceed,
    /// A card is up (or being raised) and the caller must not close.
    Held,
    /// The chat is its project's main chat: it is being put away (paused and hidden,
    /// nothing deleted), so the caller must not close it either.
    PutAway,
}

/// Whether `parent` is a chat a close must not tear down: see [`CloseOutcome`].
pub fn close_outcome(state: &Arc<DaemonState>, parent: &str) -> CloseOutcome {
    if super::put_away::is_project_main_chat(state, parent) && !is_approved(parent) {
        super::put_away::start(state, parent);
        return CloseOutcome::PutAway;
    }
    if request_card(state, parent) {
        CloseOutcome::Held
    } else {
        CloseOutcome::Proceed
    }
}

/// Asks to close `parent`. Returns true when the close is held: a card is up (or
/// being raised), or the chat is being put away, and the caller must not close.
/// False means go ahead.
pub fn request_close(state: &Arc<DaemonState>, parent: &str) -> bool {
    close_outcome(state, parent) != CloseOutcome::Proceed
}

/// Takes back a pending "Wait for them" or card on `parent` (a put-away supersedes
/// them: the chat is not closing any more).
pub(super) fn forget_pending(state: &Arc<DaemonState>, parent: &str) {
    keep_open(state, parent);
}

/// The card half of [`close_outcome`]. A second request while the card is up is
/// held without a second card; one made while "Wait for them" is pending asks
/// again, so Joe can change his mind.
fn request_card(state: &Arc<DaemonState>, parent: &str) -> bool {
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

fn names(subs: &[Instance], remote: &[RemoteSub]) -> String {
    subs.iter()
        .map(|s| super::spawn::label(s))
        .chain(remote.iter().map(super::remote::actions::name_of))
        .map(|n| format!("**{n}**"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The subs of `parent` running on a paired machine (started or waiting to start).
fn running_remote(parent: &str) -> Vec<RemoteSub> {
    records::of_main(parent).into_iter().filter(|r| matches!(r.state, RemoteState::Running | RemoteState::Held)).collect()
}

/// Puts the approval card in `parent`'s window and waits for Joe's pick on a
/// detached task.
pub(crate) async fn raise(state: &Arc<DaemonState>, parent: &str) {
    let running = running_subs(&state.registry, parent);
    // Subs the main chat runs on a paired machine are running subs too: closing the chat
    // would end them or move them to that machine's sidebar.
    let remote = running_remote(parent);
    let n = running.len() + remote.len();
    let unmerged = super::worktree::unmerged_subs(state, parent);
    let unmerged_line = (!unmerged.is_empty()).then(|| {
        let listed = unmerged.iter().map(|(name, commits)| format!("**{name}** ({commits})")).collect::<Vec<_>>().join(", ");
        format!(
            "{} sub{} unmerged commits: {listed}. Closing leaves them on their branches in their worktrees, and no window will say so.",
            unmerged.len(),
            if unmerged.len() == 1 { " has" } else { "s have" },
        )
    });
    let (header, question, options) = if n == 0 {
        (
            if unmerged.is_empty() { "Close the chat" } else { "Close with unmerged work" }.to_string(),
            // `unmerged_line` is empty when the work was merged between the held close and the card.
            match unmerged_line {
                Some(line) => format!("{line}\n\nClose anyway?"),
                None => "Close this chat?".to_string(),
            },
            vec![
                CardOption::new(CLOSE_ANYWAY, if unmerged.is_empty() { "Close it" } else { "Their branches and worktrees stay on disk" }),
                CardOption::new(KEEP_IT_OPEN, "Do not close"),
            ],
        )
    } else {
        let mut question = format!(
            "Closing this chat has {n} sub{} still running: {}.",
            if n == 1 { "" } else { "s" },
            names(&running, &remote),
        );
        if let Some(line) = unmerged_line {
            question.push_str(&format!("\n\n{line}"));
        }
        question.push_str(&format!("\n\nWhat should happen to {} first?", if n == 1 { "it" } else { "them" }));
        (
            "Close with subs running".to_string(),
            question,
            vec![
                CardOption::new(WAIT_FOR_THEM, "Close this chat when the last one finishes. Closing it again asks again, so you can change your mind"),
                CardOption::new(CLOSE_THEM_TOO, "End them now, then close"),
                CardOption::new(KEEP_IT_OPEN, "Do not close"),
            ],
        )
    };
    let card = RaisedCard { kind: KIND, display_session_id: parent.to_string(), sub_id: None, header, question, options, domain: None };
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
        CardAnswer::Picked(pick) if pick == CLOSE_THEM_TOO || pick == CLOSE_ANYWAY => close_them_too(state, parent).await,
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
    // A closing chat hands the project's pointer to another open main chat.
    super::main_pointer::reconcile(state);
    complete_if_settled(state, parent).await;
}

async fn close_them_too(state: &Arc<DaemonState>, parent: &str) {
    for sub in running_subs(&state.registry, parent) {
        super::end_sub(state, &sub.session_id);
    }
    for rec in running_remote(parent) {
        super::remote::actions::end(state, &rec);
    }
    complete(state, parent).await;
}

fn keep_open(state: &Arc<DaemonState>, parent: &str) {
    forget(parent);
    if state.registry.set_closing(parent, false) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    super::main_pointer::reconcile(state);
}

/// Closes `parent` if it is waiting and no sub is running any more.
async fn complete_if_settled(state: &Arc<DaemonState>, parent: &str) {
    if is_waiting(parent) && running_subs(&state.registry, parent).is_empty() && !super::family::has_remote_running(parent) {
        complete(state, parent).await;
    }
}

/// A sub of `sub_id`'s main chat just finished, ended or left it. If the chat is
/// waiting on its last one, the chat closes now. Sync, because it is called from
/// the pump's result handler.
pub fn on_sub_settled(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(parent) = super::family::main_of(state, sub_id) else { return };
    // A sub running on another machine is as much a reason to keep waiting as a local one.
    if !is_waiting(&parent) || !running_subs(&state.registry, &parent).is_empty() || super::family::has_remote_running(&parent) {
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
    // Ending the child sends the pump its EOF, whose backstop asks to close again
    // while the row is still open: a chat Joe just approved must not draw a second card.
    let _approved = approve(parent);
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

/// Drops the approval when [`complete`] ends, on every path out of it.
struct Unapprove(String);

impl Drop for Unapprove {
    fn drop(&mut self) {
        let mut held = APPROVED.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = held.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                held.remove(&self.0);
            }
        }
    }
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
    // Every close path settles after it marks the row ended, so this is where the
    // project's pointer to the chat goes (or moves to the project's next main chat).
    super::main_pointer::reconcile(state);
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
    // Subs on paired machines: a finished or never-started one ends with its parent, a
    // running one moves to its machine's sidebar, as a local one does.
    for rec in records::of_main(parent).into_iter().filter(|r| r.state != RemoteState::Ended) {
        if rec.state == RemoteState::Running {
            super::remote::actions::to_sidebar(state, &rec);
        } else {
            super::remote::actions::end(state, &rec);
        }
    }
    cards::drop_daemon_cards_shown_in(state, parent).await;
}

/// Hands `old`'s subs, cards, one-line-back queue and decisions log to `new`.
///
/// Order, for a crash half way: first the subs (a sub left pointing at the
/// predecessor is lost, so that goes first and each step is its own write), then
/// the files. The one-line-back queue and the window stores merge, so a second run
/// completes them; the decisions log does not (`decisions::move_log` leaves a
/// successor that already has a log alone and the predecessor's log stays where
/// it was). The caller closes the predecessor last, and
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
    // The subs on paired machines: their records name the successor, and their hosts are told.
    super::remote::actions::reparent_family(state, old, new);
    super::decisions::move_log(old, new);
    super::card_log::move_log(old, new);
    // The run plan follows the chat, or its wakes and the tick's clocks would keep
    // going to the ended predecessor. After the card log: a blocker card the watch
    // drew is named in the run file and now sits in the successor's log.
    super::run::move_run(state, old, new);
    // The drafts the subs wrote name their main chat; the successor lists them.
    if let Some(project) = state.registry.get(new).map(|i| i.project_id) {
        crate::sessions::message_drafts::rehome_main(&project, old, new);
    }
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
    super::main_pointer::hand_over(state, predecessor, successor);
    carry_window_stores(state, predecessor, successor);
    move_family(state, predecessor, successor).await;
}

/// What the predecessor's window kept per chat id and a respawn used to drop: the
/// Ask threads and Answers state (the predecessor's close deletes them), the
/// previews it pushed, and its sidebar pin. Each step merges, so a re-run is safe.
pub(crate) fn carry_window_stores(state: &Arc<DaemonState>, old: &str, new: &str) {
    crate::ask::store::move_chat(old, new);
    crate::daemon::preview::rehome_session(old, new);
    if state.registry.get(old).is_some_and(|i| i.pinned_to_sidebar) {
        state.registry.set_pinned_to_sidebar(new, true);
    }
}

/// Heals every sub whose main chat is gone or ended: the chat crashed, got a
/// SessionEnd, was closed by a path that never asked, or ended while the daemon
/// was down (an ended row is not in the snapshot, so its subs come back pointing
/// at nothing). Runs once at boot and on the 60 second tick. Returns the parents
/// settled.
pub async fn heal_orphans(state: &Arc<DaemonState>) -> Vec<String> {
    // A main chat that ended without asking leaves its project's pointer behind.
    super::main_pointer::reconcile(state);
    let mut gone: Vec<String> = Vec::new();
    for sub in state.registry.list() {
        let Some(parent) = sub.subchat_of.clone() else { continue };
        if sub.ended_at.is_some() || gone.contains(&parent) {
            continue;
        }
        // A visiting sub's main chat lives on its home machine, so its absence from
        // this registry says nothing: settling it would end a job that is running
        // fine, and the home owns the family.
        if super::is_visiting(&sub.session_id) {
            continue;
        }
        let alive = super::held::chat_live(state, &parent);
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

    #[test]
    fn a_respawn_carries_the_predecessors_sidebar_pin() {
        let st = state();
        for id in ["pin-old", "pin-new", "pin-plain-old", "pin-plain-new"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-16T00:00:00Z");
        }
        st.registry.set_pinned_to_sidebar("pin-old", true);
        // Ids that own no store file or preview, so nothing touches the data dir.
        carry_window_stores(&st, "pin-old", "pin-new");
        carry_window_stores(&st, "pin-plain-old", "pin-plain-new");
        assert!(st.registry.get("pin-new").unwrap().pinned_to_sidebar);
        assert!(!st.registry.get("pin-plain-new").unwrap().pinned_to_sidebar);
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

    /// "Wait for them" picked while the chat's turn is still running: the turn's end
    /// runs the close backstop (`close_requested` is set), which must neither take the
    /// wait away nor ask again.
    #[cfg(windows)]
    #[tokio::test]
    async fn the_turn_end_backstop_leaves_a_wait_for_them_pick_alone() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, subs) = family(&st, "cl-backstop", &[("a", false)]);
        let _child = crate::daemon::session_test_support::spawn_fake_session(&st.sessions, &main).await;
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, WAIT_FOR_THEM).await;
        assert!(until(|| is_waiting(&main)).await);

        let session = st.sessions.get(&main).unwrap().clone();
        crate::daemon::pump::close::finalize_close(&st, &session);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        assert!(is_waiting(&main), "the pick still stands");
        assert!(card_id(&st, KIND).await.is_none(), "Joe is not asked a second time");
        assert!(st.registry.get(&main).unwrap().ended_at.is_none(), "and nothing closed early");

        st.registry.set_subchat_finished(&subs[0], true);
        on_sub_settled(&st, &subs[0]);
        assert!(until(|| st.registry.get(&main).unwrap().ended_at.is_some()).await, "the last sub's end still closes it");
    }

    /// Joe can close again to change his mind: the card asks again, and the card
    /// says so.
    #[tokio::test]
    async fn the_card_says_how_to_cancel_a_wait_and_closing_again_asks_again() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, _) = family(&st, "cl-cancel", &[("a", false)]);
        assert!(request_close(&st, &main));
        let id = card_id(&st, KIND).await.unwrap();
        let p = st.list_prompts().await.into_iter().find(|p| p["id"] == id.as_str()).unwrap();
        let wait = &p["payload"]["questions"][0]["options"][0];
        assert_eq!(wait["label"], WAIT_FOR_THEM);
        assert!(wait["description"].as_str().unwrap().contains("Closing it again asks again"), "{wait}");
        answer(&st, &id, WAIT_FOR_THEM).await;
        assert!(until(|| is_waiting(&main)).await);
        assert!(request_close(&st, &main), "held again");
        assert!(!is_waiting(&main), "the wait is off until Joe picks again");
        assert!(card_id(&st, KIND).await.is_some(), "and he is asked again");
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
                cleared: Vec::new(),
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

    /// A sub that visits from another machine has its main chat there, so the
    /// registry never has the parent: the heal must not read that as a crash.
    #[tokio::test]
    async fn a_visiting_subs_missing_parent_is_not_a_crash_but_a_local_subs_is() {
        let _data = TempDataDir::new();
        let st = state();
        for id in ["visitor", "local-orphan"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
            st.registry.set_subchat_of(id, Some("home-main".into()));
        }
        crate::daemon::subchats::store_visiting_brief("visitor", "home-main", "pc");
        crate::daemon::subchats::store_sub_brief("local-orphan", "other-main");
        st.registry.set_subchat_of("local-orphan", Some("other-main".into()));
        assert_eq!(heal_orphans(&st).await, ["other-main".to_string()], "only the local sub's parent is gone");
        let visitor = st.registry.get("visitor").unwrap();
        assert_eq!(visitor.subchat_of.as_deref(), Some("home-main"), "still a sub");
        assert!(visitor.ended_at.is_none());
        assert!(crate::sessions::chat_config::get("visitor").unwrap().subchat.is_some(), "its brief is kept");
        assert!(st.registry.get("local-orphan").unwrap().subchat_of.is_none(), "the local orphan is promoted as before");
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

    /// pc-1804 step 4: the run plan is the family's too. Left at the predecessor's id,
    /// its wakes and the tick's clocks would go to a chat that is closing.
    #[tokio::test]
    async fn a_respawn_hands_the_run_plan_to_the_successor() {
        let _data = TempDataDir::new();
        let st = state();
        let (main, _subs) = family(&st, "cl-run", &[("a", false)]);
        successor(&st, &main, "cl-run-next");
        let root = crate::settings::paths::data_dir().unwrap();
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        let run = crate::daemon::subchats::run::Run {
            id: "run-resp".into(),
            main_id: main.clone(),
            title: "Finish todos".into(),
            steps: vec![crate::daemon::subchats::run::Step {
                id: "s3".into(),
                title: "Review".into(),
                owner: crate::daemon::subchats::run::Owner::Main,
                status: crate::daemon::subchats::run::StepStatus::Ready,
                ..Default::default()
            }],
            seen: vec!["ready:s3".into()],
            ..Default::default()
        };
        crate::daemon::subchats::run::save_in(&root, &run).unwrap();

        carry_to_successor(&st, &main, "cl-run-next").await;

        assert!(crate::daemon::subchats::run::load_in(&root, &main).is_none(), "the predecessor keeps no plan");
        let moved = crate::daemon::subchats::run::load_in(&root, "cl-run-next").expect("the successor holds it");
        assert_eq!((moved.id.as_str(), moved.main_id.as_str()), ("run-resp", "cl-run-next"));
        assert_eq!(moved.seen, vec!["ready:s3".to_string()], "kept, so the tick adds no second wake");
        // A respawned chat gets no SessionStart answer with the plan, so it is told once.
        let told: Vec<String> =
            st.repo_channel_wakes.lock().unwrap().get("cl-run-next").map(|q| q.iter().map(|l| l.text.clone()).collect()).unwrap_or_default();
        assert!(told.iter().any(|t| t.contains("run-resp") && t.contains("run_plan status") && t.contains("Your turn on: s3")), "{told:?}");
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

    /// A daemon whose settings know project `proj`, the project `family`'s rows sit in.
    fn state_with_project() -> Arc<DaemonState> {
        let mut s = Settings::default();
        let (id, _) = crate::settings::upsert_project_for_cwd(&mut s, std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "2026-11-12T00:00:00Z");
        s.projects.iter_mut().find(|p| p.id == id).unwrap().id = "proj".into();
        s.projects[0].name = "cv-site".into();
        DaemonState::new(new_session_map(), SettingsCache::new(s))
    }

    fn pointer(st: &DaemonState) -> Option<String> {
        st.settings.snapshot().projects[0].main_chat_id.clone()
    }

    /// Closing a project's main chat is a put-away (pc-1806): no card, nothing ended,
    /// the pointer kept, and the flow is on its way (the family record is written first).
    #[tokio::test]
    async fn closing_a_projects_main_chat_puts_it_away_and_asks_nobody() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (main, subs) = family(&st, "pm-ask", &[("done", true), ("run", false)]);
        let (other, _) = family(&st, "pm-plain", &[]);
        crate::sessions::chat_config::set_subchats_on(&main, true);
        st.settings.set_project_main_chat("proj", Some(&main));

        assert_eq!(close_outcome(&st, &other), CloseOutcome::Proceed, "a chat that is not the pointer closes as before");
        assert_eq!(close_outcome(&st, &main), CloseOutcome::PutAway);
        assert!(request_close(&st, &main), "every caller reads it as held");

        assert!(until(|| crate::daemon::subchats::put_away::is_hidden_family(&main)).await, "the family record is written first");
        assert!(until(|| st.registry.get(&main).unwrap().frozen).await, "the chat's child is stopped");
        assert!(st.list_prompts().await.is_empty(), "Joe is asked nothing");
        let row = st.registry.get(&main).unwrap();
        assert!(row.ended_at.is_none() && row.end_reason.is_none(), "nothing is closed");
        assert_eq!(pointer(&st).as_deref(), Some(main.as_str()), "the pointer is kept");
        // settle_family would have ended the finished sub and moved the running one to the sidebar.
        for sub in &subs {
            assert!(st.registry.get(sub).unwrap().ended_at.is_none());
            assert_eq!(st.registry.get(sub).unwrap().subchat_of.as_deref(), Some(main.as_str()));
        }
    }

    /// A close with a running sub used to ask Joe whether to wait, close them too or keep
    /// the chat open; for the main chat the subs are paused instead, so no card appears.
    #[tokio::test]
    async fn a_main_chat_with_a_running_sub_draws_no_close_card() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (main, _) = family(&st, "pm-run", &[("run", false)]);
        crate::sessions::chat_config::set_subchats_on(&main, true);
        st.settings.set_project_main_chat("proj", Some(&main));
        assert_eq!(close_outcome(&st, &main), CloseOutcome::PutAway);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(card_id(&st, KIND).await.is_none(), "no approval card");
        assert!(!is_waiting(&main) && !st.registry.get(&main).unwrap().closing);
        assert_eq!(pointer(&st).as_deref(), Some(main.as_str()));
    }

    /// The pointer can move between the held close and the card, and a chat that is not a
    /// project's main chat still gets the card: it names no main-chat cost, since nothing
    /// is deleted for any chat now.
    #[tokio::test]
    async fn the_close_card_of_an_ordinary_chat_says_nothing_about_answers_and_ask() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (plain, _) = family(&st, "pm-race", &[("run", false)]);
        assert!(request_close(&st, &plain));
        let id = card_id(&st, KIND).await.expect("the card is raised");
        let p = st.list_prompts().await.into_iter().find(|p| p["id"] == id.as_str()).unwrap();
        let q = &p["payload"]["questions"][0];
        assert!(!q["question"].as_str().unwrap().contains("main chat"), "{q}");
        let options = q["options"].as_array().unwrap().clone();
        let said: Vec<&str> = options.iter().filter_map(|o| o["description"].as_str()).collect();
        assert!(said.iter().all(|d| !d.contains("Answers and Ask")), "{said:?}");
        // A card raised for a chat with nothing running reads as a plain close.
        let (idle, _) = family(&st, "pm-race2", &[]);
        raise(&st, &idle).await;
        let p = st.list_prompts().await.into_iter().find(|p| p["payload"]["display_session_id"] == idle.as_str());
        let p = p.expect("the card for the idle chat");
        assert_eq!(p["payload"]["questions"][0]["question"], "Close this chat?");
    }

    /// An ordinary chat with a running sub keeps the approval flow, including the pointer
    /// handling of "Keep it open" and "Close anyway" (the pointer names no such chat, so
    /// the reconcile has nothing to clear).
    #[tokio::test]
    async fn keeping_a_chat_open_and_closing_anyway_both_work_for_an_ordinary_chat() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (plain, _) = family(&st, "pm-keep", &[("run", false)]);
        assert!(request_close(&st, &plain));
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, KEEP_IT_OPEN).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(st.registry.get(&plain).unwrap().ended_at.is_none());

        assert!(request_close(&st, &plain), "asks again");
        let id = card_id(&st, KIND).await.unwrap();
        answer(&st, &id, CLOSE_THEM_TOO).await;
        assert!(until(|| st.registry.get(&plain).unwrap().ended_at.is_some()).await, "closed");
        assert!(until(|| !is_approved(&plain)).await, "the approval is released once the close is done");
        assert!(st.list_prompts().await.is_empty(), "the approved close drew no second card");
    }

    /// A "Wait for them" pick made before this build (or on a chat that stopped being the
    /// pointer) still hands the pointer to another open main chat when it is applied.
    #[tokio::test]
    async fn waiting_for_subs_hands_the_pointer_to_another_open_main_chat() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (main, _) = family(&st, "pm-wait", &[("run", false)]);
        let (other, _) = family(&st, "pm-wait-other", &[]);
        crate::sessions::chat_config::set_subchats_on(&main, true);
        crate::sessions::chat_config::set_subchats_on(&other, true);
        st.settings.set_project_main_chat("proj", Some(&main));
        apply_answer(&st, &main, CardAnswer::Picked(WAIT_FOR_THEM.to_string())).await;
        assert!(until(|| pointer(&st).as_deref() == Some(other.as_str())).await, "new chats go to the chat that stays open");
    }

    #[tokio::test]
    async fn a_chat_being_closed_after_approval_is_not_asked_again_by_the_close_backstop() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (plain, _) = family(&st, "pm-eof", &[("run", false)]);
        assert!(needs_approval(&st, &plain));
        // `complete` holds the approval while it ends the child, and the pump's EOF
        // backstop asks `request_close` in that window.
        let first = approve(&plain);
        assert!(!needs_approval(&st, &plain));
        assert!(!request_close(&st, &plain), "the backstop lets the approved close through");
        // A second overlapping close finishing first leaves the first one's approval.
        let second = approve(&plain);
        drop(second);
        assert!(!needs_approval(&st, &plain), "one guard dropping keeps the other's approval");
        drop(first);
        assert!(needs_approval(&st, &plain), "the approval does not outlive the close");
    }

    #[tokio::test]
    async fn a_respawn_predecessor_that_is_the_main_chat_closes_without_a_card_or_a_put_away() {
        let _data = TempDataDir::new();
        let st = state_with_project();
        let (main, _) = family(&st, "pm-resp", &[]);
        st.settings.set_project_main_chat("proj", Some(&main));
        successor(&st, &main, "pm-resp-next");
        assert!(!needs_approval(&st, &main), "its place passes to the successor");
        assert_eq!(close_outcome(&st, &main), CloseOutcome::Proceed, "a respawn tears the predecessor down, it is not put away");
        carry_to_successor(&st, &main, "pm-resp-next").await;
        assert_eq!(pointer(&st).as_deref(), Some("pm-resp-next"));
    }
}
