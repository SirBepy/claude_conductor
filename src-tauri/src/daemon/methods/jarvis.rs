//! Jarvis singleton orchestrator RPC (todo 272, chunk 1: daemon core plumbing
//! only). `ensure_jarvis_session` is the one method this chunk exposes: it
//! returns the existing Jarvis session id if the settings pointer still
//! resolves to a live registry entry, or spawns a fresh one otherwise. No
//! briefing/first-message is sent here - a later chunk owns that.

use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

/// Model/effort the Jarvis singleton always spawns with. "opus" matches the
/// bare family-alias form `is_valid_model` accepts (see
/// `daemon::lifecycle::is_valid_model`); "high" mirrors the effort every
/// other opus spawn path in this file defaults to (e.g.
/// `daemon::schedule::respawn_for_message`).
const JARVIS_MODEL: &str = "opus";
const JARVIS_EFFORT: &str = "high";

fn err_to_rpc(e: LifecycleError) -> RpcError {
    match e {
        LifecycleError::InvalidConfig(_, _)
        | LifecycleError::CwdMissing(_)
        | LifecycleError::NoAccounts
        | LifecycleError::NoDefault
        | LifecycleError::AccountNotFound(_)
        | LifecycleError::AccountDrift(_) => RpcError::invalid_params(e.to_string()),
        LifecycleError::NotFound(_) => RpcError { code: -32004, message: e.to_string(), data: None },
        LifecycleError::AlreadyExists(_) => RpcError { code: -32005, message: e.to_string(), data: None },
        LifecycleError::MeteredBilling(_) | LifecycleError::Io(_) => RpcError::internal(e.to_string()),
    }
}

/// Resolves (and creates if missing) the dedicated cwd Jarvis spawns in:
/// `<data-dir>/jarvis-home/`. A non-project cwd is fine for
/// `upsert_project_for_cwd`/`upsert_interactive` - both accept any existing
/// directory and mint a fresh `ProjectConfig`/registry entry keyed off it
/// (see module docs below on `ensure_jarvis_session`), so this doesn't panic
/// or wedge the sessions UI; it just shows up as an ordinary project named
/// "jarvis-home" until a later chunk special-cases it in the frontend.
fn jarvis_home_dir() -> Result<std::path::PathBuf, RpcError> {
    let dir = crate::settings::paths::data_dir()
        .map_err(|e| RpcError::internal(e.to_string()))?
        .join("jarvis-home");
    std::fs::create_dir_all(&dir).map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(dir)
}

pub fn register_jarvis(router: &mut Router, state: Arc<DaemonState>) {
    router.register("ensure_jarvis_session", move |_params, _ctx| {
        let state = state.clone();
        async move {
            let existing = state.settings.snapshot().jarvis_session_id;
            if let Some(id) = existing {
                // Require the pointer to resolve to a still-live entry (not
                // merely present-but-ended): an ended Jarvis session can't
                // take the follow-up briefing/orchestration messages a later
                // chunk sends it, so treat "ended" the same as "gone" and
                // fall through to respawning a fresh singleton.
                if let Some(inst) = state.registry.get(&id) {
                    if inst.ended_at.is_none() {
                        return Ok(json!({"session_id": id}));
                    }
                }
            }

            let cwd = jarvis_home_dir()?;
            let params = StartSessionParams {
                cwd: cwd.clone(),
                model: JARVIS_MODEL.to_string(),
                effort: JARVIS_EFFORT.to_string(),
                resume_id: None,
                remote: false,
                account_id: None,
                fork: false,
            };
            // check_metered_billing already gates inside spawn_session.
            let session = lifecycle::spawn_session(&state, params).await.map_err(err_to_rpc)?;
            let sid = session.session_id.clone();
            let account_id = session.account_id.clone();
            let now = chrono::Utc::now().to_rfc3339();

            let (project_id, created_new) = state.settings.upsert_project_for_cwd(&cwd, &now);
            if created_new {
                state.notifier.publish("project_created", json!({
                    "project_id": project_id,
                    "cwd": cwd.to_string_lossy(),
                    "now": now,
                }));
            }
            state.registry.upsert_interactive(&sid, &cwd, &project_id, &now);
            state.registry.set_model_effort(&sid, JARVIS_MODEL, JARVIS_EFFORT);
            state.registry.set_account(&sid, &account_id);
            state.registry.set_jarvis(&sid, true);
            crate::sessions::chat_config::record(&sid, JARVIS_MODEL, JARVIS_EFFORT);
            crate::sessions::chat_config::set_account(&sid, &account_id);
            crate::sessions::persistence::save_snapshot_default(&state.registry);

            // Instant in-memory read for this and any other daemon-side
            // consumer; the app process persists the same value to
            // settings.json off the `jarvis_session_created` notification
            // below (daemon has no direct write access to that file - see
            // `SettingsCache`'s module header).
            state.settings.set_jarvis_session_id(&sid);
            state.notifier.publish("jarvis_session_created", json!({"session_id": sid}));
            state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));

            Ok(json!({"session_id": sid}))
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

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn ensure_jarvis_session_reuses_existing_pointer() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-x", "2026-07-27T00:00:00Z");
        state.settings.set_jarvis_session_id("jv-1");

        let mut r = Router::new();
        register_jarvis(&mut r, state.clone());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "ensure_jarvis_session".into(),
            params: None,
        }, dummy_ctx()).await;

        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"session_id": "jv-1"})));
    }

    // No test exercises the "pointer is stale/ended -> spawn a fresh singleton"
    // branch: that requires reaching `lifecycle::spawn_session`'s account
    // resolution, which reads the REAL accounts.json off this machine (see
    // `accounts::resolve_account` / `load_registry` - unmocked, not test-
    // isolated) and would actually launch a `claude` child process under
    // `cargo test --lib`. Every other RPC test in this daemon avoids that same
    // trap by using an invalid cwd to short-circuit before account resolution
    // (see `methods::mod::tests::start_session_invalid_cwd_does_not_register`);
    // that shortcut isn't available here since a missing cwd is exactly what
    // this method's happy path needs to create. The `ended_at.is_none()` guard
    // itself is covered by code review; verify manually via the app.
}
