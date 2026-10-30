//! PR-review git RPCs (ai_todo 244): mirror the desktop `ipc::git_diff`
//! Tauri commands so the phone PR modal's Commits/Files tabs work remotely.
//! Same registration pattern as `daemon/methods/worktrees.rs` (ai_todo 434).

use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::settings::identity::project_key;
use serde_json::json;
use std::sync::Arc;

// Must match a project the daemon already knows, so a remote client can't
// point git at an arbitrary path. Shared with `worktrees.rs`, which is in the
// same SAFE_METHODS set and shipped without this gate (fixed 2026-08-12).
pub(super) fn is_known_cwd(state: &DaemonState, cwd: &str) -> bool {
    let key = project_key(std::path::Path::new(cwd));
    state.registry.list().iter().any(|i| project_key(&i.cwd) == key)
        || state.settings.snapshot().projects.iter().any(|p| project_key(&p.path) == key)
}

// Canonical wrapper: was independently re-copied into `statusbar.rs` and
// `worktrees.rs` (ai_todo 636). Call BEFORE any filesystem access on `cwd`.
pub(super) fn reject_unknown(state: &DaemonState, cwd: &str) -> Result<(), RpcError> {
    if is_known_cwd(state, cwd) {
        Ok(())
    } else {
        Err(RpcError::invalid_params("unknown cwd".to_string()))
    }
}

/// Resolves the cwd a git/file read should run against. When `session_id` is
/// given, ALWAYS resolves it from THIS daemon's own session registry,
/// ignoring any client-supplied `cwd` entirely: a request forwarded one hop
/// by `machines/forward.rs` (desktop -> daemon A -> this daemon, the owning
/// peer) carries a `cwd` that originated from A's mirrored copy of our own
/// Instance row, so trusting it instead of our own registry would let a
/// forwarding peer (or anything upstream of it) steer a git/file read by
/// whatever string it sends, rather than the one THIS daemon actually knows
/// for that session. The registry is the sole source of truth for where a
/// session mirrored from this daemon actually lives on disk.
///
/// When `session_id` is absent (every existing phone call - the phone has no
/// reason to send one, cwd is already a path on the SAME machine it is
/// pairing with), falls back to the legacy cwd-trust path gated by
/// `reject_unknown`, unchanged.
pub(super) fn resolve_cwd(state: &DaemonState, cwd: String, session_id: Option<&str>) -> Result<String, RpcError> {
    if let Some(sid) = session_id {
        let inst = state
            .registry
            .get(sid)
            .ok_or_else(|| RpcError::invalid_params(format!("unknown session_id: {sid}")))?;
        return Ok(inst.cwd.to_string_lossy().into_owned());
    }
    reject_unknown(state, &cwd)?;
    Ok(cwd)
}

/// `resolve_cwd` for a handler that is also reachable by a paired peer machine
/// (`PM` in `remote_transport_table.rs`). A peer reads a chat it mirrors, so it
/// must name that chat's `session_id`; without one `resolve_cwd` would fall to
/// `reject_unknown`, which accepts ANY project registered here and would let a
/// peer read an unrelated project's git state, files or backlog by naming a
/// cwd. `transport` comes from the connection (`ctx.transport`), never from
/// params, so a peer cannot claim to be a phone to skip the check.
pub(super) fn resolve_cwd_for(
    state: &DaemonState,
    transport: &Transport,
    cwd: String,
    session_id: Option<&str>,
) -> Result<String, RpcError> {
    if matches!(transport, Transport::PeerMachine(_)) && session_id.is_none() {
        return Err(RpcError::invalid_params("session_id is required for a paired machine"));
    }
    resolve_cwd(state, cwd, session_id)
}

pub fn register_pr_review(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("get_range_files", move |params, ctx| {
            let state = state.clone();
            let transport = ctx.transport.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String, from: Option<String>, #[serde(default)] to: Option<String>, #[serde(default)] base: Option<String>, #[serde(default)] session_id: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = resolve_cwd_for(&state, &transport, p.cwd, p.session_id.as_deref())?;
                let files = crate::ipc::git_diff::get_range_files_local(cwd, p.from, p.to, p.base)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(files))
            }
        });
    }

    {
        let state = state.clone();
        router.register("resolve_commit_refs", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String, candidates: Vec<String> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                let refs = crate::ipc::git_commit_refs::resolve_commit_refs(p.cwd, p.candidates)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(refs))
            }
        });
    }

    {
        let state = state.clone();
        router.register("get_file_at_rev", move |params, ctx| {
            let state = state.clone();
            let transport = ctx.transport.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String, #[serde(default)] rev: Option<String>, path: String, #[serde(default)] session_id: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = resolve_cwd_for(&state, &transport, p.cwd, p.session_id.as_deref())?;
                let data = crate::ipc::git_diff::get_file_at_rev_local(cwd, p.rev, p.path)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(data))
            }
        });
    }

    {
        let state = state.clone();
        router.register("list_branch_files", move |params, ctx| {
            let state = state.clone();
            let transport = ctx.transport.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String, branch: String, #[serde(default)] session_id: Option<String> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = resolve_cwd_for(&state, &transport, p.cwd, p.session_id.as_deref())?;
                let files = crate::ipc::git_diff::list_branch_files_local(cwd, p.branch)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(files))
            }
        });
    }

    router.register("get_file_diff", move |params, ctx| {
        let state = state.clone();
        let transport = ctx.transport.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P { cwd: String, from: Option<String>, #[serde(default)] to: Option<String>, #[serde(default)] base: Option<String>, path: String, #[serde(default)] context: Option<u32>, #[serde(default)] session_id: Option<String> }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let cwd = resolve_cwd_for(&state, &transport, p.cwd, p.session_id.as_deref())?;
            let diff = crate::ipc::git_diff::get_file_diff_local(cwd, p.from, p.to, p.base, p.path, p.context)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(diff))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn dummy_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn get_range_files_rejects_unknown_cwd() {
        // Guards ai_todo 244's security note: a remote client must not be able
        // to point git diff at an arbitrary host path the daemon has never
        // seen for this session/project.
        let mut r = Router::new();
        register_pr_review(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_range_files".into(),
            params: Some(json!({"cwd": "C:\\nope\\not\\registered", "from": null, "to": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_some(), "unknown cwd must be rejected");
    }

    #[tokio::test]
    async fn list_branch_files_rejects_unknown_cwd() {
        let mut r = Router::new();
        register_pr_review(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "list_branch_files".into(),
            params: Some(json!({"cwd": "C:\\nope\\not\\registered", "branch": "main"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_some(), "unknown cwd must be rejected");
    }

    /// `resolve_cwd` is what makes a mirrored session's git/file reads safe to proxy
    /// to a mirrored session's owning daemon: when `session_id` is given it
    /// must resolve from THIS daemon's own registry, ignoring whatever `cwd`
    /// the (possibly forwarding-peer) caller sent - never the reverse.
    #[tokio::test]
    async fn resolve_cwd_with_a_session_id_ignores_the_passed_cwd() {
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        let real_cwd = std::env::current_dir().unwrap();
        state.registry.register(
            RegisterInput {
                session_id: "s1".into(),
                cwd: real_cwd.clone(),
                pid: 1,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &settings,
            "2026-01-01T00:00:00Z",
        );

        let resolved = resolve_cwd(&state, "C:\\not-the-real-one".into(), Some("s1")).unwrap();
        assert_eq!(resolved, real_cwd.to_string_lossy());
    }

    #[tokio::test]
    async fn resolve_cwd_with_an_unknown_session_id_is_rejected() {
        let state = dummy_state();
        let err = resolve_cwd(&state, "C:\\whatever".into(), Some("no-such-session")).unwrap_err();
        assert_eq!(err.code, RpcError::invalid_params("x").code);
    }

    #[tokio::test]
    async fn resolve_cwd_without_a_session_id_falls_back_to_reject_unknown() {
        let state = dummy_state();
        assert!(resolve_cwd(&state, "C:\\nope\\not\\registered".into(), None).is_err());
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        assert_eq!(resolve_cwd(&state, cwd.to_string_lossy().into_owned(), None).unwrap(), cwd.to_string_lossy());
    }

    /// End-to-end through the router (not calling `resolve_cwd` directly):
    /// `get_range_files` dispatched with a `session_id` succeeds even though
    /// its `cwd` is garbage, because the handler resolves the real cwd from
    /// the registry instead.
    #[tokio::test]
    async fn get_range_files_dispatches_via_session_id_even_with_a_bogus_cwd() {
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        let real_cwd = std::env::current_dir().unwrap();
        state.registry.register(
            RegisterInput {
                session_id: "s1".into(),
                cwd: real_cwd.clone(),
                pid: 1,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &settings,
            "2026-01-01T00:00:00Z",
        );
        let mut r = Router::new();
        register_pr_review(&mut r, state);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_range_files".into(),
            params: Some(json!({"cwd": "C:\\nope\\not\\registered", "session_id": "s1", "from": null, "to": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn list_branch_files_dispatches_for_known_cwd() {
        // Without this route the phone's branch-preview explorer would get
        // -32601 and silently show no files.
        let state = dummy_state();
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let mut r = Router::new();
        register_pr_review(&mut r, state);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "list_branch_files".into(),
            params: Some(json!({"cwd": cwd.to_string_lossy(), "branch": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn get_range_files_dispatches_for_known_cwd() {
        // Guards ai_todo 244: without this route, dispatch returns -32601 and
        // the phone PR modal's Files tab silently stays "unavailable".
        let state = dummy_state();
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let mut r = Router::new();
        register_pr_review(&mut r, state);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_range_files".into(),
            params: Some(json!({"cwd": cwd.to_string_lossy(), "from": null, "to": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    /// `resolve_cwd_for` is the peer gate every `PM` cwd-or-session_id handler
    /// shares: a paired machine without a `session_id` is refused before
    /// `reject_unknown` can accept any registered project, while a phone keeps
    /// the cwd fallback and a peer with a `session_id` resolves from the registry.
    #[tokio::test]
    async fn resolve_cwd_for_refuses_a_peer_without_a_session_id() {
        let state = dummy_state();
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        state.registry.upsert_interactive("s1", &cwd, "proj", "2026-01-01T00:00:00Z");
        let cwd_s = cwd.to_string_lossy().into_owned();
        let peer = Transport::PeerMachine("mach-b".into());

        assert!(resolve_cwd_for(&state, &peer, cwd_s.clone(), None).is_err());
        assert_eq!(resolve_cwd_for(&state, &peer, "ignored".into(), Some("s1")).unwrap(), cwd_s);
        assert_eq!(resolve_cwd_for(&state, &Transport::Phone, cwd_s.clone(), None).unwrap(), cwd_s);
        assert_eq!(resolve_cwd_for(&state, &Transport::Local, cwd_s.clone(), None).unwrap(), cwd_s);
    }

    /// Every other `PM` handler that takes a cwd (or `project_dir`) plus an optional
    /// `session_id` refuses a paired machine that names only a registered
    /// project, so a peer cannot read git state or files of a chat it does not mirror.
    #[tokio::test]
    async fn pm_cwd_handlers_refuse_a_peer_without_a_session_id() {
        let state = dummy_state();
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let c = cwd.to_string_lossy().into_owned();
        let mut r = Router::new();
        register_pr_review(&mut r, state.clone());
        crate::daemon::methods::statusbar::register_statusbar(&mut r, state.clone());
        crate::daemon::methods::worktrees::register_worktrees(&mut r, state.clone());
        crate::daemon::methods::files::register_files(&mut r, state);

        let cases = [
            ("get_range_files", json!({"cwd": c, "from": null, "to": "HEAD"})),
            ("get_file_diff", json!({"cwd": c, "from": null, "to": "HEAD", "path": "x"})),
            ("get_file_at_rev", json!({"cwd": c, "path": "x"})),
            ("list_branch_files", json!({"cwd": c, "branch": "HEAD"})),
            ("get_git_info", json!({"cwd": c})),
            ("get_git_dirty", json!({"cwd": c})),
            ("get_commit_sync", json!({"cwd": c})),
            ("get_commit_history", json!({"cwd": c})),
            ("get_recent_branches", json!({"cwd": c})),
            ("list_project_files", json!({"project_dir": c})),
        ];
        for (method, params) in cases {
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            let mut ctx = ConnectionContext::new(tx);
            ctx.transport = Transport::PeerMachine("mach-b".into());
            let resp = r
                .dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) }, ctx)
                .await;
            let err = resp.error.unwrap_or_else(|| panic!("{method}: a peer reading by cwd alone must be refused"));
            assert!(err.message.contains("session_id"), "{method}: refused for the wrong reason: {}", err.message);
        }
    }
}
