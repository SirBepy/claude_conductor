//! Machine identity for multi-machine federation: this daemon's own identity
//! plus the peer daemons it has paired with. See `registry.rs`. The HTTP
//! client for actually talking to a paired peer daemon lives in
//! `peer_client.rs`. `mirror.rs` caches every peer's instance list;
//! `peer_link.rs` keeps one peer's cache entry current over its
//! `/api/global/stream` WS; `hub.rs` owns the set of live links. `forward.rs`
//! is the RPC-level counterpart (forwards a call for a session `mirror`
//! already knows is mirrored); `relay.rs` is the chat-event-stream
//! counterpart (relays a mirrored session's live turn output). `iroh_dial.rs`
//! is `peer_client::reach_url`'s fallback when a peer has no `direct_url`:
//! dials its iroh id and exposes the tunnel as a local loopback proxy port.

pub mod forward;
pub mod hidden;
pub mod hub;
pub mod iroh_dial;
pub mod mirror;
pub mod peer_client;
pub mod peer_link;
pub mod peer_scope;
pub mod registry;
pub mod relay;

pub use hub::MachineHub;
pub use iroh_dial::IrohDialer;
pub use mirror::MirrorState;
pub use peer_client::{client_for, reach_url, PeerClient, PeerError};
pub use registry::{MachineRegistry, MachinesFile, PeerMachine, PeerMachineView, SelfMachine};
pub(crate) use registry::now_secs;

use crate::daemon::state::DaemonState;
use crate::types::Instance;

/// The full instance list this daemon should show ANY consumer (desktop app,
/// phone, or a peer machine): this daemon's own registry rows (`machine:
/// None`) plus every mirrored row cached from a paired peer (`machine:
/// Some(..)`, stamped by `MirrorState::instances`). Every listing surface
/// (RPC `list_instances`, `GET /api/sessions`, the global-stream resync
/// frame, and every `instances_changed` broadcast) routes through this so
/// mirrored rows show up everywhere a local row already does.
pub fn all_instances(state: &DaemonState) -> Vec<Instance> {
    let mut out = state.registry.list();
    let local: std::collections::HashSet<String> = out.iter().map(|i| i.session_id.clone()).collect();
    out.extend(state.mirror.instances().into_iter().filter(|i| !local.contains(&i.session_id)));
    out
}

/// True when `session_id` is hosted on this daemon: a registry row, or a
/// live child that has no row yet.
pub fn is_local_session(state: &DaemonState, session_id: &str) -> bool {
    state.registry.get(session_id).is_some() || state.sessions.get(session_id).is_some()
}

/// The paired peer that owns `session_id`, and never one for a session
/// hosted here. A peer sees our real session ids over `/api/global/stream`
/// and can report one back as its own; resolving the local registry first is
/// what keeps Joe's messages and approvals for a local chat from being routed
/// to that peer. Every "is this mirrored?" routing decision goes through this,
/// not `MirrorState::owner_of` directly.
///
/// Falls back to the persisted ownership record (`MirrorState::recorded_owner`)
/// after the live rows: right after a restart the mirror is empty until each
/// peer's link reconnects, and without the record a send for a peer's chat
/// would reach the local handler and try to resume it on the wrong machine.
pub fn mirrored_owner(state: &DaemonState, session_id: &str) -> Option<String> {
    if is_local_session(state, session_id) {
        return None;
    }
    state.mirror.owner_of(session_id).or_else(|| state.mirror.recorded_owner(session_id))
}

/// Whether `machine_id` names this daemon. False before the machine registry
/// exists, so a caller treats the id as a peer and fails on the lookup there.
pub fn is_self_machine(state: &DaemonState, machine_id: &str) -> bool {
    state.machines.get().and_then(|r| r.self_machine()).is_some_and(|m| m.machine_id == machine_id)
}

/// Every cached mirrored prompt, minus any whose session id names a local
/// chat: a peer could otherwise plant a card that renders as one of ours.
pub fn mirrored_prompts(state: &DaemonState) -> Vec<serde_json::Value> {
    state
        .mirror
        .prompts()
        .into_iter()
        .filter(|p| !p["payload"]["session_id"].as_str().is_some_and(|sid| is_local_session(state, sid)))
        .collect()
}

/// Single publish point for the `instances_changed` notifier event, used by
/// every registry mutation site AND by `peer_link`/`hub` when a peer's
/// mirrored state changes - so a mirrored row's arrival/departure reaches
/// desktop/phone clients exactly like a local mutation does.
pub fn publish_instances_changed(state: &DaemonState) {
    state.notifier.publish("instances_changed", serde_json::json!({"instances": all_instances(state)}));
}

/// Writes a peer's own name and icon into this machine's cache of it: the
/// registry entry (the peer's label wins over any older owner-set nickname,
/// since the peer's own name is now the single source), its reverse device
/// name, the mirror label, then the change events. Returns whether anything
/// changed; nothing is published otherwise, so a link reconnect that finds
/// nothing new stays quiet. An unusable label or icon is ignored, not stored.
pub(crate) fn apply_peer_profile(state: &DaemonState, machine_id: &str, label: &str, icon: Option<&str>) -> bool {
    let Some(registry) = state.machines.get() else { return false };
    let Some(before) = registry.peer(machine_id) else { return false };
    let new_label = crate::daemon::device_registry::normalize_label(label).ok();
    // An unusable icon (a newer peer's format, garbage over /api/health) keeps
    // the cached one rather than clearing it on every reconnect.
    let new_icon = registry::normalize_icon(icon).unwrap_or_else(|_| before.icon.clone());
    let label_changed = new_label.is_some_and(|l| l != before.label);
    if let Some(l) = new_label {
        // Stored even when equal so a stale nickname entry cannot mask the
        // name the peer reports.
        registry.rename_peer(machine_id, l);
        if let Some(device_id) = &before.reverse_device_id {
            let _ = crate::daemon::device_registry::DeviceRegistry::rename_device(device_id, l, registry.app_data());
        }
    }
    let icon_changed = new_icon != before.icon;
    if icon_changed {
        registry.set_peer_icon(machine_id, new_icon);
    }
    if new_label.is_some_and(|l| state.mirror.set_label(machine_id, l)) {
        publish_instances_changed(state);
    }
    let changed = label_changed || icon_changed;
    if changed {
        state.notifier.publish("machines_changed", serde_json::json!({}));
    }
    changed
}

#[cfg(test)]
mod merged_tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::RegisterInput;
    use crate::types::{MachineRef, Settings};
    use std::sync::Mutex;

    #[test]
    fn an_unusable_icon_from_a_peer_keeps_the_cached_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        let reg = state.machines.get().unwrap();
        reg.upsert_peer(PeerMachine {
            machine_id: "mac".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "dummy-token".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: Some("ph-leaf".into()),
        });
        assert!(!apply_peer_profile(&state, "mac", "Mac", Some("Not An Icon")));
        assert_eq!(reg.peer("mac").unwrap().icon.as_deref(), Some("ph-leaf"));
        assert!(apply_peer_profile(&state, "mac", "Mac", None));
        assert_eq!(reg.peer("mac").unwrap().icon, None);
    }

    #[test]
    fn all_instances_merges_local_and_mirrored_rows() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = Mutex::new(Settings::default());
        state.registry.register(
            RegisterInput {
                session_id: "local-1".into(),
                cwd: std::path::PathBuf::from("C:/x"),
                pid: 1,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-09-05T00:00:00Z".into(),
            },
            &settings,
            "2026-09-05T00:00:00Z",
        );
        let mut mirrored = state.registry.get("local-1").unwrap();
        mirrored.session_id = "remote-1".into();
        state.mirror.set_instances("mach-b", "Mac Mini", vec![mirrored]);

        let all = all_instances(&state);
        assert_eq!(all.len(), 2);
        let local = all.iter().find(|i| i.session_id == "local-1").unwrap();
        assert!(local.machine.is_none());
        let remote = all.iter().find(|i| i.session_id == "remote-1").unwrap();
        assert_eq!(remote.machine, Some(MachineRef { id: "mach-b".into(), label: "Mac Mini".into(), online: true }));
    }

    #[test]
    fn a_peer_row_and_prompt_claiming_a_local_id_never_surface() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("local-1", std::path::Path::new("C:/x"), "proj", "2026-10-18T00:00:00Z");
        let claimed = state.registry.get("local-1").unwrap();
        let mut honest = claimed.clone();
        honest.session_id = "remote-1".into();
        state.mirror.set_instances("mach-b", "Mac Mini", vec![claimed, honest]);
        state.mirror.set_prompts(
            "mach-b",
            vec![
                serde_json::json!({"id": "fake", "event": "permission-requested", "payload": {"session_id": "local-1"}}),
                serde_json::json!({"id": "real", "event": "permission-requested", "payload": {"session_id": "remote-1"}}),
            ],
        );

        let all = all_instances(&state);
        let local_rows: Vec<_> = all.iter().filter(|i| i.session_id == "local-1").collect();
        assert_eq!(local_rows.len(), 1, "one row for the local chat, not a second mirrored copy");
        assert!(local_rows[0].machine.is_none());
        assert_eq!(mirrored_owner(&state, "local-1"), None);
        assert_eq!(mirrored_owner(&state, "remote-1").as_deref(), Some("mach-b"));
        let ids: Vec<_> = mirrored_prompts(&state).iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["real".to_string()]);
    }

    /// After a restart the live mirror is empty; the persisted record still
    /// routes the peer's chat to the peer, and still never claims a local id.
    #[test]
    fn mirrored_owner_falls_back_to_the_record_but_local_ids_always_win() {
        let dir = tempfile::tempdir().unwrap();
        let (remote, local) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        let before = state_for_ownership(dir.path(), &local);
        let mut peer_row = before.registry.get(&local).unwrap();
        peer_row.session_id = remote.clone();
        let mut claimed_local = peer_row.clone();
        claimed_local.session_id = local.clone();
        before.mirror.set_instances("mach-b", "Mac Mini", vec![peer_row, claimed_local]);
        assert_eq!(before.mirror.recorded_owner(&local).as_deref(), Some("mach-b"), "the record itself does hold it");

        let after = state_for_ownership(dir.path(), &local);
        assert!(after.mirror.owner_of(&remote).is_none(), "live mirror is empty after the restart");
        assert_eq!(mirrored_owner(&after, &remote).as_deref(), Some("mach-b"));
        assert_eq!(mirrored_owner(&after, &local), None, "a local chat is never claimed by the record");
        assert_eq!(mirrored_owner(&after, "never-seen"), None);
    }

    /// A daemon on `dir` whose own registry hosts `local`, as it would after
    /// a restart that reloaded its snapshot.
    fn state_for_ownership(dir: &std::path::Path, local: &str) -> std::sync::Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.mirror.attach_ownership_store(dir, |_| true);
        state.registry.upsert_interactive(local, std::path::Path::new("C:/x"), "proj", "2026-10-23T00:00:00Z");
        state
    }

    #[tokio::test]
    async fn publish_instances_changed_carries_mirrored_rows_with_local_ones() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("local-1", std::path::Path::new("C:/x"), "proj", "2026-10-18T00:00:00Z");
        let mut mirrored = state.registry.get("local-1").unwrap();
        mirrored.session_id = "remote-1".into();
        state.mirror.set_instances("mach-b", "Mac Mini", vec![mirrored]);
        let mut rx = state.notifier.subscribe();

        publish_instances_changed(&state);

        let frame = rx.recv().await.expect("instances_changed published");
        let ids: Vec<&str> = frame["params"]["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["session_id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"local-1") && ids.contains(&"remote-1"), "got {ids:?}");
    }

    /// A frame built from `registry.list()` alone replaces the app's whole
    /// instance cache with local rows only, so every paired machine's chats
    /// vanish from the sidebar until the next peer frame. Every
    /// `instances_changed` publish must go through `publish_instances_changed`.
    #[test]
    fn no_daemon_site_publishes_instances_changed_from_the_local_registry_alone() {
        fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    rs_files(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        let publish = ["notifier", ".publish("].concat();
        let event = ["\"instances", "_changed\""].concat();
        let mut offenders = Vec::new();
        for path in files {
            let text = std::fs::read_to_string(&path).unwrap();
            for (at, _) in text.match_indices(&publish) {
                let window: String = text[at..].chars().take(200).collect();
                if window.contains(&event) && window.contains("registry.list()") {
                    offenders.push(path.display().to_string());
                }
            }
        }
        assert!(offenders.is_empty(), "publish via publish_instances_changed instead: {offenders:?}");
    }
}
