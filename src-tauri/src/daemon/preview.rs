//! Daemon-owned HTML preview snapshot store (ai_todo 138).
//!
//! Both terminal Claude (curl to `POST /hooks/preview`) and the in-app chat
//! AI push rendered HTML here so it shows up in the in-app preview panel
//! instead of an external browser. One global (not per-session) ordered
//! timeline of snapshots.
//!
//! File: `<app-data>/preview-history<suffix>.json` -> `Vec<PreviewSnapshot>`
//! (the current html included, so a still-running session's preview survives a
//! daemon restart per the locked decision in the todo). Archived versions keep
//! their metadata there but their html lives one file each in
//! `<app-data>/preview-history<suffix>.versions/`, so listing and pushing never
//! parse pages they do not return. Sole writer is the
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
//! - A same-slug replace first archives the page it overwrites into
//!   `previous` (newest first, [`KEEP_PREVIOUS_VERSIONS`] kept), so the panel can
//!   go back and look at an earlier version. A page pushed before that existed
//!   has only its latest copy; its history starts at the next push.
//! - History caps at [`MAX_HISTORY`]; evicting the oldest entry logs a note
//!   (never a silent drop).

pub use crate::claude_ai_publish::PublishedLink;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

mod shared;
mod versions;
// Only `methods/preview.rs`'s scope test reads a store file directly.
#[cfg(test)]
pub(crate) use versions::get_view_at;
pub use shared::{run as run_shared_mockup, Control, Part, SharedMockup};
pub use versions::{get_view, PreviousVersion, PreviewVersionMeta, KEEP_PREVIOUS_VERSIONS, MAX_STORE_HTML_BYTES};
use versions::{flush_archive, sweep_archive, trim_to_budget};

/// `source` for a push from the `show_preview` MCP tool. Distinct from plain
/// `"chat"` (the `<cc-preview:..>` sentinel) because this one ALSO renders as a
/// card in the transcript, so the rail must not force itself open for it.
pub const PREVIEW_SOURCE_CHAT_CARD: &str = "chat_card";

/// Max snapshots retained in the timeline. Oldest (smallest `created_at`) is
/// evicted first when a genuinely NEW slug would push the count over this.
pub const MAX_HISTORY: usize = 30;

/// Reject a push whose `html` exceeds this many bytes (8MiB). Sized for a
/// narrated test report with its video inlined (1280px, 10fps is ~6.7MB).
/// Guards against an unbounded payload bloating the persisted JSON file /
/// in-app iframe; the version store is separately bounded by
/// `MAX_STORE_HTML_BYTES`.
pub const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// HTTP body cap for every route a page's html travels in (push, render
/// staging). Above [`MAX_HTML_BYTES`] because the body is JSON (escapes grow
/// it) and the staged document adds the page wrapper; axum's 2 MiB default
/// would otherwise refuse a page the cap allows.
pub const PREVIEW_BODY_BYTES: usize = MAX_HTML_BYTES * 2;

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
    /// Its claude.ai link once published. Kept across a same-slug replace so
    /// the next publish updates the same page; `published.version` falling
    /// behind `version` is how the UI tells the link is out of date.
    #[serde(default)]
    pub published: Option<PublishedLink>,
    /// Pages this slug held before its latest push, newest first. Persisted but
    /// never sent to a client: `get_preview` returns one version at a time and
    /// `list_previews` carries [`PreviewVersionMeta`] instead.
    #[serde(default)]
    #[ts(skip)]
    pub previous: Vec<PreviousVersion>,
    /// Set for a shared mockup (pc-1620): `html` is then the composed page and
    /// this holds the shell, the parts and their controls. `None` is an ordinary
    /// (dedicated) preview, which is every entry written before this existed.
    #[serde(default)]
    pub shared: Option<SharedMockup>,
    /// What Joe left the page at: control values (`ctl|<part>|<control>` -> "value")
    /// and the page's own state (`page` -> anything the page reported through
    /// `ccPreview.state.save`). Daemon-side so the docked panel, the pop-out
    /// window and the phone all read and write one copy.
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub view_state: BTreeMap<String, serde_json::Value>,
}

/// Prefix of the `view_state` keys that hold a shared mockup's control values.
pub const CONTROL_STATE_PREFIX: &str = "ctl|";
/// Bounds on `view_state`, so a runaway page cannot bloat the persisted history file.
pub const MAX_STATE_KEYS: usize = 200;
pub const MAX_STATE_VALUE_BYTES: usize = 64 * 1024;

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
    #[serde(default)]
    pub published: Option<PublishedLink>,
    /// Archived versions behind `version`, newest first. Empty for a preview
    /// pushed once, and for any entry a peer running an older build mirrors in.
    #[serde(default)]
    pub versions: Vec<PreviewVersionMeta>,
    /// A shared mockup (`PreviewSnapshot::shared` is set); the picker groups on it.
    #[serde(default)]
    pub shared: bool,
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
            published: s.published.clone(),
            // Only the pages the same chat pushed: a version picked from here is
            // fetched under this session id, which owns nothing else.
            versions: s
                .previous
                .iter()
                .filter(|p| p.session_id == s.session_id)
                .map(|p| PreviewVersionMeta { version: p.version, created_at: p.created_at.clone() })
                .collect(),
            shared: s.shared.is_some(),
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

fn write_atomic(path: &Path, list: &[PreviewSnapshot]) -> bool {
    let json = match serde_json::to_string_pretty(list) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("preview-history: serialize failed: {e}");
            return false;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("preview-history: write failed: {e}");
        return false;
    }
    true
}

/// Persists `list`: archived html out to its files, then the history file, then
/// the sweep. Files go first and the sweep last, so a crash between the steps
/// leaves orphan files (swept next time), never a version with no html.
fn save(path: &Path, list: &mut [PreviewSnapshot]) {
    for snap in list.iter_mut() {
        prune_control_state(snap);
    }
    flush_archive(path, list);
    if write_atomic(path, list) {
        sweep_archive(path, list);
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

/// `pub(crate)` so `methods/preview.rs` can test its scope check against a real
/// store file instead of a hand-built snapshot.
pub(crate) fn push_at(
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
            let replaced_at = std::mem::replace(&mut existing.created_at, now_rfc3339());
            let old_html = std::mem::replace(&mut existing.html, html);
            existing.previous.insert(
                0,
                PreviousVersion {
                    version: existing.version,
                    title: std::mem::replace(&mut existing.title, title),
                    html_bytes: old_html.len(),
                    html: old_html,
                    created_at: replaced_at,
                    session_id: std::mem::replace(&mut existing.session_id, session_id),
                },
            );
            existing.previous.truncate(KEEP_PREVIOUS_VERSIONS);
            existing.source = source;
            // A plain push owns the slug now; the old shell must not recompose over it.
            existing.shared = None;
            existing.version += 1;
            let id = existing.id.clone();
            trim_to_budget(&mut list);
            save(path, &mut list);
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
            published: None,
            previous: Vec::new(),
            shared: None,
            view_state: BTreeMap::new(),
        });
        save(path, &mut list);
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
        published: None,
        previous: Vec::new(),
        shared: None,
        view_state: BTreeMap::new(),
    });
    save(path, &mut list);
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

/// Records `id`'s claude.ai link and broadcasts the refreshed metadata on the
/// same `preview` channel a push uses, so open panels pick it up.
pub fn set_published_and_notify(
    state: &crate::daemon::state::DaemonState,
    id: &str,
    link: PublishedLink,
) -> Option<PreviewMeta> {
    let path = store_path()?;
    let meta = {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_published_at(&path, id, link)?
    };
    state.notifier.publish("preview", serde_json::json!({ "snapshot": meta }));
    Some(meta)
}

fn set_published_at(path: &Path, id: &str, link: PublishedLink) -> Option<PreviewMeta> {
    let mut list = load_list(path);
    let snap = list.iter_mut().find(|s| s.id == id)?;
    snap.published = Some(link);
    let meta = PreviewMeta::from(&*snap);
    save(path, &mut list);
    Some(meta)
}

/// Drops the saved control values whose control the page no longer has (a plain
/// re-push has no shell, a shared edit may remove a part or a control); values
/// that still match stay, and the page's own `page` state is left for the new
/// page to use or ignore.
fn prune_control_state(snap: &mut PreviewSnapshot) {
    let live: std::collections::HashSet<String> = snap
        .shared
        .iter()
        .flat_map(|m| m.parts.iter())
        .flat_map(|p| p.controls.iter().map(move |c| format!("{CONTROL_STATE_PREFIX}{}|{}", p.id, c.id)))
        .collect();
    snap.view_state.retain(|k, _| !k.starts_with(CONTROL_STATE_PREFIX) || live.contains(k));
}

/// Sets (or, for `Value::Null`, clears) one `view_state` key and broadcasts it
/// on the `preview_state` notifier event (the webview hears it as `preview-state`) so every open window follows. Errors name
/// the refusal; an unknown preview is `Ok(false)`.
pub fn set_state_and_notify(
    state: &crate::daemon::state::DaemonState,
    id: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<bool, String> {
    let Some(path) = store_path() else { return Ok(false) };
    let found = {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_state_at(&path, id, key, &value)?
    };
    if found {
        state.notifier.publish("preview_state", serde_json::json!({ "id": id, "key": key, "value": value }));
    }
    Ok(found)
}

pub(crate) fn set_state_at(path: &Path, id: &str, key: &str, value: &serde_json::Value) -> Result<bool, String> {
    if key.is_empty() || key.len() > 200 {
        return Err("state key must be 1-200 bytes".to_string());
    }
    if !(key == "page" || key.starts_with(CONTROL_STATE_PREFIX)) {
        return Err(format!("unknown state key: {key}"));
    }
    if value.to_string().len() > MAX_STATE_VALUE_BYTES {
        return Err(format!("state value over {MAX_STATE_VALUE_BYTES} bytes"));
    }
    let mut list = load_list(path);
    let Some(snap) = list.iter_mut().find(|s| s.id == id) else { return Ok(false) };
    if value.is_null() {
        snap.view_state.remove(key);
    } else {
        if !snap.view_state.contains_key(key) && snap.view_state.len() >= MAX_STATE_KEYS {
            return Err(format!("more than {MAX_STATE_KEYS} state keys"));
        }
        snap.view_state.insert(key.to_string(), value.clone());
    }
    save(path, &mut list);
    Ok(true)
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
    fn published_link_survives_a_same_slug_replace_and_shows_it_is_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "v1".into(), Some("report".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        let link = PublishedLink {
            url: "https://claude.ai/artifact/AB".into(),
            version: 1,
            account: "Joe".into(),
            published_at: "now".into(),
        };
        let meta = set_published_at(&path, &id, link.clone()).unwrap();
        assert_eq!(meta.published, Some(link.clone()));

        push_at(&path, "v2".into(), Some("report".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();
        let after = &list_at(&path)[0];
        // Kept so the next publish updates the same page; version 2 vs 1 is
        // what tells the panel the link is out of date.
        assert_eq!(after.published, Some(link));
        assert_eq!(after.version, 2);
    }

    #[test]
    fn setting_a_link_on_an_evicted_preview_stores_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "A".into(), Some("a".into()), "<p>a</p>".into(), "chat".into(), None).unwrap();
        let link = PublishedLink { url: "https://claude.ai/artifact/AB".into(), version: 1, account: "Joe".into(), published_at: "now".into() };
        assert!(set_published_at(&path, "no-such-id", link).is_none());
        assert!(list_at(&path)[0].published.is_none());
    }

    #[test]
    fn a_history_file_written_before_published_existed_still_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        std::fs::write(
            &path,
            r#"[{"id":"a","slug":"s","title":"t","html":"<p></p>","source":"chat","session_id":null,"version":1,"created_at":"2026-01-01T00:00:00.000Z"}]"#,
        )
        .unwrap();
        assert_eq!(list_at(&path).len(), 1);
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
    fn a_page_over_two_mib_and_under_the_cap_is_stored() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let big = "x".repeat(3 * 1024 * 1024);
        push_at(&path, "Report".into(), None, big, "terminal".into(), None).unwrap();
        assert_eq!(list_at(&path).len(), 1);
        assert!(PREVIEW_BODY_BYTES > MAX_HTML_BYTES, "routes must accept every page the cap allows");
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

    #[test]
    fn view_state_is_saved_cleared_and_validated() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "t".into(), Some("deck".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        assert!(set_state_at(&path, &id, "page", &serde_json::json!({"slide": 5})).unwrap());
        assert_eq!(get_at(&path, &id).unwrap().view_state["page"], serde_json::json!({"slide": 5}));
        assert!(set_state_at(&path, &id, "page", &serde_json::Value::Null).unwrap());
        assert!(get_at(&path, &id).unwrap().view_state.is_empty());
        assert!(!set_state_at(&path, "missing", "page", &serde_json::json!(1)).unwrap(), "unknown id is not an error");
        assert!(set_state_at(&path, &id, "other", &serde_json::json!(1)).is_err());
        let big = serde_json::json!("x".repeat(MAX_STATE_VALUE_BYTES + 1));
        assert!(set_state_at(&path, &id, "page", &big).is_err());
    }

    #[test]
    fn a_re_push_keeps_page_state() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "t".into(), Some("deck".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        set_state_at(&path, &id, "page", &serde_json::json!({"slide": 5})).unwrap();
        push_at(&path, "t".into(), Some("deck".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();
        let state = get_at(&path, &id).unwrap().view_state;
        assert_eq!(state.get("page"), Some(&serde_json::json!({"slide": 5})));
    }

    #[test]
    fn control_values_survive_only_while_their_control_exists() {
        use super::shared::{Control, Part, SharedMockup};
        let control = |id: &str| Control { id: id.into(), label: id.into(), kind: "switch".into(), options: vec![], default: "off".into() };
        let part = Part { id: "header".into(), owner_session_id: "s".into(), owner_name: "n".into(), html: String::new(), css: String::new(), controls: vec![control("dense")] };
        let mut snap = PreviewSnapshot {
            id: "a".into(), slug: "a".into(), title: "a".into(), html: String::new(), source: "chat".into(), session_id: None, version: 1,
            created_at: String::new(), published: None, previous: Vec::new(),
            shared: Some(SharedMockup { owner_session_id: "s".into(), shell: String::new(), parts: vec![part] }),
            view_state: BTreeMap::new(),
        };
        for k in ["ctl|header|dense", "ctl|header|gone", "ctl|footer|dense", "page"] {
            snap.view_state.insert(k.into(), serde_json::json!("v"));
        }
        prune_control_state(&mut snap);
        let kept: Vec<&str> = snap.view_state.keys().map(String::as_str).collect();
        assert_eq!(kept, vec!["ctl|header|dense", "page"]);
    }
}
