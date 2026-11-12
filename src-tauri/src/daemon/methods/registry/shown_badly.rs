//! `flag_shown_badly`: Joe's "Shown badly" item on a send_message card's menu.
//! It appends the card, his optional note and the chat it was in to the
//! shown-badly log (`hooks_server/shown_badly.rs`), which `send_message`'s
//! `unsure_how_to_show` also writes to.
//!
//! Phone-reachable (`P` in `remote_transport_table::TRANSPORT_TABLE`): the card
//! menu is shared with the phone, and the call only appends to a local log.
//! Wired from `register_chat_registry` so `daemon/boot.rs` needs no line of
//! its own.
//!
//! The chat is named `chat_id`, never `session_id`: `machines/forward.rs` routes
//! any call carrying a mirrored chat's `session_id` to that chat's host, and a
//! flag belongs in the log of the PC Joe flagged it on, whose release report is
//! the one he reads.

use crate::daemon::hooks_server::shown_badly::{self, Source, MAX_MESSAGE_BYTES, MAX_NOTE};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
struct Params {
    chat_id: String,
    /// The card's send_message tool_use id, when the chat has one.
    #[serde(default)]
    message_id: Option<String>,
    /// The card's send_message input as the chat drew it (kind, verdict, text, ...).
    message: Value,
    #[serde(default)]
    note: Option<String>,
}

/// Checks a flag before anything is written. Every error names the fix.
fn check(p: &Params) -> Result<(), String> {
    if p.chat_id.trim().is_empty() {
        return Err("chat_id is required".into());
    }
    let Some(card) = p.message.as_object() else {
        return Err("message must be the card's send_message input, an object".into());
    };
    if !card.get("kind").is_some_and(Value::is_string) {
        return Err("message has no kind: only a send_message card can be flagged".into());
    }
    let bytes = serde_json::to_vec(&p.message).map(|v| v.len()).unwrap_or(usize::MAX);
    if bytes > MAX_MESSAGE_BYTES {
        return Err(format!("message is {bytes} bytes, over {MAX_MESSAGE_BYTES}"));
    }
    let n = p.note.as_deref().map(|n| n.trim().chars().count()).unwrap_or(0);
    if n > MAX_NOTE {
        return Err(format!("note is {n} chars, over {MAX_NOTE}"));
    }
    Ok(())
}

pub fn register_shown_badly(router: &mut Router, state: Arc<DaemonState>) {
    router.register("flag_shown_badly", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: Params = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            check(&p).map_err(RpcError::invalid_params)?;
            let note = p.note.unwrap_or_default();
            shown_badly::record(&state, Source::Joe, &p.chat_id, p.message_id.as_deref(), p.message, &note);
            Ok(json!({"ok": true}))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::register_chat_registry;
    use crate::daemon::rpc::{ConnectionContext, Request, Response, Router};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    async fn call(state: Arc<DaemonState>, params: Value) -> Response {
        let mut r = Router::new();
        register_chat_registry(&mut r, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: "flag_shown_badly".into(), params: Some(params) },
            ConnectionContext::new(tx),
        )
        .await
    }

    /// The registered method writes Joe's flag with the chat's project, the card
    /// and his note.
    #[tokio::test]
    async fn a_flag_is_recorded_with_the_card_and_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let _capture = crate::daemon::hooks_server::shown_badly::capture_in(dir.path());
        let st = state();
        st.registry.upsert_interactive("fsb", std::path::Path::new("."), "proj", "2026-11-12T00:00:00Z");
        let card = json!({"kind": "blocker", "verdict": "Blocked", "text": "Waiting on Gate 2"});
        let resp = call(st, json!({"chat_id": "fsb", "message_id": "toolu_9", "message": card, "note": "not waiting on me"})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let rows = crate::daemon::hooks_server::shown_badly::read_records(dir.path());
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r["source"].as_str(), r["kind"].as_str()), (Some("joe"), Some("blocker")));
        assert_eq!((r["project"].as_str(), r["message_id"].as_str()), (Some("proj"), Some("toolu_9")));
        assert_eq!(r["note"], "not waiting on me");
        assert_eq!(r["message"], card);
    }

    #[tokio::test]
    async fn a_flag_without_a_card_or_with_a_long_note_is_refused_and_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let _capture = crate::daemon::hooks_server::shown_badly::capture_in(dir.path());
        for params in [
            json!({"chat_id": "s", "message": "text"}),
            json!({"chat_id": "s", "message": {"text": "no kind"}}),
            json!({"chat_id": "", "message": {"kind": "answer"}}),
            json!({"chat_id": "s", "message": {"kind": "answer"}, "note": "x".repeat(501)}),
            // `session_id` is not the field: a call naming it would be routed to a mirrored chat's host.
            json!({"session_id": "s", "message": {"kind": "answer"}}),
        ] {
            let resp = call(state(), params.clone()).await;
            assert!(resp.error.is_some(), "{params} must be refused");
        }
        assert!(crate::daemon::hooks_server::shown_badly::read_records(dir.path()).is_empty());
    }
}
