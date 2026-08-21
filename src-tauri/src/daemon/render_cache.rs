//! Shared in-memory store behind both preview-render routes: bounded,
//! evict-oldest-on-insert, never touching disk.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// Rolling window, not a growable history - fires on every re-render, so
/// oldest is evicted on insert past this cap.
const MAX_RENDER_CACHE: usize = 10;

#[derive(Default)]
pub(crate) struct RenderCache {
    entries: HashMap<String, String>,
    /// Insertion order, oldest-first, for O(1) eviction without a timestamp scan.
    order: VecDeque<String>,
}

impl RenderCache {
    /// Each server passes its OWN cell: the hooks server (27182) is loopback-only
    /// and unauthenticated, the remote server (27183) is tailscale-exposed, so a
    /// single shared static would expose locally staged docs across that boundary.
    pub(crate) fn instance(
        cell: &'static OnceLock<Mutex<RenderCache>>,
    ) -> &'static Mutex<RenderCache> {
        cell.get_or_init(|| Mutex::new(RenderCache::default()))
    }

    pub(crate) fn insert(&mut self, id: String, html: String) {
        if self.order.len() >= MAX_RENDER_CACHE {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(id.clone(), html);
        self.order.push_back(id);
    }

    pub(crate) fn get(&self, id: &str) -> Option<String> {
        self.entries.get(id).cloned()
    }
}
