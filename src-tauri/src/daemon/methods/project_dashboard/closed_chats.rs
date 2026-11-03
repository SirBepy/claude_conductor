//! `dashboard_closed_chats`: one page of a target's ended chats, newest first,
//! behind the dashboard's History modal. The snapshot only carries the newest
//! few (`recent_chats`); this pages further back, over every repo of a group.

use super::gather::gather;
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::history_scan::project_dir_slug;
use crate::project_dashboard::targets::resolve_target;
use crate::project_dashboard::{DashChatRow, DashboardTargetRef};
use std::collections::HashSet;
use std::sync::Arc;

/// Rows a caller may ask for at once; a modal page is a screenful, and each
/// repo is scanned `offset + limit` deep.
const MAX_LIMIT: u32 = 100;

/// Newest-first window `[offset, offset + limit)` over rows gathered from
/// several repos, each already sorted but not against the others.
fn page_of(mut rows: Vec<DashChatRow>, offset: usize, limit: usize) -> Vec<DashChatRow> {
    rows.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| a.session_id.cmp(&b.session_id)));
    rows.into_iter().skip(offset).take(limit).collect()
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
        let mut rows = Vec::new();
        for repo in &target.repos {
            let slug = project_dir_slug(&projects_dir, &repo.cwd);
            let entries = crate::ipc::chat::history::collect_history(&projects_dir, Some(slug), None, depth, 0, None, None, None);
            rows.extend(entries.into_iter().filter(|e| !live_ids.contains(&e.session_id)).map(|e| DashChatRow {
                session_id: e.session_id,
                title: e.title,
                status: "ended".into(),
                repo_cwd: repo.cwd.clone(),
                at_ms: e.ended_at.unwrap_or(e.started_at) * 1000,
            }));
        }
        page_of(rows, offset as usize, limit as usize)
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
}
