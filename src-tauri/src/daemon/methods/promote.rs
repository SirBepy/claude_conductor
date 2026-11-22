//! "Turn into a project" (pc-1806 step 8), as the desktop asks for it: `promote_preview` (what
//! the dialog says will move) and `promote_to_project` (the move). The work is in
//! `subchats/promote.rs`.
//!
//! Desktop-pipe only, like the reopen RPCs: absent from `remote_transport_table::TRANSPORT_TABLE`,
//! so a phone or a paired machine cannot create a project folder on this PC or end a chat here.

use super::super::rpc::{parse_params as parse, Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::promote::{self, PromoteError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
struct Chat {
    session_id: String,
}

#[derive(Deserialize)]
struct Promote {
    session_id: String,
    /// The folder the project lives in (absolute); created when missing.
    path: String,
}

pub fn register_promote(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("promote_preview", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: Chat = parse(params)?;
                if state.registry.get(&p.session_id).is_none() {
                    return Err(RpcError::invalid_params(format!("unknown session: {}", p.session_id)));
                }
                let moved = promote::preview(&state, &p.session_id);
                let forks = promote::forks(&state, &p.session_id);
                Ok(json!({ "moved": moved, "forks": forks, "stays_behind": promote::stays_behind(&moved, forks) }))
            }
        });
    }
    {
        let state = state.clone();
        router.register("promote_to_project", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: Promote = parse(params)?;
                let done = promote::promote_to_project(&state, &p.session_id, std::path::Path::new(p.path.trim()))
                    .await
                    .map_err(|e| match e {
                        PromoteError::Refused(text) => RpcError::invalid_params(text),
                        PromoteError::Failed(text) => RpcError::internal(text),
                    })?;
                Ok(serde_json::to_value(done).map(|v: Value| json!({ "ok": true, "result": v })).unwrap_or(json!({ "ok": true })))
            }
        });
    }
}
