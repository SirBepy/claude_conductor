//! Archived versions of a preview: the types, the on-disk archive files, the
//! html budget and the single-version read that `get_preview` uses.
//!
//! The history file keeps each archived page's metadata; the html itself is one
//! file per page under `archive_dir`, so `list`/`push` never parse pages they
//! do not return. The file naming and the save order live with `save` in the
//! parent module, which is the only writer.

use super::{get_at, store_path, PreviewSnapshot};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// How many replaced versions a preview keeps besides its current one.
pub const KEEP_PREVIOUS_VERSIONS: usize = 5;

/// Upper bound on the `html` bytes the store holds across every preview and its
/// archived versions. Each push rewrites the whole file, so the worst case of
/// `MAX_HISTORY` previews times [`KEEP_PREVIOUS_VERSIONS`] pages of
/// `MAX_HTML_BYTES` each (hundreds of MB) must not be reachable; past this the
/// oldest archived versions are dropped first.
pub const MAX_STORE_HTML_BYTES: usize = 64 * 1024 * 1024;

/// One archived page of a preview.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreviousVersion {
    pub version: u32,
    pub title: String,
    /// Empty once `save` has moved the page into the archive dir. Non-empty
    /// only between archiving and that save, or in a file written before the
    /// archive dir existed (moved on its next save). Always serialized, even
    /// empty, so a build that still requires the key reads the file.
    #[serde(default)]
    pub html: String,
    pub created_at: String,
    /// Who pushed this page. Archiving records the session of the page being
    /// replaced, not the replacer's, so a scoped reader sees the real owner.
    /// `None` for a page archived before this was recorded, which then belongs
    /// to no chat and is never offered to one.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Size of the archived html, so the budget needs no file reads.
    #[serde(default)]
    pub html_bytes: usize,
}

impl PreviousVersion {
    pub(super) fn size(&self) -> usize {
        if self.html.is_empty() { self.html_bytes } else { self.html.len() }
    }
}

/// An archived version without its html, for the version picker.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PreviewVersionMeta {
    pub version: u32,
    pub created_at: String,
}

/// Where archived html for the history file at `path` lives.
pub(super) fn archive_dir(path: &Path) -> PathBuf {
    path.with_extension("versions")
}

pub(super) fn archive_file(dir: &Path, id: &str, version: u32) -> PathBuf {
    dir.join(format!("{id}-v{version}.html"))
}

/// Moves every archived page still held in memory into its own file and blanks
/// it in `list`. A page whose file cannot be written stays embedded, so a full
/// disk degrades to the old single-file layout instead of losing the page.
pub(super) fn flush_archive(path: &Path, list: &mut [PreviewSnapshot]) {
    let dir = archive_dir(path);
    for snap in list.iter_mut() {
        for prev in snap.previous.iter_mut().filter(|p| !p.html.is_empty()) {
            // write_json_atomic only writes a string through a temp file and a
            // rename; the content need not be JSON.
            match crate::util::write_json_atomic(&archive_file(&dir, &snap.id, prev.version), &prev.html) {
                Ok(()) => {
                    prev.html_bytes = prev.html.len();
                    prev.html = String::new();
                }
                Err(e) => log::warn!("preview-history: archiving v{} of {} failed: {e}", prev.version, snap.slug),
            }
        }
    }
}

/// Deletes archive files nothing in `list` points at: versions that fell off
/// the cap or the budget, previews evicted from the timeline, and stale temp
/// files. Run only after the history file that no longer names them is on disk.
pub(super) fn sweep_archive(path: &Path, list: &[PreviewSnapshot]) {
    let dir = archive_dir(path);
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let live: std::collections::HashSet<std::ffi::OsString> = list
        .iter()
        .flat_map(|s| s.previous.iter().map(|p| archive_file(&dir, &s.id, p.version)))
        .filter_map(|f| f.file_name().map(|n| n.to_owned()))
        .collect();
    for entry in entries.flatten() {
        if !live.contains(&entry.file_name()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Drops archived versions, oldest first across every preview, until the html the
/// store holds fits [`MAX_STORE_HTML_BYTES`]. Current pages are never dropped
/// here; the 30-preview cap and the 2MB push cap already bound those.
pub(super) fn trim_to_budget(list: &mut [PreviewSnapshot]) {
    let held = |l: &[PreviewSnapshot]| -> usize {
        l.iter().map(|s| s.html.len() + s.previous.iter().map(PreviousVersion::size).sum::<usize>()).sum()
    };
    while held(list) > MAX_STORE_HTML_BYTES {
        let oldest = list
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.previous.last().map(|p| (i, p.created_at.clone())))
            .min_by(|a, b| a.1.cmp(&b.1));
        let Some((i, _)) = oldest else { return };
        let dropped = list[i].previous.pop();
        log::info!(
            "preview-history: html budget reached, dropping v{} of {}",
            dropped.map(|p| p.version).unwrap_or(0),
            list[i].slug,
        );
    }
}

/// What `get_preview` returns: the snapshot as one page, with `previous`
/// emptied so a client never receives every archived version at once. With
/// `version` set, that archived page's title, html, version and timestamp stand
/// in for the current ones and `published` is cleared, since the link belongs
/// to the latest page. `None` when the id or that version is gone.
pub fn get_view(id: &str, version: Option<u32>) -> Option<PreviewSnapshot> {
    let path = store_path()?;
    get_view_at(&path, id, version)
}

pub(crate) fn get_view_at(path: &Path, id: &str, version: Option<u32>) -> Option<PreviewSnapshot> {
    let mut snap = get_at(path, id)?;
    let previous = std::mem::take(&mut snap.previous);
    let Some(v) = version.filter(|v| *v != snap.version) else { return Some(snap) };
    let old = previous.into_iter().find(|p| p.version == v)?;
    let html = if old.html.is_empty() {
        match std::fs::read_to_string(archive_file(&archive_dir(path), id, v)) {
            Ok(h) => h,
            // A zero-byte page has no file to find; anything else missing is a lost page.
            Err(_) if old.html_bytes == 0 => String::new(),
            Err(e) => {
                log::warn!("preview-history: archived v{v} of {id} unreadable: {e}");
                return None;
            }
        }
    } else {
        old.html
    };
    snap.title = old.title;
    snap.session_id = old.session_id;
    snap.html = html;
    snap.version = old.version;
    snap.created_at = old.created_at;
    snap.published = None;
    Some(snap)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::preview::{list_at, push_at, set_published_at, PublishedLink, MAX_HISTORY};

    #[test]
    fn a_replace_archives_the_page_it_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "one".into(), Some("m".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        push_at(&path, "two".into(), Some("m".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();

        let meta = &list_at(&path)[0];
        assert_eq!(meta.version, 2);
        assert_eq!(meta.versions.iter().map(|v| v.version).collect::<Vec<_>>(), vec![1]);

        let old = get_view_at(&path, &id, Some(1)).unwrap();
        assert_eq!((old.html.as_str(), old.title.as_str(), old.version), ("<p>1</p>", "one", 1));
        let latest = get_view_at(&path, &id, None).unwrap();
        assert_eq!((latest.html.as_str(), latest.version), ("<p>2</p>", 2));
        // Asking for the current version by number is the latest page too.
        assert_eq!(get_view_at(&path, &id, Some(2)).unwrap().html, "<p>2</p>");
    }

    #[test]
    fn only_the_newest_previous_versions_are_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "t".into(), Some("m".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        for n in 2..=(KEEP_PREVIOUS_VERSIONS as u32 + 4) {
            push_at(&path, "t".into(), Some("m".into()), format!("<p>{n}</p>"), "chat".into(), None).unwrap();
        }
        let meta = &list_at(&path)[0];
        let latest = KEEP_PREVIOUS_VERSIONS as u32 + 4;
        assert_eq!(meta.version, latest);
        let kept: Vec<u32> = meta.versions.iter().map(|v| v.version).collect();
        assert_eq!(kept, (latest - KEEP_PREVIOUS_VERSIONS as u32..latest).rev().collect::<Vec<_>>(), "newest first, oldest dropped");
        assert!(get_view_at(&path, &id, Some(1)).is_none(), "a dropped version is gone");
    }

    #[test]
    fn a_view_never_carries_the_archive_or_an_old_pages_publish_link() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "a".into(), Some("m".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        push_at(&path, "b".into(), Some("m".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();
        let link = PublishedLink { url: "https://claude.ai/artifact/AB".into(), version: 2, account: "Joe".into(), published_at: "now".into() };
        set_published_at(&path, &id, link.clone()).unwrap();

        assert!(get_view_at(&path, &id, None).unwrap().previous.is_empty());
        let old = get_view_at(&path, &id, Some(1)).unwrap();
        assert!(old.previous.is_empty());
        assert_eq!(old.published, None);
        assert_eq!(get_view_at(&path, &id, None).unwrap().published, Some(link));
    }

    #[test]
    fn the_html_budget_drops_the_oldest_archived_version_across_previews() {
        let page = |tag: &str, created: &str| PreviousVersion {
            version: 1, title: tag.into(), html: "x".repeat(MAX_STORE_HTML_BYTES / 3), created_at: created.into(), session_id: None, html_bytes: 0,
        };
        let snap = |slug: &str, prev: Vec<PreviousVersion>| PreviewSnapshot {
            id: slug.into(), slug: slug.into(), title: slug.into(), html: "<p></p>".into(), source: "chat".into(),
            session_id: None, version: 2, created_at: "2026-02-01T00:00:00.000Z".into(), published: None, previous: prev,
        };
        let mut list = vec![
            snap("new", vec![page("n", "2026-01-03T00:00:00.000Z"), page("n-old", "2026-01-02T00:00:00.000Z")]),
            snap("older", vec![page("o", "2026-01-01T00:00:00.000Z")]),
        ];
        trim_to_budget(&mut list);
        // Three third-budget pages plus the current ones overflow; only the single oldest one is dropped.
        assert_eq!(list[1].previous.len(), 0);
        assert_eq!(list[0].previous.len(), 2);
    }

    #[test]
    fn a_history_file_written_before_versions_existed_loads_with_no_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        std::fs::write(
            &path,
            r#"[{"id":"a","slug":"s","title":"t","html":"<p>now</p>","source":"chat","session_id":null,"version":3,"created_at":"2026-01-01T00:00:00.000Z"}]"#,
        )
        .unwrap();
        assert!(list_at(&path)[0].versions.is_empty());
        assert_eq!(get_view_at(&path, "a", None).unwrap().html, "<p>now</p>");
        assert!(get_view_at(&path, "a", Some(2)).is_none());
        // Its history starts at the next push.
        push_at(&path, "t2".into(), Some("s".into()), "<p>next</p>".into(), "chat".into(), None).unwrap();
        assert_eq!(list_at(&path)[0].versions.iter().map(|v| v.version).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn an_archived_page_stays_owned_by_the_chat_that_pushed_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "a".into(), Some("m".into()), "<p>from A</p>".into(), "chat".into(), Some("A".into())).unwrap();
        push_at(&path, "b".into(), Some("m".into()), "<p>from B</p>".into(), "chat".into(), Some("B".into())).unwrap();

        let old = get_view_at(&path, &id, Some(1)).unwrap();
        assert_eq!(old.html, "<p>from A</p>");
        // The scope check reads this field, so it must name the pusher of THIS page.
        assert_eq!(old.session_id.as_deref(), Some("A"));
        assert_eq!(get_view_at(&path, &id, None).unwrap().session_id.as_deref(), Some("B"));
    }

    #[test]
    fn the_version_picker_lists_only_versions_the_listed_session_pushed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "a".into(), Some("m".into()), "<p>1</p>".into(), "chat".into(), Some("A".into())).unwrap();
        push_at(&path, "a2".into(), Some("m".into()), "<p>2</p>".into(), "chat".into(), Some("A".into())).unwrap();
        assert_eq!(list_at(&path)[0].versions.len(), 1, "same chat keeps its history");

        push_at(&path, "b".into(), Some("m".into()), "<p>3</p>".into(), "chat".into(), Some("B".into())).unwrap();
        let meta = &list_at(&path)[0];
        assert_eq!(meta.session_id.as_deref(), Some("B"));
        assert!(meta.versions.is_empty(), "A's pages must not be offered under B: {:?}", meta.versions);
    }

    fn archive_files(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(archive_dir(path))
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn archived_html_lives_outside_the_history_file_and_is_swept_when_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "t".into(), Some("m".into()), "<p>marker-one</p>".into(), "chat".into(), None).unwrap();
        push_at(&path, "t".into(), Some("m".into()), "<p>marker-two</p>".into(), "chat".into(), None).unwrap();

        let main = std::fs::read_to_string(&path).unwrap();
        assert!(!main.contains("marker-one"), "an archived page must not be parsed with the listing");
        assert!(main.contains("marker-two"), "the current page stays in the history file");
        assert_eq!(archive_files(&path), vec![format!("{id}-v1.html")]);
        assert_eq!(get_view_at(&path, &id, Some(1)).unwrap().html, "<p>marker-one</p>");

        for n in 3..=(KEEP_PREVIOUS_VERSIONS as u32 + 3) {
            push_at(&path, "t".into(), Some("m".into()), format!("<p>{n}</p>"), "chat".into(), None).unwrap();
        }
        assert_eq!(archive_files(&path).len(), KEEP_PREVIOUS_VERSIONS, "a version past the cap loses its file");
        assert!(get_view_at(&path, &id, Some(1)).is_none());
    }

    #[test]
    fn a_page_archived_by_an_older_build_moves_to_a_file_on_the_next_save() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        std::fs::write(
            &path,
            r#"[{"id":"a","slug":"s","title":"t","html":"<p>now</p>","source":"chat","session_id":null,"version":3,"created_at":"2026-01-01T00:00:00.000Z",
                 "previous":[{"version":2,"title":"old","html":"<p>embedded</p>","created_at":"2025-12-31T00:00:00.000Z"}]}]"#,
        )
        .unwrap();
        // Readable before any save rewrites it.
        assert_eq!(get_view_at(&path, "a", Some(2)).unwrap().html, "<p>embedded</p>");

        push_at(&path, "t2".into(), Some("s".into()), "<p>next</p>".into(), "chat".into(), None).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("embedded"));
        assert_eq!(get_view_at(&path, "a", Some(2)).unwrap().html, "<p>embedded</p>");
        assert_eq!(get_view_at(&path, "a", Some(3)).unwrap().html, "<p>now</p>");
    }

    #[test]
    fn a_missing_archive_file_is_a_miss_not_a_blank_page() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let id = push_at(&path, "t".into(), Some("m".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        push_at(&path, "t".into(), Some("m".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();
        std::fs::remove_file(archive_file(&archive_dir(&path), &id, 1)).unwrap();
        assert!(get_view_at(&path, &id, Some(1)).is_none());
    }

    #[test]
    fn evicting_a_preview_removes_its_archive_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        push_at(&path, "t".into(), Some("old".into()), "<p>1</p>".into(), "chat".into(), None).unwrap();
        push_at(&path, "t".into(), Some("old".into()), "<p>2</p>".into(), "chat".into(), None).unwrap();
        assert_eq!(archive_files(&path).len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(2));
        for i in 0..MAX_HISTORY {
            push_at(&path, "t".into(), Some(format!("n{i}")), "<p></p>".into(), "chat".into(), None).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(!list_at(&path).iter().any(|m| m.slug == "old"));
        assert!(archive_files(&path).is_empty(), "{:?}", archive_files(&path));
    }

    /// Measurement for the cost of listing a full-budget history. Run by hand:
    /// `cargo test --lib -- --ignored --nocapture a_full_budget_history_lists_fast`.
    #[test]
    #[ignore = "timing measurement, not a pass/fail check"]
    fn a_full_budget_history_lists_fast() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let page = |n: usize| "x".repeat(n);
        // The shape a pre-sidecar build wrote: every archived page embedded.
        let entries: Vec<serde_json::Value> = (0..MAX_HISTORY)
            .map(|i| {
                serde_json::json!({
                    "id": format!("id-{i}"), "slug": format!("s{i}"), "title": "t", "html": page(50_000),
                    "source": "chat", "session_id": "S", "version": 7,
                    "created_at": format!("2026-01-{:02}T00:00:00.000Z", i + 1),
                    "previous": (0..KEEP_PREVIOUS_VERSIONS).map(|v| serde_json::json!({
                        "version": 6 - v, "title": "t", "html": page(380_000),
                        "created_at": "2026-01-01T00:00:00.000Z",
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        std::fs::write(&path, serde_json::to_string_pretty(&entries).unwrap()).unwrap();
        let mb = std::fs::metadata(&path).unwrap().len() / (1024 * 1024);

        let time = |label: &str, f: &dyn Fn()| {
            let start = std::time::Instant::now();
            for _ in 0..3 {
                f();
            }
            println!("{label}: {:?} avg over 3 ({mb} MB file)", start.elapsed() / 3);
        };
        time("list, file as first read", &|| {
            list_at(&path);
        });
        push_at(&path, "again".into(), Some("s0".into()), "<p>x</p>".into(), "chat".into(), Some("S".into())).unwrap();
        let mb = std::fs::metadata(&path).unwrap().len() / (1024 * 1024);
        time("list, after one push", &|| {
            list_at(&path);
        });
        let start = std::time::Instant::now();
        push_at(&path, "again".into(), Some("s0".into()), "<p>y</p>".into(), "chat".into(), Some("S".into())).unwrap();
        println!("push (second, steady state): {:?} ({mb} MB main file)", start.elapsed());
    }
}
