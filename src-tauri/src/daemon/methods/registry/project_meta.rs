//! Project-metadata RPCs: last-activity, account resolution, tech/icon
//! detection, slash-command listing, and the raw project list. Several take a
//! client-supplied path (`cwd`/`root`/`project_dir`) and are gated by
//! `reject_unknown` before any filesystem access - see todo 656.

use super::super::pr_review::reject_unknown;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// `get_project_icon`/`get_project_tech`'s optional `machine_id`: `None`, or a
/// match on this daemon's own id, means "read our own filesystem" - today's
/// behaviour, unchanged. Any other known, online machine forwards the SAME
/// method verbatim to it instead. Unlike `context_status` et al, these reads
/// carry no `session_id` to route by (`machines::forward`'s seam can't help),
/// but `root` is only ever a path the CALLER already resolved on that machine
/// (a mirrored Instance's own cwd, or `list_machine_projects`'s own result),
/// so forwarding it as-is is just naming which filesystem to ask, not a trust
/// decision this daemon makes - same reasoning `methods::machines::
/// list_machine_projects` already relies on for its own forward. Returns
/// `Ok(None)` for the "run locally" case so the caller falls through to its
/// own `reject_unknown` + filesystem read, unchanged.
async fn forward_project_read_if_peer(
    state: &Arc<DaemonState>,
    machine_id: Option<&str>,
    method: &str,
    root: &str,
) -> Result<Option<Value>, RpcError> {
    let Some(machine_id) = machine_id else { return Ok(None) };
    if crate::daemon::machines::is_self_machine(state, machine_id) {
        return Ok(None);
    }
    let client = crate::daemon::machines::forward::resolve_peer_client(state, machine_id).await?;
    client
        .call(method, json!({"root": root}))
        .await
        .map_err(crate::daemon::machines::forward::map_peer_err)
        .map(Some)
}

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
                Ok(json!(crate::accounts::without_api_credit(
                    crate::settings::identity::resolve_effective_preferred_account_id(
                        &projects,
                        std::path::Path::new(&p.cwd),
                    ),
                )))
            }
        });
    }
    {
        let state = state.clone();
        // Mirrors `get_ticket_tracker` (params: cwd) -> Option<TrackerInfo>, so a
        // phone-rendered chat links ticket ids too. `cwd` is client-supplied.
        router.register("get_ticket_tracker", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                let projects = state.settings.snapshot().projects;
                Ok(json!(crate::tickets::tracker_info(projects, p.cwd).await))
            }
        });
    }
    // Mirrors `get_project_tech` (params: root, optional machine_id) ->
    // Option<String>. `root` is client-supplied, so reject_unknown must run
    // before any fs access on the LOCAL path; `machine_id` naming a peer
    // forwards instead, before reject_unknown ever runs (a peer's project
    // root is never "known" to this daemon's own settings).
    {
        let state = state.clone();
        router.register("get_project_tech", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { root: String, #[serde(default)] machine_id: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if let Some(result) =
                    forward_project_read_if_peer(&state, p.machine_id.as_deref(), "get_project_tech", &p.root).await?
                {
                    return Ok(result);
                }
                reject_unknown(&state, &p.root)?;
                Ok(json!(crate::ipc::project_icons::get_project_tech_local(p.root).await))
            }
        });
    }
    // Mirrors `get_project_icon` (params: root, optional machine_id) ->
    // Option<AttachmentData>. `root` is client-supplied; reaches
    // find_icon_in_dir -> std::fs::read and returns file bytes, so
    // reject_unknown must run before any fs access on the LOCAL path; same
    // machine_id forward as get_project_tech above.
    {
        let state = state.clone();
        router.register("get_project_icon", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { root: String, #[serde(default)] machine_id: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if let Some(result) =
                    forward_project_read_if_peer(&state, p.machine_id.as_deref(), "get_project_icon", &p.root).await?
                {
                    return Ok(result);
                }
                reject_unknown(&state, &p.root)?;
                Ok(json!(crate::ipc::project_icons::get_project_icon_local(p.root).await))
            }
        });
    }
    // Mirror `count_ai_todos` / `list_ai_todos` (params: cwd): the project
    // picker's todo badge and the chat statusbar's todos chip. `cwd` is
    // client-supplied and both read the dir listing, so reject_unknown first.
    {
        let state = state.clone();
        router.register("count_ai_todos", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::ai_todos::count_ai_todos(p.cwd).await))
            }
        });
    }
    {
        let state = state.clone();
        router.register("list_ai_todos", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::ai_todos::list_ai_todos(p.cwd).await))
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
                    crate::slash::enumerate::scan_menu(project.as_deref())
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(entries))
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::rpc::Router;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    /// `get_project_icon` dispatched on A with `machine_id` naming B is
    /// forwarded over real loopback HTTP to B's REAL handler
    /// (`register_project_meta`, not a stub) - proving the machine_id forward
    /// actually reaches the peer's own filesystem read rather than querying
    /// A's, where a Mac-hosted project root would never be a known cwd at
    /// all. No icon file exists at the fixture cwd, so the point is that B's
    /// handler ran at all (`Ok(Some(Value::Null))`), not what it found.
    #[tokio::test]
    async fn get_project_icon_with_machine_id_forwards_to_the_named_peer() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        b_state.registry.upsert_interactive(
            "b-session-1", std::path::Path::new("C:/b-repo"), "proj", "2026-10-20T00:00:00Z",
        );

        let mut b_router = Router::new();
        register_project_meta(&mut b_router, b_state.clone());
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(dir.path().to_path_buf());
        a_state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", peer_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        a_state.mirror.set_instances("mach-b", "B", vec![]);
        a_state.mirror.set_online("mach-b", true);

        let result =
            forward_project_read_if_peer(&a_state, Some("mach-b"), "get_project_icon", "C:/b-repo").await;
        match result {
            Ok(Some(v)) => assert_eq!(v, json!(null)),
            other => panic!("expected the forward to reach B's handler, got {other:?}"),
        }

        b_serve.kill();
    }

    /// `machine_id` absent, or matching this daemon's own id, must run
    /// locally - `forward_project_read_if_peer` returns `Ok(None)` so the
    /// caller falls through to its own `reject_unknown` + filesystem read,
    /// exactly as before this param existed.
    #[tokio::test]
    async fn get_project_icon_with_no_machine_id_or_self_runs_locally() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();

        assert_eq!(forward_project_read_if_peer(&state, None, "get_project_icon", "C:/x").await.unwrap(), None);
        assert_eq!(
            forward_project_read_if_peer(&state, Some(&mine.machine_id), "get_project_icon", "C:/x")
                .await
                .unwrap(),
            None
        );
    }

    /// An unknown machine_id must error rather than silently falling through
    /// to a local read (which would answer from the WRONG filesystem instead
    /// of telling the caller the peer doesn't exist).
    #[tokio::test]
    async fn get_project_icon_with_unknown_machine_id_errors() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();

        let err = forward_project_read_if_peer(&state, Some("ghost-machine"), "get_project_icon", "C:/x")
            .await
            .unwrap_err();
        assert!(err.message.contains("ghost-machine"));
    }
}
