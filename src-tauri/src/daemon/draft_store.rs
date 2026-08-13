//! In-memory cross-surface draft store: composer text, AUQ partial answers,
//! and the held-message queue, fetched on demand per session
//! (`daemon::methods::drafts`). `Instance.held_count` is the cheap sibling
//! signal that DOES ride `instances_changed` - see that field's doc.

//! Never persisted: every surface already keeps its own localStorage copy,
//! which survives a daemon restart on its own - adding daemon persistence
//! here would add risk without adding durability.

use crate::types::ContentBlock;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Hard cap on tracked sessions. Bounds memory regardless of how a session
/// ends (a crash or force-kill never fires a cleanup hook, so tying eviction
/// to session-end would be unreliable). Generous for a single-user daemon;
/// the least-recently-touched entry is dropped to make room for a new one.
const MAX_SESSIONS: usize = 200;

#[derive(Clone, Serialize, Default)]
pub struct ComposerDraft {
    pub text: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
pub struct AuqDraft {
    pub prompt_id: String,
    pub payload: Value,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
pub struct HeldDraftItem {
    pub id: u64,
    pub blocks: Vec<ContentBlock>,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Default)]
pub struct SessionDrafts {
    pub composer: Option<ComposerDraft>,
    pub auq: Option<AuqDraft>,
    pub held: Vec<HeldDraftItem>,
    pub held_updated_at: Option<String>,
}

struct Entry {
    drafts: SessionDrafts,
    next_held_id: u64,
    touched_seq: u64,
}

pub struct DraftStore {
    inner: Mutex<HashMap<String, Entry>>,
    /// Monotonic counter (not wall-clock) so LRU ordering is deterministic
    /// under test and immune to clock-resolution ties.
    seq: AtomicU64,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl DraftStore {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()), seq: AtomicU64::new(0) }
    }

    /// Get-or-create `session_id`'s entry, evicting the least-recently-
    /// touched one first if already at [`MAX_SESSIONS`]. Every write path
    /// goes through this so activity always refreshes LRU position.
    fn touch<'a>(&self, map: &'a mut HashMap<String, Entry>, session_id: &str) -> &'a mut Entry {
        if !map.contains_key(session_id) && map.len() >= MAX_SESSIONS {
            if let Some(victim) = map.iter().min_by_key(|(_, e)| e.touched_seq).map(|(k, _)| k.clone()) {
                map.remove(&victim);
            }
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let entry = map.entry(session_id.to_string()).or_insert_with(|| {
            Entry { drafts: SessionDrafts::default(), next_held_id: 1, touched_seq: seq }
        });
        entry.touched_seq = seq;
        entry
    }

    /// Full snapshot for one session - the single round trip a freshly-opened
    /// surface needs to reconcile without trusting the lossy broadcast. A
    /// pure read never creates or evicts an entry.
    pub fn get(&self, session_id: &str) -> SessionDrafts {
        self.inner.lock().unwrap().get(session_id).map(|e| e.drafts.clone()).unwrap_or_default()
    }

    pub fn set_composer(&self, session_id: &str, text: String) -> String {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        self.touch(&mut map, session_id).drafts.composer = Some(ComposerDraft { text, updated_at: now.clone() });
        now
    }

    pub fn clear_composer(&self, session_id: &str) -> String {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get_mut(session_id) {
            e.drafts.composer = None;
        }
        now
    }

    pub fn set_auq(&self, session_id: &str, prompt_id: String, payload: Value) -> String {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        self.touch(&mut map, session_id).drafts.auq = Some(AuqDraft { prompt_id, payload, updated_at: now.clone() });
        now
    }

    /// Clears the AUQ draft only if `prompt_id` matches what's stored - a
    /// stale clear from a superseded prompt's UI must not wipe a newer
    /// prompt's in-progress draft. Returns whether it actually cleared.
    pub fn clear_auq(&self, session_id: &str, prompt_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        let Some(e) = map.get_mut(session_id) else { return false };
        if e.drafts.auq.as_ref().map(|a| a.prompt_id.as_str()) != Some(prompt_id) {
            return false;
        }
        e.drafts.auq = None;
        true
    }

    pub fn add_held(&self, session_id: &str, blocks: Vec<ContentBlock>) -> (u64, String) {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        let e = self.touch(&mut map, session_id);
        let id = e.next_held_id;
        e.next_held_id += 1;
        e.drafts.held.push(HeldDraftItem { id, blocks, updated_at: now.clone() });
        e.drafts.held_updated_at = Some(now.clone());
        (id, now)
    }

    pub fn update_held(&self, session_id: &str, id: u64, blocks: Vec<ContentBlock>) -> Option<String> {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        let e = map.get_mut(session_id)?;
        let item = e.drafts.held.iter_mut().find(|i| i.id == id)?;
        item.blocks = blocks;
        item.updated_at = now.clone();
        e.drafts.held_updated_at = Some(now.clone());
        Some(now)
    }

    pub fn remove_held(&self, session_id: &str, id: u64) -> Option<String> {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        let e = map.get_mut(session_id)?;
        let before = e.drafts.held.len();
        e.drafts.held.retain(|i| i.id != id);
        if e.drafts.held.len() == before {
            return None;
        }
        e.drafts.held_updated_at = Some(now.clone());
        Some(now)
    }

    pub fn clear_held(&self, session_id: &str) -> String {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get_mut(session_id) {
            e.drafts.held.clear();
            e.drafts.held_updated_at = Some(now.clone());
        }
        now
    }

    pub fn held_count(&self, session_id: &str) -> usize {
        self.inner.lock().unwrap().get(session_id).map(|e| e.drafts.held.len()).unwrap_or(0)
    }
}

impl Default for DraftStore {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_composer_draft() {
        let s = DraftStore::new();
        let t = s.set_composer("a", "hi".into());
        assert_eq!(s.get("a").composer.unwrap().text, "hi");
        assert!(!t.is_empty());
    }

    #[test]
    fn writing_one_kind_leaves_others_intact() {
        let s = DraftStore::new();
        s.set_composer("a", "text".into());
        s.set_auq("a", "p1".into(), serde_json::json!({"x": 1}));
        s.add_held("a", vec![]);
        let d = s.get("a");
        assert_eq!(d.composer.unwrap().text, "text");
        assert_eq!(d.auq.unwrap().prompt_id, "p1");
        assert_eq!(d.held.len(), 1);
    }

    #[test]
    fn held_ids_are_assigned_in_order_and_survive_edit_remove() {
        let s = DraftStore::new();
        let (id1, _) = s.add_held("a", vec![]);
        let (id2, _) = s.add_held("a", vec![]);
        assert_eq!((id1, id2), (1, 2));
        assert!(s.update_held("a", id2, vec![]).is_some());
        assert!(s.remove_held("a", id1).is_some());
        let d = s.get("a");
        assert_eq!(d.held.len(), 1);
        assert_eq!(d.held[0].id, id2);
    }

    #[test]
    fn remove_held_unknown_id_returns_none() {
        let s = DraftStore::new();
        s.add_held("a", vec![]);
        assert!(s.remove_held("a", 999).is_none());
    }

    #[test]
    fn clear_auq_only_clears_matching_prompt_id() {
        let s = DraftStore::new();
        s.set_auq("a", "p1".into(), serde_json::json!({}));
        assert!(!s.clear_auq("a", "stale"), "mismatched prompt_id must not clear");
        assert!(s.get("a").auq.is_some());
        assert!(s.clear_auq("a", "p1"));
        assert!(s.get("a").auq.is_none());
    }

    #[test]
    fn eviction_drops_the_least_recently_touched_session_at_capacity() {
        let s = DraftStore::new();
        for i in 0..MAX_SESSIONS {
            s.set_composer(&format!("s{i}"), "x".into());
        }
        s.set_composer("overflow", "x".into());
        assert!(s.get("s0").composer.is_none(), "least-recently-touched entry must be evicted");
        assert!(s.get("overflow").composer.is_some());
        assert!(
            s.get(&format!("s{}", MAX_SESSIONS - 1)).composer.is_some(),
            "recently touched entries must survive"
        );
    }
}
