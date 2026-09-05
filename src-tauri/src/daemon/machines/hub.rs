//! Owns one live `peer_link::spawn_link` task per paired peer, keyed by
//! `machine_id`. `sync_links` is idempotent - safe to call after every
//! pairing mutation (pair/unpair/peer-initiated unpair) and once at daemon
//! startup, so the link set never drifts from `MachineRegistry::peers()`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::daemon::state::DaemonState;

pub struct MachineHub {
    links: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl MachineHub {
    pub fn new() -> Self {
        Self { links: Mutex::new(HashMap::new()) }
    }

    /// Spawns a link for every peer that doesn't already have a live one,
    /// and aborts + drops the mirror for any link whose peer is no longer
    /// registered (unpaired since the last sync).
    pub fn sync_links(state: &Arc<DaemonState>) {
        let Some(registry) = state.machines.get() else { return };
        let peers = registry.peers();
        let wanted: std::collections::HashSet<String> = peers.iter().map(|p| p.machine_id.clone()).collect();

        let mut guard = state.hub.links.lock().unwrap_or_else(|e| e.into_inner());

        // Drop links for peers no longer in the registry.
        let stale: Vec<String> = guard.keys().filter(|id| !wanted.contains(*id)).cloned().collect();
        for machine_id in stale {
            if let Some(handle) = guard.remove(&machine_id) {
                handle.abort();
            }
            state.mirror.remove(&machine_id);
        }

        // Spawn links for peers with none yet (a fresh pair, or a daemon restart).
        for peer in peers {
            if guard.contains_key(&peer.machine_id) {
                continue;
            }
            let machine_id = peer.machine_id.clone();
            let handle = super::peer_link::spawn_link(state.clone(), peer);
            guard.insert(machine_id, handle);
        }
    }
}

impl Default for MachineHub {
    fn default() -> Self { Self::new() }
}

impl Drop for MachineHub {
    /// Every link is a `tokio::spawn` loop with no natural exit - abort them
    /// so a daemon shutdown (or, in tests, a `DaemonState` going out of
    /// scope) doesn't leak them running against a dead app_data dir.
    fn drop(&mut self) {
        let guard = self.links.lock().unwrap_or_else(|e| e.into_inner());
        for handle in guard.values() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn mk_peer(id: &str) -> PeerMachine {
        PeerMachine {
            machine_id: id.into(),
            label: "Peer".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: None, // reach_url fails fast; the link parks in its unreachable-retry branch
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        }
    }

    #[tokio::test]
    async fn sync_links_spawns_one_link_per_peer_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        state.machines.get().unwrap().upsert_peer(mk_peer("mach-b"));

        MachineHub::sync_links(&state);
        assert_eq!(state.hub.links.lock().unwrap().len(), 1);

        // Re-running must not spawn a second link for the same peer.
        MachineHub::sync_links(&state);
        assert_eq!(state.hub.links.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn sync_links_aborts_and_unmirrors_a_removed_peer() {
        let dir = tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        state.machines.get().unwrap().upsert_peer(mk_peer("mach-b"));
        MachineHub::sync_links(&state);
        state.mirror.set_instances("mach-b", "Peer", vec![]);

        state.machines.get().unwrap().remove_peer("mach-b");
        MachineHub::sync_links(&state);

        assert!(state.hub.links.lock().unwrap().is_empty());
        assert!(!state.mirror.is_online("mach-b"), "remove() must drop the entry entirely");
    }
}
