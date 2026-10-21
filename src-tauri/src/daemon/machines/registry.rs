//! Machine identity registry, persisted at `<app_data>/machines[suffix].json`.
//! Distinct from `device_registry.rs` (bearer tokens WE issue to callers): a
//! paired peer both presents a token to us (a `device_registry` entry there)
//! and holds one we present to it (`PeerMachine::token` here).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::util::secret_store;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SelfMachine {
    pub machine_id: String,
    pub label: String,
    #[serde(default)]
    pub os: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PeerMachine {
    pub machine_id: String,
    pub label: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub iroh_id: Option<String>,
    /// e.g. `http://127.0.0.1:27291`; used instead of iroh when present.
    #[serde(default)]
    pub direct_url: Option<String>,
    /// Bearer we present to THEM.
    pub token: String,
    /// Our `DeviceRegistry` entry that THEY present to us; revoked on unpair.
    #[serde(default)]
    pub reverse_device_id: Option<String>,
    #[serde(default)]
    pub added_at: u64,
}

/// `PeerMachine` with the bearer token stripped, for IPC/RPC responses.
#[derive(Serialize, Clone, Debug)]
pub struct PeerMachineView {
    pub machine_id: String,
    pub label: String,
    pub os: String,
    pub iroh_id: Option<String>,
    pub direct_url: Option<String>,
    pub reverse_device_id: Option<String>,
    pub added_at: u64,
    /// Whether this peer may drive chats it didn't start here
    /// (`MachineRegistry::can_drive`).
    pub can_drive: bool,
    /// How `peer_client::reach_url` would resolve this peer right now, for
    /// the machines list UI to show at a glance: `"direct"` (has a
    /// `direct_url`), `"iroh"` (no direct url but a known iroh id, so the
    /// dial-and-proxy path applies), or `"none"` (neither - unreachable).
    pub reach: &'static str,
}

/// Pure mirror of `peer_client::reach_url`'s branch order (direct wins,
/// iroh is the fallback), kept here rather than in `peer_client` so this view
/// type doesn't need to depend on the async, `DaemonState`-threading module.
pub fn reach_kind(peer: &PeerMachine) -> &'static str {
    if peer.direct_url.is_some() {
        "direct"
    } else if peer.iroh_id.is_some() {
        "iroh"
    } else {
        "none"
    }
}

impl PeerMachineView {
    /// Built through the registry, not a bare `From<&PeerMachine>`, because
    /// `can_drive` lives on `MachinesFile` beside the peer list.
    fn new(p: &PeerMachine, can_drive: bool) -> Self {
        Self {
            machine_id: p.machine_id.clone(),
            label: p.label.clone(),
            os: p.os.clone(),
            iroh_id: p.iroh_id.clone(),
            direct_url: p.direct_url.clone(),
            reverse_device_id: p.reverse_device_id.clone(),
            added_at: p.added_at,
            can_drive,
            reach: reach_kind(p),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MachinesFile {
    #[serde(rename = "self", default)]
    pub self_: Option<SelfMachine>,
    #[serde(default)]
    pub peers: Vec<PeerMachine>,
    /// Peers whose "can drive this PC's chats" switch is off: they still see
    /// every chat, but may only drive the ones they started here
    /// (`machines::peer_scope`). Kept apart from `PeerMachine` so absence
    /// means the default (on), and a re-pair keeps the owner's choice.
    #[serde(default)]
    pub view_only_peers: Vec<String>,
}

fn registry_path(app_data: &Path) -> PathBuf {
    let suffix = crate::daemon::instance::instance_suffix();
    app_data.join(format!("machines{suffix}.json"))
}

/// Used by the pairing flow (`daemon::methods::machines`) to stamp
/// `PeerMachine::added_at`, and by the `mk_peer` test fixture below.
pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hostname_label() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "this machine".to_string())
}

/// Owns this daemon's machine identity plus its paired peers, backed by one
/// JSON file. Never panics on a missing/corrupt file: falls back to Default.
pub struct MachineRegistry {
    app_data: PathBuf,
    inner: Mutex<MachinesFile>,
}

impl MachineRegistry {
    pub fn load(app_data: &Path) -> Self {
        let mut inner: MachinesFile = std::fs::read_to_string(registry_path(app_data))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut legacy_plaintext = false;
        for peer in inner.peers.iter_mut().filter(|p| !p.token.is_empty()) {
            legacy_plaintext |= secret_store::needs_migration(&peer.token);
            match secret_store::unprotect(&peer.token) {
                Ok(plain) => peer.token = plain,
                // Left in its wrapped form: it authenticates nothing, the peer
                // just needs re-pairing, and `save` will not wrap it twice.
                Err(e) => log::warn!("machines: token for peer {} unreadable: {e}", peer.machine_id),
            }
        }
        let reg = Self { app_data: app_data.to_path_buf(), inner: Mutex::new(inner) };
        if legacy_plaintext {
            let guard = reg.inner.lock().unwrap_or_else(|e| e.into_inner());
            reg.save(&guard);
        }
        reg
    }

    /// Peer tokens are wrapped on the way to disk (`util::secret_store`); the
    /// in-memory file always holds them plain.
    fn save(&self, file: &MachinesFile) {
        let mut on_disk = file.clone();
        for peer in on_disk.peers.iter_mut().filter(|p| !p.token.is_empty()) {
            match secret_store::protect(&peer.token) {
                Ok(wrapped) => peer.token = wrapped,
                Err(e) => {
                    log::error!("machines: not persisting registry, could not protect a peer token: {e}");
                    return;
                }
            }
        }
        let Ok(body) = serde_json::to_string_pretty(&on_disk) else { return };
        if let Err(e) = crate::util::write_json_atomic(&registry_path(&self.app_data), &body) {
            log::warn!("machines: failed to persist registry: {e}");
        }
    }

    /// Mints and persists this daemon's identity (endpoint id + hostname) on
    /// first call; idempotent after that.
    pub fn ensure_self(&self) -> SelfMachine {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = &guard.self_ {
            return existing.clone();
        }
        let secret = crate::daemon::iroh_tunnel::load_or_create_secret(&self.app_data);
        let mine = SelfMachine {
            machine_id: secret.public().to_string(),
            label: hostname_label(),
            os: std::env::consts::OS.to_string(),
        };
        guard.self_ = Some(mine.clone());
        self.save(&guard);
        mine
    }

    pub fn self_machine(&self) -> Option<SelfMachine> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).self_.clone()
    }

    /// The `app_data` dir this registry was loaded from, so a pairing RPC
    /// handler can reach `DeviceRegistry` without threading a second
    /// `app_data` param through every `register_*` call site.
    pub fn app_data(&self) -> &Path {
        &self.app_data
    }

    pub fn set_label(&self, label: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = guard.self_.as_mut() {
            m.label = label.to_string();
        }
        self.save(&guard);
    }

    pub fn peers(&self) -> Vec<PeerMachine> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).peers.clone()
    }

    pub fn peer(&self, machine_id: &str) -> Option<PeerMachine> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .peers
            .iter()
            .find(|p| p.machine_id == machine_id)
            .cloned()
    }

    /// Exact id match first, then a case-insensitive label match. A label
    /// matching more than one peer resolves to `None` (ambiguous).
    pub fn find_peer(&self, label_or_id: &str) -> Option<PeerMachine> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = guard.peers.iter().find(|p| p.machine_id == label_or_id) {
            return Some(p.clone());
        }
        let mut matches = guard.peers.iter().filter(|p| p.label.eq_ignore_ascii_case(label_or_id));
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(first.clone())
    }

    pub fn upsert_peer(&self, peer: PeerMachine) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.peers.iter_mut().find(|p| p.machine_id == peer.machine_id) {
            *existing = peer;
        } else {
            guard.peers.push(peer);
        }
        self.save(&guard);
    }

    pub fn remove_peer(&self, machine_id: &str) -> Option<PeerMachine> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let idx = guard.peers.iter().position(|p| p.machine_id == machine_id)?;
        let removed = guard.peers.remove(idx);
        guard.view_only_peers.retain(|id| id != machine_id);
        self.save(&guard);
        Some(removed)
    }

    /// `peer` as the token-free view list/pair responses carry.
    pub fn view(&self, peer: &PeerMachine) -> PeerMachineView {
        PeerMachineView::new(peer, self.can_drive(&peer.machine_id))
    }

    /// Whether `machine_id` may drive chats it did not start here. True for
    /// every peer unless the owner switched it off.
    pub fn can_drive(&self, machine_id: &str) -> bool {
        !self.inner.lock().unwrap_or_else(|e| e.into_inner()).view_only_peers.iter().any(|id| id == machine_id)
    }

    /// Flips a paired peer's "can drive this PC's chats" switch. Returns
    /// false (and stores nothing) for an id that isn't a paired peer.
    pub fn set_can_drive(&self, machine_id: &str, value: bool) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.peers.iter().any(|p| p.machine_id == machine_id) {
            return false;
        }
        guard.view_only_peers.retain(|id| id != machine_id);
        if !value {
            guard.view_only_peers.push(machine_id.to_string());
        }
        self.save(&guard);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn mk_peer(id: &str, label: &str) -> PeerMachine {
        PeerMachine {
            machine_id: id.into(),
            label: label.into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: now_secs(),
        }
    }

    fn raw_file(dir: &Path) -> String {
        std::fs::read_to_string(registry_path(dir)).unwrap()
    }

    #[test]
    fn peer_token_is_not_plaintext_on_disk_where_wrapping_exists() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        let mut peer = mk_peer("peer1", "Mac Mini");
        peer.token = "dummy-bearer-value".into();
        reg.upsert_peer(peer);
        assert_eq!(raw_file(dir.path()).contains("dummy-bearer-value"), !secret_store::WRAPS_AT_REST);
        let reloaded = MachineRegistry::load(dir.path());
        assert_eq!(reloaded.peer("peer1").unwrap().token, "dummy-bearer-value");
    }

    #[test]
    fn legacy_plaintext_peer_token_loads_and_is_rewritten_wrapped() {
        let dir = tempdir().unwrap();
        let legacy = serde_json::json!({
            "peers": [{ "machine_id": "p1", "label": "Old", "token": "legacy-bearer" }]
        });
        std::fs::write(registry_path(dir.path()), legacy.to_string()).unwrap();
        let reg = MachineRegistry::load(dir.path());
        assert_eq!(reg.peer("p1").unwrap().token, "legacy-bearer");
        assert_eq!(raw_file(dir.path()).contains("legacy-bearer"), !secret_store::WRAPS_AT_REST);
        assert_eq!(MachineRegistry::load(dir.path()).peer("p1").unwrap().token, "legacy-bearer");
    }

    #[test]
    fn undecryptable_peer_token_does_not_panic_or_get_double_wrapped() {
        let dir = tempdir().unwrap();
        let broken = format!("{}AAAAAAAAAAAAAAAA", secret_store::PREFIX);
        let file = serde_json::json!({ "peers": [{ "machine_id": "p1", "label": "X", "token": broken }] });
        std::fs::write(registry_path(dir.path()), file.to_string()).unwrap();
        let reg = MachineRegistry::load(dir.path());
        assert_eq!(reg.peer("p1").unwrap().token, broken, "kept verbatim so a later save cannot destroy it");
        reg.set_can_drive("p1", false);
        assert!(raw_file(dir.path()).contains(&broken));
    }

    #[test]
    fn ensure_self_is_idempotent() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        let a = reg.ensure_self();
        let b = reg.ensure_self();
        assert_eq!(a.machine_id, b.machine_id);
    }

    #[test]
    fn round_trip_persists_across_loads() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        let mine = reg.ensure_self();
        reg.upsert_peer(mk_peer("peer1", "Mac Mini"));

        let reg2 = MachineRegistry::load(dir.path());
        assert_eq!(reg2.self_machine().unwrap().machine_id, mine.machine_id);
        assert_eq!(reg2.peers().len(), 1);
        assert_eq!(reg2.peer("peer1").unwrap().label, "Mac Mini");
    }

    #[test]
    fn find_peer_by_id_or_case_insensitive_label() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        reg.upsert_peer(mk_peer("id1", "Mac Mini"));
        assert!(reg.find_peer("id1").is_some());
        assert!(reg.find_peer("mac mini").is_some());
        assert!(reg.find_peer("nope").is_none());
    }

    #[test]
    fn find_peer_ambiguous_label_returns_none() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        reg.upsert_peer(mk_peer("id1", "Mac"));
        reg.upsert_peer(mk_peer("id2", "mac"));
        assert!(reg.find_peer("mac").is_none());
    }

    #[test]
    fn remove_peer_deletes_and_returns_it() {
        let dir = tempdir().unwrap();
        let reg = MachineRegistry::load(dir.path());
        reg.upsert_peer(mk_peer("id1", "Mac"));
        let removed = reg.remove_peer("id1").unwrap();
        assert_eq!(removed.machine_id, "id1");
        assert!(reg.peers().is_empty());
        assert!(reg.remove_peer("id1").is_none());
    }

    #[test]
    fn reach_kind_prefers_direct_over_iroh() {
        let mut p = mk_peer("id1", "Mac");
        p.direct_url = Some("http://127.0.0.1:9999".into());
        p.iroh_id = Some("deadbeef".into());
        assert_eq!(reach_kind(&p), "direct");
    }

    #[test]
    fn reach_kind_falls_back_to_iroh() {
        let mut p = mk_peer("id1", "Mac");
        p.direct_url = None;
        p.iroh_id = Some("deadbeef".into());
        assert_eq!(reach_kind(&p), "iroh");
    }

    #[test]
    fn reach_kind_none_when_neither_is_set() {
        let p = mk_peer("id1", "Mac");
        assert_eq!(reach_kind(&p), "none");
    }

    #[test]
    fn corrupt_file_loads_as_default() {
        let dir = tempdir().unwrap();
        std::fs::write(registry_path(dir.path()), "not json").unwrap();
        let reg = MachineRegistry::load(dir.path());
        assert!(reg.self_machine().is_none());
        assert!(reg.peers().is_empty());
    }
}
