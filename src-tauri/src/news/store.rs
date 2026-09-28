//! Persists scraped news posts + per-slug read state to news.json.
//!
//! Posts are kept newest-first, capped at MAX_KEEP. The store also holds
//! `bootstrapped`: false on a fresh install so the first scrape can mark
//! every post as read and not present a wall of unread items.

use crate::types::NewsPost;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

const MAX_KEEP: usize = 100;

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct NewsStore {
    #[serde(default)]
    pub posts: Vec<NewsPost>,
    #[serde(default)]
    pub read_slugs: HashSet<String>,
    #[serde(default)]
    pub bootstrapped: bool,
    #[serde(default)]
    pub last_fetch_at: Option<String>,
}

pub fn load(path: &Path) -> NewsStore {
    let Ok(raw) = std::fs::read_to_string(path) else { return NewsStore::default(); };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(path: &Path, store: &NewsStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(store)?;
    crate::util::write_json_atomic(path, &raw).with_context(|| format!("write {path:?}"))?;
    Ok(())
}

pub fn mark_all_read(store: &mut NewsStore) {
    for p in &mut store.posts {
        p.unread = false;
        store.read_slugs.insert(p.slug.clone());
    }
}

pub fn mark_read(store: &mut NewsStore, slug: &str) {
    store.read_slugs.insert(slug.to_string());
    if let Some(p) = store.posts.iter_mut().find(|p| p.slug == slug) {
        p.unread = false;
    }
}

/// Merges scraped items into the store. Returns the slugs that are NEW
/// (not previously present in the store), so the caller can back-fill
/// per-article summaries and decide whether to fire a notification. On the
/// first ever merge (bootstrapped == false), no slugs are reported as new
/// and every post is marked read.
pub fn merge_scraped(
    store: &mut NewsStore,
    scraped: Vec<crate::news::ScrapedItem>,
) -> Vec<String> {
    let was_bootstrapped = store.bootstrapped;
    let existing: HashSet<String> = store.posts.iter().map(|p| p.slug.clone()).collect();

    let mut new_slugs = Vec::new();
    let mut next_posts: Vec<NewsPost> = Vec::with_capacity(scraped.len());
    for item in scraped {
        let is_new = !existing.contains(&item.slug);
        let prev = store.posts.iter().find(|p| p.slug == item.slug);
        let unread = if !was_bootstrapped {
            false
        } else if is_new {
            true
        } else {
            prev.map(|p| p.unread).unwrap_or(false)
        };
        if !was_bootstrapped {
            store.read_slugs.insert(item.slug.clone());
        } else if is_new {
            new_slugs.push(item.slug.clone());
        }
        let summary = prev.and_then(|p| p.summary.clone());
        let ai_summary = prev.and_then(|p| p.ai_summary.clone());
        let ai_summary_model = prev.and_then(|p| p.ai_summary_model.clone());
        let ai_summary_at = prev.and_then(|p| p.ai_summary_at.clone());
        let date_iso = crate::news::scraper::parse_date_iso(&item.date_label);
        next_posts.push(NewsPost {
            slug: item.slug,
            url: item.url,
            title: item.title,
            category: item.category,
            excerpt: item.excerpt,
            summary,
            ai_summary,
            ai_summary_model,
            ai_summary_at,
            date_label: item.date_label,
            date_iso,
            unread,
        });
    }

    next_posts.sort_by(|a, b| b.date_iso.cmp(&a.date_iso));
    next_posts.truncate(MAX_KEEP);

    store.posts = next_posts;
    store.bootstrapped = true;
    new_slugs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::news::ScrapedItem;
    use tempfile::tempdir;

    fn item(slug: &str, date: &str) -> ScrapedItem {
        ScrapedItem {
            slug: slug.into(),
            url: format!("https://www.anthropic.com/news/{slug}"),
            title: format!("Title {slug}"),
            category: Some("Product".into()),
            excerpt: Some("body".into()),
            date_label: date.into(),
        }
    }

    #[test]
    fn first_merge_marks_everything_read_and_returns_no_new() {
        let mut s = NewsStore::default();
        let new = merge_scraped(&mut s, vec![item("a", "May 5, 2026"), item("b", "May 6, 2026")]);
        assert!(new.is_empty(), "first merge bootstraps without notifications");
        assert!(s.bootstrapped);
        assert_eq!(s.posts.len(), 2);
        assert!(s.posts.iter().all(|p| !p.unread));
        assert_eq!(s.read_slugs.len(), 2);
    }

    #[test]
    fn second_merge_flags_only_truly_new_slugs() {
        let mut s = NewsStore::default();
        merge_scraped(&mut s, vec![item("a", "May 5, 2026")]);
        let new = merge_scraped(&mut s, vec![
            item("b", "May 7, 2026"),
            item("a", "May 5, 2026"),
        ]);
        assert_eq!(new, vec!["b".to_string()]);
        let post_b = s.posts.iter().find(|p| p.slug == "b").unwrap();
        assert!(post_b.unread, "new post must surface as unread");
        let post_a = s.posts.iter().find(|p| p.slug == "a").unwrap();
        assert!(!post_a.unread, "previously seen post stays read");
    }

    #[test]
    fn merge_sorts_newest_first_by_iso_date() {
        let mut s = NewsStore::default();
        merge_scraped(&mut s, vec![
            item("old", "Apr 1, 2026"),
            item("new", "May 9, 2026"),
            item("mid", "Apr 20, 2026"),
        ]);
        let slugs: Vec<&str> = s.posts.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, vec!["new", "mid", "old"]);
    }

    #[test]
    fn merge_preserves_summary_and_ai_summary_across_refetches() {
        let mut s = NewsStore::default();
        merge_scraped(&mut s, vec![item("a", "May 5, 2026")]);
        s.posts[0].summary = Some("TLDR sentence.".into());
        s.posts[0].ai_summary = Some("Para one.\n\nPara two.".into());
        s.posts[0].ai_summary_model = Some("sonnet".into());
        s.posts[0].ai_summary_at = Some("2026-05-29T00:00:00Z".into());
        merge_scraped(&mut s, vec![item("a", "May 5, 2026")]);
        assert_eq!(s.posts[0].summary.as_deref(), Some("TLDR sentence."));
        assert_eq!(s.posts[0].ai_summary.as_deref(), Some("Para one.\n\nPara two."));
        assert_eq!(s.posts[0].ai_summary_model.as_deref(), Some("sonnet"));
        assert_eq!(s.posts[0].ai_summary_at.as_deref(), Some("2026-05-29T00:00:00Z"));
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("news.json");
        let mut s = NewsStore::default();
        merge_scraped(&mut s, vec![item("a", "May 5, 2026")]);
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(back.posts.len(), 1);
        assert!(back.bootstrapped);
    }

    #[test]
    fn mark_all_read_clears_unread_flag() {
        let mut s = NewsStore::default();
        merge_scraped(&mut s, vec![item("a", "May 5, 2026")]);
        merge_scraped(&mut s, vec![item("b", "May 7, 2026"), item("a", "May 5, 2026")]);
        mark_all_read(&mut s);
        assert!(s.posts.iter().all(|p| !p.unread));
    }
}
