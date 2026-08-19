//! Durable store for "Your Todos": action items an AI writes for the user, which
//! outlive the turn that raised them. File
//! `<app-data>/user-todos/<project_id>.json`, daemon is sole writer, same shape
//! as `repo_channel`. Scope is deliberately NOT a field - see `origin_session_id`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum TodoState {
    #[default]
    Open,
    Done,
    Archived,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UserTodo {
    pub id: String,
    pub text: String,
    pub origin_session_id: String,
    /// Registry `name` at write time, exactly like `ChannelMessage::author`: no
    /// per-card registry lookup, and a renamed session keeps its old label.
    pub origin_label: String,
    #[serde(default)]
    pub state: TodoState,
    /// Archived because an AI cancelled it, not because Joe ticked it.
    #[serde(default)]
    pub dropped: bool,
    #[serde(default)]
    pub drop_reason: String,
    /// Set on rewrite; the panel renders it struck through under the new text.
    #[serde(default)]
    pub previous_text: String,
    /// This card's current state was set by an AI, not by Joe.
    #[serde(default)]
    pub by_ai: bool,
    pub created_at: String,
    pub updated_at: String,
    /// False after a user-side change, true once a turn has been served the card.
    /// The CTA counts the false ones; the injection hook flipping it clears it.
    #[serde(default)]
    pub seen_by_origin: bool,
}

/// Not a rolling log: hitting this cap means something is wrong.
const MAX_TODOS: usize = 200;
/// Bounds both card text and drop reason, so a looping agent can't blow up the
/// store or the text injected into every turn.
pub(crate) const MAX_TEXT_LEN: usize = 500;

/// Same rationale as `repo_channel::WRITE_LOCK` - cross-process integrity comes
/// from the atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn store_dir() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("user-todos"))
}

fn store_path_for(project_id: &str) -> Option<PathBuf> {
    Some(store_dir()?.join(format!("{project_id}.json")))
}

fn load(path: &Path) -> Vec<UserTodo> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, todos: &[UserTodo]) {
    let json = match serde_json::to_string_pretty(todos) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("user_todos: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("user_todos: write failed: {e}");
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn clamp(text: &str) -> String {
    text.chars().take(MAX_TEXT_LEN).collect()
}

/// Drops Archived first, then Done, then Open - unlike `repo_channel`'s flat
/// drain, because silently deleting an OPEN action item is the one outcome this
/// store must not produce.
fn prune(todos: &mut Vec<UserTodo>) {
    if todos.len() <= MAX_TODOS {
        return;
    }
    let mut excess = todos.len() - MAX_TODOS;
    for state in [TodoState::Archived, TodoState::Done, TodoState::Open] {
        if excess == 0 {
            break;
        }
        todos.retain(|t| {
            if excess > 0 && t.state == state {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

/// All retained cards for a project, oldest first. Empty (never an error) for
/// a project with no file yet.
pub fn list(project_id: &str) -> Vec<UserTodo> {
    let Some(path) = store_path_for(project_id) else { return Vec::new() };
    list_at(&path)
}

fn list_at(path: &Path) -> Vec<UserTodo> {
    load(path)
}

/// `path: None` skips the disk write (mirroring the `store_path_for` failure
/// branch); `Some(path)` is the seam the tests drive, same as
/// `repo_channel::post_at`.
pub fn add(project_id: &str, origin_session_id: &str, origin_label: &str, text: &str) -> UserTodo {
    match store_path_for(project_id) {
        Some(path) => add_at(Some(&path), origin_session_id, origin_label, text),
        None => add_at(None, origin_session_id, origin_label, text),
    }
}

fn add_at(path: Option<&Path>, origin_session_id: &str, origin_label: &str, text: &str) -> UserTodo {
    let stamp = now();
    let todo = UserTodo {
        id: uuid::Uuid::new_v4().to_string(),
        text: clamp(text),
        origin_session_id: origin_session_id.to_string(),
        origin_label: origin_label.to_string(),
        state: TodoState::Open,
        dropped: false,
        drop_reason: String::new(),
        previous_text: String::new(),
        by_ai: true,
        created_at: stamp.clone(),
        updated_at: stamp,
        // The AI just wrote it, so there is nothing unseen about it yet.
        seen_by_origin: true,
    };
    if let Some(path) = path {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut todos = load(path);
        todos.push(todo.clone());
        prune(&mut todos);
        write_atomic(path, &todos);
    }
    todo
}

/// Applies `mutate` to the card with `id` and persists. Returns the mutated
/// card, or None if this project has no such id.
fn mutate_at(path: &Path, id: &str, mutate: impl FnOnce(&mut UserTodo)) -> Option<UserTodo> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut todos = load(path);
    let found = todos.iter_mut().find(|t| t.id == id)?;
    mutate(&mut *found);
    found.updated_at = now();
    let updated = found.clone();
    write_atomic(path, &todos);
    Some(updated)
}

fn mutate(project_id: &str, id: &str, mutate_fn: impl FnOnce(&mut UserTodo)) -> Option<UserTodo> {
    let path = store_path_for(project_id)?;
    mutate_at(&path, id, mutate_fn)
}

/// AI rewrite: the old text is kept so the panel can strike it under the new.
pub fn rewrite(project_id: &str, id: &str, text: &str) -> Option<UserTodo> {
    let text = clamp(text);
    mutate(project_id, id, |t| {
        t.previous_text = std::mem::replace(&mut t.text, text);
        t.by_ai = true;
    })
}

/// AI drop: archived as no-longer-needed, carrying its reason onto the card.
pub fn drop_todo(project_id: &str, id: &str, reason: &str) -> Option<UserTodo> {
    let reason = clamp(reason);
    mutate(project_id, id, |t| {
        t.state = TodoState::Archived;
        t.dropped = true;
        t.drop_reason = reason;
        t.by_ai = true;
    })
}

/// State change. A Joe-side one clears `seen_by_origin`, which is what raises
/// the notify CTA; an AI-side one leaves it alone (the AI already knows).
pub fn set_state(project_id: &str, id: &str, state: TodoState, by_ai: bool) -> Option<UserTodo> {
    mutate(project_id, id, |t| {
        t.state = state;
        t.by_ai = by_ai;
        if state != TodoState::Archived {
            t.dropped = false;
            t.drop_reason = String::new();
        }
        if !by_ai {
            t.seen_by_origin = false;
        }
    })
}

/// Marks every card authored by `origin_session_id` as seen; returns how many
/// flipped. Called by the injection hook, so the CTA clears without a click.
pub fn mark_seen(project_id: &str, origin_session_id: &str) -> usize {
    let Some(path) = store_path_for(project_id) else { return 0 };
    mark_seen_at(&path, origin_session_id)
}

fn mark_seen_at(path: &Path, origin_session_id: &str) -> usize {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut todos = load(path);
    let mut flipped = 0usize;
    for t in todos.iter_mut() {
        if t.origin_session_id == origin_session_id && !t.seen_by_origin {
            t.seen_by_origin = true;
            flipped += 1;
        }
    }
    if flipped > 0 {
        write_atomic(path, &todos);
    }
    flipped
}

/// Explicit "Clear archived" action. v1 never prunes archived cards on a timer.
pub fn clear_archived(project_id: &str) -> usize {
    let Some(path) = store_path_for(project_id) else { return 0 };
    clear_archived_at(&path)
}

fn clear_archived_at(path: &Path) -> usize {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut todos = load(path);
    let before = todos.len();
    todos.retain(|t| t.state != TodoState::Archived);
    let removed = before - todos.len();
    if removed > 0 {
        write_atomic(path, &todos);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn seed(path: &Path, n: usize, session: &str) -> Vec<UserTodo> {
        (0..n).map(|i| add_at(Some(path), session, "chat A", &format!("todo {i}"))).collect()
    }

    #[test]
    fn list_on_missing_file_returns_empty() {
        assert_eq!(list("nonexistent-project-id-xyz"), Vec::new());
    }

    #[test]
    fn add_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let todo = add_at(Some(&path), "s1", "push-notifs", "grab a token");
        assert_eq!(todo.state, TodoState::Open);
        assert!(todo.by_ai, "an added card is the AI's");
        assert!(todo.seen_by_origin, "nothing unseen about a card the AI just wrote");
        let loaded = list_at(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, todo.id);
        assert_eq!(loaded[0].origin_label, "push-notifs");
    }

    #[test]
    fn add_truncates_overlong_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let long = "x".repeat(MAX_TEXT_LEN + 500);
        let todo = add_at(Some(&path), "s1", "chat A", &long);
        assert_eq!(todo.text.chars().count(), MAX_TEXT_LEN);
        // Persisted copy must match the returned one - the daemon method
        // responds from the returned card, not the raw argument.
        assert_eq!(list_at(&path)[0].text.chars().count(), MAX_TEXT_LEN);
    }

    #[test]
    fn add_at_with_no_path_still_returns_truncated_card() {
        let long = "x".repeat(MAX_TEXT_LEN + 500);
        let todo = add_at(None, "s1", "chat A", &long);
        assert_eq!(todo.text.chars().count(), MAX_TEXT_LEN);
    }

    #[test]
    fn overflow_drops_archived_before_open() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let seeded = seed(&path, MAX_TODOS, "s1");
        // Archive the two OLDEST cards, then overflow by two.
        for t in seeded.iter().take(2) {
            set_state_at(&path, &t.id, TodoState::Archived, true);
        }
        add_at(Some(&path), "s1", "chat A", "overflow 1");
        add_at(Some(&path), "s1", "chat A", "overflow 2");

        let loaded = list_at(&path);
        assert_eq!(loaded.len(), MAX_TODOS);
        assert!(
            loaded.iter().all(|t| t.state != TodoState::Archived),
            "the two archived cards must be the ones dropped"
        );
        assert!(
            loaded.iter().any(|t| t.text == "overflow 2"),
            "the newly added card must survive"
        );
    }

    #[test]
    fn overflow_falls_back_to_open_when_nothing_else_to_drop() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        seed(&path, MAX_TODOS + 3, "s1");
        let loaded = list_at(&path);
        assert_eq!(loaded.len(), MAX_TODOS);
        assert_eq!(loaded[0].text, "todo 3", "oldest open cards dropped first");
    }

    // Thin wrappers so the tests drive the real mutators through the path seam.
    fn set_state_at(path: &Path, id: &str, state: TodoState, by_ai: bool) -> Option<UserTodo> {
        mutate_at(path, id, |t| {
            t.state = state;
            t.by_ai = by_ai;
            if state != TodoState::Archived {
                t.dropped = false;
                t.drop_reason = String::new();
            }
            if !by_ai {
                t.seen_by_origin = false;
            }
        })
    }

    #[test]
    fn seen_by_origin_lifecycle() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let todo = add_at(Some(&path), "s1", "chat A", "grab a token");
        assert!(todo.seen_by_origin);

        // Joe ticks it: now unseen, which is what raises the CTA.
        let ticked = set_state_at(&path, &todo.id, TodoState::Done, false).unwrap();
        assert!(!ticked.seen_by_origin);
        assert!(!ticked.by_ai, "a Joe tick is not labelled as the AI's");

        // A turn from the authoring session consumes it: CTA clears itself.
        assert_eq!(mark_seen_at(&path, "s1"), 1);
        assert!(list_at(&path)[0].seen_by_origin);
        // Idempotent - a second turn flips nothing and rewrites nothing.
        assert_eq!(mark_seen_at(&path, "s1"), 0);
    }

    #[test]
    fn mark_seen_only_touches_the_authoring_session() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let mine = add_at(Some(&path), "s1", "chat A", "mine");
        let theirs = add_at(Some(&path), "s2", "chat B", "theirs");
        set_state_at(&path, &mine.id, TodoState::Done, false);
        set_state_at(&path, &theirs.id, TodoState::Done, false);

        assert_eq!(mark_seen_at(&path, "s1"), 1);
        let loaded = list_at(&path);
        let by_id = |id: &str| loaded.iter().find(|t| t.id == id).unwrap();
        assert!(by_id(&mine.id).seen_by_origin);
        assert!(!by_id(&theirs.id).seen_by_origin, "another chat's card stays unseen");
    }

    #[test]
    fn rewrite_keeps_the_previous_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let todo = add_at(Some(&path), "s1", "chat A", "old wording");
        let after = mutate_at(&path, &todo.id, |t| {
            t.previous_text = std::mem::replace(&mut t.text, "new wording".to_string());
            t.by_ai = true;
        })
        .unwrap();
        assert_eq!(after.text, "new wording");
        assert_eq!(after.previous_text, "old wording");
    }

    #[test]
    fn untick_clears_the_dropped_marker() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let todo = add_at(Some(&path), "s1", "chat A", "grab a token");
        mutate_at(&path, &todo.id, |t| {
            t.state = TodoState::Archived;
            t.dropped = true;
            t.drop_reason = "wrangler did it".to_string();
        });
        let back = set_state_at(&path, &todo.id, TodoState::Open, false).unwrap();
        assert!(!back.dropped, "reopening must clear the AI's drop marker");
        assert_eq!(back.drop_reason, "");
    }

    #[test]
    fn clear_archived_leaves_open_and_done_alone() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let a = add_at(Some(&path), "s1", "chat A", "open one");
        let b = add_at(Some(&path), "s1", "chat A", "done one");
        let c = add_at(Some(&path), "s1", "chat A", "archived one");
        set_state_at(&path, &b.id, TodoState::Done, false);
        set_state_at(&path, &c.id, TodoState::Archived, true);

        assert_eq!(clear_archived_at(&path), 1);
        let ids: Vec<String> = list_at(&path).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![a.id, b.id]);
        assert_eq!(clear_archived_at(&path), 0, "second call is a no-op");
    }

    #[test]
    fn mutating_an_unknown_id_returns_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        add_at(Some(&path), "s1", "chat A", "grab a token");
        assert!(set_state_at(&path, "not-an-id", TodoState::Done, false).is_none());
    }
}
