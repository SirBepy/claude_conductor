//! A sub's `blocker` cards, and the retraction of the ones the app drew itself.

use super::*;

/// What a sub's `blocker` message carries into the main chat.
#[derive(Clone, Debug, Default)]
pub struct BlockerCard {
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
}

/// Draws a sub's `blocker` into its main chat. Any other kind stays in the sub,
/// so the caller checks the kind. `None` when `sub_id` is not a sub.
pub fn on_blocker(state: &Arc<DaemonState>, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    send_blocker(state, sub_id, card).ok().flatten()
}

/// [`on_blocker`] that also says when a visiting sub's card was lost on the way to its home.
pub fn send_blocker(state: &Arc<DaemonState>, sub_id: &str, card: BlockerCard) -> Result<Option<CardEntry>, CardLost> {
    // A visiting sub's main chat is on its home: the card is drawn there.
    if crate::daemon::subchats::is_visiting(sub_id) {
        return lost_unless(queue_remote_blocker(state, sub_id, card, false), sub_id).map(|()| None);
    }
    let Ok(root) = crate::settings::paths::data_dir() else { return Ok(None) };
    Ok(on_blocker_at(&root, state, sub_id, card))
}

pub(crate) fn on_blocker_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    card: BlockerCard,
) -> Option<CardEntry> {
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    on_blocker_in(root, state, &parent, sub_id, card)
}

/// [`on_blocker_at`] for a sub that no longer names its main chat in the
/// registry: one just moved to the sidebar still has something to say to the
/// window it left, so the caller passes the chat it had.
pub(crate) fn on_blocker_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    card: BlockerCard,
) -> Option<CardEntry> {
    blocker_in(root, state, parent, sub_id, card, false)
}

pub fn on_blocker_for(state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_blocker_in(&root, state, parent, sub_id, card)
}

/// A visiting sub's `blocker`, queued for its home, which draws it. `by_app` is carried so the
/// home stores the app's own card as such and a resolved problem takes it down there too.
fn queue_remote_blocker(state: &Arc<DaemonState>, sub_id: &str, card: BlockerCard, by_app: bool) -> bool {
    let event = crate::daemon::subchats::remote::events::CardEvent {
        kind: KIND_BLOCKER.into(),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        by_app,
        ..Default::default()
    };
    crate::daemon::subchats::remote::events::queue_card(state, sub_id, event)
}

/// [`on_blocker`] for a card the app draws about a sub (a tree it kept), so a later
/// [`retract_blockers`] may take it down. `root` is the data dir, `None` for the real one.
pub(crate) fn on_app_blocker(state: &Arc<DaemonState>, sub_id: &str, root: Option<&Path>, card: BlockerCard) -> Option<CardEntry> {
    // A visiting sub's main chat is on its home: the card is drawn there, as `on_blocker` does.
    if root.is_none() && crate::daemon::subchats::is_visiting(sub_id) {
        let _ = lost_unless(queue_remote_blocker(state, sub_id, card, true), sub_id);
        return None;
    }
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    match root {
        Some(root) => blocker_in(root, state, &parent, sub_id, card, true),
        None => on_app_blocker_for(state, &parent, sub_id, card),
    }
}

/// [`on_app_blocker`] for a sub that no longer names its main chat (see [`on_blocker_in`]).
pub(crate) fn on_app_blocker_for(state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    blocker_in(&root, state, parent, sub_id, card, true)
}

fn blocker_in(root: &Path, state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard, by_app: bool) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let entry = CardEntry {
        id: format!("blocker-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_BLOCKER.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        verdict: card.verdict,
        // A blocker is red by kind and the dashboard drops a "good" one as a success
        // notice, so a sub that sends a blocker with tone good keeps the card, not the colour.
        tone: card.tone.filter(|t| t != "good"),
        text: card.text,
        points: card.points,
        by_app,
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}

/// The verdicts of the "not merged" blocker cards an older build drew when a landing was
/// refused, before `by_app` existed.
const LEGACY_LANDING_VERDICTS: [&str; 3] = ["Not merged", "Merge conflict", "Not merged (unreachable)"];

/// How the texts of those cards begin (`worktree::land_with`'s and `remote/land.rs`'s
/// refusals, which the old build drew as they were). A sub may send a blocker under the
/// same verdict, and that one is its own word, so a legacy card needs the daemon's
/// wording too. The prefixes are whole daemon sentences, never a bare "The checkout ".
const LEGACY_LANDING_TEXTS: [&str; 14] = [
    "Its commits conflict with ",
    "Its worktree folder ",
    "The main checkout is on ",
    "The main checkout is not on ",
    "The main checkout has ",
    "Its branch could not be brought up to date with ",
    "git refused to fast-forward ",
    "The machine that hosts this sub is not paired any more",
    "The other machine did not name a commit for the sub's branch.",
    "The bundle from the other machine could not be read: ",
    "The bundle's head is not the commit the other machine named",
    "The sub's commits could not be imported: ",
    "The sub's branch does not build on the target tip",
    // A `spawn_blocking` join error reads "task <n> panicked ..." or "task <n> was cancelled".
    "The merge did not run: task ",
];

/// Whole daemon sentences that sit inside a legacy card's text, for the refusals that
/// open with a free-text name (a branch, a path or a peer's label) and so cannot be
/// matched by their start. Each is specific enough that a sub's own blocker never
/// reads like it.
const LEGACY_LANDING_PHRASES: [&str; 9] = [
    " no longer exists, so there is nothing to merge.",
    " kept moving while the merge ran.",
    " is gone, so the commits could not be merged.",
    " no longer exists here.",
    " has moved too far from where the sub started for a machine link to carry it: ",
    " would not bring the sub's branch up to date: ",
    " would not hand over the sub's branch: ",
    "), so the commits could not be fetched.",
    " any more, so nothing was merged.",
];

/// Whether `entry` is a landing refusal the daemon itself drew before `by_app` existed.
fn is_legacy_landing_card(entry: &CardEntry) -> bool {
    let text = entry.text.as_str();
    LEGACY_LANDING_VERDICTS.contains(&entry.verdict.as_str())
        && (LEGACY_LANDING_TEXTS.iter().any(|t| text.starts_with(t)) || LEGACY_LANDING_PHRASES.iter().any(|p| text.contains(p)))
}

/// Takes the app's own open `blocker` cards about `sub_id` out of the Waiting on you
/// zone: a problem that is over (its commits landed, it started, the main chat dropped
/// it) must not stay on the dashboard as red, and no card says "all fine" in its place,
/// because a success is nothing Joe waits on. A blocker the sub sent itself is its own
/// word and stays. Marks each card retracted in place and announces the change; the
/// card stays in the log as a thin pill. Returns how many it marked.
pub fn retract_blockers(state: &Arc<DaemonState>, sub_id: &str) -> usize {
    let Ok(root) = crate::settings::paths::data_dir() else { return 0 };
    // A sub that runs on another machine has no row here: its record names the main chat
    // the app's cards about it were drawn in.
    let Some(parent) = state
        .registry
        .get(sub_id)
        .and_then(|i| i.subchat_of.clone())
        .or_else(|| crate::daemon::subchats::remote::records::get(sub_id).map(|r| r.main_id))
    else {
        return 0;
    };
    retract_blockers_in(&root, state, &parent, sub_id)
}

pub(crate) fn retract_blockers_in(root: &Path, state: &Arc<DaemonState>, parent: &str, sub_id: &str) -> usize {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut n = 0;
    for mut entry in read_in(root, parent) {
        let app_drawn = entry.by_app || is_legacy_landing_card(&entry);
        if entry.kind != KIND_BLOCKER || !app_drawn || entry.retracted || entry.sub_id.as_deref() != Some(sub_id) {
            continue;
        }
        entry.retracted = true;
        if let Err(e) = replace_line(root, parent, &entry) {
            log::warn!("subchats: could not retract blocker card {} for {parent}: {e}", entry.id);
            continue;
        }
        state.notifier.publish(NOTIFY, json!({ "session_id": parent, "card": entry, "replace": true }));
        n += 1;
    }
    n
}
