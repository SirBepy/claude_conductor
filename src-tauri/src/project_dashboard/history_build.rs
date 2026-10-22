//! Turns scanned transcripts into the dashboard's History half: quick actions,
//! outcomes, gallery and files. Pure over `ScannedChat`s, so the ranking and
//! filtering rules are tested with in-memory facts.

use super::history_scan::{encode_image_id, TranscriptFacts};
use super::snapshot_parts::clip;
use super::snapshot_types::{DashboardHistory, FileRow, GalleryItem, OutcomeRow, QuickAction};
use super::types::cwd_key;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

const QUICK_ACTIONS: usize = 5;
const QUICK_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const OUTCOMES: usize = 6;
const OUTCOME_CHARS: usize = 1000;
const GALLERY: usize = 9;
const FILES: usize = 10;

/// Extensions worth listing as "files a chat produced".
const FILE_EXTS: [&str; 9] = ["md", "html", "pdf", "pptx", "docx", "xlsx", "csv", "png", "svg"];
/// Source and tooling trees: a Write there is code, not a deliverable.
const FILE_EXCLUDED: [&str; 4] = ["/src/", "/src-tauri/", "node_modules", ".claude/todos"];

pub struct ScannedChat {
    pub session_id: String,
    pub title: String,
    pub repo_cwd: String,
    /// Transcript mtime in epoch ms; orders the chats newest first.
    pub ended_ms: i64,
    pub path: PathBuf,
    /// Still running, so it has no final outcome yet.
    pub live: bool,
    pub facts: Arc<TranscriptFacts>,
}

/// Top commands by use inside the last 30 days, most used first, ties by name.
pub fn top_commands(chats: &[ScannedChat], now_ms: i64) -> Vec<QuickAction> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for c in chats {
        for (name, at) in &c.facts.commands {
            if now_ms - at <= QUICK_WINDOW_MS {
                *counts.entry(name.as_str()).or_insert(0) += 1;
            }
        }
    }
    let mut rows: Vec<QuickAction> =
        counts.into_iter().map(|(command, count)| QuickAction { command: command.to_string(), count }).collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.command.cmp(&b.command)));
    rows.truncate(QUICK_ACTIONS);
    rows
}

/// The last message each finished chat sent the dev, newest chat first. Chats
/// that never sent one are passed over, so the list is the six most recent
/// that have something to show.
pub fn outcomes(chats: &[ScannedChat]) -> Vec<OutcomeRow> {
    chats
        .iter()
        .filter(|c| !c.live)
        .filter_map(|c| {
            let (text, at_ms) = c.facts.outcome.as_ref()?;
            Some(OutcomeRow {
                session_id: c.session_id.clone(),
                title: c.title.clone(),
                text: clip(text, OUTCOME_CHARS),
                at_ms: *at_ms,
                repo_cwd: c.repo_cwd.clone(),
            })
        })
        .take(OUTCOMES)
        .collect()
}

pub fn gallery(chats: &[ScannedChat]) -> Vec<GalleryItem> {
    let mut items: Vec<GalleryItem> = chats
        .iter()
        .flat_map(|c| {
            c.facts.images.iter().map(move |img| GalleryItem {
                id: encode_image_id(&c.path, img.offset, &img.block),
                session_id: c.session_id.clone(),
                title: c.title.clone(),
                at_ms: img.at_ms,
                repo_cwd: c.repo_cwd.clone(),
            })
        })
        .collect();
    items.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    items.truncate(GALLERY);
    items
}

/// Deliverable-looking files only: a listed extension, and outside source and
/// tooling folders.
pub fn file_wanted(path: &str) -> bool {
    let norm = path.replace('\\', "/").to_lowercase();
    let ext = norm.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    FILE_EXTS.contains(&ext) && !FILE_EXCLUDED.iter().any(|x| norm.contains(x))
}

/// Chats also write outside their repo (Claude's memory notes, global config),
/// and those are not this project's deliverables.
fn inside_repo(path: &str, repo_cwd: &str) -> bool {
    let root = cwd_key(repo_cwd);
    let p = cwd_key(path);
    let root = root.trim_end_matches(['/', '\\']);
    p.len() > root.len() && p.starts_with(root) && matches!(p.as_bytes()[root.len()], b'/' | b'\\')
}

/// Distinct paths, newest write first. `exists` is checked only for the rows
/// that survive the cap: a stat per candidate would scale with transcript size.
pub fn files(chats: &[ScannedChat]) -> Vec<FileRow> {
    let mut newest: HashMap<String, FileRow> = HashMap::new();
    for c in chats {
        let wanted = |p: &String| file_wanted(p) && inside_repo(p, &c.repo_cwd);
        for (path, at_ms) in c.facts.writes.iter().filter(|(p, _)| wanted(p)) {
            let row = FileRow {
                path: path.clone(),
                session_id: c.session_id.clone(),
                chat_title: c.title.clone(),
                at_ms: *at_ms,
                exists: false,
                repo_cwd: c.repo_cwd.clone(),
            };
            let slot = newest.entry(cwd_key(path)).or_insert_with(|| row.clone());
            if row.at_ms > slot.at_ms {
                *slot = row;
            }
        }
    }
    let mut rows: Vec<FileRow> = newest.into_values().collect();
    rows.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| a.path.cmp(&b.path)));
    rows.truncate(FILES);
    for r in &mut rows {
        r.exists = std::path::Path::new(&r.path).exists();
    }
    rows
}

/// `chats` may arrive in any order; the helpers above want newest first.
pub fn build_history(mut chats: Vec<ScannedChat>, now_ms: i64) -> DashboardHistory {
    chats.sort_by(|a, b| b.ended_ms.cmp(&a.ended_ms));
    DashboardHistory {
        quick_actions: top_commands(&chats, now_ms),
        outcomes: outcomes(&chats),
        gallery: gallery(&chats),
        files: files(&chats),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::history_scan::ImageRef;

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn chat(title: &str, ended_ms: i64, live: bool, facts: TranscriptFacts) -> ScannedChat {
        ScannedChat {
            session_id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            repo_cwd: "C:/w/app".into(),
            ended_ms,
            path: PathBuf::from(format!("C:/t/{title}.jsonl")),
            live,
            facts: Arc::new(facts),
        }
    }

    fn with_commands(cmds: &[(&str, i64)]) -> TranscriptFacts {
        TranscriptFacts { commands: cmds.iter().map(|(n, t)| (n.to_string(), *t)).collect(), ..Default::default() }
    }

    #[test]
    fn commands_rank_by_count_then_name_and_stop_at_five() {
        let mut cmds = Vec::new();
        for (name, n) in [("/a", 1), ("/b", 4), ("/c", 2), ("/d", 2), ("/e", 3), ("/f", 1), ("/g", 1)] {
            for _ in 0..n {
                cmds.push((name, NOW - DAY));
            }
        }
        let rows = top_commands(&[chat("x", NOW, false, with_commands(&cmds))], NOW);
        let names: Vec<&str> = rows.iter().map(|r| r.command.as_str()).collect();
        assert_eq!(names, ["/b", "/e", "/c", "/d", "/a"]);
        assert_eq!(rows[0].count, 4);
    }

    #[test]
    fn commands_older_than_thirty_days_do_not_count() {
        let facts = with_commands(&[("/old", NOW - 31 * DAY), ("/new", NOW - 29 * DAY)]);
        let rows = top_commands(&[chat("x", NOW, false, facts)], NOW);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "/new");
    }

    #[test]
    fn counts_add_up_across_chats() {
        let a = chat("a", NOW, false, with_commands(&[("/close", NOW)]));
        let b = chat("b", NOW - 1, true, with_commands(&[("/close", NOW), ("/test", NOW)]));
        let rows = top_commands(&[a, b], NOW);
        assert_eq!((rows[0].command.as_str(), rows[0].count), ("/close", 2));
    }

    fn with_outcome(text: &str, at: i64) -> TranscriptFacts {
        TranscriptFacts { outcome: Some((text.into(), at)), ..Default::default() }
    }

    #[test]
    fn outcomes_skip_live_chats_and_chats_without_one_and_cap_at_six() {
        let mut chats = vec![
            chat("live", 100, true, with_outcome("still going", 100)),
            chat("silent", 99, false, TranscriptFacts::default()),
        ];
        for i in 0..8 {
            chats.push(chat(&format!("done{i}"), 90 - i, false, with_outcome(&format!("result {i}"), 90 - i)));
        }
        let out = outcomes(&chats);
        assert_eq!(out.len(), 6);
        assert_eq!(out[0].text, "result 0");
        assert!(out.iter().all(|o| o.title.starts_with("done")));
    }

    #[test]
    fn a_long_outcome_is_clipped() {
        let out = outcomes(&[chat("c", 1, false, with_outcome(&"word ".repeat(500), 1))]);
        assert!(out[0].text.chars().count() < 1010);
        assert!(out[0].text.ends_with("..."));
    }

    #[test]
    fn the_gallery_takes_the_nine_newest_images_across_chats() {
        let img = |t: i64| ImageRef { offset: t as u64, block: "0".into(), at_ms: t };
        let a = chat("a", 1, false, TranscriptFacts { images: (1..=6).map(img).collect(), ..Default::default() });
        let b = chat("b", 2, false, TranscriptFacts { images: (7..=12).map(img).collect(), ..Default::default() });
        let g = gallery(&[a, b]);
        assert_eq!(g.len(), 9);
        assert_eq!(g[0].at_ms, 12);
        assert_eq!(g[8].at_ms, 4);
        assert!(g.iter().all(|i| !i.id.is_empty()));
        assert_eq!(g[0].title, "b");
    }

    #[test]
    fn file_filter_keeps_deliverables_and_drops_source_trees() {
        assert!(file_wanted("C:\\proj\\docs\\report.md"));
        assert!(file_wanted("C:/proj/out/Deck.PPTX"));
        assert!(file_wanted("/home/a/mock.svg"));
        assert!(!file_wanted("C:\\proj\\src\\readme.md"));
        assert!(!file_wanted("C:\\proj\\src-tauri\\notes.md"));
        assert!(!file_wanted("C:\\proj\\node_modules\\pkg\\README.md"));
        assert!(!file_wanted("C:\\proj\\.claude\\todos\\12-x.md"));
        assert!(!file_wanted("C:\\proj\\main.rs"));
        assert!(!file_wanted("C:\\proj\\Makefile"));
    }

    fn with_writes(writes: &[(&str, i64)]) -> TranscriptFacts {
        TranscriptFacts { writes: writes.iter().map(|(p, t)| (p.to_string(), *t)).collect(), ..Default::default() }
    }

    #[test]
    fn files_are_distinct_newest_first_capped_and_flag_existence() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        std::fs::write(&real, "x").unwrap();
        let real_s = real.to_string_lossy().to_string();
        let root = dir.path().to_string_lossy().to_string();
        let mut writes: Vec<(String, i64)> = (0..14).map(|i| (format!("{root}/gone/f{i}.html"), i)).collect();
        writes.push((real_s.clone(), 100));
        writes.push((real_s.to_uppercase(), 50));
        writes.push((format!("{root}/src/skipped.md"), 999));
        let facts = TranscriptFacts { writes, ..Default::default() };
        let mut c = chat("c", 1, false, facts);
        c.repo_cwd = root;
        let rows = files(&[c]);
        assert_eq!(rows.len(), 10);
        assert_eq!(rows[0].path, real_s);
        assert!(rows[0].exists);
        assert!(!rows[1].exists);
        assert_eq!(rows.iter().filter(|r| cwd_key(&r.path) == cwd_key(&real_s)).count(), 1, "one row per distinct path");
        assert!(rows.iter().all(|r| !r.path.contains("/src/")));
    }

    #[test]
    fn a_rewritten_file_keeps_its_newest_chat() {
        let old = chat("old", 1, false, with_writes(&[("C:/w/app/a.md", 10)]));
        let new = chat("new", 2, false, with_writes(&[("C:/w/app/a.md", 20)]));
        let rows = files(&[old, new]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chat_title, "new");
    }

    #[test]
    fn files_written_outside_the_repo_are_not_its_deliverables() {
        let c = chat(
            "c",
            1,
            false,
            with_writes(&[
                ("C:\\Users\\me\\.claude\\projects\\x\\memory\\note.md", 30),
                ("C:/w/app-other/deck.pptx", 20),
                ("C:/w/app/docs/report.md", 10),
            ]),
        );
        let rows = files(&[c]);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].path.ends_with("report.md"));
    }

    #[test]
    fn build_history_orders_chats_newest_first_before_picking() {
        let older = chat("older", 10, false, with_outcome("old result", 10));
        let newer = chat("newer", 20, false, with_outcome("new result", 20));
        let h = build_history(vec![older, newer], NOW);
        assert_eq!(h.outcomes[0].text, "new result");
    }
}
