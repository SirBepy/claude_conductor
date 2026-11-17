//! The peer half of "same personal settings on every paired machine" (todo
//! pc-1455). The model (which keys, how a stamp wins) is `settings::sync`; the
//! stamps' storage and the settings write are `settings::sync_store`, and both
//! belong to the APP process, which owns `settings.json`. This daemon only moves
//! changes between the app and the paired peers: an incoming call is handed to the
//! app as a `settings_sync_incoming` notification, and what goes out is read from
//! `settings.json` and the stamps file beside it (the app's pushed snapshot trails
//! the disk, so it is not used).
//!
//! Nothing is queued on disk. The state is what travels (every stamped personal key
//! with its value and stamp), so a peer that was unreachable catches up from the
//! next exchange; a change that reaches a daemon whose app is not connected is kept
//! in memory and handed to the app after its next settings push.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::rpc::{ConnectionContext, Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::settings::sync::{is_personal, is_skewed, Change};
use crate::settings::sync_store;

use super::{peer_client, PeerMachine};

/// Most changes one call may carry: a call names each personal key at most once,
/// and the list is a handful. A longer one is refused as a whole.
pub(crate) const MAX_CHANGES: usize = 64;
/// Most one change's value may serialize to. Personal values are small switches,
/// colours and a few lists; this stops a peer filling `settings.json`.
const MAX_VALUE_BYTES: usize = 256 * 1024;

pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    super::asset_sync::register(router, state.clone());
    // Machine-only (M in the transport table).
    router.register("settings_sync", move |params, ctx| {
        let state = state.clone();
        async move {
            let req: ExchangeParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            handle_exchange(&state, &ctx, req)
        }
    });
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExchangeParams {
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Asks for the receiver's own stamped state in the reply (a pull), which a
    /// machine that just connected uses to catch up.
    #[serde(default)]
    pub want_reply: bool,
}

/// Outgoing bookkeeping, one per daemon (held by `MachineHub`). In memory only: a
/// restart sends the state again, which a peer merges as a no-op.
pub struct SyncState {
    /// True until the app's first settings push of this boot, which also asks the
    /// peers for theirs: a peer's answer to an earlier connect had no app to take it.
    first_push: AtomicBool,
    /// What the last push sent, so a settings save that changed no stamp sends nothing.
    last_sent: Mutex<Vec<Change>>,
    /// Peers whose last call failed or was refused: the next push sends to them even
    /// when no stamp moved. Per peer, so one that keeps refusing does not make every
    /// unrelated save resend full state to the others.
    resend: Mutex<HashSet<String>>,
    /// Peers a character-file pull (`asset_sync`) is running for: one at a time each.
    pulling: Mutex<HashSet<String>>,
    /// When each peer's last successful pull ended: another one inside
    /// [`PULL_COOLDOWN`] is skipped (every settings push from a peer asks for one).
    pulled_at: Mutex<HashMap<String, Instant>>,
    /// The newest change per (sender, key) received, for redelivery to the app.
    received: Mutex<BTreeMap<(String, String), Change>>,
    /// Peers whose changes are being refused over a clock difference, in either
    /// direction (see [`SkewFlags`]).
    skew: Mutex<HashMap<String, SkewFlags>>,
}

/// A merge refuses a stamp more than 5 minutes ahead of the receiver's clock, so two
/// machines whose clocks differ by more than that stop taking each other's edits in
/// one direction. Each daemon notes what it can see: a peer's stamps it would refuse,
/// and the peer's report that it refused ours.
#[derive(Default, Clone, Copy)]
struct SkewFlags {
    /// The peer's changes carry stamps ahead of this machine's clock by too much.
    theirs_refused_here: bool,
    /// The peer answered that this machine's stamps are ahead of its clock by too much.
    ours_refused_there: bool,
}

/// Least time between two character-file pulls from one peer, unless the last failed.
const PULL_COOLDOWN: Duration = Duration::from_secs(30);

impl Default for SyncState {
    fn default() -> Self {
        Self {
            first_push: AtomicBool::new(true),
            last_sent: Mutex::new(Vec::new()),
            resend: Mutex::new(HashSet::new()),
            pulling: Mutex::new(HashSet::new()),
            pulled_at: Mutex::new(HashMap::new()),
            received: Mutex::new(BTreeMap::new()),
            skew: Mutex::new(HashMap::new()),
        }
    }
}

impl SyncState {
    /// True when the caller may run a pull for `machine_id` now: none is running and
    /// the last good one is not recent. The caller ends it with [`PullGuard`].
    pub(super) fn begin_pull(self: &Arc<Self>, machine_id: &str) -> Option<PullGuard> {
        let recent = self.pulled_at.lock().unwrap_or_else(|e| e.into_inner()).get(machine_id).is_some_and(|t| t.elapsed() < PULL_COOLDOWN);
        if recent || !self.pulling.lock().unwrap_or_else(|e| e.into_inner()).insert(machine_id.to_string()) {
            return None;
        }
        Some(PullGuard { sync: self.clone(), machine_id: machine_id.to_string(), ok: false })
    }

    /// Notes whether `peer`'s changes (`incoming`) or this machine's (`!incoming`) are
    /// being refused over a clock difference. True only when that is newly the case,
    /// so the caller logs it once and not on every exchange.
    pub(crate) fn set_skew(&self, peer: &str, incoming: bool, skewed: bool) -> bool {
        let mut map = self.skew.lock().unwrap_or_else(|e| e.into_inner());
        let flags = map.entry(peer.to_string()).or_default();
        let slot = if incoming { &mut flags.theirs_refused_here } else { &mut flags.ours_refused_there };
        let newly = skewed && !*slot;
        *slot = skewed;
        newly
    }

    /// The line the machines list shows for `peer` when its settings are not flowing
    /// because of a clock difference; `None` when they are.
    pub(crate) fn skew_note(&self, peer: &str) -> Option<String> {
        let flags = *self.skew.lock().unwrap_or_else(|e| e.into_inner()).get(peer)?;
        match (flags.theirs_refused_here, flags.ours_refused_there) {
            (false, false) => None,
            (true, false) => Some("Clocks differ by over 5 minutes: its settings changes are refused here until they agree".into()),
            (false, true) => Some("Clocks differ by over 5 minutes: settings changes made here are refused by it until they agree".into()),
            (true, true) => Some("Clocks differ by over 5 minutes: settings changes are refused both ways until they agree".into()),
        }
    }

    fn remember_received(&self, from: &str, changes: &[Change]) {
        let mut map = self.received.lock().unwrap_or_else(|e| e.into_inner());
        for c in changes {
            map.insert((from.to_string(), c.key.clone()), c.clone());
        }
    }

    /// Makes the next push send to `peer` even if no stamp moved: a call that failed
    /// must not leave that peer waiting for some other key to change.
    fn forget_last_sent(&self, peer: &str) {
        self.resend.lock().unwrap_or_else(|e| e.into_inner()).insert(peer.to_string());
    }

    /// The peers owed a resend; empties the set (a push that fails marks them again).
    fn take_resend(&self) -> HashSet<String> {
        std::mem::take(&mut *self.resend.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn received(&self) -> Vec<(String, Vec<Change>)> {
        let map = self.received.lock().unwrap_or_else(|e| e.into_inner());
        let mut by_sender: BTreeMap<String, Vec<Change>> = BTreeMap::new();
        for ((from, _), change) in map.iter() {
            by_sender.entry(from.clone()).or_default().push(change.clone());
        }
        by_sender.into_iter().collect()
    }
}

/// Holds a peer's pull slot; dropping it (a panic included) frees the slot, and
/// [`PullGuard::succeeded`] starts the cooldown.
pub(super) struct PullGuard {
    sync: Arc<SyncState>,
    machine_id: String,
    ok: bool,
}

impl PullGuard {
    pub(super) fn succeeded(&mut self) {
        self.ok = true;
    }
}

impl Drop for PullGuard {
    fn drop(&mut self) {
        self.sync.pulling.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.machine_id);
        if self.ok {
            self.sync.pulled_at.lock().unwrap_or_else(|e| e.into_inner()).insert(self.machine_id.clone(), Instant::now());
        }
    }
}

/// What this machine would send a peer right now: the settings file's
/// stamped personal keys. Empty before the machine registry exists.
pub(crate) fn local_state(state: &DaemonState) -> Vec<Change> {
    let Some(registry) = state.machines.get() else { return Vec::new() };
    // Values and stamps both come from the files the app wrote (not from the pushed
    // snapshot, which trails the disk): a stamp read next to an older value would make
    // a peer keep the old value, since the real one arrives under the same stamp. The
    // app writes the settings file and then the stamps, so the stamps are read FIRST:
    // the worst a reader can see is a newer value under an older stamp, which the next
    // exchange corrects.
    let clocks = sync_store::peek_clocks(&registry.app_data().join(sync_store::CLOCKS_FILE));
    let Some(settings) = sync_store::read_previous(&registry.app_data().join("settings.json")) else {
        return Vec::new();
    };
    sync_store::stamped_state(&settings, &clocks)
}

/// `state` without the keys `peer` wrote itself: it has them, and sending a key back
/// would only make it merge its own edit again.
fn outgoing_for(state: &[Change], peer: &str) -> Vec<Change> {
    state.iter().filter(|c| c.stamp.by != peer).cloned().collect()
}

/// Makes a peer's changes safe to hand to the app: only personal keys, values of a
/// sane size, and every stamp's `by` set to the machine the call came from. The
/// sender is what `ctx.transport` says, never what the payload claims (CLAUDE.md,
/// multi-machine). The app's merge still refuses a value that does not fit
/// `Settings` and a stamp that is not a time or is far ahead.
pub(crate) fn sanitize(changes: Vec<Change>, from: &str) -> Result<Vec<Change>, RpcError> {
    if changes.len() > MAX_CHANGES {
        return Err(RpcError::invalid_params(format!("at most {MAX_CHANGES} changes per call")));
    }
    Ok(changes
        .into_iter()
        .filter(|c| is_personal(&c.key))
        .filter(|c| serde_json::to_vec(&c.value).is_ok_and(|v| v.len() <= MAX_VALUE_BYTES))
        .map(|mut c| {
            c.stamp.by = from.to_string();
            c
        })
        .collect())
}

/// Notes (and logs once per peer) that `from`'s stamps are further ahead of this
/// machine's clock than a merge accepts, so the app will refuse them. Returns whether
/// any are. A call with no changes says nothing about the clocks and changes no note.
fn note_incoming_skew(state: &DaemonState, from: &str, changes: &[Change]) -> bool {
    if changes.is_empty() {
        return false;
    }
    let now = chrono::Utc::now();
    let skewed = changes.iter().any(|c| is_skewed(&c.stamp, now));
    if state.hub.settings_sync.set_skew(from, true, skewed) {
        log::warn!(
            "[settings-sync] {from} sent settings stamped more than {} minutes ahead of this machine's clock: they are refused until the clocks agree (check both machines' time)",
            crate::settings::sync::MAX_FUTURE_SKEW_MINUTES
        );
    }
    skewed
}

/// Hands changes from machine `from` to the app process, which merges and
/// persists them (the daemon never writes `settings.json`).
///
/// The broadcast is dropped when the app is not connected, so the newest change per
/// key is also kept in memory and sent again after the app's next settings push
/// (`redeliver_to_app`); the app's merge ignores one it already has.
pub(crate) fn deliver_to_app(state: &DaemonState, from: &str, changes: &[Change]) {
    if changes.is_empty() {
        return;
    }
    state.hub.settings_sync.remember_received(from, changes);
    state.notifier.publish("settings_sync_incoming", json!({ "from": from, "changes": changes }));
}

/// Sends the remembered incoming changes again, for peers that are still switched on.
fn redeliver_to_app(state: &DaemonState) {
    let Some(registry) = state.machines.get() else { return };
    for (from, changes) in state.hub.settings_sync.received() {
        if registry.sync_settings(&from) {
            state.notifier.publish("settings_sync_incoming", json!({ "from": from, "changes": changes }));
        }
    }
}

/// A peer's `settings_sync` call. The caller is `ctx.transport`'s machine; the call
/// is refused unless the owner switched "Sync settings" on for that machine here.
pub(crate) fn handle_exchange(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: ExchangeParams) -> Result<Value, RpcError> {
    let Transport::PeerMachine(from) = &ctx.transport else {
        return Err(RpcError::invalid_params("settings_sync is only callable by a peer machine"));
    };
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    if !registry.sync_settings(from) {
        return Err(RpcError::invalid_params("settings sync is off for this machine"));
    }
    let changes = sanitize(req.changes, from)?;
    let skewed = note_incoming_skew(state, from, &changes);
    deliver_to_app(state, from, &changes);
    // A peer that just sent settings has us switched on at its end, so its character
    // files are ours to fetch now, even if our own link to it has been up for hours.
    if let Some(peer) = registry.peer(from) {
        super::asset_sync::spawn_pull(state, &peer);
    }
    // `clock_skew` tells the sender its stamps were refused here, so it can show why its
    // edits do not arrive (it cannot tell from a plain `ok`).
    let mut out = json!({ "ok": true, "clock_skew": skewed });
    if req.want_reply {
        out["changes"] = json!(outgoing_for(&local_state(state), from));
    }
    Ok(out)
}

/// Paired peers settings should flow to now: switched on here and reachable. An
/// offline peer is not queued for; it catches up from the exchange its link makes
/// when it comes back.
fn peers_to_sync(state: &DaemonState) -> Vec<PeerMachine> {
    let Some(registry) = state.machines.get() else { return Vec::new() };
    registry
        .peers()
        .into_iter()
        .filter(|p| registry.sync_settings(&p.machine_id) && state.mirror.is_online(&p.machine_id))
        .collect()
}

/// What an app settings push should send, and whether to ask for the peers' state
/// too; `None` when nothing needs to leave. Pure apart from the bookkeeping it
/// updates, so the decision is testable without a peer.
fn plan_push(sync: &SyncState, now: Vec<Change>) -> Option<(Vec<Change>, bool)> {
    let first = sync.first_push.swap(false, Ordering::SeqCst);
    let mut last = sync.last_sent.lock().unwrap_or_else(|e| e.into_inner());
    let changed = *last != now;
    *last = now.clone();
    (first || changed).then_some((now, first))
}

/// Called after every settings push from the app (`set_settings`): the app has
/// stamped what the save changed and written the stamps before pushing, so the
/// state read here is current. Sends to each syncing peer, best effort.
pub(crate) fn on_app_push(state: &Arc<DaemonState>) {
    redeliver_to_app(state);
    let local = local_state(state);
    let plan = plan_push(&state.hub.settings_sync, local.clone());
    let resend = state.hub.settings_sync.take_resend();
    let (now, ask) = plan.clone().unwrap_or((local, false));
    for peer in push_targets(peers_to_sync(state), plan.is_some(), &resend) {
        let (state, changes) = (state.clone(), outgoing_for(&now, &peer.machine_id));
        tokio::spawn(async move { exchange(&state, &peer, changes, ask).await });
    }
}

/// Who a push goes to: every syncing peer when a stamp moved, otherwise only the
/// peers whose last call failed.
fn push_targets(peers: Vec<PeerMachine>, stamps_moved: bool, resend: &HashSet<String>) -> Vec<PeerMachine> {
    peers.into_iter().filter(|p| stamps_moved || resend.contains(&p.machine_id)).collect()
}

/// A link to `peer` just came up: trade state with it, which covers everything either
/// side changed while apart.
pub(super) async fn on_connect(state: &Arc<DaemonState>, peer: &PeerMachine) {
    let Some(registry) = state.machines.get() else { return };
    if registry.sync_settings(&peer.machine_id) {
        // Character files first into the background: a pull outlasts the link's
        // frame loop, which is waiting on this call.
        super::asset_sync::spawn_pull(state, peer);
        exchange(state, peer, outgoing_for(&local_state(state), &peer.machine_id), true).await;
    }
}

/// The owner just switched "Sync settings" on for `machine_id`: trade state now.
pub(crate) fn on_switched_on(state: &Arc<DaemonState>, machine_id: &str) {
    let Some(peer) = state.machines.get().and_then(|r| r.peer(machine_id)) else { return };
    if !state.mirror.is_online(machine_id) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move { on_connect(&state, &peer).await });
}

/// One `settings_sync` call to `peer`. With `want_reply` its own state comes back
/// and goes to the app like any incoming change. An unreachable or refusing peer
/// (its switch for us is off) is only logged: nothing is kept to resend, the next
/// connect or settings push sends the state again.
async fn exchange(state: &Arc<DaemonState>, peer: &PeerMachine, changes: Vec<Change>, want_reply: bool) {
    if changes.is_empty() && !want_reply {
        return;
    }
    let client = match peer_client::client_for(state, peer).await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("settings_sync: {} unreachable: {e}", peer.machine_id);
            state.hub.settings_sync.forget_last_sent(&peer.machine_id);
            return;
        }
    };
    let sent_any = !changes.is_empty();
    match client.call("settings_sync", json!({ "changes": changes, "want_reply": want_reply })).await {
        Ok(reply) => accept_reply(state, &peer.machine_id, sent_any, want_reply, &reply),
        Err(e) => {
            log::debug!("settings_sync: {} did not take our settings: {e}", peer.machine_id);
            state.hub.settings_sync.forget_last_sent(&peer.machine_id);
        }
    }
}

/// What to do with a peer's answer to one of our `settings_sync` calls: note whether it
/// refused our stamps over a clock difference, and, when we asked for its state, hand
/// that to the app like any incoming change. An answer that comes back after the owner
/// switched "Sync settings" off for that peer is dropped: the switch decides what this
/// machine takes, and the call was made while it was on.
fn accept_reply(state: &Arc<DaemonState>, peer_id: &str, sent_any: bool, want_reply: bool, reply: &Value) {
    if !state.machines.get().is_some_and(|r| r.sync_settings(peer_id)) {
        log::debug!("settings_sync: dropped {peer_id}'s answer, sync was switched off meanwhile");
        return;
    }
    if sent_any {
        let refused = reply.get("clock_skew").and_then(Value::as_bool).unwrap_or(false);
        if refused {
            // The peer took the call but dropped every change in it: sending nothing more
            // until some other key changes would leave them unsynced after the clocks agree.
            state.hub.settings_sync.forget_last_sent(peer_id);
        }
        if state.hub.settings_sync.set_skew(peer_id, false, refused) {
            log::warn!(
                "[settings-sync] {peer_id} refused this machine's settings: their stamps are more than {} minutes ahead of its clock (check both machines' time)",
                crate::settings::sync::MAX_FUTURE_SKEW_MINUTES
            );
        }
    }
    if !want_reply {
        return;
    }
    let theirs: Vec<Change> = reply.get("changes").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    match sanitize(theirs, peer_id) {
        Ok(theirs) => {
            note_incoming_skew(state, peer_id, &theirs);
            deliver_to_app(state, peer_id, &theirs);
        }
        Err(e) => log::warn!("settings_sync: {peer_id} sent an unusable reply: {}", e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::machines::PeerMachine;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::settings::sync::Stamp;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn change(key: &str, value: Value, by: &str) -> Change {
        Change { key: key.into(), value, stamp: Stamp { at: "2026-11-15T10:00:00Z".into(), by: by.into() } }
    }

    fn state_with_peer(dir: &std::path::Path, settings: Settings) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        state.init_machines(dir.to_path_buf());
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mac".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        state
    }

    async fn call(state: &Arc<DaemonState>, params: Value, transport: Option<Transport>) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register(&mut r, state.clone());
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = match transport {
            Some(t) => crate::daemon::rpc::TRANSPORT.scope(t, async { ConnectionContext::new(tx) }).await,
            None => ConnectionContext::new(tx),
        };
        r.dispatch(
            crate::daemon::rpc::Request { jsonrpc: "2.0".into(), id: json!(1), method: "settings_sync".into(), params: Some(params) },
            ctx,
        )
        .await
    }

    fn from_mac() -> Option<Transport> {
        Some(Transport::PeerMachine("mac".into()))
    }

    #[tokio::test]
    async fn a_peer_with_the_switch_off_is_refused_and_nothing_reaches_the_app() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        let mut rx = state.notifier.subscribe();
        let params = json!({"changes": [change("paceBand", json!(1), "mac")]});
        let resp = call(&state, params, from_mac()).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        assert!(rx.try_recv().is_err(), "a refused call must not be delivered");
    }

    #[tokio::test]
    async fn only_a_peer_machine_may_call_it_even_with_a_switch_on() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        assert!(state.machines.get().unwrap().set_sync_settings("mac", true));
        for transport in [None, Some(Transport::Phone)] {
            let resp = call(&state, json!({"changes": []}), transport).await;
            assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        }
    }

    #[tokio::test]
    async fn an_accepted_call_reaches_the_app_with_the_sender_taken_from_the_transport() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut rx = state.notifier.subscribe();
        let params = json!({"changes": [
            change("paceBand", json!(3), "some-other-machine"),
            change("hook_port", json!(1), "mac"),
            change("projects", json!([]), "mac"),
        ]});
        let resp = call(&state, params, from_mac()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let frame = rx.try_recv().expect("delivered to the app");
        assert_eq!(frame["method"], "settings_sync_incoming");
        assert_eq!(frame["params"]["from"], "mac");
        let delivered = frame["params"]["changes"].as_array().unwrap();
        assert_eq!(delivered.len(), 1, "machine-local keys never reach the app: {delivered:?}");
        assert_eq!(delivered[0]["key"], "paceBand");
        assert_eq!(delivered[0]["stamp"]["by"], "mac", "a payload cannot claim to be another machine");
    }

    fn change_at(key: &str, at: chrono::DateTime<chrono::Utc>) -> Change {
        Change {
            key: key.into(),
            value: json!(3),
            stamp: Stamp { at: at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), by: "mac".into() },
        }
    }

    /// The peer's clock is ahead of this one by more than a merge accepts: its edits are
    /// refused here, which must be said (the reply to the sender, the machine list here),
    /// then clear once its stamps are acceptable again.
    #[tokio::test]
    async fn a_peer_whose_clock_is_ahead_is_told_and_noted_not_silently_dropped() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let ahead = chrono::Utc::now() + chrono::Duration::minutes(10);
        let resp = call(&state, json!({"changes": [change_at("paceBand", ahead)]}), from_mac()).await;
        assert_eq!(resp.result.unwrap()["clock_skew"], json!(true), "the sender learns its stamps are refused");
        let note = state.hub.settings_sync.skew_note("mac").expect("noted for the machines list");
        assert!(note.contains("refused here"), "{note}");

        // Logged once per peer: the same condition again is not "newly" skewed.
        assert!(!state.hub.settings_sync.set_skew("mac", true, true));

        // Behind by any amount is fine, and an in-limit exchange clears the note.
        let behind = chrono::Utc::now() - chrono::Duration::hours(3);
        let resp = call(&state, json!({"changes": [change_at("paceBand", behind)]}), from_mac()).await;
        assert_eq!(resp.result.unwrap()["clock_skew"], json!(false));
        assert!(state.hub.settings_sync.skew_note("mac").is_none());
    }

    /// The other direction: this machine's clock is the one that is ahead, so the peer
    /// refuses ITS stamps; the peer's reply says so, and that is shown here.
    #[test]
    fn a_peer_that_refused_our_stamps_is_noted_and_the_note_clears_when_it_stops() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let one = vec![change("paceBand", json!(1), "pc")];
        assert!(plan_push(&state.hub.settings_sync, one.clone()).is_some());
        assert!(plan_push(&state.hub.settings_sync, one.clone()).is_none(), "unchanged stamps send nothing");
        accept_reply(&state, "mac", true, false, &json!({"ok": true, "clock_skew": true}));
        assert!(state.hub.settings_sync.take_resend().contains("mac"), "a refused send is sent again on the next push");
        let note = state.hub.settings_sync.skew_note("mac").expect("noted");
        assert!(note.contains("made here are refused by it"), "{note}");
        // A call that sent nothing says nothing about our stamps.
        accept_reply(&state, "mac", false, false, &json!({"ok": true, "clock_skew": false}));
        assert!(state.hub.settings_sync.skew_note("mac").is_some());
        accept_reply(&state, "mac", true, false, &json!({"ok": true, "clock_skew": false}));
        assert!(state.hub.settings_sync.skew_note("mac").is_none());
        // Both at once reads as both.
        state.hub.settings_sync.set_skew("mac", true, true);
        state.hub.settings_sync.set_skew("mac", false, true);
        assert!(state.hub.settings_sync.skew_note("mac").unwrap().contains("both ways"));
    }

    /// A peer's answer to a call made while sync was on, arriving after the owner switched
    /// it off, is not handed to the app (and leaves no skew note either).
    #[test]
    fn an_answer_that_arrives_after_the_switch_went_off_is_dropped() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        let reg = state.machines.get().unwrap();
        reg.set_sync_settings("mac", true);
        let mut rx = state.notifier.subscribe();
        let reply = json!({"ok": true, "clock_skew": true, "changes": [change("paceBand", json!(7), "mac")]});

        reg.set_sync_settings("mac", false);
        accept_reply(&state, "mac", true, true, &reply);
        assert!(rx.try_recv().is_err(), "nothing reaches the app");
        assert!(state.hub.settings_sync.skew_note("mac").is_none());

        reg.set_sync_settings("mac", true);
        accept_reply(&state, "mac", true, true, &reply);
        let frame = rx.try_recv().expect("the same answer is taken while the switch is on");
        assert_eq!(frame["params"]["changes"][0]["key"], "paceBand");
    }

    #[tokio::test]
    async fn a_huge_value_is_dropped_and_too_many_changes_are_refused() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut rx = state.notifier.subscribe();
        let big = "x".repeat(MAX_VALUE_BYTES + 1);
        let resp = call(&state, json!({"changes": [change("paceColors", json!(big), "mac")]}), from_mac()).await;
        assert!(resp.error.is_none());
        assert!(rx.try_recv().is_err(), "an oversized value is dropped, so nothing is delivered");

        let many: Vec<Change> = (0..=MAX_CHANGES).map(|_| change("paceBand", json!(1), "mac")).collect();
        let resp = call(&state, json!({"changes": many}), from_mac()).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
    }

    #[tokio::test]
    async fn want_reply_returns_this_machines_stamped_personal_state() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.poll_interval_secs = 77;
        settings.hook_port = Some(5);
        // The pushed snapshot trails the file (the app pushes after it saves): the file wins.
        let state = state_with_peer(dir.path(), Settings::default());
        crate::settings::store::save(&dir.path().join("settings.json"), &settings).unwrap();
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut clocks = crate::settings::sync::Clocks::new();
        let stamp = Stamp { at: "2026-11-15T09:00:00Z".into(), by: "pc".into() };
        clocks.insert("poll_interval_secs".into(), stamp.clone());
        clocks.insert("hook_port".into(), stamp);
        sync_store::save_clocks(&dir.path().join(sync_store::CLOCKS_FILE), &clocks).unwrap();

        let resp = call(&state, json!({"changes": [], "want_reply": true}), from_mac()).await;
        let result = resp.result.expect("answered");
        let sent = result["changes"].as_array().unwrap();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0]["key"], "poll_interval_secs");
        assert_eq!(sent[0]["value"], 77);

        let resp = call(&state, json!({"changes": []}), from_mac()).await;
        assert!(resp.result.unwrap().get("changes").is_none(), "no reply state unless asked for");
    }

    #[test]
    fn a_change_that_arrived_while_the_app_was_away_is_sent_again_after_its_next_push() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        // Nobody is subscribed: the broadcast reaches no app.
        deliver_to_app(&state, "mac", &[change("paceBand", json!(3), "mac")]);
        deliver_to_app(&state, "mac", &[change("paceBand", json!(5), "mac")]);
        let mut rx = state.notifier.subscribe();
        redeliver_to_app(&state);
        let frame = rx.try_recv().expect("sent again");
        assert_eq!(frame["params"]["from"], "mac");
        assert_eq!(frame["params"]["changes"].as_array().unwrap().len(), 1, "the newest change per key");
        assert_eq!(frame["params"]["changes"][0]["value"], 5);

        state.machines.get().unwrap().set_sync_settings("mac", false);
        redeliver_to_app(&state);
        assert!(rx.try_recv().is_err(), "a peer switched off is not redelivered");
    }

    #[test]
    fn a_failed_send_makes_the_next_push_send_again() {
        let sync = SyncState::default();
        let one = vec![change("paceBand", json!(1), "pc")];
        assert!(plan_push(&sync, one.clone()).is_some());
        assert!(plan_push(&sync, one.clone()).is_none());
        sync.forget_last_sent("mac");
        assert_eq!(plan_push(&sync, one), None, "the stamps did not move, so no other peer is sent anything");
        let owed = sync.take_resend();
        assert!(owed.contains("mac"), "the peer never got it, so it goes again");
        assert!(sync.take_resend().is_empty(), "a resend is owed once, until the next failure");
    }

    #[test]
    fn a_failed_peer_alone_gets_the_resend_while_stamps_are_unchanged() {
        let peer = |id: &str| PeerMachine {
            machine_id: id.into(),
            label: id.into(),
            os: "x".into(),
            iroh_id: None,
            direct_url: None,
            token: "t".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        };
        let owed: HashSet<String> = ["mac".to_string()].into();
        let ids = |v: Vec<PeerMachine>| v.into_iter().map(|p| p.machine_id).collect::<Vec<_>>();
        assert_eq!(ids(push_targets(vec![peer("mac"), peer("lap")], false, &owed)), ["mac"], "an unrelated save resends to the failed peer only");
        assert_eq!(ids(push_targets(vec![peer("mac"), peer("lap")], true, &owed)), ["mac", "lap"], "a moved stamp goes to everyone");
        assert!(push_targets(vec![peer("lap")], false, &HashSet::new()).is_empty());
    }

    #[test]
    fn a_peers_pull_slot_is_single_and_a_good_pull_starts_a_cooldown_but_a_failed_one_does_not() {
        let sync = Arc::new(SyncState::default());
        let first = sync.begin_pull("mac").expect("free");
        assert!(sync.begin_pull("mac").is_none(), "one pull at a time per peer");
        assert!(sync.begin_pull("other").is_some(), "another peer is independent");
        drop(first); // failed or panicked: no success recorded
        let mut again = sync.begin_pull("mac").expect("a failed pull is retried at once");
        again.succeeded();
        drop(again);
        assert!(sync.begin_pull("mac").is_none(), "right after a good pull, wait out the cooldown");
    }

    #[test]
    fn a_key_the_peer_wrote_is_not_sent_back_to_it() {
        let state = vec![change("paceBand", json!(1), "mac"), change("paceColors", json!({}), "pc")];
        let out = outgoing_for(&state, "mac");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, "paceColors");
    }

    #[test]
    fn a_push_sends_on_the_first_push_and_after_a_change_but_not_for_an_unrelated_save() {
        let sync = SyncState::default();
        let one = vec![change("paceBand", json!(1), "pc")];
        // The app's first push of a boot also asks the peers for theirs.
        assert_eq!(plan_push(&sync, one.clone()), Some((one.clone(), true)));
        // The same stamps again (an unrelated settings save): nothing leaves.
        assert_eq!(plan_push(&sync, one.clone()), None);
        // A newly stamped key sends, with no ask.
        let two = vec![change("paceBand", json!(2), "pc")];
        assert_eq!(plan_push(&sync, two.clone()), Some((two, false)));
        // Nothing stamped at all on the first push still asks for the peers' state.
        let fresh = SyncState::default();
        assert_eq!(plan_push(&fresh, Vec::new()), Some((Vec::new(), true)));
    }

    #[test]
    fn only_a_switched_on_online_peer_is_synced_to() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        assert!(peers_to_sync(&state).is_empty(), "off by default");
        state.machines.get().unwrap().set_sync_settings("mac", true);
        assert!(peers_to_sync(&state).is_empty(), "no mirror entry yet means offline: nothing to send to");
        state.mirror.set_instances("mac", "Mac", vec![]);
        assert_eq!(peers_to_sync(&state).len(), 1);
        state.mirror.set_online("mac", false);
        assert!(peers_to_sync(&state).is_empty(), "an unreachable peer is not queued for");
    }

    /// Two daemons over loopback, each with a stamped edit and the switch on for the
    /// other: when A's link comes up, A's change reaches B's app and B's reaches A's.
    #[tokio::test]
    async fn two_daemons_trade_their_stamped_settings_when_the_link_comes_up() {
        use crate::daemon::device_registry::DeviceRegistry;
        use crate::daemon::rpc::Router;

        let (a_dir, b_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let mut a_extra = serde_json::Map::new();
        a_extra.insert("paceBand".into(), json!(4));
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut a_router = Router::new();
        crate::daemon::methods::register_machines(&mut a_router, a_state.clone());
        let mut b_router = Router::new();
        crate::daemon::methods::register_machines(&mut b_router, b_state.clone());
        let (_a_stt, a_port, a_serve) =
            crate::daemon::remote_server::spawn_on(a_state.clone(), a_dir.path().to_path_buf(), a_router, 0);
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), b_dir.path().to_path_buf(), b_router, 0);
        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        crate::settings::store::save(&a_dir.path().join("settings.json"), &Settings { extra: a_extra, ..Settings::default() }).unwrap();
        crate::settings::store::save(&b_dir.path().join("settings.json"), &Settings { poll_interval_secs: 77, ..Settings::default() }).unwrap();
        let stamp = |by: &str| Stamp { at: "2026-11-15T10:00:00Z".into(), by: by.into() };
        let mut a_clocks = crate::settings::sync::Clocks::new();
        a_clocks.insert("paceBand".into(), stamp(&a_id));
        sync_store::save_clocks(&a_dir.path().join(sync_store::CLOCKS_FILE), &a_clocks).unwrap();
        let mut b_clocks = crate::settings::sync::Clocks::new();
        b_clocks.insert("poll_interval_secs".into(), stamp(&b_id));
        sync_store::save_clocks(&b_dir.path().join(sync_store::CLOCKS_FILE), &b_clocks).unwrap();

        let pair = |state: &Arc<DaemonState>, peer_id: &str, peer_port: u16, peer_dir: &std::path::Path, me: &str| {
            let (token, _) = DeviceRegistry::add_machine_device("peer", me, peer_dir).unwrap();
            let registry = state.machines.get().unwrap();
            registry.upsert_peer(PeerMachine {
                machine_id: peer_id.into(),
                label: "peer".into(),
                os: "test".into(),
                iroh_id: None,
                direct_url: Some(format!("http://127.0.0.1:{peer_port}")),
                token,
                reverse_device_id: None,
                added_at: 0,
                icon: None,
            });
            assert!(registry.set_sync_settings(peer_id, true));
        };
        pair(&a_state, &b_id, b_port, b_dir.path(), &a_id);
        pair(&b_state, &a_id, a_port, a_dir.path(), &b_id);

        let (mut a_rx, mut b_rx) = (a_state.notifier.subscribe(), b_state.notifier.subscribe());
        crate::daemon::machines::MachineHub::sync_links(&a_state);

        async fn incoming(rx: &mut tokio::sync::broadcast::Receiver<Value>) -> Value {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                let frame = tokio::time::timeout(left, rx.recv()).await.expect("no settings_sync_incoming within 10s").unwrap();
                if frame["method"] == "settings_sync_incoming" {
                    return frame["params"].clone();
                }
            }
        }
        let at_b = incoming(&mut b_rx).await;
        assert_eq!(at_b["from"], json!(a_id));
        assert_eq!(at_b["changes"][0]["key"], "paceBand");
        assert_eq!(at_b["changes"][0]["value"], 4);
        let at_a = incoming(&mut a_rx).await;
        assert_eq!(at_a["from"], json!(b_id));
        assert_eq!(at_a["changes"][0]["key"], "poll_interval_secs");
        assert_eq!(at_a["changes"][0]["value"], 77);

        a_serve.kill();
        b_serve.kill();
    }

    /// With the switch off on the receiving side the same link moves nothing.
    #[tokio::test]
    async fn a_peer_that_has_not_switched_sync_on_receives_nothing() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        let mut rx = state.notifier.subscribe();
        let resp = call(&state, json!({"changes": [change("paceBand", json!(1), "mac")], "want_reply": true}), from_mac()).await;
        assert!(resp.error.is_some() && resp.result.is_none());
        assert!(rx.try_recv().is_err());
    }
}
