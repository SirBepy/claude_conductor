//! The reopen of a put-away main chat (pc-1806 step 6), as the desktop asks for it:
//! `reopen_main_chat` (the user starts a chat in the project, or uses the dashboard's
//! "Open main chat"), `put_away_paused` (what "Continue the plan?" draws) and
//! `resume_paused` (the answer). The work is in `subchats/put_away/reopen.rs`.
//!
//! Desktop-pipe only: absent from `remote_transport_table::TRANSPORT_TABLE`, so a phone or
//! a paired machine cannot reopen a chat. That is the rule the todo gives unattended
//! starters ("keep everything paused and never kill"): a family is reopened by a person at
//! the desktop, and a phone's send to it is refused with `PUT_AWAY:` until then.

use super::super::rpc::{parse_params as parse, RpcError, Router};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::put_away;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
struct Chat {
    session_id: String,
}

#[derive(Deserialize)]
struct Answer {
    session_id: String,
    /// The paused subs the answer ends ("No, stop these"); empty for "Yes".
    #[serde(default)]
    end: Vec<String>,
}

pub fn register_put_away(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("reopen_main_chat", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: Chat = parse(params)?;
                let view = put_away::reopen_main(&state, &p.session_id).await.map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({ "ok": true, "state": view }))
            }
        });
    }
    {
        let state = state.clone();
        router.register("put_away_paused", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: Chat = parse(params)?;
                Ok(put_away::paused_view(&state, &p.session_id))
            }
        });
    }
    {
        let state = state.clone();
        router.register("resume_paused", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: Answer = parse(params)?;
                let (ended, resuming) =
                    put_away::resume_family(&state, &p.session_id, &p.end).map_err(RpcError::invalid_params)?;
                Ok(json!({ "ok": true, "ended": ended, "resuming": resuming }))
            }
        });
    }
}
