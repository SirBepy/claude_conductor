//! `compact_now`: the chat menu's "Compact now" for a main chat. The same
//! checks as the automatic trigger except the threshold (`subchats::compaction`).
//! Desktop pipe only: absent from `remote_transport_table`'s table on purpose,
//! since a rare action belongs in the desktop menu.

use super::SessionIdOnly;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_compact(router: &mut Router, state: Arc<DaemonState>) {
    router.register("compact_now", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            compact_now(&state, &p.session_id).await
        }
    });
}

async fn compact_now(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, RpcError> {
    match crate::daemon::subchats::compaction::start(state, session_id, false).await {
        Ok(()) => Ok(json!({"ok": true})),
        // A plain answer, not an RPC error: the menu shows the reason.
        Err(skip) => Ok(json!({"ok": false, "error": format!("Not compacted: {}.", skip.reason())})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;

    #[tokio::test]
    async fn compact_now_answers_a_reason_for_a_chat_that_is_not_a_main_chat() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        st.registry.upsert_interactive("cn-plain", std::path::Path::new("."), "proj", "2026-11-12T00:00:00Z");
        let v = compact_now(&st, "cn-plain").await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("main chat"), "{v}");
    }
}
