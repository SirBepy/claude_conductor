//! Owns one live `peer_link::spawn_link` task per paired peer, keyed by
//! `machine_id`. `sync_links` is idempotent - safe to call after every
//! pairing mutation (pair/unpair/peer-initiated unpair) and once at daemon
//! startup, so the link set never drifts from `MachineRegistry::peers()`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{watch, Notify};

use crate::daemon::state::DaemonState;

use super::registry::PeerMachine;

/// Most a "is this peer really offline?" probe may take: one cold iroh dial
/// (`iroh_dial::DIAL_TIMEOUT`, 30s) plus a health round trip on the fresh
/// connection. A caller still sees "<label> is offline" when it elapses, so
/// this is also the longest an action on a dead peer can hang.
const PROBE_BOUND: Duration = Duration::from_secs(35);

/// Most a caller waits on that probe before it is refused; the probe itself
/// runs on to `PROBE_BOUND` without it. A peer that is back answers a cold
/// dial well inside this, and a peer that is asleep must not hold a request
/// for the whole dial: the phone gives a read 15s (`READ_TIMEOUT_MS` in
/// `http-transport.ts`) and reports a link failure after it, so a 30s hold on
/// a request about a sleeping Mac read as "Reconnecting to your PC" there.
const PROBE_WAIT: Duration = Duration::from_secs(4);

type ProbeOutcome = Result<(), String>;

/// A probe in flight: when it began and where its outcome lands.
struct RunningProbe {
    started: tokio::time::Instant,
    done: watch::Receiver<Option<ProbeOutcome>>,
}

/// Takes the finished probe out of the hub when its task ends, a panic included,
/// so the next offline caller asks afresh instead of joining a dead entry.
struct RetireProbe {
    state: Arc<DaemonState>,
    machine_id: String,
}

impl Drop for RetireProbe {
    fn drop(&mut self) {
        self.state.hub.probes.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.machine_id);
    }
}

pub struct MachineHub {
    links: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// Per-peer wake handle for that peer's `peer_link` task: notifying it cuts
    /// the task's reconnect backoff short.
    wakes: Mutex<HashMap<String, Arc<Notify>>>,
    /// The probe currently running for a peer, shared by every caller that
    /// finds the peer marked offline meanwhile: a failed probe is also handed
    /// to everyone who queued behind it, instead of each waiter running its own
    /// 35s probe in turn. It runs in its own task, so a caller that stops
    /// waiting (`PROBE_WAIT`) does not cancel it.
    probes: Mutex<HashMap<String, RunningProbe>>,
    /// Milliseconds; an atomic only so a test can shorten it on the hub already
    /// inside a built `DaemonState`.
    probe_bound_ms: AtomicU64,
    /// Milliseconds, for the same reason.
    probe_wait_ms: AtomicU64,
    /// What the settings sync last sent (`machines::settings_sync`).
    pub(crate) settings_sync: Arc<super::settings_sync::SyncState>,
}

impl MachineHub {
    pub fn new() -> Self {
        Self {
            links: Mutex::new(HashMap::new()),
            wakes: Mutex::new(HashMap::new()),
            probes: Mutex::new(HashMap::new()),
            probe_bound_ms: AtomicU64::new(PROBE_BOUND.as_millis() as u64),
            probe_wait_ms: AtomicU64::new(PROBE_WAIT.as_millis() as u64),
            settings_sync: Default::default(),
        }
    }

    fn probe_bound(&self) -> Duration {
        Duration::from_millis(self.probe_bound_ms.load(Ordering::Relaxed))
    }

    #[cfg(test)]
    pub(crate) fn set_probe_bound(&self, bound: Duration) {
        self.probe_bound_ms.store(bound.as_millis() as u64, Ordering::Relaxed);
    }

    fn probe_wait(&self) -> Duration {
        Duration::from_millis(self.probe_wait_ms.load(Ordering::Relaxed))
    }

    #[cfg(test)]
    pub(crate) fn set_probe_wait(&self, wait: Duration) {
        self.probe_wait_ms.store(wait.as_millis() as u64, Ordering::Relaxed);
    }

    /// The wake handle `peer_link` sleeps on between reconnect attempts.
    pub(super) fn wake_handle(&self, machine_id: &str) -> Arc<Notify> {
        self.wakes.lock().unwrap_or_else(|e| e.into_inner()).entry(machine_id.to_string()).or_default().clone()
    }

    /// Makes `machine_id`'s link retry its connection now rather than after its
    /// backoff. `Notify` stores one permit, so a wake that lands while the link
    /// is mid-connect makes its NEXT pause return at once: one extra quick retry.
    pub(crate) fn wake(&self, machine_id: &str) {
        self.wake_handle(machine_id).notify_one();
    }

    /// The mirror's "offline" flag is only as fresh as the link's last failed
    /// connect, and a link backs off up to 30s between tries, so it routinely
    /// outlives the peer's return. Before a caller refuses an action on that
    /// word, ask the peer: a health probe over a freshly dialed path. On
    /// success the peer is marked online and its link is woken to reconnect
    /// immediately. Concurrent callers share one probe; it is bounded by
    /// `probe_bound` (`PROBE_BOUND`).
    ///
    /// A caller waits for the answer only until the probe is `probe_wait`
    /// (`PROBE_WAIT`) old, then is refused while the probe runs on. So a peer
    /// that is asleep costs the first caller that wait and later callers
    /// nothing, and a peer that answers late is still marked online for the
    /// caller's next try.
    pub(crate) async fn probe_offline_peer(state: &Arc<DaemonState>, peer: &PeerMachine) -> Result<(), String> {
        let (started, mut done) = {
            let mut probes = state.hub.probes.lock().unwrap_or_else(|e| e.into_inner());
            let running = probes.entry(peer.machine_id.clone()).or_insert_with(|| {
                let (tx, rx) = watch::channel(None);
                let (state, peer) = (state.clone(), peer.clone());
                tokio::spawn(async move {
                    let retire = RetireProbe { state: state.clone(), machine_id: peer.machine_id.clone() };
                    let outcome = Self::probe(&state, &peer).await;
                    if outcome.is_ok() {
                        state.mirror.set_online(&peer.machine_id, true);
                        super::publish_instances_changed(&state);
                        state.hub.wake(&peer.machine_id);
                    }
                    // Retired before the outcome is sent: a stale failure must not
                    // answer for a peer that may be back by the next call.
                    drop(retire);
                    let _ = tx.send(Some(outcome));
                });
                RunningProbe { started: tokio::time::Instant::now(), done: rx }
            });
            (running.started, running.done.clone())
        };
        let wait = state.hub.probe_wait();
        let answered = tokio::time::timeout_at(started + wait, done.wait_for(|outcome| outcome.is_some())).await;
        match answered {
            Ok(Ok(outcome)) => outcome.clone().unwrap_or_else(|| Err("the probe ended without an answer".into())),
            Ok(Err(_)) => Err("the probe ended without an answer".into()),
            Err(_) => Err(format!("no answer within {}s, still asking", wait.as_secs())),
        }
    }

    async fn probe(state: &Arc<DaemonState>, peer: &PeerMachine) -> ProbeOutcome {
        let attempt = async {
            let client = super::peer_client::client_for(state, peer).await.map_err(|e| e.to_string())?;
            client.health().await.map(|_| ()).map_err(|e| e.to_string())
        };
        let bound = state.hub.probe_bound();
        match tokio::time::timeout(bound, attempt).await {
            Ok(outcome) => outcome,
            Err(_) => Err(format!("no answer within {}s", bound.as_secs())),
        }
    }

    /// Whether a link task for `machine_id` is currently tracked. Test-only:
    /// a cheap probe for "did `sync_links` actually spawn one" that doesn't
    /// depend on the link reaching the peer (unlike `mirror.is_online`,
    /// which only flips once a real connection succeeds) - used by the
    /// regression proving the receiving side of a pairing starts its link.
    #[cfg(test)]
    pub(crate) fn has_link(state: &Arc<DaemonState>, machine_id: &str) -> bool {
        state.hub.links.lock().unwrap_or_else(|e| e.into_inner()).contains_key(machine_id)
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
            state.hub.wakes.lock().unwrap_or_else(|e| e.into_inner()).remove(&machine_id);
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
        drop(guard);
        // Every pairing mutation on either side ends here, including the
        // receiving side of a pair it didn't initiate, so this is what lets
        // that machine's open Settings page show the new peer live.
        state.notifier.publish("machines_changed", serde_json::json!({}));
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
            icon: None,
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
