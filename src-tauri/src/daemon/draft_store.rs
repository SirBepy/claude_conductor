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

/// Per-session cap on remembered nudge-served ids; a clear only ever needs
/// the recent ones, since the client asks about items it queued moments ago.
const MAX_INJECTED_IDS: usize = 32;

struct Entry {
    drafts: SessionDrafts,
    next_held_id: u64,
    touched_seq: u64,
    injected: Vec<u64>,
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
            Entry { drafts: SessionDrafts::default(), next_held_id: 1, touched_seq: seq, injected: Vec::new() }
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

    /// Records an empty-text TOMBSTONE rather than dropping the draft: a
    /// `None` composer is indistinguishable from "never had one", so another
    /// surface's reconcile has no timestamp to compare and silently keeps
    /// showing text this device already sent.
    pub fn clear_composer(&self, session_id: &str) -> String {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get_mut(session_id) {
            e.drafts.composer = Some(ComposerDraft { text: String::new(), updated_at: now.clone() });
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

    /// Empties the queue and returns the timestamp plus the ids it actually
    /// removed. A caller that is about to send those messages itself needs the
    /// ids: an item the mid-turn inject (`hooks_server::nudge`) already took is
    /// absent here, and sending it again would deliver it twice.
    pub fn clear_held(&self, session_id: &str) -> (String, Vec<u64>) {
        let now = now_iso();
        let mut map = self.inner.lock().unwrap();
        let mut removed = Vec::new();
        if let Some(e) = map.get_mut(session_id) {
            removed = e.drafts.held.drain(..).map(|i| i.id).collect();
            e.drafts.held_updated_at = Some(now.clone());
        }
        (now, removed)
    }

    /// Remembers ids the mid-turn nudge removed and served, newest last, capped
    /// at [`MAX_INJECTED_IDS`]. `clear_held`'s `removed_ids` cannot say this:
    /// this store is never persisted, so a client that sees an id missing from
    /// it cannot tell "already injected" from "this daemon never held it".
    pub fn record_injected(&self, session_id: &str, ids: &[u64]) {
        let mut map = self.inner.lock().unwrap();
        let e = self.touch(&mut map, session_id);
        e.injected.extend_from_slice(ids);
        if e.injected.len() > MAX_INJECTED_IDS {
            let excess = e.injected.len() - MAX_INJECTED_IDS;
            e.injected.drain(..excess);
        }
    }

    pub fn injected_ids(&self, session_id: &str) -> Vec<u64> {
        self.inner.lock().unwrap().get(session_id).map(|e| e.injected.clone()).unwrap_or_default()
    }

    pub fn held_count(&self, session_id: &str) -> usize {
        self.inner.lock().unwrap().get(session_id).map(|e| e.drafts.held.len()).unwrap_or(0)
    }

    /// Hands `from`'s held queue to `to` (a respawn successor), appended after
    /// anything `to` already holds. Items get fresh ids from `to`'s counter,
    /// since ids are only unique per session. Every surface reconciles its
    /// held set from this store on attach, so a queue left under the old id
    /// is wiped from the successor's chip the moment the pane follows it.
    /// Returns how many items moved.
    pub fn move_held(&self, from: &str, to: &str) -> usize {
        if from == to {
            return 0;
        }
        let mut map = self.inner.lock().unwrap();
        let Some(src) = map.get_mut(from) else { return 0 };
        if src.drafts.held.is_empty() {
            return 0;
        }
        let now = now_iso();
        let items = std::mem::take(&mut src.drafts.held);
        src.drafts.held_updated_at = Some(now.clone());
        let moved = items.len();
        let dst = self.touch(&mut map, to);
        for item in items {
            let id = dst.next_held_id;
            dst.next_held_id += 1;
            dst.drafts.held.push(HeldDraftItem { id, blocks: item.blocks, updated_at: now.clone() });
        }
        dst.drafts.held_updated_at = Some(now);
        moved
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

    fn held_texts(s: &DraftStore, sid: &str) -> Vec<String> {
        s.get(sid)
            .held
            .iter()
            .map(|i| match i.blocks.first() {
                Some(ContentBlock::Text { text }) => text.clone(),
                _ => String::new(),
            })
            .collect()
    }

    fn text(t: &str) -> Vec<ContentBlock> {
        vec![ContentBlock::Text { text: t.into() }]
    }

    #[test]
    fn move_held_hands_the_queue_to_the_successor_in_order() {
        let s = DraftStore::new();
        s.add_held("old", text("one"));
        s.add_held("old", text("two"));
        s.add_held("new", text("already here"));
        assert_eq!(s.move_held("old", "new"), 2);
        assert!(s.get("old").held.is_empty());
        assert_eq!(held_texts(&s, "new"), ["already here", "one", "two"]);
        let ids: Vec<u64> = s.get("new").held.iter().map(|i| i.id).collect();
        assert_eq!(ids, [1, 2, 3], "moved items take fresh ids from the successor's counter");
    }

    #[test]
    fn move_held_with_nothing_queued_creates_no_entry() {
        let s = DraftStore::new();
        assert_eq!(s.move_held("old", "new"), 0);
        s.set_composer("old", "draft".into());
        assert_eq!(s.move_held("old", "new"), 0);
        assert!(s.get("new").held_updated_at.is_none());
        assert_eq!(s.move_held("old", "old"), 0);
    }

    #[test]
    fn remove_held_unknown_id_returns_none() {
        let s = DraftStore::new();
        s.add_held("a", vec![]);
        assert!(s.remove_held("a", 999).is_none());
    }

    #[test]
    fn clear_held_returns_only_the_ids_still_queued() {
        let s = DraftStore::new();
        let (id1, _) = s.add_held("a", text("one"));
        let (id2, _) = s.add_held("a", text("two"));
        let (id3, _) = s.add_held("a", text("three"));
        s.remove_held("a", id2);
        let (_, removed) = s.clear_held("a");
        assert_eq!(removed, [id1, id3], "an item taken earlier must not be reported as cleared");
        assert!(s.get("a").held.is_empty());
        assert_eq!(s.clear_held("a").1, Vec::<u64>::new());
        assert_eq!(s.clear_held("ghost").1, Vec::<u64>::new());
    }

    #[test]
    fn injected_ids_keep_only_the_last_32_per_session() {
        let s = DraftStore::new();
        let ids: Vec<u64> = (1..=40).collect();
        s.record_injected("a", &ids);
        s.record_injected("b", &[7]);
        assert_eq!(s.injected_ids("a"), (9..=40).collect::<Vec<u64>>());
        assert_eq!(s.injected_ids("b"), [7]);
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
