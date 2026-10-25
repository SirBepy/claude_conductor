//! HTML preview window RPCs (ai_todo 138): `list_previews`/`get_preview` are
//! read-only mirrors of `daemon::preview`'s store, exposed over both the
//! daemon's own pipe RPC (desktop IPC proxy) and the remote-access API
//! (`SAFE_METHODS` in `remote_handlers.rs`) so the phone can read the same
//! timeline with no store rewrite.
//!
//! `push_preview` is registered on the pipe Router ONLY (the desktop
//! `push_preview` command's proxy target) and is deliberately EXCLUDED from
//! `SAFE_METHODS`: the phone/remote write path is a separate reviewed
//! decision. Terminal Claude and the in-app chat AI both push via the
//! UNAUTHENTICATED `/hooks/preview` hook-server endpoint instead (see
//! `hooks_server/preview.rs`), which shares `preview::push_and_notify` with
//! this handler so both write paths stay in sync.

use crate::daemon::preview::{PreviewMeta, PreviewSnapshot};
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_preview(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("push_preview", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    title: String,
                    #[serde(default)]
                    slug: Option<String>,
                    html: String,
                    #[serde(default)]
                    source: Option<String>,
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let source = p.source.filter(|s| !s.is_empty()).unwrap_or_else(|| "terminal".to_string());
                let id = crate::daemon::preview::push_and_notify(&state, p.title, p.slug, p.html, source, p.session_id)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({ "id": id }))
            }
        });
    }
    // Mirrors the desktop `list_previews` command -> Vec<PreviewMeta>, newest
    // (most-recently-pushed/replaced) first. No html - see PreviewMeta.
    // `session_id` narrows the list to that chat's previews. It also routes the
    // call: `machines/forward.rs` reads it off the raw params and, for a chat
    // mirrored from a paired machine, sends the call to the host that owns the
    // store holding that chat's previews. A peer caller MUST send it (see
    // `scope_previews`).
    {
        let state = state.clone();
        router.register("list_previews", move |params, ctx| {
            let state = state.clone();
            async move {
                let p: ScopeParams = parse_scope(params)?;
                let peer = matches!(ctx.transport, Transport::PeerMachine(_));
                let scoped = scope_previews(
                    crate::daemon::preview::list(),
                    p.session_id.as_deref(),
                    peer,
                    |sid| crate::daemon::machines::is_local_session(&state, sid),
                )?;
                Ok(json!(scoped))
            }
        });
    }
    // Mirrors the desktop `get_preview` command (params: id, optional
    // session_id) -> PreviewSnapshot (html included), for the iframe render.
    {
        let state = state.clone();
        router.register("get_preview", move |params, ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    id: String,
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let peer = matches!(ctx.transport, Transport::PeerMachine(_));
                let snap = crate::daemon::preview::get(&p.id)
                    .ok_or_else(|| RpcError::internal(format!("no such preview: {}", p.id)))?;
                check_snapshot_scope(&snap, p.session_id.as_deref(), peer, |sid| {
                    crate::daemon::machines::is_local_session(&state, sid)
                })?;
                Ok(json!(snap))
            }
        });
    }
}

#[derive(serde::Deserialize, Default)]
struct ScopeParams {
    #[serde(default)]
    session_id: Option<String>,
}

/// `list_previews` takes no params from older callers (null) and an object
/// from newer ones.
fn parse_scope(params: Option<serde_json::Value>) -> Result<ScopeParams, RpcError> {
    match params {
        None | Some(serde_json::Value::Null) => Ok(ScopeParams::default()),
        Some(v) => serde_json::from_value(v).map_err(|e| RpcError::invalid_params(e.to_string())),
    }
}

/// What a caller may list. A phone token already reads the whole timeline, so
/// a phone or the desktop pipe gets everything unless it names a session. A
/// paired peer gets ONLY the previews of one chat this machine hosts: it
/// must name that chat, the chat must be hosted here (so a peer cannot pull
/// previews filed under a third machine's or an unknown id), and previews with
/// no session at all (terminal pushes) never leave this machine for a peer.
fn scope_previews(
    all: Vec<PreviewMeta>,
    session_id: Option<&str>,
    peer: bool,
    is_local: impl Fn(&str) -> bool,
) -> Result<Vec<PreviewMeta>, RpcError> {
    if peer {
        let sid = session_id.ok_or_else(|| RpcError::invalid_params("session_id is required"))?;
        if !is_local(sid) {
            return Ok(Vec::new());
        }
    }
    Ok(match session_id {
        Some(sid) => all.into_iter().filter(|m| m.session_id.as_deref() == Some(sid)).collect(),
        None => all,
    })
}

/// A peer may fetch a snapshot only through the chat that owns it, so knowing
/// (or guessing) a preview id is not enough to read another chat's html.
fn check_snapshot_scope(
    snap: &PreviewSnapshot,
    session_id: Option<&str>,
    peer: bool,
    is_local: impl Fn(&str) -> bool,
) -> Result<(), RpcError> {
    if !peer {
        return Ok(());
    }
    let sid = session_id.ok_or_else(|| RpcError::invalid_params("session_id is required"))?;
    if is_local(sid) && snap.session_id.as_deref() == Some(sid) {
        Ok(())
    } else {
        // Same text as a genuine miss so a peer cannot probe which ids exist.
        Err(RpcError::internal(format!("no such preview: {}", snap.id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::rpc::{ConnectionContext, Request, TRANSPORT};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::{json, Value};
    use tempfile::tempdir;

    fn meta(id: &str, session: Option<&str>) -> PreviewMeta {
        PreviewMeta {
            id: id.into(),
            slug: id.into(),
            title: id.into(),
            source: "chat_card".into(),
            session_id: session.map(str::to_string),
            version: 1,
            created_at: "2026-10-23T00:00:00.000Z".into(),
            published: None,
        }
    }

    fn snap(id: &str, session: Option<&str>) -> PreviewSnapshot {
        PreviewSnapshot {
            id: id.into(),
            slug: id.into(),
            title: id.into(),
            html: "<p>secret</p>".into(),
            source: "chat_card".into(),
            session_id: session.map(str::to_string),
            version: 1,
            created_at: "2026-10-23T00:00:00.000Z".into(),
            published: None,
        }
    }

    fn all() -> Vec<PreviewMeta> {
        vec![meta("a", Some("s1")), meta("b", Some("s2")), meta("c", None)]
    }

    fn ids(v: &[PreviewMeta]) -> Vec<&str> {
        v.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn a_phone_or_desktop_reads_the_whole_timeline_or_one_chats() {
        let local = |_: &str| true;
        assert_eq!(ids(&scope_previews(all(), None, false, local).unwrap()), ["a", "b", "c"]);
        assert_eq!(ids(&scope_previews(all(), Some("s2"), false, local).unwrap()), ["b"]);
    }

    /// A peer reads one chat it names and this machine hosts, never the rest
    /// of the timeline and never a session-less (terminal) push.
    #[test]
    fn a_peer_gets_only_the_previews_of_the_one_local_chat_it_names() {
        let local = |sid: &str| sid == "s1";
        assert_eq!(ids(&scope_previews(all(), Some("s1"), true, local).unwrap()), ["a"]);
        assert!(scope_previews(all(), None, true, local).is_err(), "a peer must name a chat");
        assert!(
            scope_previews(all(), Some("s2"), true, local).unwrap().is_empty(),
            "a chat not hosted here yields nothing for a peer"
        );
    }

    #[test]
    fn a_peer_cannot_fetch_another_chats_snapshot_by_id() {
        let local = |sid: &str| sid == "s1" || sid == "s2";
        let s2_snap = snap("b", Some("s2"));
        assert!(check_snapshot_scope(&s2_snap, Some("s1"), true, local).is_err(), "id belongs to s2, not s1");
        assert!(check_snapshot_scope(&s2_snap, None, true, local).is_err());
        assert!(check_snapshot_scope(&snap("c", None), Some("s1"), true, local).is_err(), "session-less stays home");
        assert!(check_snapshot_scope(&s2_snap, Some("s2"), true, local).is_ok());
        assert!(check_snapshot_scope(&s2_snap, None, false, local).is_ok(), "non-peer callers are unscoped");
    }

    /// Both RPCs forward to the host for a chat mirrored from a peer: the
    /// local store holds none of that chat's previews.
    #[tokio::test]
    async fn list_and_get_forward_to_the_host_of_a_mirrored_chat() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let mut b_router = Router::new();
        for method in ["list_previews", "get_preview"] {
            let seen = seen.clone();
            b_router.register(method, move |params, _ctx| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(params.unwrap_or(Value::Null));
                    Ok(json!("from-host"))
                }
            });
        }
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state, peer_dir.path().to_path_buf(), b_router, 0);

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(dir.path().to_path_buf());
        a_state.machines.get().unwrap().ensure_self();
        let (token, _id) = DeviceRegistry::add_machine_device("A", "mach-a", peer_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        a_state.registry.upsert_interactive("scratch", std::path::Path::new("C:/x"), "p", "2026-10-23T00:00:00Z");
        let mut row = a_state.registry.get("scratch").unwrap();
        row.session_id = "s1".into();
        a_state.mirror.set_instances("mach-b", "B", vec![row]);
        a_state.mirror.set_online("mach-b", true);

        let mut router = Router::new();
        register_preview(&mut router, a_state.clone());
        crate::daemon::machines::forward::install(a_state.clone(), &mut router);

        for (method, params) in [
            ("list_previews", json!({"session_id": "s1"})),
            ("get_preview", json!({"id": "p1", "session_id": "s1"})),
        ] {
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            let resp = router
                .dispatch(
                    Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
                    ConnectionContext::new(tx),
                )
                .await;
            assert_eq!(resp.result, Some(json!("from-host")), "{method} must be answered by the host: {resp:?}");
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "both calls must reach the host");
        assert_eq!(seen[1], json!({"id": "p1", "session_id": "s1"}));
        b_serve.kill();
    }

    /// The host-side handler itself refuses a peer that names no chat, before
    /// anything is returned.
    #[tokio::test]
    async fn the_host_refuses_a_peer_list_without_a_session() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut router = Router::new();
        register_preview(&mut router, state);
        let resp = TRANSPORT
            .scope(Transport::PeerMachine("mach-a".into()), async {
                let (tx, _rx) = tokio::sync::mpsc::channel(16);
                router
                    .dispatch(
                        Request { jsonrpc: "2.0".into(), id: json!(1), method: "list_previews".into(), params: None },
                        ConnectionContext::new(tx),
                    )
                    .await
            })
            .await;
        assert!(resp.error.is_some(), "a peer listing every preview must be refused: {resp:?}");
    }
}
