//! Project-metadata RPCs: last-activity, account resolution, tech/icon
//! detection, slash-command listing, and the raw project list. Several take a
//! client-supplied path (`cwd`/`root`/`project_dir`) and are gated by
//! `reject_unknown` before any filesystem access - see todo 656.

use super::super::pr_review::reject_unknown;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_project_meta(router: &mut Router, state: Arc<DaemonState>) {
    // Mirrors `list_projects` -> Vec<ProjectConfig>. The Tauri command returns
    // `settings.projects.clone()`; the daemon reads the same from its snapshot.
    {
        let state = state.clone();
        router.register("list_projects", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.settings.snapshot().projects)) }
        });
    }
    // Mirrors `project_last_activity_at` (params: cwd) -> i64. `cwd` is
    // client-supplied, so reject_unknown must run before any fs access.
    {
        let state = state.clone();
        router.register("project_last_activity_at", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                let secs = tokio::task::spawn_blocking(move || {
                    crate::ipc::project_groups::latest_jsonl_mtime_in_projects_dir(
                        std::path::Path::new(&p.cwd),
                    )
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(secs))
            }
        });
    }
    {
        let state = state.clone();
        // Mirrors `resolve_project_account` (params: cwd) -> Option<String>.
        // `cwd` is client-supplied, so reject_unknown must run before any resolution.
        router.register("resolve_project_account", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                let projects = state.settings.snapshot().projects;
                Ok(json!(crate::settings::identity::resolve_effective_preferred_account_id(
                    &projects,
                    std::path::Path::new(&p.cwd),
                )))
            }
        });
    }
    // Mirrors `get_project_tech` (params: root) -> Option<String>. `root` is
    // client-supplied, so reject_unknown must run before any fs access.
    {
        let state = state.clone();
        router.register("get_project_tech", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { root: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.root)?;
                Ok(json!(crate::ipc::project_icons::get_project_tech(p.root)))
            }
        });
    }
    // Mirrors `get_project_icon` (params: root) -> Option<AttachmentData>.
    // `root` is client-supplied; reaches find_icon_in_dir -> std::fs::read and
    // returns file bytes, so reject_unknown must run before any fs access.
    {
        let state = state.clone();
        router.register("get_project_icon", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { root: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.root)?;
                Ok(json!(crate::ipc::project_icons::get_project_icon(p.root).await))
            }
        });
    }
    // Mirrors the `list_slash_commands` Tauri command (params: project_dir) ->
    // Vec<SlashEntry>. project_dir is client-supplied, so reject_unknown must
    // run before any fs access when it's Some; None only scans the daemon's
    // own ~/.claude/{commands,skills,plugins} (no client path involved).
    {
        let state = state.clone();
        router.register("list_slash_commands", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize, Default)]
                struct P { project_dir: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null)).unwrap_or_default();
                if let Some(dir) = &p.project_dir {
                    reject_unknown(&state, dir)?;
                }
                let project = p.project_dir.map(std::path::PathBuf::from);
                let entries = tokio::task::spawn_blocking(move || {
                    crate::slash::enumerate::scan_all(project.as_deref())
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(entries))
            }
        });
    }
}
