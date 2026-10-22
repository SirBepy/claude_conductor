//! `new_session_bundle`: everything the new-chat flow (project picker ->
//! location step -> model/effort modal) reads, in ONE response. The phone
//! reaches the daemon over a tunnel capped at 6 concurrent HTTP/1.1
//! connections, so the per-project reads (2 stats + a CLAUDE.md scan + an
//! account binding, times ~40 projects) queued behind each other and the
//! modal a tap was waiting on sat at the back of that queue. One request
//! means the phone can warm it at boot and every step opens from cache.

use super::listings::project_groups;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;

/// The folder the location step scans first: the remembered worktree when it
/// is still one of the project's worktrees, else the project root. Mirrors
/// `rememberedWorktree` in location-picker.ts.
fn remembered_worktree(g: &crate::types::ProjectGroup) -> &str {
    match &g.last_worktree_path {
        Some(p) if g.worktrees.iter().any(|w| &w.path == p) => p,
        _ => &g.path,
    }
}

async fn bundle(state: &Arc<DaemonState>) -> Result<Value, RpcError> {
    let groups = project_groups(state).await?;
    let settings = state.settings.snapshot();

    // Every path below comes from this daemon's own project list, never from
    // the caller, so no reject_unknown gate is needed.
    let paths: Vec<(String, String)> = groups
        .iter()
        .filter(|g| g.path_exists)
        .map(|g| (g.path.clone(), remembered_worktree(g).to_string()))
        .collect();
    let scan_paths = paths.clone();
    let (stats_fs, scopes) = tokio::task::spawn_blocking(move || {
        let mut mtimes = Map::new();
        let mut scopes = Map::new();
        for (path, wt) in &scan_paths {
            let mtime = crate::ipc::project_groups::latest_jsonl_mtime_in_projects_dir(Path::new(path));
            mtimes.insert(path.clone(), json!(mtime));
            scopes.insert(wt.clone(), json!(crate::ipc::claude_scopes::list_claude_md_scopes_sync(wt)));
        }
        (mtimes, scopes)
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))?;

    let mut stats = Map::new();
    let mut project_accounts = Map::new();
    for (path, _) in &paths {
        let todo_count = crate::ipc::ai_todos::count_ai_todos(path.clone()).await;
        let mtime = stats_fs.get(path).cloned().unwrap_or(json!(0));
        stats.insert(path.clone(), json!({ "mtime": mtime, "todoCount": todo_count }));
        let account = crate::settings::identity::resolve_effective_preferred_account_id(
            &settings.projects,
            Path::new(path),
        );
        project_accounts.insert(path.clone(), json!(account));
    }

    Ok(json!({
        "groups": groups,
        "stats": stats,
        "scopes": scopes,
        "projectAccounts": project_accounts,
        "projects": settings.projects,
        "settings": settings,
        "accounts": crate::accounts::load_registry(),
    }))
}

pub fn register_new_session_bundle(router: &mut Router, state: Arc<DaemonState>) {
    router.register("new_session_bundle", move |_params, _ctx| {
        let state = state.clone();
        async move { bundle(&state).await }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProjectGroup, WorktreeSummary};

    fn group(path: &str, last_wt: Option<&str>, worktrees: &[&str]) -> ProjectGroup {
        let mut g: ProjectGroup = serde_json::from_value(json!({
            "id": null, "path": path, "name": "p", "parent_segment": null,
            "avatar": {"kind": "none"}, "worktrees": [], "automation_enabled": false, "tokens_7d": 0,
            "live": 0, "any_automated": false, "last_active_at": null, "path_exists": true,
        }))
        .unwrap_or_else(|_| panic!("ProjectGroup fixture no longer deserializes"));
        g.last_worktree_path = last_wt.map(str::to_string);
        g.worktrees = worktrees
            .iter()
            .map(|p| WorktreeSummary {
                path: p.to_string(), name: "w".into(), tokens_7d: 0, live: 0,
                last_active_at: None, path_exists: true,
            })
            .collect();
        g
    }

    #[test]
    fn remembered_worktree_prefers_a_live_last_worktree() {
        assert_eq!(remembered_worktree(&group("C:\\r", Some("C:\\r-wt"), &["C:\\r-wt"])), "C:\\r-wt");
    }

    #[test]
    fn remembered_worktree_falls_back_to_root_when_the_worktree_is_gone() {
        assert_eq!(remembered_worktree(&group("C:\\r", Some("C:\\gone"), &["C:\\r-wt"])), "C:\\r");
        assert_eq!(remembered_worktree(&group("C:\\r", None, &[])), "C:\\r");
    }
}
