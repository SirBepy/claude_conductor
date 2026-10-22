//! `dashboard_history` and `dashboard_gallery_image`: the transcript-mining
//! half, split from the snapshot so the dashboard can paint first.

use super::gather::gather;
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::history_build::{build_history, ScannedChat};
use crate::project_dashboard::history_scan::{facts_for, project_dir_slug, read_image};
use crate::project_dashboard::targets::resolve_target;
use crate::project_dashboard::{DashboardHistory, DashboardTargetRef, RepoRef};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

/// Transcripts read per repo. Older ones rarely hold anything the dev still
/// wants on a dashboard, and each is a full-file scan on a cold cache.
const PER_REPO: u32 = 20;

/// Scans the newest transcripts of each repo. Blocking: file IO throughout.
fn scan_repos(repos: &[RepoRef], projects_dir: &Path, live_ids: &HashSet<String>) -> Vec<ScannedChat> {
    let mut jobs = Vec::new();
    for repo in repos {
        let slug = project_dir_slug(projects_dir, &repo.cwd);
        let entries =
            crate::ipc::chat::history::collect_history(projects_dir, Some(slug), None, PER_REPO, 0, None, None, None);
        for e in entries {
            let path = projects_dir.join(&e.project_id).join(format!("{}.jsonl", e.session_id));
            jobs.push((repo.cwd.clone(), e, path));
        }
    }
    let scanned = par_map(&jobs, |(repo_cwd, e, path)| {
        let facts = facts_for(path)?;
        Some(ScannedChat {
            session_id: e.session_id.clone(),
            title: e.title.clone(),
            repo_cwd: repo_cwd.clone(),
            ended_ms: e.ended_at.unwrap_or(e.started_at) * 1000,
            path: path.clone(),
            live: live_ids.contains(&e.session_id),
            facts,
        })
    });
    scanned.into_iter().flatten().collect()
}

/// `f` over `items` on up to four threads (the repo's concurrency cap),
/// results in input order. A cold dashboard scans up to ~80 files, and one
/// thread per file would be a spike for nothing.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    const WORKERS: usize = 4;
    if items.len() < 2 {
        return items.iter().map(&f).collect();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut slots: Vec<Option<R>> = items.iter().map(|_| None).collect();
    let results = std::sync::Mutex::new(&mut slots);
    std::thread::scope(|s| {
        for _ in 0..WORKERS.min(items.len()) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let r = f(item);
                results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    slots.into_iter().flatten().collect()
}

pub(super) async fn history(state: &Arc<DaemonState>, target_ref: DashboardTargetRef) -> Result<DashboardHistory, RpcError> {
    let g = gather(state).await;
    let target = resolve_target(&target_ref, &g.groups, &g.projects)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown {} dashboard: {}", target_ref.kind, target_ref.id)))?;
    let projects_dir = crate::tokens::claude_projects_dir().ok_or_else(|| RpcError::internal("no home dir"))?;
    let live_ids: HashSet<String> = g.live.iter().map(|c| c.inst.session_id.clone()).collect();
    let now_ms = g.now_ms;
    tokio::task::spawn_blocking(move || {
        build_history(scan_repos(&target.repos, &projects_dir, &live_ids), now_ms)
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))
}

pub(super) async fn gallery_image(id: String) -> Result<String, RpcError> {
    let projects_dir = crate::tokens::claude_projects_dir().ok_or_else(|| RpcError::internal("no home dir"))?;
    tokio::task::spawn_blocking(move || read_image(&id, &projects_dir))
        .await
        .map_err(|e| RpcError::internal(format!("join: {e}")))?
        .map_err(RpcError::invalid_params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn par_map_keeps_input_order_and_covers_every_item() {
        let items: Vec<u32> = (0..50).collect();
        let out = par_map(&items, |n| n * 2);
        assert_eq!(out, (0..50).map(|n| n * 2).collect::<Vec<_>>());
    }

    #[test]
    fn par_map_handles_empty_and_single_inputs() {
        assert!(par_map(&Vec::<u32>::new(), |n| *n).is_empty());
        assert_eq!(par_map(&[7u32], |n| *n + 1), vec![8]);
    }

    /// Wall-clock measurement against the dev's real transcripts; run by hand
    /// with `--ignored --nocapture`. Not a pass/fail check.
    #[test]
    #[ignore]
    fn live_scan_timing() {
        let projects_dir = crate::tokens::claude_projects_dir().unwrap();
        let repo = RepoRef { cwd: std::env::var("DASH_REPO").unwrap(), name: "r".into(), project_id: None };
        for pass in ["cold", "warm"] {
            let t = std::time::Instant::now();
            let chats = scan_repos(&[repo.clone()], &projects_dir, &HashSet::new());
            let h = build_history(chats, chrono::Utc::now().timestamp_millis());
            println!(
                "{pass}: {:?} quick={} outcomes={} gallery={} files={}",
                t.elapsed(),
                h.quick_actions.len(),
                h.outcomes.len(),
                h.gallery.len(),
                h.files.len()
            );
        }
    }
}
