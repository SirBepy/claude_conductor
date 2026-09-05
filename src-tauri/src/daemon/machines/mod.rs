//! Machine identity for multi-machine federation: this daemon's own identity
//! plus the peer daemons it has paired with. See `registry.rs`. The HTTP
//! client for actually talking to a paired peer daemon lives in
//! `peer_client.rs`. `mirror.rs` caches every peer's instance list;
//! `peer_link.rs` keeps one peer's cache entry current over its
//! `/api/global/stream` WS; `hub.rs` owns the set of live links.

pub mod hub;
pub mod mirror;
pub mod peer_client;
pub mod peer_link;
pub mod registry;

pub use hub::MachineHub;
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
    out.extend(state.mirror.instances());
    out
}

/// Single publish point for the `instances_changed` notifier event, used by
/// every registry mutation site AND by `peer_link`/`hub` when a peer's
/// mirrored state changes - so a mirrored row's arrival/departure reaches
/// desktop/phone clients exactly like a local mutation does.
pub fn publish_instances_changed(state: &DaemonState) {
    state.notifier.publish("instances_changed", serde_json::json!({"instances": all_instances(state)}));
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
}
