//! The chat heads' per-chat "viewed" mark: when Joe last had a chat on screen, on any of
//! his devices. A head's purple unread-answers and green finished-subs badge count only what
//! happened after this mark, so viewing a chat on the PC clears the badge on the phone and
//! the Mac. The mark lives in `sessions::chat_config` (the daemon is its sole writer) and
//! only moves forward.
//!
//! `chat_seen_mark` names one session, so `machines/forward.rs` routes a mark for a mirrored
//! chat to the machine that hosts it. `chat_seen_list` names many, so the handler splits the
//! ids by host itself. Both are `PM` rows in `remote_transport_table.rs`. A device that was
//! offline catches up by reading the list again when it reconnects: nothing is pushed.

use crate::daemon::machines::forward::{map_peer_err, resolve_peer_client};
use crate::daemon::machines::{is_local_session, mirrored_owner};
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

/// Session ids are short; a longer string is not one.
const MAX_ID_LEN: usize = 200;
/// The heads show a few dozen chats, subs included; the cap only bounds a bad caller.
const MAX_IDS: usize = 400;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN
}

fn ids_of(params: Option<&Value>) -> Result<Vec<String>, RpcError> {
    let Some(items) = params.and_then(|p| p.get("session_ids")).and_then(Value::as_array) else {
        return Err(RpcError::invalid_params("session_ids must be a list of ids".to_string()));
    };
    if items.len() > MAX_IDS {
        return Err(RpcError::invalid_params(format!("session_ids holds at most {MAX_IDS} ids")));
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(id) if valid_id(id) => {
                if !out.iter().any(|seen| seen == id) {
                    out.push(id.to_string());
                }
            }
            _ => return Err(RpcError::invalid_params(format!("each id must be a string of 1 to {MAX_ID_LEN} characters"))),
        }
    }
    Ok(out)
}

/// Stores the mark for `session_id` at `at_ms` in the store at `path`. A peer machine only
/// marks chats this daemon hosts: it has no say over a chat it merely mirrors, and an id it
/// names that is not ours stores nothing.
fn mark_at(state: &DaemonState, transport: &Transport, path: &Path, session_id: &str, at_ms: i64) -> Result<Value, RpcError> {
    if !valid_id(session_id) {
        return Err(RpcError::invalid_params(format!("session_id must be a string of 1 to {MAX_ID_LEN} characters")));
    }
    if matches!(transport, Transport::PeerMachine(_)) && !is_local_session(state, session_id) {
        return Ok(json!({ "viewed_at": 0 }));
    }
    Ok(json!({ "viewed_at": chat_config::set_viewed_at(path, session_id, at_ms) }))
}

/// The marks this daemon holds for `ids`, plus (for a caller that is not a peer) the marks
/// the hosts of the mirrored ids hold. A host that cannot be reached is skipped: its chats
/// read as never viewed until the next list, which is when an offline device catches up.
async fn list_at(state: &Arc<DaemonState>, transport: &Transport, path: &Path, ids: Vec<String>) -> BTreeMap<String, i64> {
    let from_peer = matches!(transport, Transport::PeerMachine(_));
    let mut by_owner: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut local: Vec<String> = Vec::new();
    for id in ids {
        match (!from_peer).then(|| mirrored_owner(state, &id)).flatten() {
            Some(owner) => by_owner.entry(owner).or_default().push(id),
            None => local.push(id),
        }
    }
    let mut out = chat_config::viewed_marks_at(path, &local);
    for (owner, ids) in by_owner {
        let client = match resolve_peer_client(state, &owner).await {
            Ok(c) => c,
            Err(e) => {
                log::debug!("chat_seen_list: {owner} not reachable: {}", e.message);
                continue;
            }
        };
        match client.call("chat_seen_list", json!({ "session_ids": ids })).await.map_err(map_peer_err) {
            Ok(Value::Object(marks)) => {
                for (id, at) in marks {
                    if let (true, Some(at)) = (ids.contains(&id), at.as_i64()) {
                        out.insert(id, at);
                    }
                }
            }
            Ok(_) => {}
            Err(e) => log::debug!("chat_seen_list: {owner} failed: {}", e.message),
        }
    }
    out
}

pub fn register_chat_seen(router: &mut Router, state: Arc<DaemonState>) {
    router.register("chat_seen_mark", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move {
                let session_id = params
                    .as_ref()
                    .and_then(|p| p.get("session_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let Some(path) = default_path() else { return Err(RpcError::internal("no data dir".to_string())) };
                mark_at(&state, &ctx.transport, &path, &session_id, crate::types::now_epoch_ms())
            }
        }
    });
    router.register("chat_seen_list", move |params, ctx| {
        let state = state.clone();
        async move {
            let ids = ids_of(params.as_ref())?;
            let Some(path) = default_path() else { return Err(RpcError::internal("no data dir".to_string())) };
            Ok(json!(list_at(&state, &ctx.transport, &path, ids).await))
        }
    });
}

fn default_path() -> Option<std::path::PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("chat-config.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn a_mark_is_stored_and_never_lowered() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        let st = state();
        let t = Transport::Phone;
        assert_eq!(mark_at(&st, &t, &path, "c1", 800).unwrap(), json!({ "viewed_at": 800 }));
        assert_eq!(mark_at(&st, &t, &path, "c1", 300).unwrap(), json!({ "viewed_at": 800 }), "a late older view keeps the mark");
        assert_eq!(chat_config::viewed_marks_at(&path, &["c1".to_string()])["c1"], 800);
    }

    #[test]
    fn a_bad_session_id_is_refused_and_stores_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        let st = state();
        for bad in ["", &"x".repeat(MAX_ID_LEN + 1)] {
            assert!(mark_at(&st, &Transport::Phone, &path, bad, 5).is_err());
        }
        assert!(!path.exists());
    }

    #[test]
    fn a_peer_machine_marks_only_chats_this_daemon_hosts() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        let st = state();
        let peer = Transport::PeerMachine("mach-b".into());
        let out = mark_at(&st, &peer, &path, "not-ours", 900).unwrap();
        assert_eq!(out, json!({ "viewed_at": 0 }));
        assert!(chat_config::viewed_marks_at(&path, &["not-ours".to_string()]).is_empty(), "a peer cannot store a mark for a chat it only mirrors");
    }

    #[tokio::test]
    async fn the_list_returns_the_marks_of_the_asked_chats_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chat-config.json");
        let st = state();
        mark_at(&st, &Transport::Phone, &path, "a", 100).unwrap();
        mark_at(&st, &Transport::Phone, &path, "b", 200).unwrap();
        let got = list_at(&st, &Transport::Phone, &path, vec!["a".into(), "never".into()]).await;
        assert_eq!(got, BTreeMap::from([("a".to_string(), 100)]));
        let from_peer = list_at(&st, &Transport::PeerMachine("m".into()), &path, vec!["a".into(), "b".into()]).await;
        assert_eq!(from_peer.len(), 2, "a peer is told the marks this daemon holds");
    }

    #[test]
    fn the_id_list_is_validated_and_deduplicated() {
        assert_eq!(ids_of(Some(&json!({ "session_ids": ["a", "b", "a"] }))).unwrap(), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(ids_of(Some(&json!({ "session_ids": [] }))).unwrap(), Vec::<String>::new());
        let too_many: Vec<String> = (0..=MAX_IDS).map(|n| format!("id-{n}")).collect();
        for bad in [json!({}), json!({ "session_ids": "a" }), json!({ "session_ids": ["a", 3] }), json!({ "session_ids": [""] }), json!({ "session_ids": too_many })] {
            assert!(ids_of(Some(&bad)).is_err(), "{bad} must be refused");
        }
    }

    #[tokio::test]
    async fn both_methods_are_registered_on_the_router() {
        let mut r = Router::new();
        register_chat_seen(&mut r, state());
        for (method, params) in [("chat_seen_mark", json!({})), ("chat_seen_list", json!({}))] {
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            let resp = r
                .dispatch(
                    Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
                    ConnectionContext::new(tx),
                )
                .await;
            let err = resp.error.expect("a call with no params is refused");
            assert_ne!(err.code, -32601, "{method} must be a known method, got {}", err.message);
        }
    }
}
