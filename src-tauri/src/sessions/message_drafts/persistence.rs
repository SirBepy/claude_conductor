//! Raw file IO for the on-disk `Store` (load/write, the two overflow prunes)
//! plus the recipient-lookup helpers every mutation needs. Draft-mutation
//! business logic lives in the sibling `api` module.

use super::types::{DraftState, DraftVersion, MessageDraft, Store};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(super) const MAX_DRAFTS: usize = 100;
const MAX_VERSIONS: usize = 30;

/// Same rationale as `user_todos::WRITE_LOCK` - cross-process integrity comes
/// from the atomic rename, not this lock.
pub(super) static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn store_path_for(project_id: &str) -> Option<PathBuf> {
    let dir = crate::settings::paths::data_dir().ok()?.join("message-drafts");
    Some(dir.join(format!("{project_id}.json")))
}

pub(super) fn load(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(super) fn write_atomic(path: &Path, store: &Store) {
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

/// Drops Copied first, then Ready - never a card still marked NeedsYou, which
/// is the one outcome this store must not silently produce.
pub(super) fn prune(drafts: &mut Vec<MessageDraft>) {
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
pub(super) fn prune_versions(versions: &mut Vec<DraftVersion>) {
    if versions.len() <= MAX_VERSIONS {
        return;
    }
    let keep_tail = MAX_VERSIONS - 1;
    let first = versions.remove(0);
    let drop = versions.len() - keep_tail;
    versions.drain(0..drop);
    versions.insert(0, first);
}

pub(super) fn norm_recipient(recipient: &str) -> String {
    recipient.trim().to_lowercase()
}

/// Finds the variant to act on. An empty recipient means the only variant, and
/// is an error on a multi-recipient card rather than a silent pick.
pub(super) fn variant_index(draft: &MessageDraft, recipient: &str) -> Result<usize, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::DraftAuthor;

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
}
