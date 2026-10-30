//! `context_status` RPC: mirrors the desktop `context_status` Tauri command
//! (`ipc/git.rs`) and the daemon's own localhost-only `/context` hooks-server
//! endpoint (`daemon/hooks_server/context.rs`) - both already call
//! `context_status::context_status_for_session`, this just exposes that same
//! computation over the pipe RPC so the phone (which cannot reach the
//! 127.0.0.1-bound hooks_server) gets the authoritative, transcript-derived
//! context % instead of the frontend's stale-model fallback heuristic.
//!
//! `instance_token_stats` (the overflow panel's message and turn counts) lives
//! here too: another transcript-derived per-session number the statusbar reads,
//! answered from this daemon's own registry so a chat mirrored from a paired
//! machine gets the host's transcript, not a missing local one.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_context(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionId { session_id: String }

    {
        let state = state.clone();
        router.register("context_status", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let registry = state.registry.clone();
                let status = tokio::task::spawn_blocking(move || {
                    crate::context_status::context_status_for_session(&registry, &p.session_id)
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(status))
            }
        });
    }

    router.register("instance_token_stats", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: SessionId = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // Resolved from this registry by id, never from a client path: an
            // unknown id answers the same all-zero shape the desktop command does.
            let Some(inst) = state.registry.get(&p.session_id) else {
                return Ok(json!({ "tokens": 0, "turns": 0, "prompts": 0 }));
            };
            tokio::task::spawn_blocking(move || {
                crate::ipc::instances::token_stats_for_session(&inst.cwd, inst.transcript_path.as_deref(), &inst.session_id)
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::RegisterInput;
    use crate::types::Settings;
    use std::io::Write;

    async fn stats(state: Arc<DaemonState>, session_id: &str) -> serde_json::Value {
        let mut router = Router::new();
        register_context(&mut router, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "instance_token_stats".into(),
                    params: Some(json!({ "session_id": session_id })),
                },
                ConnectionContext::new(tx),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        resp.result.unwrap()
    }

    /// The host answers from ITS registry and transcript by `session_id`, which
    /// is what lets the Mac's overflow panel show a PC chat's counts instead of
    /// the zeros a local-disk lookup produced.
    #[tokio::test]
    async fn instance_token_stats_reads_the_hosts_transcript_by_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("hosted.jsonl");
        let mut f = std::fs::File::create(&transcript).unwrap();
        for _ in 0..2 {
            writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"hi"}}}}"#).unwrap();
        }
        for _ in 0..3 {
            writeln!(f, r#"{{"type":"assistant","message":{{"usage":{{"output_tokens":1}}}}}}"#).unwrap();
        }
        drop(f);
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.register(
            RegisterInput {
                session_id: "hosted".into(),
                cwd: dir.path().to_path_buf(),
                pid: 1,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: Some(transcript),
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &settings,
            "2026-01-01T00:00:00Z",
        );

        let got = stats(state.clone(), "hosted").await;
        assert_eq!(got, json!({ "tokens": 3, "turns": 3, "prompts": 2 }));
        // An id this daemon does not host answers zeros, like the desktop command.
        let unknown = stats(state, "not-hosted").await;
        assert_eq!(unknown, json!({ "tokens": 0, "turns": 0, "prompts": 0 }));
    }
}
