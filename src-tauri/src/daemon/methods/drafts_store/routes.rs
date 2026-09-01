//! `Router` wiring for the draft-message RPCs. Handler logic lives in the
//! parent `drafts_store` module; this file only parses params and dispatches.

use super::{delete_draft, list_message_drafts, set_draft_body, set_draft_state, set_draft_version};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub fn register_drafts_store(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionOnly {
        session_id: String,
    }

    {
        let state = state.clone();
        router.register("list_message_drafts", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                list_message_drafts(&state, &p.session_id).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_body", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    #[serde(default)]
                    recipient: String,
                    body: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_body(&state, &p.session_id, &p.id, &p.recipient, &p.body).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_version", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    #[serde(default)]
                    recipient: String,
                    n: u32,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_version(&state, &p.session_id, &p.id, &p.recipient, p.n).map_err(RpcError::internal)
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_draft_state", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    session_id: String,
                    id: String,
                    state: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                set_draft_state(&state, &p.session_id, &p.id, &p.state).map_err(RpcError::internal)
            }
        });
    }
    router.register("delete_draft", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                session_id: String,
                id: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            delete_draft(&state, &p.session_id, &p.id).map_err(RpcError::internal)
        }
    });
}
