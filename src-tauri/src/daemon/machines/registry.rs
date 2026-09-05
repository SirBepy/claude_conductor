//! Machine identity registry, persisted at `<app_data>/machines[suffix].json`.
//! Distinct from `device_registry.rs` (bearer tokens WE issue to callers): a
//! paired peer both presents a token to us (a `device_registry` entry there)
//! and holds one we present to it (`PeerMachine::token` here).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

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
}

impl From<&PeerMachine> for PeerMachineView {
    fn from(p: &PeerMachine) -> Self {
        Self {
            machine_id: p.machine_id.clone(),
            label: p.label.clone(),
            os: p.os.clone(),
            iroh_id: p.iroh_id.clone(),
            direct_url: p.direct_url.clone(),
            reverse_device_id: p.reverse_device_id.clone(),
            added_at: p.added_at,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MachinesFile {
    #[serde(rename = "self", default)]
    pub self_: Option<SelfMachine>,
    #[serde(default)]
    pub peers: Vec<PeerMachine>,
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
        let inner = std::fs::read_to_string(registry_path(app_data))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { app_data: app_data.to_path_buf(), inner: Mutex::new(inner) }
    }

    fn save(&self, file: &MachinesFile) {
        let Ok(body) = serde_json::to_string_pretty(file) else { return };
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
        self.save(&guard);
        Some(removed)
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
    fn corrupt_file_loads_as_default() {
        let dir = tempdir().unwrap();
        std::fs::write(registry_path(dir.path()), "not json").unwrap();
        let reg = MachineRegistry::load(dir.path());
        assert!(reg.self_machine().is_none());
        assert!(reg.peers().is_empty());
    }
}
