//! A put-away family takes no typed message and no account move (pc-1806 step 2),
//! driven through the router like the desktop does.

use super::account_move::register_account_move;
use super::core::register_core;
use crate::daemon::rpc::{ConnectionContext, Request, Router};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{put_away, TempDataDir};
use serde_json::json;
use std::sync::Arc;

fn dummy_ctx() -> ConnectionContext {
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    ConnectionContext::new(tx)
}

fn state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()))
}

/// A put-away main chat `m1` with a sub `s1`.
fn put_away_family(st: &Arc<DaemonState>) {
    st.registry.upsert_interactive("m1", std::path::Path::new("."), "proj", "2026-11-21T00:00:00Z");
    st.registry.upsert_interactive("s1", std::path::Path::new("."), "proj", "2026-11-21T00:00:00Z");
    st.registry.set_subchat_of("s1", Some("m1".into()));
    put_away::put_away(st, "m1", Vec::new(), "2026-11-21T01:00:00Z").unwrap();
}

async fn call(router: &Router, method: &str, params: serde_json::Value) -> crate::daemon::rpc::Response {
    router
        .dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) }, dummy_ctx())
        .await
}

#[tokio::test]
async fn a_message_typed_into_a_put_away_chat_or_one_of_its_subs_is_refused_and_latches_nothing() {
    let _data = TempDataDir::new();
    let st = state();
    put_away_family(&st);
    let mut router = Router::new();
    register_core(&mut router, st.clone());

    for id in ["m1", "s1"] {
        let resp = call(&router, "send_message", json!({"session_id": id, "text": "hello"})).await;
        let err = resp.error.unwrap_or_else(|| panic!("{id}: a put-away family must refuse the send"));
        assert!(err.message.starts_with(put_away::REFUSAL_PREFIX), "{id}: {}", err.message);
        assert!(!st.registry.get(id).unwrap().busy, "{id}: a refused send never marks the chat busy");
    }
}

#[tokio::test]
async fn a_chat_outside_the_family_is_not_refused_by_the_gate() {
    let _data = TempDataDir::new();
    let st = state();
    put_away_family(&st);
    st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-21T00:00:00Z");
    let mut router = Router::new();
    register_core(&mut router, st.clone());

    let resp = call(&router, "send_message", json!({"session_id": "plain", "text": "hello"})).await;
    let message = resp.error.map(|e| e.message).unwrap_or_default();
    assert!(!message.starts_with(put_away::REFUSAL_PREFIX), "the gate is per family: {message}");
}

#[tokio::test]
async fn a_restart_of_a_put_away_chat_is_refused_as_put_away_and_not_as_a_missing_chat() {
    let _data = TempDataDir::new();
    let st = state();
    put_away_family(&st);
    // An idle-frozen member would otherwise reach the freeze wake, which refuses and
    // surfaces as NotFound.
    st.registry.set_frozen("s1", true);
    st.registry.set_auto_frozen("s1", true);
    assert!(crate::daemon::subchats::idle_freeze::mark("s1"));

    for id in ["m1", "s1"] {
        let restart = crate::daemon::lifecycle::restart_session(&st, id).await.err().expect("restart refused");
        assert!(matches!(restart, crate::daemon::lifecycle::LifecycleError::PutAway(_)), "{id}: {restart}");
    }
    assert!(st.registry.get("s1").unwrap().frozen, "the freeze stays");
}

/// The phone's mockup message door sets the awaiting mark and busy flag before it sends, so
/// a refusal has to come first.
#[tokio::test]
async fn a_preview_message_to_a_put_away_chat_or_sub_is_refused_and_leaves_its_awaiting_mark() {
    let _data = TempDataDir::new();
    let st = state();
    put_away_family(&st);
    st.registry.set_awaiting("m1", Some("question".into()));

    for id in ["m1", "s1"] {
        let err = crate::daemon::methods::preview::deliver_user_text(&st, id, "hello").await.err().expect("refused");
        assert!(err.message.starts_with(put_away::REFUSAL_PREFIX), "{id}: {}", err.message);
    }
    let row = st.registry.get("m1").unwrap();
    assert_eq!(row.awaiting.as_deref(), Some("question"));
    assert!(!row.busy);
}

#[tokio::test]
async fn an_account_move_of_a_put_away_chat_is_refused_before_it_clears_a_freeze_or_sends_a_resume() {
    let _data = TempDataDir::new();
    let st = state();
    put_away_family(&st);
    st.registry.set_frozen("m1", true);
    st.registry.set_auto_frozen("m1", true);
    let mut router = Router::new();
    register_account_move(&mut router, st.clone());

    let resp = call(&router, "move_session_to_account", json!({"session_id": "m1", "target_account_id": "other"})).await;
    let err = resp.error.expect("a put-away chat is not moved");
    assert!(err.message.starts_with(put_away::REFUSAL_PREFIX), "{}", err.message);
    let row = st.registry.get("m1").unwrap();
    assert!(row.frozen && row.auto_frozen, "the freeze stays");
}
