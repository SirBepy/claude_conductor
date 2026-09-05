//! `attach_session`/`detach_session` - subscribe/unsubscribe a client
//! connection to a session's live chat-event stream. A session mirrored in
//! from a paired peer machine (no local `Session`) attaches to a RELAY
//! instead (`machines::relay`) that reads the peer's own per-session stream
//! and re-wraps each frame in the same `chat_event` envelope below - see
//! `DaemonState::relays`'s doc for why that's tracked separately from
//! `ctx.subscriptions`.

use super::{err_to_rpc, SessionIdOnly};
use crate::daemon::lifecycle::LifecycleError;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Spawns the relay task for a mirrored session and records it in
/// `state.relays` keyed by `(ctx.conn_id, session_id)` so `detach_session`
/// can find and abort it later. Awaited (not fire-and-forget) so the entry
/// is recorded before this RPC returns "ok" - otherwise a client that
/// detaches immediately after attaching could race the insert. The task
/// self-removes its own map entry once its consumer loop ends (outbound
/// closed, or the relay gave up for good), so an ungraceful disconnect (no
/// explicit detach) doesn't leak the entry.
async fn spawn_mirrored_relay(
    state: &Arc<DaemonState>,
    ctx: &crate::daemon::rpc::ConnectionContext,
    peer: crate::daemon::machines::PeerMachine,
    session_id: String,
) {
    let state_for_task = state.clone();
    let ctx_for_task = ctx.clone();
    let sid_for_frame = session_id.clone();
    let sid_for_removal = session_id.clone();
    let sid_for_key = session_id.clone();
    let conn_id = ctx.conn_id;
    let handle = tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
        let _producer_guard = crate::daemon::machines::relay::AbortOnDrop(tokio::spawn(
            crate::daemon::machines::relay::relay_session_frames(state_for_task.clone(), peer, session_id, tx),
        ));
        while let Some(txt) = rx.recv().await {
            // A malformed frame from the peer is skipped, not fatal - mirrors
            // `peer_link::handle_frame`'s "a peer's own bug shouldn't tear
            // down our reconnect" stance.
            let Ok(event) = serde_json::from_str::<Value>(&txt) else { continue };
            let frame = json!({
                "jsonrpc": "2.0",
                "method": "chat_event",
                "params": { "session_id": sid_for_frame, "event": event },
            });
            if ctx_for_task.send_outbound(frame).await.is_err() {
                break; // this connection is gone; end the relay
            }
        }
        state_for_task.relays.lock().await.remove(&(conn_id, sid_for_removal));
    });
    // Replaces any stale prior entry for this (conn, session) pair - same
    // "old handle wins the abort" shape as `ctx.subscriptions`'s insert below.
    if let Some(old) = state.relays.lock().await.insert((ctx.conn_id, sid_for_key), handle) {
        old.abort();
    }
}

#[derive(Debug, Deserialize)]
struct AttachSessionParams {
    session_id: String,
    /// True = the client understands the O(delta) `assistant_delta` stream
    /// protocol (ai_todo 186). Legacy clients (older app builds) omit it and
    /// get each delta converted back into a full-text streaming
    /// `AssistantMessage` snapshot from the session's shared accumulator -
    /// the exact pre-delta wire shape.
    #[serde(default)]
    delta: bool,
}

pub fn register_attach(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let map = map.clone();
        let state = state.clone();
        router.register("attach_session", move |params, ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: AttachSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let Some(session) = map.get(&p.session_id).map(|s| s.clone()) else {
                    // Not a local session - maybe one mirrored in from a
                    // paired peer machine (see `spawn_mirrored_relay`'s doc).
                    let Some(machine_id) = state.mirror.owner_of(&p.session_id) else {
                        return Err(err_to_rpc(LifecycleError::NotFound(p.session_id.clone())));
                    };
                    let registry = state
                        .machines
                        .get()
                        .ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
                    let peer = registry
                        .peer(&machine_id)
                        .ok_or_else(|| RpcError::internal("paired machine no longer known"))?;
                    spawn_mirrored_relay(&state, &ctx, peer, p.session_id.clone()).await;
                    return Ok(json!({"ok": true}));
                };
                let mut rx = crate::daemon::broadcast::subscribe(&session);
                // Mid-turn attach resync (ai_todo 186): the stream carries
                // O(delta) chunks, so a client joining mid-turn can't recover
                // the text already streamed. Send the accumulated block first
                // (subscribe happened above, so deltas racing in behind this
                // snapshot carry a covered `seq` and are dropped client-side).
                // Legacy clients get the old full-text streaming snapshot.
                let resync = {
                    let s = session.streaming.lock().unwrap();
                    if p.delta { s.snapshot_event() } else { s.legacy_snapshot_event() }
                };
                let delta_capable = p.delta;
                let outbound = ctx.clone();
                let session_id_for_task = p.session_id.clone();
                let session_for_task = Arc::clone(&session);
                let handle = tokio::spawn(async move {
                    let frame = |ev: &crate::types::chat::ChatEvent| {
                        json!({
                            "jsonrpc": "2.0",
                            "method": "chat_event",
                            "params": {
                                "session_id": session_id_for_task,
                                "event": ev,
                            }
                        })
                    };
                    if let Some(snap) = resync {
                        if outbound.send_outbound(frame(&snap)).await.is_err() {
                            return;
                        }
                    }
                    loop {
                        match rx.recv().await {
                            Ok(ev) => {
                                let ev = match ev {
                                    // Legacy client: convert each delta into the
                                    // full-text streaming snapshot it expects. The
                                    // shared accumulator may already be ahead of
                                    // this rx position; a fuller idempotent
                                    // snapshot early is harmless. Empty (turn just
                                    // ended) -> skip; the finalized message is
                                    // next in the queue anyway.
                                    crate::types::chat::ChatEvent::AssistantDelta { .. } if !delta_capable => {
                                        match session_for_task.streaming.lock().unwrap().legacy_snapshot_event() {
                                            Some(snap) => snap,
                                            None => continue,
                                        }
                                    }
                                    other => other,
                                };
                                if outbound.send_outbound(frame(&ev)).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                log::warn!(
                                    "attach forwarding lagged for {session_id_for_task}: dropped {n} chat events"
                                );
                                // Non-delta events (finalized messages, tool
                                // calls, notifications) are gone for good -
                                // tell the client to force a transcript re-read.
                                let lagged = crate::types::chat::ChatEvent::EventsLagged {
                                    timestamp: chrono::Utc::now().timestamp_millis(),
                                };
                                if outbound.send_outbound(frame(&lagged)).await.is_err() {
                                    break;
                                }
                                // Deltas don't compose across a gap: resync the
                                // streamed text before continuing. (Legacy clients
                                // self-heal - their next converted delta reads the
                                // full accumulator anyway.)
                                if delta_capable {
                                    let snap = session_for_task.streaming.lock().unwrap().snapshot_event();
                                    if let Some(snap) = snap {
                                        if outbound.send_outbound(frame(&snap)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                continue;
                            }
                        }
                    }
                });
                let mut subs = ctx.subscriptions.lock().await;
                if let Some(old) = subs.insert(p.session_id.clone(), handle.abort_handle()) {
                    old.abort();
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    router.register("detach_session", move |params, ctx| {
        let state = state.clone();
        async move {
            let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let mut subs = ctx.subscriptions.lock().await;
            if let Some(handle) = subs.remove(&p.session_id) {
                handle.abort();
            }
            drop(subs);
            // A local subscription and a mirrored-session relay are mutually
            // exclusive per (conn, session_id) - only one of the two lookups
            // above/below ever finds anything - so trying both unconditionally
            // is simpler than branching on which kind this session was.
            if let Some(handle) = state.relays.lock().await.remove(&(ctx.conn_id, p.session_id.clone())) {
                handle.abort();
            }
            Ok(json!({"ok": true}))
        }
    });
}

#[cfg(test)]
mod relay_tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::{new_session_map, Session};
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::kinds::InstanceKind;
    use crate::types::chat::ChatEvent;
    use crate::types::{Instance, Settings};
    use serde_json::json;
    use tempfile::tempdir;

    fn mirrored_instance(session_id: &str) -> Instance {
        Instance {
            session_id: session_id.into(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/b-repo"),
            project_id: "proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-09-05T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            held_count: 0,
            local_task_running: false,
            successor_of: None,
            machine: None,
        }
    }

    /// A real throwaway child process for its `ChildStdin` - same pattern as
    /// `lifecycle::teardown`'s `end_session_drops_the_closed_chats_ask_threads`
    /// (Windows-only for the same reason: there's no cross-platform stand-in
    /// for a live `ChildStdin`, and `Session::new` requires one).
    #[cfg(windows)]
    async fn spawn_fake_session(map: &crate::daemon::session::SessionMap, session_id: &str) -> tokio::process::Child {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let pid = child.id().expect("pid");
        let session = Session::new(
            session_id.to_string(),
            std::env::temp_dir(),
            "m".into(),
            "high".into(),
            pid,
            stdin,
            None,
            None,
            "acct".into(),
        );
        map.insert(session_id.to_string(), session);
        child
    }

    fn dummy_ctx() -> (ConnectionContext, tokio::sync::mpsc::Receiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        (ConnectionContext::new(tx), rx)
    }

    /// End-to-end over real loopback sockets, mirroring `peer_link`'s own
    /// `two_daemons_mirror_each_other_over_loopback` fixture: B hosts a real
    /// (throwaway-child-backed) `Session` and broadcasts two `ChatEvent`s on
    /// it; A's `mirror` already knows B owns that session id (no need to
    /// drive the full `peer_link` WS to prove THIS relay); attaching on A
    /// must deliver both events, wrapped in the local `chat_event` envelope,
    /// on the attaching connection's outbound channel - and detaching must
    /// stop further delivery.
    #[cfg(windows)]
    #[tokio::test]
    async fn attach_session_relays_a_mirrored_sessions_chat_events_and_detach_stops_it() {
        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();
        let sid = "b-session-1";

        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut b_child = spawn_fake_session(&b_state.sessions, sid).await;
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), b_dir.path().to_path_buf(), Router::new(), 0);
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(a_dir.path().to_path_buf());
        a_state.machines.get().unwrap().ensure_self();
        let (token_for_a, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id.clone(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token: token_for_a,
            reverse_device_id: None,
            added_at: 0,
        });
        a_state.mirror.set_instances(&b_id, "B", vec![mirrored_instance(sid)]);
        a_state.mirror.set_online(&b_id, true);

        let mut router = Router::new();
        register_attach(&mut router, a_state.clone());

        let (ctx, mut rx) = dummy_ctx();
        let conn_id = ctx.conn_id;
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "attach_session".into(),
                    params: Some(json!({"session_id": sid})),
                },
                ctx,
            )
            .await;
        assert!(resp.error.is_none(), "attach must succeed for a mirrored session: {:?}", resp.error);

        // Push markers repeatedly until the relay's WS handshake with B has
        // actually landed - tokio broadcast only delivers to subscribers
        // already attached at send time, so an early push can be missed
        // (same race `two_daemons_mirror_each_other_over_loopback` polls
        // around for the mirror link).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut seen = std::collections::HashSet::new();
        loop {
            let _ = b_state.sessions.get(sid).unwrap().events.send(ChatEvent::EventsLagged { timestamp: 111 });
            let _ = b_state.sessions.get(sid).unwrap().events.send(ChatEvent::EventsLagged { timestamp: 222 });
            while let Ok(frame) = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
                .await
                .unwrap_or(None)
                .ok_or(())
            {
                assert_eq!(frame["jsonrpc"], json!("2.0"));
                assert_eq!(frame["method"], json!("chat_event"));
                assert_eq!(frame["params"]["session_id"], json!(sid));
                assert_eq!(frame["params"]["event"]["type"], json!("events_lagged"));
                if let Some(ts) = frame["params"]["event"]["timestamp"].as_i64() {
                    seen.insert(ts);
                }
            }
            if seen.contains(&111) && seen.contains(&222) {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("never saw both relayed frames within 5s: seen={seen:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // Detach must stop the relay: the (conn_id, session_id) entry is gone
        // afterward, and no further pushed event reaches this connection.
        let detach_resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(2),
                    method: "detach_session".into(),
                    params: Some(json!({"session_id": sid})),
                },
                {
                    let (tx, _rx) = tokio::sync::mpsc::channel(16);
                    let mut c = ConnectionContext::new(tx);
                    c.conn_id = conn_id; // same connection identity as the attach above
                    c
                },
            )
            .await;
        assert!(detach_resp.error.is_none());
        assert!(
            a_state.relays.lock().await.get(&(conn_id, sid.to_string())).is_none(),
            "detach must remove the relay entry"
        );

        // Give the aborted task a moment to actually unwind, then prove no
        // more frames arrive even though B keeps broadcasting.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let _ = b_state.sessions.get(sid).unwrap().events.send(ChatEvent::EventsLagged { timestamp: 333 });
        let post_detach = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
        // Either a timeout (nothing arrived) or `Ok(None)` (the relay task's
        // aborted, so its outbound sender clone dropped and the channel
        // closed for good) both prove the relay is really gone; only a real
        // `Ok(Some(frame))` would mean detach failed to stop it.
        assert!(
            matches!(post_detach, Err(_) | Ok(None)),
            "no frame should arrive after detach, got {post_detach:?}"
        );

        b_serve.kill();
        let _ = b_child.kill().await;
    }
}
