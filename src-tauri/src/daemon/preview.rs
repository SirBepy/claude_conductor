//! Daemon-owned HTML preview snapshot store (ai_todo 138).
//!
//! Both terminal Claude (curl to `POST /hooks/preview`) and the in-app chat
//! AI push rendered HTML here so it shows up in the in-app preview panel
//! instead of an external browser. One global (not per-session) ordered
//! timeline of snapshots.
//!
//! File: `<app-data>/preview-history<suffix>.json` -> `Vec<PreviewSnapshot>`
//! (full html included, so a still-running session's preview survives a
//! daemon restart per the locked decision in the todo). Sole writer is the
//! daemon (the `/hooks/preview` handler); reads happen via the `list_previews`
//! / `get_preview` RPC methods, mirroring `sessions::scheduled_items`'s
//! read-modify-write-the-whole-file style (small dataset, capped at
//! [`MAX_HISTORY`]). Instance-suffixed like `scheduled_items::config_path_for`
//! so a test daemon never clobbers the production file.
//!
//! Semantics (locked in the todo):
//! - A push with a `slug` matching an existing snapshot REPLACES it in place:
//!   same id, `version` += 1, content overwritten, `created_at` refreshed so
//!   it sorts as the most-recently-pushed ("live") entry.
//! - A push with an absent/new slug APPENDS a new snapshot (version 1). An
//!   absent slug gets a synthetic one derived from the id so every entry is
//!   addressable.
//! - History caps at [`MAX_HISTORY`]; evicting the oldest entry logs a note
//!   (never a silent drop).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

/// `source` for a push from the `show_preview` MCP tool. Distinct from plain
/// `"chat"` (the `<cc-preview:..>` sentinel) because this one ALSO renders as a
/// card in the transcript, so the rail must not force itself open for it.
pub const PREVIEW_SOURCE_CHAT_CARD: &str = "chat_card";

/// Max snapshots retained in the timeline. Oldest (smallest `created_at`) is
/// evicted first when a genuinely NEW slug would push the count over this.
pub const MAX_HISTORY: usize = 30;

/// Reject a push whose `html` exceeds this many bytes (~2MB). Guards against
/// an unbounded payload bloating the persisted JSON file / in-app iframe.
pub const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;

/// A single pushed preview, full content included. Persisted verbatim.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PreviewSnapshot {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub html: String,
    /// `"terminal"` (curled from a terminal `claude` process) or `"chat"`
    /// (pushed by the in-app chat AI). Plain `String`, not an enum, so the
    /// unauthenticated `/hooks/preview` curl endpoint never rejects a payload
    /// over an unrecognized future source value.
    pub source: String,
    pub session_id: Option<String>,
    /// Count of pushes for this snapshot's slug. 1 on first push; increments
    /// each time a same-slug push replaces it in place.
    pub version: u32,
    /// UTC RFC3339 with fixed millisecond precision (matches the rest of the
    /// codebase's `created_at: String` convention, e.g. `ScheduledItem`,
    /// `ProjectConfig`). Fixed width means lexicographic `String` ordering is
    /// also chronological ordering, so `list()` can sort without parsing.
    /// Refreshed on every replace so newest-first ordering always surfaces
    /// the most-recently-pushed entry as "live".
    pub created_at: String,
}

/// Metadata-only projection for the history rail (`list_previews`) - omits
/// `html` so listing 30 snapshots doesn't ship megabytes of markup the caller
/// doesn't need yet.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PreviewMeta {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub source: String,
    pub session_id: Option<String>,
    pub version: u32,
    pub created_at: String,
}

impl From<&PreviewSnapshot> for PreviewMeta {
    fn from(s: &PreviewSnapshot) -> Self {
        Self {
            id: s.id.clone(),
            slug: s.slug.clone(),
            title: s.title.clone(),
            source: s.source.clone(),
            session_id: s.session_id.clone(),
            version: s.version,
            created_at: s.created_at.clone(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("preview html too large: {0} bytes (max {MAX_HTML_BYTES})")]
    TooLarge(usize),
}

/// Serialize read-modify-write within a process. Cross-process integrity
/// comes from the atomic rename, not this lock (mirrors
/// `scheduled_items::WRITE_LOCK` / `chat_config::WRITE_LOCK`).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> Option<PathBuf> {
    store_path_for(&crate::daemon::instance::instance_suffix())
}

/// Instance-scoped store path (see module docs) so a `CC_DAEMON_INSTANCE`
/// test daemon never races the production preview history file.
pub fn store_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir()
        .ok()
        .map(|d| d.join(format!("preview-history{suffix}.json")))
}

fn load_list(path: &Path) -> Vec<PreviewSnapshot> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, list: &[PreviewSnapshot]) {
    let json = match serde_json::to_string_pretty(list) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("preview-history: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("preview-history: write failed: {e}");
    }
}

/// Fixed-millisecond-precision UTC RFC3339, so plain `String` comparison
/// sorts chronologically (see `PreviewSnapshot::created_at` doc).
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Push a new snapshot or replace the live one for `slug` in place. Returns
/// the snapshot id, or `Err` if `html` exceeds [`MAX_HTML_BYTES`] (logged by
/// the caller into a 4xx at the `/hooks/preview` handler).
pub fn push(
    title: String,
    slug: Option<String>,
    html: String,
    source: String,
    session_id: Option<String>,
) -> Result<String, PreviewError> {
    let Some(path) = store_path() else {
        // No app-data dir resolvable (should not happen in practice); still
        // hand back a fresh id so the caller's broadcast/response shape is
        // consistent, just unpersisted.
        return Ok(uuid::Uuid::new_v4().to_string());
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    push_at(&path, title, slug, html, source, session_id)
}

fn push_at(
    path: &Path,
    title: String,
    slug: Option<String>,
    html: String,
    source: String,
    session_id: Option<String>,
) -> Result<String, PreviewError> {
    if html.len() > MAX_HTML_BYTES {
        log::warn!("preview push rejected: {} bytes over the {MAX_HTML_BYTES}-byte cap", html.len());
        return Err(PreviewError::TooLarge(html.len()));
    }
    let mut list = load_list(path);

    if let Some(slug) = slug.filter(|s| !s.is_empty()) {
        if let Some(existing) = list.iter_mut().find(|s| s.slug == slug) {
            existing.title = title;
            existing.html = html;
            existing.source = source;
            existing.session_id = session_id;
            existing.version += 1;
            existing.created_at = now_rfc3339();
            let id = existing.id.clone();
            write_atomic(path, &list);
            return Ok(id);
        }
        // New/unseen slug: append as a fresh snapshot below.
        let id = uuid::Uuid::new_v4().to_string();
        evict_if_at_cap(&mut list);
        list.push(PreviewSnapshot {
            id: id.clone(),
            slug,
            title,
            html,
            source,
            session_id,
            version: 1,
            created_at: now_rfc3339(),
        });
        write_atomic(path, &list);
        return Ok(id);
    }

    // No slug given: synthesize one from a fresh id so every entry stays
    // addressable (e.g. for a future re-push by the same slug).
    let id = uuid::Uuid::new_v4().to_string();
    evict_if_at_cap(&mut list);
    list.push(PreviewSnapshot {
        id: id.clone(),
        slug: format!("untitled-{id}"),
        title,
        html,
        source,
        session_id,
        version: 1,
        created_at: now_rfc3339(),
    });
    write_atomic(path, &list);
    Ok(id)
}

/// Evicts the single oldest entry (by `created_at`) if `list` is already at
/// [`MAX_HISTORY`], logging what was dropped. Called only on the
/// new-snapshot path (a same-slug replace never grows the count).
fn evict_if_at_cap(list: &mut Vec<PreviewSnapshot>) {
    if list.len() < MAX_HISTORY {
        return;
    }
    if let Some((idx, oldest)) = list
        .iter()
        .enumerate()
        .min_by_key(|(_, s)| s.created_at.clone())
        .map(|(i, s)| (i, s.clone()))
    {
        log::info!(
            "preview-history: capacity {MAX_HISTORY} reached, evicting oldest snapshot id={} slug={}",
            oldest.id, oldest.slug,
        );
        list.remove(idx);
    }
}

/// Metadata for every snapshot, newest-first (most-recently-pushed/replaced
/// first). No `html` - see [`PreviewMeta`].
pub fn list() -> Vec<PreviewMeta> {
    let Some(path) = store_path() else { return Vec::new() };
    list_at(&path)
}

fn list_at(path: &Path) -> Vec<PreviewMeta> {
    let mut items = load_list(path);
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items.iter().map(PreviewMeta::from).collect()
}

/// Push + broadcast the resulting metadata on the daemon-wide `preview`
/// notifier channel in one call. Shared by the unauthenticated
/// `/hooks/preview` hook-server endpoint and the desktop-only `push_preview`
/// RPC method (`daemon::methods::registry`) so both write paths stay in sync
/// and never publish out of step with the store.
pub fn push_and_notify(
    state: &crate::daemon::state::DaemonState,
    title: String,
    slug: Option<String>,
    html: String,
    source: String,
    session_id: Option<String>,
) -> Result<String, PreviewError> {
    let id = push(title, slug, html, source, session_id)?;
    if let Some(meta) = list().into_iter().find(|m| m.id == id) {
        state.notifier.publish("preview", serde_json::json!({ "snapshot": meta }));
    }
    Ok(id)
}

/// Full snapshot (html included) by id, for the iframe render.
pub fn get(id: &str) -> Option<PreviewSnapshot> {
    let path = store_path()?;
    get_at(&path, id)
}

fn get_at(path: &Path, id: &str) -> Option<PreviewSnapshot> {
    load_list(path).into_iter().find(|s| s.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_new_slug_appears_in_list() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "First".into(), Some("mockup".into()), "<html></html>".into(), "terminal".into(), None).unwrap();
        let listed = list_at(&path);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].slug, "mockup");
        assert_eq!(listed[0].version, 1);
    }

    #[test]
    fn push_same_slug_replaces_in_place_and_bumps_version() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id1 = push_at(&path, "v1".into(), Some("mockup".into()), "<p>1</p>".into(), "terminal".into(), None).unwrap();
        let id2 = push_at(&path, "v2".into(), Some("mockup".into()), "<p>2</p>".into(), "terminal".into(), None).unwrap();

        assert_eq!(id1, id2, "same-slug push must keep the same id");
        let listed = list_at(&path);
        assert_eq!(listed.len(), 1, "replace must not grow the list");
        assert_eq!(listed[0].version, 2);
        assert_eq!(listed[0].title, "v2");

        let full = get_at(&path, &id1).unwrap();
        assert_eq!(full.html, "<p>2</p>", "get must return the replaced html");
    }

    #[test]
    fn push_different_slug_appends_new_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "A".into(), Some("slug-a".into()), "<p>a</p>".into(), "terminal".into(), None).unwrap();
        push_at(&path, "B".into(), Some("slug-b".into()), "<p>b</p>".into(), "chat".into(), Some("sess-1".into())).unwrap();

        let listed = list_at(&path);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|s| s.slug == "slug-a"));
        assert!(listed.iter().any(|s| s.slug == "slug-b"));
    }

    #[test]
    fn get_returns_full_html() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "T".into(), None, "<h1>hi</h1>".into(), "terminal".into(), None).unwrap();
        let got = get_at(&path, &id).expect("recorded");
        assert_eq!(got.html, "<h1>hi</h1>");
        assert!(get_at(&path, "missing").is_none());
    }

    #[test]
    fn absent_slug_synthesizes_a_unique_one() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id1 = push_at(&path, "A".into(), None, "<p>a</p>".into(), "terminal".into(), None).unwrap();
        let id2 = push_at(&path, "B".into(), None, "<p>b</p>".into(), "terminal".into(), None).unwrap();
        assert_ne!(id1, id2);
        let listed = list_at(&path);
        assert_eq!(listed.len(), 2, "two absent-slug pushes must both append, never replace each other");
    }

    #[test]
    fn oversized_html_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let huge = "x".repeat(MAX_HTML_BYTES + 1);
        let err = push_at(&path, "Too big".into(), None, huge, "terminal".into(), None).unwrap_err();
        assert!(matches!(err, PreviewError::TooLarge(_)));
        assert!(list_at(&path).is_empty());
    }

    #[test]
    fn cap_evicts_oldest_when_a_new_slug_would_exceed_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        for i in 0..MAX_HISTORY {
            push_at(&path, format!("T{i}"), Some(format!("slug-{i}")), "<p></p>".into(), "terminal".into(), None).unwrap();
            // Ensure strictly increasing created_at even on a fast filesystem/clock.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(list_at(&path).len(), MAX_HISTORY);

        push_at(&path, "Newest".into(), Some("slug-newest".into()), "<p></p>".into(), "terminal".into(), None).unwrap();
        let listed = list_at(&path);
        assert_eq!(listed.len(), MAX_HISTORY, "cap must hold steady, not grow");
        assert!(listed.iter().any(|s| s.slug == "slug-newest"), "the new push must be present");
        assert!(!listed.iter().any(|s| s.slug == "slug-0"), "the oldest entry must have been evicted");
    }

    #[test]
    fn list_orders_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "old".into(), Some("s1".into()), "<p></p>".into(), "terminal".into(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        push_at(&path, "new".into(), Some("s2".into()), "<p></p>".into(), "terminal".into(), None).unwrap();

        let listed = list_at(&path);
        assert_eq!(listed[0].title, "new");
        assert_eq!(listed[1].title, "old");
    }

    #[test]
    fn replace_moves_entry_to_the_front() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "s1-v1".into(), Some("s1".into()), "<p></p>".into(), "terminal".into(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        push_at(&path, "s2-v1".into(), Some("s2".into()), "<p></p>".into(), "terminal".into(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        // Re-push s1: it should become newest again.
        push_at(&path, "s1-v2".into(), Some("s1".into()), "<p></p>".into(), "terminal".into(), None).unwrap();

        let listed = list_at(&path);
        assert_eq!(listed[0].slug, "s1");
        assert_eq!(listed[0].version, 2);
        assert_eq!(listed[1].slug, "s2");
    }
}
