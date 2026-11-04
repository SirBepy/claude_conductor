//! `dashboard_closed_chats`: one page of a target's ended chats, newest first,
//! behind the dashboard's History modal. The snapshot only carries the newest
//! few (`recent_chats`); this pages further back, over every repo of a group.

use super::gather::gather;
use super::snapshot::{ended_rows, sort_newest_first};
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::targets::resolve_target;
use crate::project_dashboard::{DashChatRow, DashboardTargetRef, RepoRef};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

/// Rows a caller may ask for at once; a modal page is a screenful, and each
/// repo is scanned `offset + limit` deep.
const MAX_LIMIT: u32 = 100;

/// Newest-first window `[offset, offset + limit)` over rows gathered from
/// several repos, each already sorted but not against the others.
fn page_of(mut rows: Vec<DashChatRow>, offset: usize, limit: usize) -> Vec<DashChatRow> {
    sort_newest_first(&mut rows);
    rows.into_iter().skip(offset).take(limit).collect()
}

/// One page of ended chats over an explicit projects dir, so a test can point
/// it at a fixture.
fn closed_page(
    projects_dir: &Path,
    repos: &[RepoRef],
    live_ids: &HashSet<String>,
    depth: u32,
    offset: usize,
    limit: usize,
) -> Vec<DashChatRow> {
    page_of(ended_rows(repos, projects_dir, live_ids, depth), offset, limit)
}

pub(super) async fn closed_chats(
    state: &Arc<DaemonState>,
    target_ref: DashboardTargetRef,
    offset: u32,
    limit: u32,
) -> Result<Vec<DashChatRow>, RpcError> {
    let g = gather(state).await;
    let target = resolve_target(&target_ref, &g.groups, &g.projects)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown {} dashboard: {}", target_ref.kind, target_ref.id)))?;
    let live_ids: HashSet<String> = g.live.iter().map(|c| c.inst.session_id.clone()).collect();
    let limit = limit.min(MAX_LIMIT);
    // Live chats are filtered out after the scan, so each repo is read that much deeper.
    let depth = offset.saturating_add(limit).saturating_add(live_ids.len() as u32);
    tokio::task::spawn_blocking(move || {
        let Some(projects_dir) = crate::tokens::claude_projects_dir() else { return Vec::new() };
        closed_page(&projects_dir, &target.repos, &live_ids, depth, offset as usize, limit as usize)
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, at_ms: i64) -> DashChatRow {
        DashChatRow { session_id: id.into(), title: id.into(), status: "ended".into(), repo_cwd: "r".into(), at_ms }
    }

    #[test]
    fn pages_merge_repos_newest_first() {
        let rows = vec![row("a", 10), row("c", 30), row("b", 20), row("d", 40)];
        let first: Vec<_> = page_of(rows.clone(), 0, 2).into_iter().map(|r| r.session_id).collect();
        let second: Vec<_> = page_of(rows, 2, 2).into_iter().map(|r| r.session_id).collect();
        assert_eq!(first, ["d", "c"]);
        assert_eq!(second, ["b", "a"]);
    }

    #[test]
    fn a_page_past_the_end_is_empty() {
        assert!(page_of(vec![row("a", 1)], 5, 3).is_empty());
    }

    #[test]
    fn equal_times_keep_a_stable_order_across_pages() {
        let rows = vec![row("y", 5), row("x", 5), row("z", 5)];
        let all: Vec<_> = page_of(rows.clone(), 0, 3).into_iter().map(|r| r.session_id).collect();
        let tail: Vec<_> = page_of(rows, 1, 2).into_iter().map(|r| r.session_id).collect();
        assert_eq!(all, ["x", "y", "z"]);
        assert_eq!(tail, ["y", "z"]);
    }

    /// Writes `<projects_dir>/<slug of cwd>/<id>.jsonl` with the given mtime
    /// (whole seconds, which is the resolution `ended_at` keeps).
    fn write_chat(projects_dir: &Path, cwd: &str, id: &str, mtime_secs: u64) {
        let dir = projects_dir.join(crate::tokens::encode_cwd_as_project_dir(Path::new(cwd)));
        std::fs::create_dir_all(&dir).unwrap();
        let line = serde_json::json!({"type":"user","message":{"role":"user","content":id}}).to_string();
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, line).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime_secs))
            .unwrap();
    }

    fn repo(cwd: &str) -> RepoRef {
        RepoRef { cwd: cwd.into(), name: cwd.into(), project_id: None }
    }

    #[test]
    fn the_snapshots_recent_rows_equal_the_first_modal_page_for_one_projects_dir() {
        let tmp = tempfile::tempdir().unwrap();
        // "bbb" (first repo) and "aaa" (second repo) tie on time, so the card
        // and the modal's first page only agree if both break the tie by id.
        write_chat(tmp.path(), "/fixture/z", "bbb", 2_000);
        write_chat(tmp.path(), "/fixture/z", "ddd", 1_000);
        write_chat(tmp.path(), "/fixture/a", "aaa", 2_000);
        write_chat(tmp.path(), "/fixture/a", "ccc", 3_000);
        write_chat(tmp.path(), "/fixture/a", "live", 4_000);
        let repos = [repo("/fixture/z"), repo("/fixture/a")];
        let live: HashSet<String> = ["live".to_string()].into();

        let recent: Vec<_> = super::super::snapshot::recent_chats_in(tmp.path(), &repos, &live, 1)
            .into_iter().map(|r| r.session_id).collect();
        let modal: Vec<_> = closed_page(tmp.path(), &repos, &live, 7, 0, 6)
            .into_iter().map(|r| r.session_id).collect();

        assert_eq!(recent, ["ccc", "aaa", "bbb", "ddd"]);
        assert_eq!(modal, recent);
    }
}
