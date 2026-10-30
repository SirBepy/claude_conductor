//! `new_session_bundle`: everything the new-chat flow (project picker ->
//! location step -> model/effort modal) reads, in ONE response. The phone
//! reaches the daemon over a tunnel capped at 6 concurrent HTTP/1.1
//! connections, so the per-project reads (2 stats + a CLAUDE.md scan + an
//! account binding, times ~40 projects) queued behind each other and the
//! modal a tap was waiting on sat at the back of that queue. One request
//! means the phone can warm it at boot and every step opens from cache.

use super::listings::project_groups;
use crate::daemon::rpc::{Router, RpcError, Transport};
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
    let registry = crate::accounts::load_registry();
    for (path, _) in &paths {
        let todo_count = crate::ipc::ai_todos::count_ai_todos(path.clone()).await;
        let mtime = stats_fs.get(path).cloned().unwrap_or(json!(0));
        stats.insert(path.clone(), json!({ "mtime": mtime, "todoCount": todo_count }));
        // A binding to an API-credit account is never preselected: the picker
        // treats it as unset, and the account is chosen explicitly per chat.
        let account = crate::accounts::without_api_credit_in(
            &registry,
            crate::settings::identity::resolve_effective_preferred_account_id(
                &settings.projects,
                Path::new(path),
            ),
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
        "accounts": registry,
    }))
}

/// The project list a paired machine's new-chat picker needs, and nothing
/// else: `groups` (icons, worktrees, last activity) plus per-project `stats`
/// (todo badge, recency). The full `bundle` also carries this daemon's whole
/// settings, account registry, per-project account bindings and CLAUDE.md
/// scopes; none of that is the other machine's business, and the scopes scan
/// is the slow part of the bundle.
pub(crate) async fn project_list(state: &Arc<DaemonState>) -> Result<Value, RpcError> {
    let mut groups = project_groups(state).await?;
    for g in &mut groups {
        // An image avatar is an absolute path on THIS disk; the picker's other
        // machine could neither read it nor should learn it. It re-asks for
        // the project's icon through `get_project_icon` instead.
        if matches!(g.avatar, crate::types::Avatar::Image(_)) {
            g.avatar = crate::types::Avatar::None;
        }
    }
    let paths: Vec<String> = groups.iter().filter(|g| g.path_exists).map(|g| g.path.clone()).collect();
    let scan_paths = paths.clone();
    let mtimes = tokio::task::spawn_blocking(move || {
        scan_paths
            .iter()
            .map(|p| crate::ipc::project_groups::latest_jsonl_mtime_in_projects_dir(Path::new(p)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))?;
    let mut stats = Map::new();
    for (path, mtime) in paths.into_iter().zip(mtimes) {
        let todo_count = crate::ipc::ai_todos::count_ai_todos(path.clone()).await;
        stats.insert(path, json!({ "mtime": mtime, "todoCount": todo_count }));
    }
    Ok(json!({ "groups": groups, "stats": stats }))
}

pub fn register_new_session_bundle(router: &mut Router, state: Arc<DaemonState>) {
    router.register("new_session_bundle", move |_params, ctx| {
        let state = state.clone();
        // Decided from the connection, never from a param, so a peer can't ask
        // for the full bundle by claiming to be a phone.
        let from_peer = matches!(ctx.transport, Transport::PeerMachine(_));
        async move {
            if from_peer {
                project_list(&state).await
            } else {
                bundle(&state).await
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProjectGroup, WorktreeSummary};

    fn group(path: &str, last_wt: Option<&str>, worktrees: &[&str]) -> ProjectGroup {
        let mut g: ProjectGroup = serde_json::from_value(json!({
            "id": null, "path": path, "name": "p", "parent_segment": null,
            "avatar": {"kind": "none"}, "worktrees": [], "tokens_7d": 0,
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
