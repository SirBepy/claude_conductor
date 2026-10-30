//! Shared in-memory store behind both preview-render routes: byte-budgeted,
//! least-recently-served-first eviction, never touching disk.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Total html bytes kept. Bytes, not an entry count: every panel render and every
/// inline-card mount stages a fresh entry, and a card's iframe can point at a
/// render id minted many renders earlier (the gallery's `render-url`), so a small
/// count cap 404ed live cards after ten later renders. Docs are typically tens to a
/// few hundred KB, so this holds hundreds of them.
///
/// This is a per-cache ceiling and the daemon runs two (hooks server and remote
/// server, see `RenderCache::instance`), so the worst case is twice this in
/// resident memory until the daemon restarts. That is the price of keeping old
/// card ids alive; it is deliberately not lowered, since a smaller budget brings
/// back the 404ing cards the byte budget replaced the entry count to avoid.
const MAX_RENDER_BYTES: usize = 64 * 1024 * 1024;

struct Entry {
    html: String,
    /// Tick of the last insert or serve. A `Cell` so `get(&self)` can refresh it
    /// without every caller needing a mutable lock guard; the cache always sits
    /// behind a `Mutex`, so there is never concurrent access to it.
    last_used: Cell<u64>,
}

pub(crate) struct RenderCache {
    entries: HashMap<String, Entry>,
    bytes: usize,
    budget: usize,
    tick: Cell<u64>,
}

impl Default for RenderCache {
    fn default() -> Self {
        Self::with_budget(MAX_RENDER_BYTES)
    }
}

impl RenderCache {
    fn with_budget(budget: usize) -> Self {
        Self { entries: HashMap::new(), bytes: 0, budget, tick: Cell::new(0) }
    }

    /// Each server passes its OWN cell: the hooks server (27182) is loopback-only
    /// and unauthenticated, the remote server (27183) is iroh-exposed, so a
    /// single shared static would expose locally staged docs across that boundary.
    pub(crate) fn instance(
        cell: &'static OnceLock<Mutex<RenderCache>>,
    ) -> &'static Mutex<RenderCache> {
        cell.get_or_init(|| Mutex::new(RenderCache::default()))
    }

    fn next_tick(&self) -> u64 {
        let t = self.tick.get() + 1;
        self.tick.set(t);
        t
    }

    pub(crate) fn insert(&mut self, id: String, html: String) {
        let last_used = Cell::new(self.next_tick());
        self.bytes += html.len();
        if let Some(old) = self.entries.insert(id, Entry { html, last_used }) {
            self.bytes -= old.html.len();
        }
        // Never evict the entry just inserted, even when it alone exceeds the
        // budget: the caller is about to hand its id to an iframe.
        while self.bytes > self.budget && self.entries.len() > 1 {
            let Some(coldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used.get())
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&coldest) {
                self.bytes -= evicted.html.len();
            }
        }
    }

    /// Serving an id marks it recently used, so a card that keeps being opened
    /// outlives the renders that churn past it.
    pub(crate) fn get(&self, id: &str) -> Option<String> {
        let entry = self.entries.get(id)?;
        entry.last_used.set(self.next_tick());
        Some(entry.html.clone())
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eleven_renders_keep_the_first_id_loadable() {
        // An inline card's iframe points at a render id minted earlier; every
        // panel render and card mount since then inserted another entry.
        let mut cache = RenderCache::default();
        for i in 0..11 {
            cache.insert(format!("id-{i}"), format!("<p>{i}</p>"));
        }
        assert_eq!(cache.get("id-0").as_deref(), Some("<p>0</p>"));
    }

    #[test]
    fn over_budget_evicts_the_least_recently_used_entry() {
        let mut cache = RenderCache::with_budget(30);
        cache.insert("a".into(), "x".repeat(10));
        cache.insert("b".into(), "x".repeat(10));
        cache.insert("c".into(), "x".repeat(10));
        cache.insert("d".into(), "x".repeat(10));
        assert!(!cache.contains("a"), "the oldest untouched entry goes first");
        assert!(cache.contains("b") && cache.contains("c") && cache.contains("d"));
    }

    #[test]
    fn serving_an_id_protects_it_from_eviction() {
        let mut cache = RenderCache::with_budget(30);
        cache.insert("a".into(), "x".repeat(10));
        cache.insert("b".into(), "x".repeat(10));
        cache.insert("c".into(), "x".repeat(10));
        assert!(cache.get("a").is_some(), "a card loading its frame");
        cache.insert("d".into(), "x".repeat(10));
        assert!(cache.contains("a"), "a was served after b, so b is colder");
        assert!(!cache.contains("b"));
    }

    #[test]
    fn a_single_oversized_doc_is_still_stored() {
        let mut cache = RenderCache::with_budget(10);
        cache.insert("small".into(), "x".repeat(4));
        cache.insert("big".into(), "x".repeat(50));
        assert!(cache.contains("big"), "the id just handed out must load");
        assert!(!cache.contains("small"));
    }

    #[test]
    fn reinserting_an_id_does_not_double_count_its_bytes() {
        let mut cache = RenderCache::with_budget(30);
        for _ in 0..10 {
            cache.insert("a".into(), "x".repeat(10));
        }
        cache.insert("b".into(), "x".repeat(10));
        cache.insert("c".into(), "x".repeat(10));
        assert!(cache.contains("a") && cache.contains("b") && cache.contains("c"));
    }
}
