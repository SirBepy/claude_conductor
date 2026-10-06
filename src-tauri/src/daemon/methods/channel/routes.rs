//! `Router` wiring for the channel RPCs that cross machines (`peer_channel_post`)
//! or back the desktop/phone UI's read (`list_channel_messages`). Handler
//! logic lives in the parent `channel` module; this file only parses params
//! and dispatches.

use super::{list_channel_messages, list_channel_messages_at};
use crate::daemon::repo_channel_wake;
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::sessions::repo_channel;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Registers the peer-facing half of `post_message`'s `to` param on the
/// shared RPC router: reached only via `remote_transport_table::TRANSPORT_TABLE`'s
/// `M`-only entry, so `ctx.transport` is always `Transport::PeerMachine(..)`
/// here. SECURITY: the stored author's machine label comes from THAT (via
/// `state.machines`'s own registry of who `machine_id` is), never from
/// `params.from`'s `name` field's implied machine - a payload cannot forge
/// which machine it claims to be from.
pub fn register_channel_rpc(router: &mut Router, state: Arc<DaemonState>) {
    register_channel_rpc_at(router, state, None)
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root the
/// two handlers below resolve through `repo_channel::list_all`/`post` - the
/// seam a hermetic test needs to drive the actual REGISTERED closures through
/// a real router dispatch, rather than a hand-rolled mirror that
/// would stop exercising the security check (`ctx.transport`-derived label,
/// never the payload's) these handlers exist to enforce.
pub(crate) fn register_channel_rpc_at(router: &mut Router, state: Arc<DaemonState>, root: Option<PathBuf>) {
    // Desktop/phone UI read (todo 893), not peer-to-peer like
    // `peer_channel_post` below - `P` in `remote_transport_table` because the
    // peer-chip panel renders in the same shared SPA on both surfaces.
    router.register("list_channel_messages", {
        let state = state.clone();
        let root = root.clone();
        move |params, _ctx| {
            let state = state.clone();
            let root = root.clone();
            async move {
                let p = params.unwrap_or(Value::Null);
                let session_id = p.get("session_id").and_then(Value::as_str).unwrap_or_default();
                let result = match &root {
                    Some(r) => list_channel_messages_at(Some(r), &state, session_id),
                    None => list_channel_messages(&state, session_id),
                };
                result.map_err(RpcError::invalid_params)
            }
        }
    });

    router.register("peer_channel_post", move |params, ctx| {
        let state = state.clone();
        let root = root.clone();
        async move {
            let p = params.unwrap_or(Value::Null);
            let to_id = p.get("to_session_id").and_then(Value::as_str).unwrap_or_default();
            let text = p.get("text").and_then(Value::as_str).unwrap_or_default();
            let from = p.get("from");
            let from_session_id =
                from.and_then(|f| f.get("session_id")).and_then(Value::as_str).unwrap_or("unknown");
            let from_name = from.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or(from_session_id);

            let machine_id = match &ctx.transport {
                Transport::PeerMachine(id) => id.clone(),
                _ => return Err(RpcError::invalid_params("peer_channel_post is machine-only")),
            };
            let label = state
                .machines
                .get()
                .and_then(|r| r.peer(&machine_id))
                .map(|p| p.label)
                .unwrap_or(machine_id);

            let Some(inst) = state.registry.get(to_id) else {
                return Err(RpcError::invalid_params(format!("unknown session: {to_id}")));
            };
            if inst.ended_at.is_some() {
                return Err(RpcError::invalid_params(format!("target session has already ended: {to_id}")));
            }
            let author = format!("{from_name} @ {label}");
            let msg = match &root {
                Some(r) => repo_channel::post_at(Some(&repo_channel::channel_path(r, &inst.project_id)), from_session_id, &author, text, Some(to_id)),
                None => repo_channel::post(&inst.project_id, from_session_id, &author, text, Some(to_id)),
            };
            repo_channel_wake::enqueue(&state, to_id, from_session_id, msg.text.clone());
            repo_channel_wake::spawn_drain(&state, to_id);
            Ok(json!({"ok": true, "message": msg}))
        }
    });
}
