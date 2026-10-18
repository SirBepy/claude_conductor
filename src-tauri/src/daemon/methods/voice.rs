//! Daemon-side RPC for the dictation cleanup pass (`voice::cleanup`).
//! Stateless - unlike `ask`, there's no store or thread; it's one request,
//! one `claude -p` haiku call, one response.

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub fn register_voice(router: &mut Router, _state: Arc<DaemonState>) {
    router.register("voice_clean_transcript", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            text: String,
        }
        let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let cleaned = crate::voice::cleanup::clean_transcript(&p.text)
            .await
            .map_err(|e| RpcError::internal(format!("{e:#}")))?;
        Ok(Value::String(cleaned))
    });
}
