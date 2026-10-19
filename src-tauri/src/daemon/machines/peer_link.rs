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
/// While the peer's prompt cache is non-empty, re-fetch on this cadence
/// so a prompt answered directly on the peer (or from a third device) drops
/// out of OUR cache even with no intervening `instances_changed` frame.
const PROMPT_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

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
                read_until_dead(&state, &peer, stream).await;
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
/// dead even though TCP hasn't noticed). Also runs the prompt-cache
/// refresh: a periodic tick independent of `FRAME_DEAD_AFTER` - the dead-link
/// deadline is only ever pushed out by an actual frame arriving (via
/// `sleep_until`, recomputed on receipt), never by the tick, so a silent
/// socket is still caught at 45s even while the tick keeps firing every 2s.
async fn read_until_dead(state: &Arc<DaemonState>, peer: &PeerMachine, mut stream: WsStream) {
    let mut deadline = tokio::time::Instant::now() + FRAME_DEAD_AFTER;
    let mut prompt_tick = tokio::time::interval(PROMPT_REFRESH_INTERVAL);
    loop {
        tokio::select! {
            frame = stream.next() => {
                match frame {
                    Some(Ok(Message::Text(txt))) => {
                        deadline = tokio::time::Instant::now() + FRAME_DEAD_AFTER;
                        // Only re-check prompts when the frame actually changed our
                        // cached view of the peer: a row's `awaiting` flipping (new
                        // question, or one just answered) IS a row change, so it is
                        // already covered. A prompt answered on the peer with no
                        // accompanying row change (rare) is still caught within 2s
                        // by `prompt_tick` below, so skipping the refresh on a
                        // no-op frame costs nothing but saves the per-frame RPC
                        // round trip that amplified the hot loop.
                        if handle_frame(state, &peer.machine_id, &peer.label, &txt) {
                            maybe_refresh_prompts_after_frame(state, peer).await;
                        }
                    }
                    Some(Ok(_)) => deadline = tokio::time::Instant::now() + FRAME_DEAD_AFTER, // ping/pong/binary: still alive
                    Some(Err(_)) | None => return, // errored or closed
                }
            }
            () = tokio::time::sleep_until(deadline) => return, // silent too long
            _ = prompt_tick.tick() => {
                if state.mirror.has_cached_prompts(&peer.machine_id) {
                    refresh_prompts(state, peer).await;
                }
            }
        }
    }
}

/// After an `instances_changed` frame is applied: refetch the peer's prompts
/// when something might have changed worth showing - a row now awaiting
/// input (a NEW prompt may exist), or the cache already non-empty (an open
/// prompt may have just been answered and must drop out promptly rather than
/// waiting for the next tick).
async fn maybe_refresh_prompts_after_frame(state: &Arc<DaemonState>, peer: &PeerMachine) {
    if state.mirror.peer_has_awaiting(&peer.machine_id) || state.mirror.has_cached_prompts(&peer.machine_id) {
        refresh_prompts(state, peer).await;
    }
}

/// One `list_pending_prompts` round trip against `peer`, replacing its cached
/// snapshot wholesale on success. Never fatal to the link: a fetch failure
/// (network blip, peer mid-restart) just keeps the last-known cache and
/// leaves retrying to the next frame or tick.
async fn refresh_prompts(state: &Arc<DaemonState>, peer: &PeerMachine) {
    let client = match peer_client::client_for(state, peer).await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("peer_link: prompt refresh for {} unreachable: {e}", peer.machine_id);
            return;
        }
    };
    match client.call("list_pending_prompts", serde_json::Value::Null).await {
        Ok(serde_json::Value::Array(prompts)) => {
            // A prompt (raw JSON from `list_pending_prompts`) never carries a
            // `machine` tag the way an `Instance` row does, so every collision
            // here is "untagged" and counted - there is no silently-dropped-
            // elsewhere case to defer to.
            let (prompts, collisions) =
                drop_local_collisions(state, prompts, |_: &serde_json::Value| false, |p| p["payload"]["session_id"].as_str());
            if collisions > 0 {
                log::warn!(
                    "peer_link: {} reported {collisions} local session id(s) in its prompt list; dropped",
                    peer.machine_id
                );
            }
            state.mirror.set_prompts(&peer.machine_id, prompts)
        }
        Ok(other) => {
            log::warn!("peer_link: list_pending_prompts for {} returned non-array: {other:?}", peer.machine_id)
        }
        Err(e) => log::debug!("peer_link: list_pending_prompts for {} failed: {e}", peer.machine_id),
    }
}

/// Ignores every method except `instances_changed` (a later chunk forwards
/// chat streams over this same link). Malformed frames are dropped, not
/// fatal to the link - a peer's own bug shouldn't tear down our reconnect.
///
/// Returns whether the frame actually changed our cached view of the peer
/// (per `MirrorState::set_instances`), and only re-publishes
/// `instances_changed` locally when it did. Two paired daemons each run a
/// link to the other, and `remote_ws_pump::pump_global_events` forwards
/// every publish immediately, so republishing an unchanged frame would feed
/// it straight back to the peer's own link, which republishes it back to
/// us, forever - the feedback loop behind the daemon.log flood this guards
/// against.
fn handle_frame(state: &Arc<DaemonState>, machine_id: &str, label: &str, txt: &str) -> bool {
    let Ok(frame) = serde_json::from_str::<serde_json::Value>(txt) else { return false };
    if frame.get("method").and_then(serde_json::Value::as_str) != Some("instances_changed") {
        return false;
    }
    let Some(arr) = frame.pointer("/params/instances") else { return false };
    let Ok(rows) = serde_json::from_value::<Vec<Instance>>(arr.clone()) else { return false };
    let (rows, collisions) = drop_local_collisions(state, rows, |i: &Instance| i.machine.is_some(), |i| Some(i.session_id.as_str()));
    if collisions > 0 {
        log::warn!("peer_link: {machine_id} reported {collisions} local session id(s) as its own; dropped");
    }
    let changed = state.mirror.set_instances(machine_id, label, rows);
    if changed {
        publish_instances_changed(state);
    }
    changed
}

/// Drops every row or prompt a peer reports under one of OUR session ids,
/// returning the survivors plus a count of how many untagged collisions were
/// found. An item already carrying a `machine` tag (an `Instance` row that is
/// a peer's own mirrored copy of a THIRD machine, or a stale echo of us) is
/// left alone here, not logged: `MirrorState::set_instances` already drops
/// those silently one hop later, and logging them again here per row per
/// frame is exactly the hot-loop log spam this guards against. Only an UNTAGGED
/// collision - a peer claiming raw, untagged ownership of our session id,
/// which an honest peer never does since ids are fresh uuids - is suspicious,
/// and it is counted and logged once per call, never once per row. The read
/// side (`machines::mirrored_owner`/`mirrored_prompts`/`all_instances`) also
/// refuses collisions, covering a local chat created after the frame landed.
fn drop_local_collisions<T>(
    state: &DaemonState,
    items: Vec<T>,
    is_tagged: impl Fn(&T) -> bool,
    session_id: impl Fn(&T) -> Option<&str>,
) -> (Vec<T>, usize) {
    let mut collisions = 0usize;
    let kept = items
        .into_iter()
        .filter(|item| {
            if is_tagged(item) {
                return true;
            }
            match session_id(item) {
                Some(sid) if super::is_local_session(state, sid) => {
                    collisions += 1;
                    false
                }
                _ => true,
            }
        })
        .collect();
    (kept, collisions)
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

    #[test]
    fn handle_frame_drops_a_row_claiming_a_local_session_id() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("ours", std::path::Path::new("C:/x"), "p", "2026-10-18T00:00:00Z");
        let row = |sid: &str| serde_json::json!({
            "session_id": sid, "pid": 1, "cwd": "C:/x", "project_id": "p",
            "kind": "interactive", "started_at": "2026-09-05T00:00:00Z",
        });
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "instances_changed",
            "params": {"instances": [row("ours"), row("theirs")]},
        });
        handle_frame(&state, "mach-b", "Mac Mini", &frame.to_string());
        let ids: Vec<String> = state.mirror.instances().into_iter().map(|i| i.session_id).collect();
        assert_eq!(ids, vec!["theirs".to_string()]);
        assert_eq!(state.mirror.owner_of("ours"), None, "the claim never reached the mirror");
    }

    #[test]
    fn drop_local_collisions_counts_only_untagged_hits() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("ours", std::path::Path::new("C:/x"), "p", "2026-10-18T00:00:00Z");

        // A plain (sid, tagged) pair stands in for an Instance/prompt row here -
        // the two real call sites each pass their own `is_tagged`/`session_id`
        // closures over their own item type.
        let rows = vec![
            ("ours", true),   // a one-hop echo of us, already carrying a machine tag
            ("ours", false),  // a bare claim of our session id, no tag at all
            ("theirs", false), // an honest, unrelated row
        ];
        let (kept, collisions) = drop_local_collisions(
            &state,
            rows,
            |(_, tagged): &(&str, bool)| *tagged,
            |(sid, _): &(&str, bool)| Some(*sid),
        );
        assert_eq!(collisions, 1, "only the untagged collision counts - a tagged echo is left for set_instances to drop silently, never logged here");
        assert_eq!(kept.len(), 2, "the tagged row survives this filter (set_instances drops it one hop later); only the untagged collision is removed here");
    }

    #[test]
    fn handle_frame_republishes_only_when_the_frame_changed_something() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut rx = state.notifier.subscribe();
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "instances_changed",
            "params": {"instances": [{
                "session_id": "s1", "pid": 1, "cwd": "C:/x", "project_id": "p",
                "kind": "interactive", "started_at": "2026-09-05T00:00:00Z",
            }]},
        })
        .to_string();

        assert!(handle_frame(&state, "mach-b", "Mac Mini", &frame), "the first delivery changes the mirror");
        assert!(!handle_frame(&state, "mach-b", "Mac Mini", &frame), "an identical re-delivery of the same frame is a no-op");

        assert!(rx.try_recv().is_ok(), "the real change must still publish instances_changed once");
        assert!(rx.try_recv().is_err(), "the unchanged echo must not publish a second time - this is the A-republishes-to-B-republishes-to-A feedback loop");
    }

    #[test]
    fn handle_frame_tagged_echo_of_a_local_session_is_silently_dropped() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("ours", std::path::Path::new("C:/x"), "p", "2026-10-18T00:00:00Z");
        // Tagged with OUR OWN machine id, the way a peer's one-hop echo of a
        // row it mirrored from us would arrive - distinct from the untagged
        // claim `handle_frame_drops_a_row_claiming_a_local_session_id` covers.
        let tagged_echo = serde_json::json!({
            "session_id": "ours", "pid": 1, "cwd": "C:/x", "project_id": "p",
            "kind": "interactive", "started_at": "2026-09-05T00:00:00Z",
            "machine": {"id": "this-daemon", "label": "Us", "online": true},
        });
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "instances_changed",
            "params": {"instances": [tagged_echo]},
        });
        handle_frame(&state, "mach-b", "Mac Mini", &frame.to_string());
        assert!(state.registry.get("ours").is_some(), "the local session itself must be untouched");
        assert_eq!(state.mirror.owner_of("ours"), None, "the tagged echo must never be adopted as a mirrored row");
        assert!(state.mirror.instances().is_empty(), "set_instances drops the tagged row silently, same as the loop guard it already had");
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
