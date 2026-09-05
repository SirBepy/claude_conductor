//! In-memory cache of every OTHER paired machine's instance list, kept
//! current by `peer_link::spawn_link`'s WS subscription. Never persisted:
//! a fresh daemon starts with an empty mirror and repopulates within one
//! `instances_changed` frame of each link reconnecting.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::types::{Instance, MachineRef};

struct MirroredPeer {
    label: String,
    online: bool,
    instances: Vec<Instance>,
}

pub struct MirrorState {
    inner: Mutex<HashMap<String, MirroredPeer>>,
}

impl MirrorState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// Every mirrored row across every peer, each stamped with the owning
    /// peer's `MachineRef`. A row already carrying a `machine` tag (a
    /// peer's own mirrored copy of a THIRD machine, or of us) is dropped
    /// here too, on top of `set_instances`'s own guard - belt and braces
    /// against a caller that bypassed `set_instances` and wrote a raw
    /// snapshot straight into a test fixture.
    pub fn instances(&self) -> Vec<Instance> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .iter()
            .flat_map(|(machine_id, peer)| {
                let stamp = MachineRef { id: machine_id.clone(), label: peer.label.clone(), online: peer.online };
                peer.instances
                    .iter()
                    .filter(|i| i.machine.is_none())
                    .cloned()
                    .map(move |mut i| {
                        i.machine = Some(stamp.clone());
                        i
                    })
            })
            .collect()
    }

    /// Which machine hosts `session_id`, if it is a mirrored row (not a
    /// locally-registered one - callers check `registry` first).
    pub fn owner_of(&self, session_id: &str) -> Option<String> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .iter()
            .find(|(_, peer)| peer.instances.iter().any(|i| i.session_id == session_id))
            .map(|(machine_id, _)| machine_id.clone())
    }

    /// Replace `machine_id`'s cached instance list wholesale (the frame we
    /// just received is a full snapshot, never a delta - see
    /// `remote_ws_pump::instances_changed_frame`) and mark it online. Rows
    /// already carrying a `machine` tag (the peer's own mirror of a THIRD
    /// machine, or a stale echo of us) are dropped, so mirroring never
    /// transitively chains past one hop.
    pub fn set_instances(&self, machine_id: &str, label: &str, rows: Vec<Instance>) {
        let rows: Vec<Instance> = rows.into_iter().filter(|i| i.machine.is_none()).collect();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(machine_id.to_string(), MirroredPeer { label: label.to_string(), online: true, instances: rows });
    }

    /// Flips the online flag without touching the cached rows - a dropped
    /// link keeps showing its last-known state, just grayed as offline,
    /// same contract session status elsewhere in this codebase already uses.
    pub fn set_online(&self, machine_id: &str, online: bool) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = guard.get_mut(machine_id) {
            peer.online = online;
        }
    }

    pub fn is_online(&self, machine_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(machine_id).map(|p| p.online).unwrap_or(false)
    }

    /// Drops a peer entirely - called on unpair, so a removed peer's rows
    /// vanish immediately instead of lingering "offline" forever.
    pub fn remove(&self, machine_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(machine_id);
    }
}

impl Default for MirrorState {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::kinds::InstanceKind;

    fn fixture(session_id: &str, machine: Option<MachineRef>) -> Instance {
        Instance {
            session_id: session_id.into(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/x"),
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
            machine,
        }
    }

    #[test]
    fn set_instances_stamps_machine_ref_and_online() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]);
        let rows = m.instances();
        assert_eq!(rows.len(), 1);
        let stamp = rows[0].machine.as_ref().expect("stamped");
        assert_eq!(stamp.id, "mach-b");
        assert_eq!(stamp.label, "Mac Mini");
        assert!(stamp.online);
    }

    #[test]
    fn owner_of_resolves_the_hosting_machine() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]);
        assert_eq!(m.owner_of("s1").as_deref(), Some("mach-b"));
        assert_eq!(m.owner_of("unknown"), None);
    }

    #[test]
    fn loop_guard_drops_rows_already_carrying_a_machine_tag() {
        let m = MirrorState::new();
        let already_mirrored = MachineRef { id: "mach-c".into(), label: "Third".into(), online: true };
        m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None), fixture("s2", Some(already_mirrored))]);
        let rows = m.instances();
        assert_eq!(rows.len(), 1, "a peer's own mirrored copy of a third machine must not re-mirror");
        assert_eq!(rows[0].session_id, "s1");
    }

    #[test]
    fn set_online_flips_the_stamp_without_dropping_rows() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]);
        m.set_online("mach-b", false);
        let rows = m.instances();
        assert_eq!(rows.len(), 1, "a dropped link keeps its last-known rows");
        assert!(!rows[0].machine.as_ref().unwrap().online);
        assert!(!m.is_online("mach-b"));
    }

    #[test]
    fn remove_drops_the_peer_entirely() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]);
        m.remove("mach-b");
        assert!(m.instances().is_empty());
        assert_eq!(m.owner_of("s1"), None);
    }
}
