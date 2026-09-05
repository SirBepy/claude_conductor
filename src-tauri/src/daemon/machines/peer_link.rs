//! Keeps one paired peer's `MirrorState` entry current by subscribing to its
//! `/api/global/stream` WebSocket (the same endpoint `remote_ws_pump.rs`
//! serves to the phone/browser) and re-publishing the merged list locally on
//! every update. One link per peer, owned/aborted by `MachineHub`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;

use crate::daemon::state::DaemonState;
use crate::types::Instance;

use super::registry::PeerMachine;
use super::{peer_client, publish_instances_changed};

/// Backoff floor/ceiling for a dropped-then-reconnecting link (step 4: "2s,
/// doubling to 30s"). Deliberately short at the floor - a same-LAN peer
/// blipping should recover fast, not leave a stale mirrored row lingering.
const RECONNECT_MIN: Duration = Duration::from_secs(2);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
/// `reach_url` errs for a peer with neither a `direct_url` nor an `iroh_id`,
/// or when the iroh dial endpoint itself fails to bind - retry on this
/// cadence rather than hot-looping a guaranteed-`Err` call.
const UNREACHABLE_RETRY: Duration = Duration::from_secs(30);
/// A revoked token means re-pairing fixes it, not a fast retry - back off
/// harder than a plain network blip (step 2).
const REVOKED_BACKOFF: Duration = Duration::from_secs(60);
/// Heartbeat cadence is 15s (`GLOBAL_HEARTBEAT_INTERVAL`); silence past 3x
/// that means the socket is dead even though TCP hasn't noticed yet.
const FRAME_DEAD_AFTER: Duration = Duration::from_secs(45);

/// Runs forever (until the returned handle is aborted by `MachineHub`),
/// keeping `state.mirror`'s entry for `peer.machine_id` in sync with that
/// peer's own `instances_changed` broadcasts.
pub fn spawn_link(state: Arc<DaemonState>, peer: PeerMachine) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run_link(state, peer).await })
}

async fn run_link(state: Arc<DaemonState>, peer: PeerMachine) {
    let machine_id = peer.machine_id.clone();
    let mut backoff = RECONNECT_MIN;
    loop {
        let base_url = match peer_client::reach_url(&state, &peer).await {
            Ok(u) => u,
            Err(_) => {
                mark_offline(&state, &machine_id);
                tokio::time::sleep(UNREACHABLE_RETRY).await;
                continue;
            }
        };
        let ws_url = to_stream_url(&base_url, &peer.token);
        match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((stream, _resp)) => {
                backoff = RECONNECT_MIN; // a clean connect resets the ladder
                read_until_dead(&state, &machine_id, &peer.label, stream).await;
                mark_offline(&state, &machine_id);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RECONNECT_MAX);
            }
            Err(e) => {
                if handshake_was_revoked(&e) {
                    state.mirror.remove(&machine_id);
                    publish_instances_changed(&state);
                    tokio::time::sleep(REVOKED_BACKOFF).await;
                } else {
                    mark_offline(&state, &machine_id);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(RECONNECT_MAX);
                }
            }
        }
    }
}

fn mark_offline(state: &Arc<DaemonState>, machine_id: &str) {
    state.mirror.set_online(machine_id, false);
    publish_instances_changed(state);
}

/// True when the WS handshake itself was rejected with 401/403 - the peer
/// revoked our token (unpair on their end), so re-pairing is the fix, not a
/// fast retry.
fn handshake_was_revoked(err: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(
        err,
        tokio_tungstenite::tungstenite::Error::Http(resp)
            if resp.status().as_u16() == 401 || resp.status().as_u16() == 403
    )
}

fn to_stream_url(base_url: &str, token: &str) -> String {
    let ws_base = if let Some(rest) = base_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base_url.to_string()
    };
    format!("{}/api/global/stream?token={}", ws_base.trim_end_matches('/'), token)
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Reads frames until the socket closes, errors, or goes silent past
/// `FRAME_DEAD_AFTER` (the heartbeat is every 15s, so 45s of nothing means
/// dead even though TCP hasn't noticed).
async fn read_until_dead(state: &Arc<DaemonState>, machine_id: &str, label: &str, mut stream: WsStream) {
    loop {
        match tokio::time::timeout(FRAME_DEAD_AFTER, stream.next()).await {
            Ok(Some(Ok(Message::Text(txt)))) => handle_frame(state, machine_id, label, &txt),
            Ok(Some(Ok(_))) => {} // ping/pong/binary/close-frame-as-data: ignore
            Ok(Some(Err(_))) | Ok(None) | Err(_) => return, // errored, closed, or silent too long
        }
    }
}

/// Ignores every method except `instances_changed` (a later chunk forwards
/// chat streams over this same link). Malformed frames are dropped, not
/// fatal to the link - a peer's own bug shouldn't tear down our reconnect.
fn handle_frame(state: &Arc<DaemonState>, machine_id: &str, label: &str, txt: &str) {
    let Ok(frame) = serde_json::from_str::<serde_json::Value>(txt) else { return };
    if frame.get("method").and_then(serde_json::Value::as_str) != Some("instances_changed") {
        return;
    }
    let Some(arr) = frame.pointer("/params/instances") else { return };
    let Ok(rows) = serde_json::from_value::<Vec<Instance>>(arr.clone()) else { return };
    state.mirror.set_instances(machine_id, label, rows);
    publish_instances_changed(state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_stream_url_rewrites_http_to_ws() {
        assert_eq!(
            to_stream_url("http://127.0.0.1:27291", "tok"),
            "ws://127.0.0.1:27291/api/global/stream?token=tok"
        );
    }

    #[test]
    fn to_stream_url_rewrites_https_to_wss() {
        assert_eq!(
            to_stream_url("https://example.tailnet.ts.net", "tok"),
            "wss://example.tailnet.ts.net/api/global/stream?token=tok"
        );
    }

    #[test]
    fn handle_frame_ignores_other_methods() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        handle_frame(&state, "mach-b", "Mac Mini", r#"{"jsonrpc":"2.0","method":"heartbeat","params":{}}"#);
        assert!(state.mirror.instances().is_empty());
    }

    #[test]
    fn handle_frame_stamps_and_stores_instances_changed() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "instances_changed",
            "params": {"instances": [{
                "session_id": "s1", "pid": 1, "cwd": "C:/x", "project_id": "p",
                "kind": "interactive", "started_at": "2026-09-05T00:00:00Z",
            }]},
        });
        handle_frame(&state, "mach-b", "Mac Mini", &frame.to_string());
        let rows = state.mirror.instances();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].machine.as_ref().unwrap().id, "mach-b");
    }

    /// End-to-end over real loopback sockets: two `DaemonState`s each run
    /// their own remote-access server (ephemeral ports, `spawn_on`), A is
    /// paired to mirror B, and `sync_links` is expected to bring B's fake
    /// session into A's merged view within a few seconds - then dropping
    /// B's server must flip the mirrored row's `online` back to false
    /// without the row itself vanishing. Touches neither 27183 nor 27182
    /// (both bind port 0) and spawns no `claude` process.
    #[tokio::test]
    async fn two_daemons_mirror_each_other_over_loopback() {
        use crate::daemon::device_registry::DeviceRegistry;
        use crate::daemon::rpc::Router;
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;
        use crate::types::Settings;
        use std::sync::Mutex;
        use tempfile::tempdir;

        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));

        let (_a_stt, _a_port, a_serve) = crate::daemon::remote_server::spawn_on(
            a_state.clone(), a_dir.path().to_path_buf(), Router::new(), 0,
        );
        let (_b_stt, b_port, b_serve) = crate::daemon::remote_server::spawn_on(
            b_state.clone(), b_dir.path().to_path_buf(), Router::new(), 0,
        );

        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        // A fake live session on B, so A's mirror has something to pick up.
        let settings = Mutex::new(Settings::default());
        b_state.registry.register(
            RegisterInput {
                session_id: "b-session-1".into(),
                cwd: std::path::PathBuf::from("C:/b-repo"),
                pid: 4242,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-09-05T00:00:00Z".into(),
            },
            &settings,
            "2026-09-05T00:00:00Z",
        );

        // Mint on B the bearer A will present, and register on A the peer
        // pointing back at B - mirrors what `pair_machine` does, minus the
        // HTTP handshake (both daemons are in-process here).
        let (token_for_a, _device_id) =
            DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
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

        crate::daemon::machines::MachineHub::sync_links(&a_state);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let rows = a_state.mirror.instances();
            if let Some(row) = rows.iter().find(|i| i.session_id == "b-session-1") {
                assert_eq!(row.machine.as_ref().unwrap().id, b_id);
                assert!(row.machine.as_ref().unwrap().online, "must be online while B's server is up");
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("B's session never showed up in A's mirror within 5s: {rows:?}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Kill B's server to simulate the peer going offline.
        b_serve.kill();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let rows = a_state.mirror.instances();
            let row = rows.iter().find(|i| i.session_id == "b-session-1");
            match row {
                Some(r) if !r.machine.as_ref().unwrap().online => break,
                _ if tokio::time::Instant::now() >= deadline => {
                    panic!("mirrored row never flipped offline within 5s after B's server died: {rows:?}");
                }
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }

        a_serve.kill();
    }
}
