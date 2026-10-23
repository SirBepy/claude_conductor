//! In-memory cache of every OTHER paired machine's instance list, kept
//! current by `peer_link::spawn_link`'s WS subscription. Never persisted:
//! a fresh daemon starts with an empty mirror and repopulates within one
//! `instances_changed` frame of each link reconnecting.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::types::{Instance, MachineRef};

/// A pending-owner entry older than this is treated as stale and dropped on
/// next lookup rather than trusted forever - a peer that silently failed to
/// ever report the session back (crashed before its next broadcast, or the
/// id was never real) must not pin a phantom owner indefinitely.
const PENDING_TTL: Duration = Duration::from_secs(120);

/// Most rows (and prompts) kept per peer. A paired peer is trusted to pair,
/// not to size our memory: an unbounded snapshot would be cloned on every
/// `instances()` call.
const MAX_ROWS_PER_PEER: usize = 500;

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
    /// `start_session`'s forwarded-id bridge: the owning peer's
    /// `instances_changed` broadcast can take up to one mirror-link cycle to
    /// report a chat it just spawned for us, so `forward_start_session`
    /// records the id here the instant the peer's RPC response names it.
    /// `owner_of` consults this only after the real mirrored rows come up
    /// empty, and `set_instances` retires an entry the moment a real row for
    /// that id arrives.
    pending: Mutex<HashMap<String, (String, Instant)>>,
    /// Each peer's own hidden-chat session ids, as that peer last reported
    /// them. Kept apart from `inner` because the hidden list can arrive
    /// before the peer's first `instances_changed` frame creates its entry.
    /// Raw on purpose: `hidden_sessions` is where ownership filters it.
    hidden: Mutex<HashMap<String, Vec<String>>>,
    /// Last-known `machine_id -> hosted session ids`, kept on disk. The row
    /// cache above is memory only, so right after a daemon restart (before a
    /// peer's link reconnects) a mirrored chat's id resolves to nobody and a
    /// send falls through to the LOCAL handler, which then tries to resume a
    /// chat whose transcript and folder live on the peer. This is what keeps
    /// such a send routed at the peer (and failing "offline" until its link is up).
    ownership: Mutex<Ownership>,
}

#[derive(Default)]
struct Ownership {
    /// `None` until `attach_ownership_store`: a bare `MirrorState` (tests, a
    /// daemon before `init_machines`) records in memory only.
    path: Option<PathBuf>,
    hosted: HashMap<String, HashSet<String>>,
}

#[derive(Serialize, Deserialize, Default)]
struct OwnershipFile {
    #[serde(default)]
    hosted: HashMap<String, Vec<String>>,
}

fn ownership_path(app_data: &Path) -> PathBuf {
    let suffix = crate::daemon::instance::instance_suffix();
    app_data.join(format!("mirror-owners{suffix}.json"))
}

impl Ownership {
    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let file = OwnershipFile {
            hosted: self
                .hosted
                .iter()
                .map(|(machine, ids)| {
                    let mut ids: Vec<String> = ids.iter().cloned().collect();
                    ids.sort();
                    (machine.clone(), ids)
                })
                .collect(),
        };
        let Ok(body) = serde_json::to_string(&file) else { return };
        if let Err(e) = crate::util::write_json_atomic(path, &body) {
            log::warn!("mirror: failed to persist session ownership: {e}");
        }
    }
}

impl MirrorState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            hidden: Mutex::new(HashMap::new()),
            ownership: Mutex::new(Ownership::default()),
        }
    }

    /// Loads the persisted ownership record from `app_data` and starts
    /// persisting future changes there. Entries for a machine `is_paired`
    /// rejects (unpaired while the daemon was down) are dropped, and each
    /// machine is capped like its live row cache.
    pub fn attach_ownership_store(&self, app_data: &Path, is_paired: impl Fn(&str) -> bool) {
        let path = ownership_path(app_data);
        let file: OwnershipFile = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut guard = self.ownership.lock().unwrap_or_else(|e| e.into_inner());
        guard.hosted = file
            .hosted
            .into_iter()
            .filter(|(machine, _)| is_paired(machine))
            .map(|(machine, ids)| (machine, ids.into_iter().take(MAX_ROWS_PER_PEER).collect()))
            .collect();
        guard.path = Some(path);
    }

    /// The machine the persisted record says hosts `session_id`. Only a
    /// fallback for `machines::mirrored_owner` once the live rows and the
    /// pending map have nothing: it can lag a peer's real state by a restart.
    pub fn recorded_owner(&self, session_id: &str) -> Option<String> {
        let guard = self.ownership.lock().unwrap_or_else(|e| e.into_inner());
        guard.hosted.iter().find(|(_, ids)| ids.contains(session_id)).map(|(machine, _)| machine.clone())
    }

    fn record_hosted(&self, machine_id: &str, ids: HashSet<String>) {
        let mut guard = self.ownership.lock().unwrap_or_else(|e| e.into_inner());
        if guard.hosted.get(machine_id) == Some(&ids) {
            return;
        }
        guard.hosted.insert(machine_id.to_string(), ids);
        guard.persist();
    }

    /// Replaces `machine_id`'s reported hidden session ids. Capped like the
    /// row cache, since a paired peer is trusted to pair, not to size our memory.
    pub fn set_hidden_sessions(&self, machine_id: &str, mut ids: Vec<String>) {
        ids.truncate(MAX_ROWS_PER_PEER);
        let mut guard = self.hidden.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(machine_id.to_string(), ids);
    }

    /// Applies a hide/unhide we just forwarded to the owner, so the sidebar
    /// reflects it before the owner's own `hidden_chats_changed` frame comes
    /// back over the link.
    pub fn apply_hidden_delta(&self, machine_id: &str, add: &[String], remove: &[String]) {
        let mut guard = self.hidden.lock().unwrap_or_else(|e| e.into_inner());
        let ids = guard.entry(machine_id.to_string()).or_default();
        ids.retain(|id| !remove.contains(id));
        for id in add {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }

    /// Hidden session ids that a peer reports AND hosts (a mirrored row of
    /// that same peer exists), sorted. The ownership test is what stops two
    /// daemons that mirror each other from keeping a chat hidden forever on
    /// the strength of each other's echo after the owner unhid it.
    pub fn hidden_sessions(&self) -> Vec<String> {
        let hidden = self.hidden.lock().unwrap_or_else(|e| e.into_inner());
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<String> = hidden
            .iter()
            .filter_map(|(machine_id, ids)| inner.get(machine_id).map(|peer| (ids, peer)))
            .flat_map(|(ids, peer)| ids.iter().filter(|id| peer.instances.iter().any(|i| &i.session_id == *id)).cloned())
            .collect();
        out.sort();
        out.dedup();
        out
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

    /// Which machine hosts `session_id`, if it is a mirrored row. Knows
    /// nothing about local sessions, so routing code calls
    /// `machines::mirrored_owner` (local registry first) instead. Falls back
    /// to the pending-owner map for an id too new to have appeared in a
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
    ///
    /// Returns whether the peer's cached view actually changed (a new peer
    /// entry, an online transition, or the filtered rows differing from what
    /// was already cached) - `peer_link::handle_frame` uses this to decide
    /// whether to re-publish `instances_changed` locally. Without it, two
    /// daemons each mirroring the other form a feedback loop: A republishes
    /// B's unchanged frame, which reaches B's link and makes B republish,
    /// forever, bounded only by round-trip latency.
    pub fn set_instances(&self, machine_id: &str, label: &str, rows: Vec<Instance>) -> bool {
        let mut rows: Vec<Instance> = rows.into_iter().filter(|i| i.machine.is_none()).collect();
        if rows.len() > MAX_ROWS_PER_PEER {
            log::warn!("mirror: peer {machine_id} sent {} rows, keeping {MAX_ROWS_PER_PEER}", rows.len());
            rows.truncate(MAX_ROWS_PER_PEER);
        }
        // A real row for an id just superseded any pending-owner guess for
        // it - whether that guess named this machine or (in theory) a stale
        // one, the freshly-reported row is ground truth now.
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            for row in &rows {
                pending.remove(&row.session_id);
            }
        }
        // A snapshot only ever arrives over a live link, so replacing the
        // record wholesale is what retires a session the peer no longer
        // reports; going offline (`set_online`) never touches it.
        let hosted: HashSet<String> = rows.iter().map(|r| r.session_id.clone()).collect();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let prev = guard.get(machine_id);
        let changed = match prev {
            None => true,
            Some(p) => !p.online || p.instances != rows,
        };
        let prompts = prev.map(|p| p.prompts.clone()).unwrap_or_default();
        guard.insert(machine_id.to_string(), MirroredPeer { label: label.to_string(), online: true, instances: rows, prompts });
        drop(guard);
        self.record_hosted(machine_id, hosted);
        changed
    }

    /// Flips the online flag without touching the cached rows - a dropped
    /// link keeps showing its last-known state, just grayed as offline,
    /// same contract session status elsewhere in this codebase already uses.
    /// Going offline DOES clear the prompt cache: an unreachable peer
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
    /// this machine: once it's gone, nothing can ever confirm a
    /// forwarded `start_session` of its, so guessing its ownership further
    /// would just strand a caller on a machine that no longer exists.
    pub fn remove(&self, machine_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(machine_id);
        drop(guard);
        self.hidden.lock().unwrap_or_else(|e| e.into_inner()).remove(machine_id);
        {
            let mut owners = self.ownership.lock().unwrap_or_else(|e| e.into_inner());
            if owners.hosted.remove(machine_id).is_some() {
                owners.persist();
            }
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, (owner, _)| owner != machine_id);
    }

    /// Replaces `machine_id`'s cached prompt list wholesale - `peer_link`'s
    /// fetch is always a full `list_pending_prompts` snapshot, same contract
    /// as `set_instances`. A no-op if the peer isn't a known mirror entry
    /// (e.g. it went offline between the fetch starting and finishing).
    pub fn set_prompts(&self, machine_id: &str, mut prompts: Vec<serde_json::Value>) {
        prompts.truncate(MAX_ROWS_PER_PEER);
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

    /// Evicts one prompt from `machine_id`'s cached list right after a
    /// successfully forwarded answer (`forward.rs::forward_one`), instead of
    /// waiting for `peer_link`'s next refresh (the next `instances_changed`
    /// frame, or its 2s tick) - a caller polling `list_pending_prompts` in
    /// that window would otherwise see the already-answered prompt resurface.
    pub fn drop_prompt(&self, machine_id: &str, request_id: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = guard.get_mut(machine_id) {
            peer.prompts.retain(|p| p["id"].as_str() != Some(request_id));
        }
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

    fn restarted(dir: &std::path::Path, paired: &[&str]) -> MirrorState {
        let m = MirrorState::new();
        m.attach_ownership_store(dir, |id| paired.contains(&id));
        m
    }

    /// What lets a send for a peer's chat still find the peer after a restart,
    /// while the live mirror is empty.
    #[test]
    fn ownership_record_survives_a_restart_and_follows_the_peers_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        let m = restarted(dir.path(), &["mach-b"]);
        m.set_instances("mach-b", "B", vec![fixture(&a, None), fixture(&b, None)]);

        let after = restarted(dir.path(), &["mach-b"]);
        assert!(after.owner_of(&a).is_none(), "the live rows are memory only");
        assert_eq!(after.recorded_owner(&a).as_deref(), Some("mach-b"));
        assert_eq!(after.recorded_owner(&b).as_deref(), Some("mach-b"));
        assert_eq!(after.recorded_owner("never-seen"), None);

        // The next snapshot (link online) is the truth: a chat the peer no
        // longer reports is retired from the record.
        after.set_instances("mach-b", "B", vec![fixture(&b, None)]);
        let again = restarted(dir.path(), &["mach-b"]);
        assert_eq!(again.recorded_owner(&a), None);
        assert_eq!(again.recorded_owner(&b).as_deref(), Some("mach-b"));
    }

    /// A dropped link keeps the rows greyed and the record intact: only a
    /// snapshot received over a live link may retire a session.
    #[test]
    fn going_offline_keeps_the_ownership_record() {
        let dir = tempfile::tempdir().unwrap();
        let a = uuid::Uuid::new_v4().to_string();
        let m = restarted(dir.path(), &["mach-b"]);
        m.set_instances("mach-b", "B", vec![fixture(&a, None)]);
        m.set_online("mach-b", false);
        assert_eq!(m.recorded_owner(&a).as_deref(), Some("mach-b"));
        assert_eq!(restarted(dir.path(), &["mach-b"]).recorded_owner(&a).as_deref(), Some("mach-b"));
    }

    #[test]
    fn unpairing_or_a_missing_pairing_drops_the_ownership_record() {
        let dir = tempfile::tempdir().unwrap();
        let a = uuid::Uuid::new_v4().to_string();
        let m = restarted(dir.path(), &["mach-b", "mach-c"]);
        m.set_instances("mach-b", "B", vec![fixture(&a, None)]);
        m.set_instances("mach-c", "C", vec![fixture("c-1", None)]);

        // Unpaired while the daemon was down: not loaded back.
        let after = restarted(dir.path(), &["mach-c"]);
        assert_eq!(after.recorded_owner(&a), None);
        assert_eq!(after.recorded_owner("c-1").as_deref(), Some("mach-c"));

        // Unpaired live: removed now and on disk.
        m.remove("mach-b");
        assert_eq!(m.recorded_owner(&a), None);
        assert_eq!(restarted(dir.path(), &["mach-b", "mach-c"]).recorded_owner(&a), None);
    }

    #[test]
    fn ownership_record_is_capped_per_peer_and_tolerates_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let m = restarted(dir.path(), &["mach-b"]);
        let rows: Vec<Instance> = (0..MAX_ROWS_PER_PEER + 50).map(|i| fixture(&format!("s{i}"), None)).collect();
        m.set_instances("mach-b", "B", rows);
        let file: OwnershipFile =
            serde_json::from_str(&std::fs::read_to_string(ownership_path(dir.path())).unwrap()).unwrap();
        assert_eq!(file.hosted["mach-b"].len(), MAX_ROWS_PER_PEER);

        std::fs::write(ownership_path(dir.path()), "{not json").unwrap();
        assert_eq!(restarted(dir.path(), &["mach-b"]).recorded_owner("s0"), None);
    }

    #[test]
    fn set_instances_and_prompts_are_capped_per_peer() {
        let m = MirrorState::new();
        let rows: Vec<Instance> = (0..MAX_ROWS_PER_PEER + 50).map(|i| fixture(&format!("s{i}"), None)).collect();
        m.set_instances("peer-a", "A", rows);
        assert_eq!(m.instances().len(), MAX_ROWS_PER_PEER);
        assert!(m.owner_of(&format!("s{}", MAX_ROWS_PER_PEER + 1)).is_none(), "rows past the cap are dropped");
        m.set_prompts("peer-a", vec![serde_json::json!({}); MAX_ROWS_PER_PEER + 10]);
        assert_eq!(m.prompts().len(), MAX_ROWS_PER_PEER);
        // The cap is per peer, not shared.
        m.set_instances("peer-b", "B", vec![fixture("b0", None)]);
        assert_eq!(m.instances().len(), MAX_ROWS_PER_PEER + 1);
    }

    #[test]
    fn hidden_sessions_keep_only_ids_the_reporting_peer_hosts() {
        let m = MirrorState::new();
        m.set_instances("peer-a", "A", vec![fixture("a1", None)]);
        m.set_instances("peer-b", "B", vec![fixture("b1", None)]);
        // B reports an id of A's chat (an echo of a hide made via A) and A an
        // id it does not host: neither may hold a chat hidden on its own say.
        m.set_hidden_sessions("peer-a", vec!["a1".into(), "ghost".into()]);
        m.set_hidden_sessions("peer-b", vec!["a1".into(), "b1".into()]);
        assert_eq!(m.hidden_sessions(), vec!["a1".to_string(), "b1".to_string()]);
        m.set_hidden_sessions("peer-a", Vec::new());
        m.set_hidden_sessions("peer-b", vec!["b1".into()]);
        assert_eq!(m.hidden_sessions(), vec!["b1".to_string()], "unhiding on the host clears it despite a stale echo");
    }

    #[test]
    fn removing_a_peer_drops_its_hidden_ids() {
        let m = MirrorState::new();
        m.set_instances("peer-a", "A", vec![fixture("a1", None)]);
        m.set_hidden_sessions("peer-a", vec!["a1".into()]);
        m.remove("peer-a");
        m.set_instances("peer-a", "A", vec![fixture("a1", None)]);
        assert!(m.hidden_sessions().is_empty());
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
    fn set_instances_reports_change_only_when_the_view_actually_differs() {
        let m = MirrorState::new();
        assert!(m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]), "a brand new peer entry is always a change");
        assert!(!m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None)]), "an identical re-delivery of the same snapshot is not a change");
        assert!(m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None), fixture("s2", None)]), "a differing row set is a change");
        m.set_online("mach-b", false);
        assert!(m.set_instances("mach-b", "Mac Mini", vec![fixture("s1", None), fixture("s2", None)]), "coming back online with the same rows is still a change");
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

    // ── pending-owner map ────────────────────────────────────────────────────

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

    // ── mirrored prompt cache ────────────────────────────────────────────────

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
    fn drop_prompt_evicts_only_the_matching_id() {
        let m = MirrorState::new();
        m.set_instances("mach-b", "Mac Mini", vec![]);
        m.set_prompts("mach-b", vec![serde_json::json!({"id": "p1"}), serde_json::json!({"id": "p2"})]);
        m.drop_prompt("mach-b", "p1");
        assert_eq!(m.prompts(), vec![serde_json::json!({"id": "p2"})]);
    }

    #[test]
    fn drop_prompt_on_an_unknown_machine_or_id_is_a_no_op() {
        let m = MirrorState::new();
        m.drop_prompt("mach-nonexistent", "p1"); // no entry at all - must not panic
        m.set_instances("mach-b", "Mac Mini", vec![]);
        m.set_prompts("mach-b", vec![serde_json::json!({"id": "p1"})]);
        m.drop_prompt("mach-b", "no-such-id");
        assert_eq!(m.prompts(), vec![serde_json::json!({"id": "p1"})]);
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
