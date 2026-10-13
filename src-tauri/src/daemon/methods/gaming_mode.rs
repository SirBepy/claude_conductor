//! `get_gaming_mode` / `set_gaming_mode` RPCs - desktop-pipe only (absent from
//! `remote_transport_table::TRANSPORT_TABLE`, which refuses anything not
//! listed for every remote transport). See `daemon::gaming_mode` for the
//! actual pause/resume logic; this file only wires it to the Router and
//! publishes the change so the tray check item and the Settings toggle stay
//! in sync (`gaming_mode_changed`, forwarded by `daemon_link`).

use crate::daemon::gaming_mode::{self, GamingModeSummary};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

fn publish(state: &Arc<DaemonState>, summary: &GamingModeSummary) {
    state.notifier.publish("gaming_mode_changed", serde_json::to_value(summary).unwrap_or(Value::Null));
}

pub fn register_gaming_mode(router: &mut Router, state: Arc<DaemonState>) {
    router.register("get_gaming_mode", move |_params, _ctx| async move {
        let file = gaming_mode::load_file();
        Ok(serde_json::to_value(gaming_mode::summary_of(&file)).unwrap_or(Value::Null))
    });

    router.register("set_gaming_mode", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                on: bool,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // The real toggle makes blocking HTTP/subprocess calls
            // (RealExecutor) - run it off the async runtime's worker threads.
            let blocking_state = state.clone();
            let summary = tokio::task::spawn_blocking(move || gaming_mode::set_on(&blocking_state, p.on))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
            publish(&state, &summary);
            Ok(serde_json::to_value(&summary).unwrap_or(Value::Null))
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
    async fn get_gaming_mode_dispatches_to_registered_handler() {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", tmp.path());

        let mut r = Router::new();
        register_gaming_mode(&mut r, test_state());
        let resp = r
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "get_gaming_mode".into(), params: None },
                dummy_ctx(),
            )
            .await;

        std::env::remove_var("CC_DATA_DIR");
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["on"], json!(false));
    }
}
