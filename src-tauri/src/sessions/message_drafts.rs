//! Durable store for draft messages Claude writes for the user to send
//! elsewhere (todo 666). File `<app-data>/message-drafts/<project_id>.json`,
//! daemon is sole writer, same shape and trust model as `user_todos`.
//! One card is one TOPIC; recipients are variants inside it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DraftState {
    /// Written or edited, not yet acted on.
    #[default]
    NeedsYou,
    Ready,
    /// Set when Copy is actually pressed. Inferred, never claimed - nothing
    /// here can see whether it reached Slack.
    Copied,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DraftAuthor {
    #[default]
    Ai,
    User,
}

/// Where one claim in the body came from: a `file:line`, a command's output, or
/// the user's own words. The reviewer (chunk 2) checks the text against these.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftReceipt {
    pub claim: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftVersion {
    pub n: u32,
    /// Markdown. Kept as text, not HTML, so a later diff against the user's
    /// edit is exact and the plain-text clipboard payload is free.
    pub body: String,
    pub author: DraftAuthor,
    pub note: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftVariant {
    pub recipient: String,
    /// The `#n` in "Bruno #2": per person, project-wide, never reused.
    pub handle_n: u32,
    pub versions: Vec<DraftVersion>,
    pub current: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct MessageDraft {
    pub id: String,
    pub topic: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub receipts: Vec<DraftReceipt>,
    pub variants: Vec<DraftVariant>,
    #[serde(default)]
    pub state: DraftState,
    pub origin_session_id: String,
    /// Registry `name` at write time, same rule as `UserTodo::origin_label`:
    /// a renamed session keeps the label its cards were written under.
    pub origin_label: String,
    pub created_at: String,
    pub updated_at: String,
    /// False after a user-side edit, true once a turn from the authoring
    /// session has been served the change. Same contract as `UserTodo`.
    #[serde(default)]
    pub seen_by_origin: bool,
}

/// Persisted as an object rather than a bare array because `handles` must
/// outlive the drafts it counted - a pruned card must not free its number.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    drafts: Vec<MessageDraft>,
    #[serde(default)]
    handles: BTreeMap<String, u32>,
}

const MAX_DRAFTS: usize = 100;
const MAX_VERSIONS: usize = 30;
pub(crate) const MAX_BODY_LEN: usize = 8000;
pub(crate) const MAX_SHORT_LEN: usize = 200;
const MAX_RECEIPTS: usize = 40;

/// Same rationale as `user_todos::WRITE_LOCK` - cross-process integrity comes
/// from the atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn store_path_for(project_id: &str) -> Option<PathBuf> {
    let dir = crate::settings::paths::data_dir().ok()?.join("message-drafts");
    Some(dir.join(format!("{project_id}.json")))
}

fn load(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, store: &Store) {
    let json = match serde_json::to_string_pretty(store) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("message_drafts: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("message_drafts: write failed: {e}");
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn clamp(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Drops Copied first, then Ready - never a card still marked NeedsYou, which
/// is the one outcome this store must not silently produce.
fn prune(drafts: &mut Vec<MessageDraft>) {
    if drafts.len() <= MAX_DRAFTS {
        return;
    }
    let mut excess = drafts.len() - MAX_DRAFTS;
    for state in [DraftState::Copied, DraftState::Ready, DraftState::NeedsYou] {
        if excess == 0 {
            break;
        }
        drafts.retain(|d| {
            if excess > 0 && d.state == state {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

/// Keeps v1 as the origin point plus the most recent tail, so Revert always has
/// somewhere to land even on a heavily iterated card.
fn prune_versions(versions: &mut Vec<DraftVersion>) {
    if versions.len() <= MAX_VERSIONS {
        return;
    }
    let keep_tail = MAX_VERSIONS - 1;
    let first = versions.remove(0);
    let drop = versions.len() - keep_tail;
    versions.drain(0..drop);
    versions.insert(0, first);
}

fn norm_recipient(recipient: &str) -> String {
    recipient.trim().to_lowercase()
}

fn next_version_n(variant: &DraftVariant) -> u32 {
    variant.versions.iter().map(|v| v.n).max().unwrap_or(0) + 1
}

fn push_version(variant: &mut DraftVariant, body: &str, author: DraftAuthor, note: &str) {
    let n = next_version_n(variant);
    variant.versions.push(DraftVersion {
        n,
        body: clamp(body, MAX_BODY_LEN),
        author,
        note: clamp(note, MAX_SHORT_LEN),
        created_at: now(),
    });
    prune_versions(&mut variant.versions);
    variant.current = n;
}

// ── Public API ───────────────────────────────────────────────────────────────

/// All cards for a project, oldest first. Empty (never an error) for a project
/// with no file yet.
pub fn list(project_id: &str) -> Vec<MessageDraft> {
    match store_path_for(project_id) {
        Some(path) => load(&path).drafts,
        None => Vec::new(),
    }
}

pub struct NewDraft<'a> {
    pub topic: &'a str,
    pub recipient: &'a str,
    pub body: &'a str,
    pub brief: &'a str,
    pub receipts: Vec<DraftReceipt>,
    pub origin_session_id: &'a str,
    pub origin_label: &'a str,
}

pub fn add(project_id: &str, new: NewDraft<'_>) -> Option<MessageDraft> {
    let path = store_path_for(project_id)?;
    add_at(&path, new)
}

fn add_at(path: &Path, new: NewDraft<'_>) -> Option<MessageDraft> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(path);
    let handle_n = allocate_handle(&mut store, new.recipient);
    let stamp = now();
    let mut variant = DraftVariant {
        recipient: clamp(new.recipient.trim(), MAX_SHORT_LEN),
        handle_n,
        versions: Vec::new(),
        current: 0,
    };
    push_version(&mut variant, new.body, DraftAuthor::Ai, "first pass");
    let draft = MessageDraft {
        id: uuid::Uuid::new_v4().to_string(),
        topic: clamp(new.topic.trim(), MAX_SHORT_LEN),
        brief: clamp(new.brief, MAX_BODY_LEN),
        receipts: new.receipts.into_iter().take(MAX_RECEIPTS).collect(),
        variants: vec![variant],
        state: DraftState::NeedsYou,
        origin_session_id: new.origin_session_id.to_string(),
        origin_label: new.origin_label.to_string(),
        created_at: stamp.clone(),
        updated_at: stamp,
        // The AI just wrote it, so there is nothing unseen about it yet.
        seen_by_origin: true,
    };
    store.drafts.push(draft.clone());
    prune(&mut store.drafts);
    write_atomic(path, &store);
    Some(draft)
}

/// Bumps this person's counter and hands back the new number. Never decreases,
/// so a pruned card cannot hand its `#n` to someone else later.
fn allocate_handle(store: &mut Store, recipient: &str) -> u32 {
    let key = norm_recipient(recipient);
    let next = store.handles.get(&key).copied().unwrap_or(0) + 1;
    store.handles.insert(key, next);
    next
}

fn mutate_at(
    path: &Path,
    id: &str,
    mutate: impl FnOnce(&mut MessageDraft, &mut BTreeMap<String, u32>) -> Result<(), String>,
) -> Result<MessageDraft, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(path);
    let mut handles = std::mem::take(&mut store.handles);
    let found = store
        .drafts
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("no such draft: {id}"))?;
    mutate(found, &mut handles)?;
    found.updated_at = now();
    let updated = found.clone();
    store.handles = handles;
    write_atomic(path, &store);
    Ok(updated)
}

fn mutate(
    project_id: &str,
    id: &str,
    f: impl FnOnce(&mut MessageDraft, &mut BTreeMap<String, u32>) -> Result<(), String>,
) -> Result<MessageDraft, String> {
    let path = store_path_for(project_id).ok_or_else(|| "no data dir".to_string())?;
    mutate_at(&path, id, f)
}

/// Finds the variant to act on. An empty recipient means the only variant, and
/// is an error on a multi-recipient card rather than a silent pick.
fn variant_index(draft: &MessageDraft, recipient: &str) -> Result<usize, String> {
    if recipient.trim().is_empty() {
        return match draft.variants.len() {
            1 => Ok(0),
            _ => Err("recipient is required: this draft has more than one".to_string()),
        };
    }
    let key = norm_recipient(recipient);
    draft
        .variants
        .iter()
        .position(|v| norm_recipient(&v.recipient) == key)
        .ok_or_else(|| format!("no variant for recipient: {recipient}"))
}

/// A new AI version on an existing variant.
pub fn revise(project_id: &str, id: &str, recipient: &str, body: &str, note: &str) -> Result<MessageDraft, String> {
    mutate(project_id, id, |d, _| {
        let i = variant_index(d, recipient)?;
        push_version(&mut d.variants[i], body, DraftAuthor::Ai, note);
        d.state = DraftState::NeedsYou;
        Ok(())
    })
}

/// A second recipient for the same topic: same card, its own version track.
pub fn add_variant(project_id: &str, id: &str, recipient: &str, body: &str) -> Result<MessageDraft, String> {
    if recipient.trim().is_empty() {
        return Err("recipient is required to add a variant".to_string());
    }
    mutate(project_id, id, |d, handles| {
        if variant_index(d, recipient).is_ok() {
            return Err(format!("draft already has a variant for {recipient}"));
        }
        let key = norm_recipient(recipient);
        let handle_n = handles.get(&key).copied().unwrap_or(0) + 1;
        handles.insert(key, handle_n);
        let mut variant = DraftVariant {
            recipient: clamp(recipient.trim(), MAX_SHORT_LEN),
            handle_n,
            versions: Vec::new(),
            current: 0,
        };
        push_version(&mut variant, body, DraftAuthor::Ai, "first pass");
        d.variants.push(variant);
        d.state = DraftState::NeedsYou;
        Ok(())
    })
}

/// The user's own edit. Coalesces into his own newest version rather than
/// appending one per autosave, so the version list stays one entry per
/// divergence from an AI version instead of one per typing pause.
pub fn set_body(project_id: &str, id: &str, recipient: &str, body: &str) -> Result<MessageDraft, String> {
    mutate(project_id, id, |d, _| {
        let i = variant_index(d, recipient)?;
        set_body_on(&mut d.variants[i], body);
        d.state = DraftState::NeedsYou;
        d.seen_by_origin = false;
        Ok(())
    })
}

fn set_body_on(variant: &mut DraftVariant, body: &str) {
    let amendable = variant
        .versions
        .last()
        .map(|v| v.author == DraftAuthor::User && v.n == variant.current)
        .unwrap_or(false);
    match amendable {
        true => {
            let last = variant.versions.last_mut().expect("amendable implies a last version");
            last.body = clamp(body, MAX_BODY_LEN);
            last.created_at = now();
        }
        false => push_version(variant, body, DraftAuthor::User, "your edit"),
    }
}

/// Revert: makes an existing version current instead of deleting the ones after it.
pub fn set_current_version(project_id: &str, id: &str, recipient: &str, n: u32) -> Result<MessageDraft, String> {
    mutate(project_id, id, |d, _| {
        let i = variant_index(d, recipient)?;
        if !d.variants[i].versions.iter().any(|v| v.n == n) {
            return Err(format!("no such version: v{n}"));
        }
        d.variants[i].current = n;
        Ok(())
    })
}

pub fn set_state(project_id: &str, id: &str, state: DraftState) -> Result<MessageDraft, String> {
    mutate(project_id, id, |d, _| {
        d.state = state;
        Ok(())
    })
}

pub fn remove(project_id: &str, id: &str) -> Result<bool, String> {
    let path = store_path_for(project_id).ok_or_else(|| "no data dir".to_string())?;
    remove_at(&path, id)
}

fn remove_at(path: &Path, id: &str) -> Result<bool, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(path);
    let before = store.drafts.len();
    store.drafts.retain(|d| d.id != id);
    let removed = store.drafts.len() != before;
    if removed {
        write_atomic(path, &store);
    }
    Ok(removed)
}

/// Marks every card authored by `origin_session_id` as seen; returns how many
/// flipped. Called by the injection hook, so the block is served exactly once.
pub fn mark_seen(project_id: &str, origin_session_id: &str) -> usize {
    let Some(path) = store_path_for(project_id) else { return 0 };
    mark_seen_at(&path, origin_session_id)
}

fn mark_seen_at(path: &Path, origin_session_id: &str) -> usize {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(path);
    let mut flipped = 0usize;
    for d in store.drafts.iter_mut() {
        if d.origin_session_id == origin_session_id && !d.seen_by_origin {
            d.seen_by_origin = true;
            flipped += 1;
        }
    }
    if flipped > 0 {
        write_atomic(path, &store);
    }
    flipped
}

/// The newest version this variant got from the AI, which is what a user edit
/// diverged FROM - the other half of the diff the injected block carries.
pub fn last_ai_body(variant: &DraftVariant) -> &str {
    variant
        .versions
        .iter()
        .rev()
        .find(|v| v.author == DraftAuthor::Ai)
        .map(|v| v.body.as_str())
        .unwrap_or("")
}

/// "Bruno #2". The speakable id the injected block and the panel both use.
pub fn handle_of(variant: &DraftVariant) -> String {
    format!("{} #{}", variant.recipient, variant.handle_n)
}

/// The version the card is currently showing for this variant.
pub fn current_body(variant: &DraftVariant) -> &str {
    variant
        .versions
        .iter()
        .find(|v| v.n == variant.current)
        .or_else(|| variant.versions.last())
        .map(|v| v.body.as_str())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn new_draft<'a>(topic: &'a str, recipient: &'a str, body: &'a str) -> NewDraft<'a> {
        NewDraft {
            topic,
            recipient,
            body,
            brief: "",
            receipts: Vec::new(),
            origin_session_id: "s1",
            origin_label: "chat A",
        }
    }

    fn store_at(path: &Path) -> Store {
        load(path)
    }

    #[test]
    fn list_on_missing_file_returns_empty() {
        assert_eq!(list("nonexistent-project-id-xyz"), Vec::new());
    }

    #[test]
    fn add_creates_one_variant_at_v1() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let d = add_at(&path, new_draft("Sprint slip", "Bruno", "hey bruno")).unwrap();
        assert_eq!(d.variants.len(), 1);
        assert_eq!(d.variants[0].handle_n, 1);
        assert_eq!(d.variants[0].current, 1);
        assert_eq!(current_body(&d.variants[0]), "hey bruno");
        assert_eq!(handle_of(&d.variants[0]), "Bruno #1");
        assert_eq!(d.state, DraftState::NeedsYou);
    }

    #[test]
    fn handles_count_per_person_and_never_repeat() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        add_at(&path, new_draft("Topic A", "Bruno", "a")).unwrap();
        let ana = add_at(&path, new_draft("Topic B", "Ana", "b")).unwrap();
        let bruno2 = add_at(&path, new_draft("Topic C", "Bruno", "c")).unwrap();
        assert_eq!(ana.variants[0].handle_n, 1, "a different person starts at 1");
        assert_eq!(bruno2.variants[0].handle_n, 2);
        // Case and padding must not fork the counter into two people.
        let bruno3 = add_at(&path, new_draft("Topic D", "  bruno ", "d")).unwrap();
        assert_eq!(bruno3.variants[0].handle_n, 3);
    }

    #[test]
    fn deleting_a_draft_does_not_free_its_handle() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let first = add_at(&path, new_draft("Topic A", "Bruno", "a")).unwrap();
        assert!(remove_at(&path, &first.id).unwrap());
        let next = add_at(&path, new_draft("Topic B", "Bruno", "b")).unwrap();
        assert_eq!(next.variants[0].handle_n, 2, "#1 is burned even though its card is gone");
    }

    #[test]
    fn revise_appends_a_version_and_keeps_the_old_one() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let d = add_at(&path, new_draft("Sprint slip", "Bruno", "v1 body")).unwrap();
        let after = mutate_at(&path, &d.id, |d, _| {
            let i = variant_index(d, "")?;
            push_version(&mut d.variants[i], "v2 body", DraftAuthor::Ai, "softened");
            Ok(())
        })
        .unwrap();
        assert_eq!(after.variants[0].versions.len(), 2);
        assert_eq!(after.variants[0].current, 2);
        assert_eq!(current_body(&after.variants[0]), "v2 body");
        assert_eq!(after.variants[0].versions[0].body, "v1 body");
    }

    #[test]
    fn a_second_variant_shares_the_card_and_gets_its_own_handle() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let d = add_at(&path, new_draft("Sprint slip", "Bruno", "technical")).unwrap();
        let after = mutate_at(&path, &d.id, |d, handles| {
            let key = norm_recipient("Ana");
            let n = handles.get(&key).copied().unwrap_or(0) + 1;
            handles.insert(key, n);
            let mut v = DraftVariant { recipient: "Ana".into(), handle_n: n, versions: vec![], current: 0 };
            push_version(&mut v, "plain", DraftAuthor::Ai, "first pass");
            d.variants.push(v);
            Ok(())
        })
        .unwrap();
        assert_eq!(after.variants.len(), 2);
        assert_eq!(handle_of(&after.variants[1]), "Ana #1");
        // The handle map must have persisted, not just the in-memory copy.
        assert_eq!(store_at(&path).handles.get("ana").copied(), Some(1));
    }

    #[test]
    fn variant_index_refuses_to_guess_on_a_multi_recipient_card() {
        let mut d = MessageDraft {
            id: "x".into(),
            topic: "t".into(),
            brief: String::new(),
            receipts: vec![],
            variants: vec![],
            state: DraftState::NeedsYou,
            origin_session_id: "s1".into(),
            origin_label: "chat A".into(),
            created_at: "now".into(),
            updated_at: "now".into(),
            seen_by_origin: true,
        };
        for name in ["Bruno", "Ana"] {
            d.variants.push(DraftVariant {
                recipient: name.into(),
                handle_n: 1,
                versions: vec![],
                current: 0,
            });
        }
        assert!(variant_index(&d, "").is_err());
        assert_eq!(variant_index(&d, "ana").unwrap(), 1);
        assert!(variant_index(&d, "Marko").is_err());
    }

    #[test]
    fn body_is_truncated_on_the_way_in() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let long = "x".repeat(MAX_BODY_LEN + 500);
        let d = add_at(&path, new_draft("t", "Bruno", &long)).unwrap();
        assert_eq!(current_body(&d.variants[0]).chars().count(), MAX_BODY_LEN);
    }

    #[test]
    fn version_pruning_keeps_v1_and_the_recent_tail() {
        let mut versions: Vec<DraftVersion> = (1..=MAX_VERSIONS as u32 + 5)
            .map(|n| DraftVersion {
                n,
                body: format!("body {n}"),
                author: DraftAuthor::Ai,
                note: String::new(),
                created_at: "now".into(),
            })
            .collect();
        prune_versions(&mut versions);
        assert_eq!(versions.len(), MAX_VERSIONS);
        assert_eq!(versions[0].n, 1, "the origin version survives");
        assert_eq!(versions.last().unwrap().n, MAX_VERSIONS as u32 + 5);
    }

    #[test]
    fn overflow_drops_copied_before_needs_you() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let mut ids = Vec::new();
        for i in 0..MAX_DRAFTS {
            ids.push(add_at(&path, new_draft(&format!("topic {i}"), "Bruno", "b")).unwrap().id);
        }
        for id in ids.iter().take(2) {
            mutate_at(&path, id, |d, _| {
                d.state = DraftState::Copied;
                Ok(())
            })
            .unwrap();
        }
        add_at(&path, new_draft("overflow 1", "Bruno", "b")).unwrap();
        add_at(&path, new_draft("overflow 2", "Bruno", "b")).unwrap();

        let drafts = store_at(&path).drafts;
        assert_eq!(drafts.len(), MAX_DRAFTS);
        assert!(drafts.iter().all(|d| d.state != DraftState::Copied));
        assert!(drafts.iter().any(|d| d.topic == "overflow 2"));
    }

    #[test]
    fn current_body_falls_back_when_current_points_nowhere() {
        let v = DraftVariant {
            recipient: "Bruno".into(),
            handle_n: 1,
            versions: vec![DraftVersion {
                n: 1,
                body: "only".into(),
                author: DraftAuthor::Ai,
                note: String::new(),
                created_at: "now".into(),
            }],
            current: 99,
        };
        assert_eq!(current_body(&v), "only");
        let empty = DraftVariant { recipient: "X".into(), handle_n: 1, versions: vec![], current: 0 };
        assert_eq!(current_body(&empty), "");
    }

    #[test]
    fn repeated_autosaves_amend_one_version_instead_of_stacking() {
        let mut v = variant_with_ai("v1 body");
        set_body_on(&mut v, "typing");
        set_body_on(&mut v, "typing more");
        assert_eq!(v.versions.len(), 2, "one AI version plus one edit of his own");
        assert_eq!(current_body(&v), "typing more");
        assert_eq!(v.versions[0].body, "v1 body");
    }

    #[test]
    fn editing_after_a_revert_starts_a_new_version() {
        let mut v = variant_with_ai("v1 body");
        push_version(&mut v, "v2 body", DraftAuthor::Ai, "");
        set_body_on(&mut v, "his v3");
        // Revert to v1, then type: his v3 must survive as its own version.
        v.current = 1;
        set_body_on(&mut v, "his v4");
        assert_eq!(v.versions.len(), 4);
        assert_eq!(v.versions[2].body, "his v3");
        assert_eq!(current_body(&v), "his v4");
    }

    fn variant_with_ai(body: &str) -> DraftVariant {
        let mut v = DraftVariant { recipient: "Bruno".into(), handle_n: 1, versions: vec![], current: 0 };
        push_version(&mut v, body, DraftAuthor::Ai, "first pass");
        v
    }

    #[test]
    fn mutating_an_unknown_id_is_an_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        add_at(&path, new_draft("t", "Bruno", "b")).unwrap();
        assert!(mutate_at(&path, "not-an-id", |_, _| Ok(())).is_err());
        assert!(!remove_at(&path, "not-an-id").unwrap());
    }
}
