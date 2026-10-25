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
/// Longest the WS upgrade may take once `reach_url` has the path up. The cold
/// iroh dial is not in here (it completes inside `reach_url`), so what is left
/// is a loopback TCP connect plus one round trip through the tunnel. Without a
/// bound, a path that died between those two steps parks the link until the
/// proxy's QUIC idle timeout, with the peer still shown online.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
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
    let wake = state.hub.wake_handle(&machine_id);
    let mut backoff = RECONNECT_MIN;
    loop {
        // `reach_url` now also completes the iroh dial, so it can fail after
        // ~30s as well as at once (no iroh id): either way the failure climbs
        // the same ladder, which also keeps a guaranteed-`Err` from hot-looping.
        let base_url = match peer_client::reach_url(&state, &peer).await {
            Ok(u) => u,
            Err(e) => {
                log::debug!("peer_link: {machine_id} unreachable: {e}");
                mark_offline(&state, &machine_id);
                backoff = pause(&wake, backoff).await;
                continue;
            }
        };
        let ws_url = to_stream_url(&base_url, &peer.token);
        let connected = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&ws_url)).await;
        match connected {
            Ok(Ok((stream, _resp))) => {
                backoff = RECONNECT_MIN; // a clean connect resets the ladder
                sync_profile(&state, &machine_id, &base_url).await;
                read_until_dead(&state, &peer, stream).await;
                mark_offline(&state, &machine_id);
                backoff = pause(&wake, backoff).await;
            }
            Ok(Err(e)) if handshake_was_revoked(&e) => {
                state.mirror.remove(&machine_id);
                publish_instances_changed(&state);
                tokio::time::sleep(REVOKED_BACKOFF).await;
            }
            Ok(Err(_)) | Err(_) => {
                mark_offline(&state, &machine_id);
                backoff = pause(&wake, backoff).await;
            }
        }
    }
}

/// Pulls the peer's current name and icon on every (re)connect, covering a
/// change made while this link was down (the peer's push is best-effort). A
/// failed health call is not a link failure: the stream is what matters.
async fn sync_profile(state: &Arc<DaemonState>, machine_id: &str, base_url: &str) {
    let Ok(health) = peer_client::PeerClient::new(base_url, "").health().await else { return };
    // Identity check: the base url could answer for some other machine.
    let Some(them) = health.get("machine").filter(|m| m["machine_id"].as_str() == Some(machine_id)) else { return };
    let Some(label) = them["label"].as_str() else { return };
    super::apply_peer_profile(state, machine_id, label, them["icon"].as_str());
}

/// Sleeps `backoff`, or until `MachineHub::wake` says the peer was just seen
/// alive. Returns the next backoff: doubled on a plain timeout, reset to the
/// floor on a wake (the ladder was climbed against a peer that is now back).
async fn pause(wake: &tokio::sync::Notify, backoff: Duration) -> Duration {
    tokio::select! {
        () = tokio::time::sleep(backoff) => (backoff * 2).min(RECONNECT_MAX),
        () = wake.notified() => RECONNECT_MIN,
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
    super::hidden::fetch_peer(state, peer).await;
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
                        let hidden_before = state.mirror.hidden_sessions();
                        super::hidden::apply_peer_frame(state, &peer.machine_id, &txt);
                        // The registry, not this link's spawn-time copy, so
                        // an owner rename made while the link is up sticks.
                        let label = state
                            .machines
                            .get()
                            .and_then(|r| r.peer(&peer.machine_id))
                            .map_or_else(|| peer.label.clone(), |p| p.label);
                        let changed = handle_frame(state, &peer.machine_id, &label, &txt);
                        // After the rows: a hidden id only counts once the
                        // peer's row for that chat is known, so an
                        // instances frame can be what makes it appear.
                        super::hidden::publish_if_changed(state, &hidden_before);
                        if changed {
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

/// Handles `instances_changed` and relays `preview`; ignores every other
/// method (chat streams are forwarded over a separate relay). Malformed
/// frames are dropped, not fatal to the link - a peer's own bug shouldn't
/// tear down our reconnect.
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
    match frame.get("method").and_then(serde_json::Value::as_str) {
        Some("instances_changed") => {}
        Some("preview") => {
            relay_preview(state, machine_id, &frame);
            return false;
        }
        _ => return false,
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

/// Re-publishes a peer's `preview` notifier frame locally, so a panel open on
/// a chat mirrored from that peer updates live (the store itself stays on the
/// host; the panel re-reads it through `list_previews`/`get_preview`, which
/// forward). Only a snapshot filed under a session this peer owns is relayed:
/// a peer cannot make our panel refresh for a local chat, nor for one a
/// different machine owns. The echo that would follow (our global stream
/// carries the republished frame back to the peer's own link) dies at the
/// peer for the same reason - the id is local to it. Rebuilt from the typed
/// metadata so only the fields the panel reads cross over.
fn relay_preview(state: &Arc<DaemonState>, machine_id: &str, frame: &serde_json::Value) {
    let Some(snapshot) = frame.pointer("/params/snapshot") else { return };
    let Ok(meta) = serde_json::from_value::<crate::daemon::preview::PreviewMeta>(snapshot.clone()) else { return };
    let Some(sid) = meta.session_id.as_deref() else { return };
    if super::mirrored_owner(state, sid).as_deref() != Some(machine_id) {
        return;
    }
    state.notifier.publish("preview", serde_json::json!({ "snapshot": meta }));
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
            icon: None,
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

    /// A profile change reaches the other daemon both ways: B changed its
    /// profile while A had not heard (A pulls it from `/api/health` when the link
    /// connects), then A edits its own profile and pushes it to B
    /// (`peer_profile_changed`).
    #[tokio::test]
    async fn profile_changes_reach_the_other_daemon_by_pull_and_by_push() {
        use crate::daemon::device_registry::DeviceRegistry;
        use crate::daemon::rpc::{ConnectionContext, Request, Router};
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;
        use tempfile::tempdir;

        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut a_serve_router = Router::new();
        crate::daemon::methods::register_machines(&mut a_serve_router, a_state.clone());
        let mut b_serve_router = Router::new();
        crate::daemon::methods::register_machines(&mut b_serve_router, b_state.clone());
        let (_a_stt, a_port, a_serve) = crate::daemon::remote_server::spawn_on(
            a_state.clone(), a_dir.path().to_path_buf(), a_serve_router, 0,
        );
        let (_b_stt, b_port, b_serve) = crate::daemon::remote_server::spawn_on(
            b_state.clone(), b_dir.path().to_path_buf(), b_serve_router, 0,
        );
        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        // B renamed itself while A was not listening.
        b_state.machines.get().unwrap().set_label("B renamed");
        b_state.machines.get().unwrap().set_icon(Some("ph-laptop".into()));

        let (token_for_a, _) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id.clone(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token: token_for_a,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        let (token_for_b, _) = DeviceRegistry::add_machine_device("B", &b_id, a_dir.path()).unwrap();
        b_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: a_id.clone(),
            label: "A".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{a_port}")),
            token: token_for_b,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        crate::daemon::machines::MachineHub::sync_links(&a_state);

        let wait_for = |ok: Box<dyn Fn() -> bool>| async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            while !ok() {
                assert!(tokio::time::Instant::now() < deadline, "condition not met within 8s");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let (s, id) = (a_state.clone(), b_id.clone());
        wait_for(Box::new(move || {
            let p = s.machines.get().unwrap().peer(&id).unwrap();
            p.label == "B renamed" && p.icon.as_deref() == Some("ph-laptop")
        }))
        .await;
        let (s, id) = (a_state.clone(), b_id.clone());
        wait_for(Box::new(move || s.mirror.is_online(&id))).await;

        let mut a_router = Router::new();
        crate::daemon::methods::register_machines(&mut a_router, a_state.clone());
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let resp = a_router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "set_machine_profile".into(),
                    params: Some(serde_json::json!({"label": "A renamed", "icon": "ph-desktop"})),
                },
                ConnectionContext::new(tx),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let (s, id) = (b_state.clone(), a_id.clone());
        wait_for(Box::new(move || {
            let p = s.machines.get().unwrap().peer(&id).unwrap();
            p.label == "A renamed" && p.icon.as_deref() == Some("ph-desktop")
        }))
        .await;

        a_serve.kill();
        b_serve.kill();
    }

    fn preview_frame(session_id: Option<&str>) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "preview",
            "params": {"snapshot": {
                "id": "p1", "slug": "mock", "title": "Mock", "source": "chat_card",
                "session_id": session_id, "version": 1, "created_at": "2026-10-23T00:00:00.000Z",
            }},
        })
        .to_string()
    }

    fn state_mirroring_s1_from_b() -> Arc<DaemonState> {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let rows = serde_json::json!([{
            "session_id": "s1", "pid": 1, "cwd": "C:/x", "project_id": "p",
            "kind": "interactive", "started_at": "2026-09-05T00:00:00Z",
        }]);
        let rows: Vec<Instance> = serde_json::from_value(rows).unwrap();
        state.mirror.set_instances("mach-b", "Mac Mini", rows);
        state
    }

    /// The panel on this machine only learns of a push to a mirrored chat if
    /// the peer's `preview` frame is re-published on the local notifier.
    #[test]
    fn handle_frame_relays_a_preview_for_a_chat_the_peer_owns() {
        let state = state_mirroring_s1_from_b();
        let mut rx = state.notifier.subscribe();
        assert!(!handle_frame(&state, "mach-b", "Mac Mini", &preview_frame(Some("s1"))));
        let got = rx.try_recv().expect("the preview must be re-published locally");
        assert_eq!(got["method"], "preview");
        assert_eq!(got["params"]["snapshot"]["id"], "p1");
        assert_eq!(got["params"]["snapshot"]["session_id"], "s1");
    }

    /// A peer must not refresh our panel for a chat it does not own: a local
    /// chat, one mirrored from a different machine, or a session-less push.
    #[test]
    fn handle_frame_drops_a_preview_the_peer_does_not_own() {
        let state = state_mirroring_s1_from_b();
        state.registry.upsert_interactive("ours", std::path::Path::new("C:/x"), "p", "2026-10-18T00:00:00Z");
        let mut rx = state.notifier.subscribe();

        handle_frame(&state, "mach-b", "Mac Mini", &preview_frame(Some("ours")));
        handle_frame(&state, "mach-c", "Other", &preview_frame(Some("s1")));
        handle_frame(&state, "mach-b", "Mac Mini", &preview_frame(None));
        handle_frame(&state, "mach-b", "Mac Mini", &preview_frame(Some("unknown")));
        assert!(rx.try_recv().is_err(), "none of these may reach the local notifier");
    }

    /// `MachineHub::wake` (a probe found the peer alive) must end the link's
    /// backoff at once and put the next one back at the floor.
    #[tokio::test]
    async fn a_wake_ends_the_backoff_and_resets_the_ladder() {
        let wake = tokio::sync::Notify::new();
        wake.notify_one();
        let next = tokio::time::timeout(Duration::from_secs(1), pause(&wake, RECONNECT_MAX))
            .await
            .expect("a woken pause must not sit out its backoff");
        assert_eq!(next, RECONNECT_MIN);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unwoken_pause_waits_out_the_backoff_and_doubles_it() {
        let wake = tokio::sync::Notify::new();
        let next = pause(&wake, RECONNECT_MIN).await;
        assert_eq!(next, RECONNECT_MIN * 2);
        assert_eq!(pause(&wake, RECONNECT_MAX).await, RECONNECT_MAX, "the ladder stops at its ceiling");
    }
}
