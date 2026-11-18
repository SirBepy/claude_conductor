//! `respond_broker_card`: Joe's answer to a broker card (import, add/replace, policy
//! edit). The only way to answer one. It is not in `remote_transport_table`, so a
//! phone or a paired machine cannot reach it, and it checks the transport again here
//! so a table edit alone cannot open it. What an answer does is `broker::cards`.
//!
//! Hygiene: `params` may hold a pasted token. It is read into `cards::respond_from_params`
//! and nowhere else: not logged, not echoed, not in an error.

use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub fn register_broker_card(router: &mut Router, state: Arc<DaemonState>) {
    router.register("respond_broker_card", move |params, ctx| {
        let state = state.clone();
        async move {
            if ctx.transport != Transport::Local {
                // Same shape as an unknown method: a refused caller learns nothing about the card.
                return Err(RpcError::method_not_found("respond_broker_card"));
            }
            Ok(crate::daemon::broker::cards::respond_from_params(&state, params.unwrap_or(Value::Null)).await)
        }
    });
}
