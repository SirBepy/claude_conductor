//! Debug-only: drive the whole rate-limit flow without waiting hours
//! for a real window to run out. Feeds `handle_rate_limit_rejection` the same
//! payload shape `chat/parser.rs` builds from the CLI's `rate_limit_event`,
//! so the blocked state, the banner, and the staggered scheduled resume all
//! come from the production path, not a test-only branch.

use super::err_to_rpc;
use crate::daemon::lifecycle::LifecycleError;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Debug-only: see the `simulate_rate_limit` RPC.
#[cfg(debug_assertions)]
#[derive(Debug, Deserialize)]
struct SimulateRateLimitParams {
    session_id: String,
    /// Seconds from now until the fake window resets. Defaults to 120, long
    /// enough to inspect the banner and short enough to watch the resume fire.
    #[serde(default)]
    resets_in_secs: Option<i64>,
    /// `five_hour` (default) | `seven_day` | `weekly`.
    #[serde(default)]
    kind: Option<String>,
}

/// Debug-only: see the `debug_sleep` RPC.
#[cfg(debug_assertions)]
#[derive(Debug, Deserialize)]
struct DebugSleepParams {
    ms: u64,
}

#[cfg(debug_assertions)]
pub fn register_debug(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let map = map.clone();
        let state = state.clone();
        router.register("simulate_rate_limit", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SimulateRateLimitParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map
                    .get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                let resets_at = chrono::Utc::now().timestamp() + p.resets_in_secs.unwrap_or(120);
                let kind = p.kind.unwrap_or_else(|| "five_hour".to_string());
                let body = json!({
                    "status": "rejected",
                    "rateLimitType": kind,
                    "resetsAt": resets_at,
                    "utilization": 100.0,
                })
                .to_string();
                crate::daemon::rate_limit::handle_rate_limit_rejection(&state, &session, &body, false);
                Ok(json!({"resets_at": resets_at, "rate_limit_type": kind}))
            }
        });
    }
    // Debug builds only: sleeps for `ms` (clamped to 10s) and returns. Exists
    // to measure client-side contention on `AppState.daemon_client`'s outer
    // mutex (todo 1006) - a real daemon RPC never has a controllable, fixed
    // wait long enough to see the stall reliably.
    router.register("debug_sleep", move |params, _ctx| async move {
        let p: DebugSleepParams = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let ms = p.ms.min(10_000);
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(json!({"slept_ms": ms}))
    });
}
