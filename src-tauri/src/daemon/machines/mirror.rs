//! In-memory cache of every OTHER paired machine's instance list, kept
//! current by `peer_link::spawn_link`'s WS subscription. Never persisted:
//! a fresh daemon starts with an empty mirror and repopulates within one
//! `instances_changed` frame of each link reconnecting.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::types::{Instance, MachineRef};

/// A pending-owner entry older than this is treated as stale and dropped on
/// next lookup rather than trusted forever - a peer that silently failed to
/// ever report the session back (crashed before its next broadcast, or the
/// id was never real) must not pin a phantom owner indefinitely.
const PENDING_TTL: Duration = Duration::from_secs(120);

struct MirroredPeer {
    label: String,
    online: bool,
    instances: Vec<Instance>,
    /// The peer's own `list_pending_prompts` snapshot, last fetched by
    /// `peer_link`. Cleared on `set_online(.., false)` and on `remove` (via
    /// the whole entry going away) - a mirrored prompt must never outlive the
    /// link that vouched for it.
    prompts: Vec<serde_json::Value>,
}

pub struct MirrorState {
    inner: Mutex<HashMap<String, MirroredPeer>>,
    /// `start_session`'s forwarded-id bridge (G2): the owning peer's
    /// `instances_changed` broadcast can take up to one mirror-link cycle to
    /// report a chat it just spawned for us, so `forward_start_session`
    /// records the id here the instant the peer's RPC response names it.
    /// `owner_of` consults this only after the real mirrored rows come up
    /// empty, and `set_instances` retires an entry the moment a real row for
    /// that id arrives.
    pending: Mutex<HashMap<String, (String, Instant)>>,
}

impl MirrorState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()) }
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
    /// locally-registered one - callers check `registry` first). Falls back
    /// to the pending-owner map (G2) for an id too new to have appeared in a
    /// real mirrored row yet, pruning it first if it has outlived
    /// `PENDING_TTL` - a real row always wins once it shows up.
    pub fn owner_of(&self, session_id: &str) -> Option<String> {
        {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((machine_id, _)) =
                guard.iter().find(|(_, peer)| peer.instances.iter().any(|i| i.session_id == session_id))
            {
                return Some(machine_id.clone());
            }
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match pending.get(session_id) {
            Some((machine_id, inserted_at)) if inserted_at.elapsed() <= PENDING_TTL => Some(machine_id.clone()),
            Some(_) => {
                pending.remove(session_id);
                None
            }
            None => None,
        }
    }

    /// Records `session_id` as owned by `machine_id` the instant a forwarded
    /// `start_session` returns it (`lifecycle/core.rs::forward_start_session`),
    /// before the peer's own next `instances_changed` frame can report it.
    pub fn record_pending(&self, session_id: &str, machine_id: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(session_id.to_string(), (machine_id.to_string(), Instant::now()));
    }

    /// Replace `machine_id`'s cached instance list wholesale (the frame we
    /// just received is a full snapshot, never a delta - see
    /// `remote_ws_pump::instances_changed_frame`) and mark it online. Rows
    /// already carrying a `machine` tag (the peer's own mirror of a THIRD
    /// machine, or a stale echo of us) are dropped, so mirroring never
    /// transitively chains past one hop.
    pub fn set_instances(&self, machine_id: &str, label: &str, rows: Vec<Instance>) {
        let rows: Vec<Instance> = rows.into_iter().filter(|i| i.machine.is_none()).collect();
        // A real row for an id just superseded any pending-owner guess for
        // it - whether that guess named this machine or (in theory) a stale
        // one, the freshly-reported row is ground truth now.
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            for row in &rows {
                pending.remove(&row.session_id);
            }
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let prompts = guard.get(machine_id).map(|p| p.prompts.clone()).unwrap_or_default();
        guard.insert(machine_id.to_string(), MirroredPeer { label: label.to_string(), online: true, instances: rows, prompts });
    }

    /// Flips the online flag without touching the cached rows - a dropped
    /// link keeps showing its last-known state, just grayed as offline,
    /// same contract session status elsewhere in this codebase already uses.
    /// Going offline DOES clear the prompt cache (G4): an unreachable peer
    /// can't be asked to re-confirm or re-answer, so a stale card is worse
    /// than no card.
    pub fn set_online(&self, machine_id: &str, online: bool) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = guard.get_mut(machine_id) {
            peer.online = online;
            if !online {
                peer.prompts.clear();
            }
        }
    }

    pub fn is_online(&self, machine_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(machine_id).map(|p| p.online).unwrap_or(false)
    }

    /// Drops a peer entirely - called on unpair, so a removed peer's rows
    /// (and its prompt cache) vanish immediately instead of lingering
    /// "offline" forever. Also drops any pending-owner entry still naming
    /// this machine (G2): once it's gone, nothing can ever confirm a
    /// forwarded `start_session` of its, so guessing its ownership further
    /// would just strand a caller on a machine that no longer exists.
    pub fn remove(&self, machine_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(machine_id);
        drop(guard);
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, (owner, _)| owner != machine_id);
    }

    /// Replaces `machine_id`'s cached prompt list wholesale - `peer_link`'s
    /// fetch is always a full `list_pending_prompts` snapshot, same contract
    /// as `set_instances`. A no-op if the peer isn't a known mirror entry
    /// (e.g. it went offline between the fetch starting and finishing).
    pub fn set_prompts(&self, machine_id: &str, prompts: Vec<serde_json::Value>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = guard.get_mut(machine_id) {
            peer.prompts = prompts;
        }
    }

    /// Every cached mirrored prompt across every peer, merged into
    /// `list_pending_prompts`' local list by `methods::permission`.
    pub fn prompts(&self) -> Vec<serde_json::Value> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.values().flat_map(|p| p.prompts.clone()).collect()
    }

    /// Whether `machine_id`'s prompt cache currently holds anything - the
    /// "still non-empty, keep polling even without a fresh frame" half of
    /// `peer_link`'s refresh trigger.
    pub fn has_cached_prompts(&self, machine_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(machine_id).map(|p| !p.prompts.is_empty()).unwrap_or(false)
    }

    /// Whether any of `machine_id`'s currently-mirrored rows is awaiting
    /// input - the "something NEW might need a prompt fetch" half of
    /// `peer_link`'s refresh trigger.
    pub fn peer_has_awaiting(&self, machine_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(machine_id).map(|p| p.instances.iter().any(|i| i.awaiting.is_some())).unwrap_or(false)
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

    // ── pending-owner map (G2) ──────────────────────────────────────────────

    #[test]
    fn owner_of_resolves_a_pending_id_with_no_real_row_yet() {
        let m = MirrorState::new();
        m.record_pending("new-sid", "mach-b");
        assert_eq!(m.owner_of("new-sid").as_deref(), Some("mach-b"));
    }

    #[test]
    fn a_real_row_supersedes_a_pending_guess() {
        let m = MirrorState::new();
        // A stale/wrong guess (the pending entry was never promised to be
        // correct forever) must lose to the peer's own ground-truth row once
        // it broadcasts one, even naming a DIFFERENT machine.
        m.record_pending("sid-1", "mach-wrong");
        m.set_instances("mach-b", "Mac Mini", vec![fixture("sid-1", None)]);
        assert_eq!(m.owner_of("sid-1").as_deref(), Some("mach-b"));
    }

    #[test]
    fn a_pending_entry_older_than_the_ttl_is_pruned() {
        let m = MirrorState::new();
        m.record_pending("stale-sid", "mach-b");
        // Rewrite the insertion instant directly - same module, private field
        // reachable from this nested test module - rather than sleeping 2
        // real minutes in a unit test.
        {
            let mut pending = m.pending.lock().unwrap();
            pending.insert("stale-sid".to_string(), ("mach-b".to_string(), Instant::now() - PENDING_TTL - Duration::from_secs(1)));
        }
        assert_eq!(m.owner_of("stale-sid"), None);
    }

    #[test]
    fn remove_drops_pending_entries_naming_that_machine() {
        let m = MirrorState::new();
        m.record_pending("sid-1", "mach-b");
        m.remove("mach-b");
        assert_eq!(m.owner_of("sid-1"), None);
    }

    // ── mirrored prompt cache (G4) ───────────────────────────────────────────

    #[test]
    fn set_prompts_is_merged_by_prompts_and_tracked_by_has_cached_prompts() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![]);
        assert!(!m.has_cached_prompts("mach-b"));
        m.set_prompts("mach-b", vec![serde_json::json!({"id": "p1"})]);
        assert!(m.has_cached_prompts("mach-b"));
        assert_eq!(m.prompts(), vec![serde_json::json!({"id": "p1"})]);
    }

    #[test]
    fn going_offline_clears_the_prompt_cache() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![]);
        m.set_prompts("mach-b", vec![serde_json::json!({"id": "p1"})]);
        m.set_online("mach-b", false);
        assert!(!m.has_cached_prompts("mach-b"));
        assert!(m.prompts().is_empty());
    }

    #[test]
    fn peer_has_awaiting_reflects_the_cached_rows() {
        let m = MirrorState::new();
        let mut awaiting_row = fixture("s1", None);
        awaiting_row.awaiting = Some("question".into());
        m.set_instances("mach-b", "Mac Mini", vec![awaiting_row]);
        assert!(m.peer_has_awaiting("mach-b"));
        assert!(!m.peer_has_awaiting("mach-nonexistent"));
    }
}
