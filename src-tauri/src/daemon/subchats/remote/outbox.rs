//! The on-disk outbox for what must survive a gap in the link between a sub's
//! host and its home (`docs/cross-machine-subchats.md`, "Outbox").
//!
//! Only what has to be delivered later goes through it: the host's `sub_event`
//! calls (finished, ended, a plumbing wake) and, from step 6, the home's
//! `sub_end`, `sub_drop`, `sub_to_sidebar`, `sub_reparent` and `sub_cleanup`.
//! An entry is written BEFORE the first send attempt, delivered in order per
//! machine, removed on any reply (an error reply is logged and dropped, never
//! retried forever), and retried on the busy_watchdog tick and whenever a peer
//! link connects. Interactive calls (`sub_spawn`, `sub_status`, ...) never use it.
//!
//! `<data_dir>/subchats/outbox[suffix].json`, one file per daemon instance (the
//! same reason `held[suffix].json` is). It also keeps the last event number handed
//! out per sub, so a number is never reused after the entries that carried the
//! earlier ones were delivered and removed: the receiver drops any number it has
//! already seen, so a reused one would be dropped as a replay.

use crate::daemon::machines::PeerError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The most entries kept for one machine. A sub that talks all through a long
/// outage must not grow the file without end; the oldest entry goes first.
pub const MAX_PER_MACHINE: usize = 500;
/// The largest `params` an entry may carry. A finish record and its facts are a
/// few kilobytes; this only stops a bug or a hostile caller filling the disk.
pub const MAX_PARAMS_BYTES: usize = 512 * 1024;
/// A reply that is not a decision (the answer was not even JSON, or the peer said it
/// failed on its own side) is retried, but not for ever: a peer that never gives a
/// decision is dropped from here.
const MAX_UNDECIDED_ATTEMPTS: u32 = 50;
/// JSON-RPC "internal error": the peer's own failure (a disk write that did not
/// land), which a later attempt may get past, unlike a refusal.
const PEER_INTERNAL_ERROR: i64 = -32603;

/// JSON-RPC "method not found", which a peer's transport table answers (403) for a
/// method it does not take: a build that predates the method says the same, and the
/// other machine may be updated later.
const PEER_METHOD_REFUSED: i64 = -32601;

fn undecided(e: &PeerError) -> bool {
    matches!(e, PeerError::Protocol(_) | PeerError::Rejected { code: PEER_INTERNAL_ERROR | PEER_METHOD_REFUSED, .. })
}

/// One call waiting to be delivered.
///
/// Only `id` is required: every other field has a default, so an entry written
/// by an older build still loads and a present-but-incomplete one never fails
/// the whole file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Entry {
    pub id: String,
    /// The machine the call goes to.
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Default)]
struct Contents {
    /// The last event number handed out per sub.
    seqs: BTreeMap<String, u64>,
    entries: Vec<Entry>,
}

/// Serialises read-modify-write of the file. Never held across an await.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn file_path() -> Option<PathBuf> {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::data_dir().ok().map(|d| d.join("subchats").join(format!("outbox{suffix}.json")))
}

fn no_data_dir() -> std::io::Error {
    std::io::Error::other("no data dir")
}

/// `Err` when the file exists but cannot be read now (locked): a writer stops
/// instead of replacing every entry with a list built from nothing. An entry or
/// a seq table that will not decode costs only itself (the whole text is kept as
/// `.bad` first, see [`super::super::jsonfile`]).
fn try_read_at(path: &Path) -> std::io::Result<Contents> {
    let Some(raw) = super::super::jsonfile::read_text_guarded(path)? else { return Ok(Contents::default()) };
    let value: Value = match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            super::super::jsonfile::keep_bad_copy(path, &raw, &e.to_string());
            return Ok(Contents::default());
        }
    };
    let mut out = Contents::default();
    let mut unreadable = 0;
    match value.get("seqs").cloned().map(serde_json::from_value::<BTreeMap<String, u64>>) {
        Some(Ok(seqs)) => out.seqs = seqs,
        Some(Err(_)) => unreadable += 1,
        None => {}
    }
    for entry in value.get("entries").and_then(Value::as_array).cloned().unwrap_or_default() {
        match serde_json::from_value::<Entry>(entry) {
            Ok(e) if !e.id.is_empty() => out.entries.push(e),
            _ => unreadable += 1,
        }
    }
    if unreadable > 0 {
        super::super::jsonfile::keep_bad_copy(path, &raw, &format!("{unreadable} of its parts did not decode"));
    }
    Ok(out)
}

fn write_at(path: &Path, c: &Contents) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string(&json!({ "seqs": c.seqs, "entries": c.entries })).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(path, &body)
}

fn now_ms() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}

fn push(c: &mut Contents, machine_id: &str, method: &str, params: Value) -> std::io::Result<String> {
    let size = serde_json::to_string(&params).map_or(usize::MAX, |s| s.len());
    if size > MAX_PARAMS_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{method} carries {size} bytes, over the {MAX_PARAMS_BYTES} an outbox entry may hold")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    c.entries.push(Entry {
        id: id.clone(),
        machine_id: machine_id.to_string(),
        method: method.to_string(),
        params,
        created_at: chrono::Utc::now().to_rfc3339(),
        attempts: 0,
    });
    // Oldest of this machine's entries goes first when it is over its share.
    let mine = c.entries.iter().filter(|e| e.machine_id == machine_id).count();
    if mine > MAX_PER_MACHINE {
        if let Some(at) = c.entries.iter().position(|e| e.machine_id == machine_id) {
            let dropped = c.entries.remove(at);
            log::warn!("subchats: outbox for {machine_id} is over {MAX_PER_MACHINE} entries, dropped the oldest ({})", dropped.method);
        }
    }
    Ok(id)
}

fn enqueue_at(path: &Path, machine_id: &str, method: &str, params: Value) -> std::io::Result<String> {
    let mut c = try_read_at(path)?;
    let id = push(&mut c, machine_id, method, params)?;
    write_at(path, &c)?;
    Ok(id)
}

/// A `sub_event` for `sub_id`: the number is handed out and the entry written in
/// one step, so numbers rise in the order events were queued. At least the clock
/// in milliseconds, so a lost seq table (an unreadable file kept as `.bad`) starts
/// above anything the receiver has seen instead of below it.
fn enqueue_event_at(path: &Path, machine_id: &str, sub_id: &str, event: Value) -> std::io::Result<(String, u64)> {
    let mut c = try_read_at(path)?;
    let seq = c.seqs.get(sub_id).map_or(0, |s| s + 1).max(now_ms());
    c.seqs.insert(sub_id.to_string(), seq);
    let id = push(&mut c, machine_id, "sub_event", json!({ "sub_id": sub_id, "seq": seq, "event": event }))?;
    write_at(path, &c)?;
    Ok((id, seq))
}

fn pending_at(path: &Path, machine_id: &str) -> Vec<Entry> {
    try_read_at(path).map(|c| c.entries.into_iter().filter(|e| e.machine_id == machine_id).collect()).unwrap_or_default()
}

fn settle_at(path: &Path, id: &str, delivered: bool) -> std::io::Result<()> {
    let mut c = try_read_at(path)?;
    let Some(at) = c.entries.iter().position(|e| e.id == id) else { return Ok(()) };
    if delivered {
        c.entries.remove(at);
    } else {
        c.entries[at].attempts = c.entries[at].attempts.saturating_add(1);
    }
    write_at(path, &c)
}

/// Leaves an entry as it is: the link was down, which says nothing about the entry.
fn nothing_at(_path: &Path, _id: &str) -> std::io::Result<()> {
    Ok(())
}

/// Drops every entry for `machine_id`; returns how many.
fn drop_machine_at(path: &Path, machine_id: &str) -> std::io::Result<usize> {
    let mut c = try_read_at(path)?;
    let before = c.entries.len();
    c.entries.retain(|e| e.machine_id != machine_id);
    let dropped = before - c.entries.len();
    if dropped > 0 {
        write_at(path, &c)?;
    }
    Ok(dropped)
}

/// Queues a call for `machine_id`. The entry is on disk before this returns.
pub fn enqueue(machine_id: &str, method: &str, params: Value) -> std::io::Result<String> {
    let path = file_path().ok_or_else(no_data_dir)?;
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    enqueue_at(&path, machine_id, method, params)
}

/// Queues a `sub_event` about `sub_id` for its home and returns the event number.
pub fn enqueue_event(machine_id: &str, sub_id: &str, event: Value) -> std::io::Result<u64> {
    let path = file_path().ok_or_else(no_data_dir)?;
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    enqueue_event_at(&path, machine_id, sub_id, event).map(|(_, seq)| seq)
}

/// What waits for `machine_id`, oldest first.
pub fn pending_for(machine_id: &str) -> Vec<Entry> {
    let Some(path) = file_path() else { return Vec::new() };
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    pending_at(&path, machine_id)
}

/// The machines something waits for.
pub fn machines_waiting() -> Vec<String> {
    let Some(path) = file_path() else { return Vec::new() };
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut machines: Vec<String> = Vec::new();
    for e in try_read_at(&path).map(|c| c.entries).unwrap_or_default() {
        if !machines.contains(&e.machine_id) {
            machines.push(e.machine_id);
        }
    }
    machines
}

/// What one delivery pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Delivery {
    /// Entries removed (a reply came, good or error).
    pub settled: usize,
    /// The pass stopped at an entry the link could not carry: it and everything
    /// behind it wait for the next pass, so order holds.
    pub stalled: bool,
}

/// Machines a delivery pass is running for, so two passes never send the same
/// entry twice at once.
static DELIVERING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct PassGuard(String);

impl PassGuard {
    fn claim(machine_id: &str) -> Option<PassGuard> {
        let mut g = DELIVERING.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(Default::default).insert(machine_id.to_string()).then(|| PassGuard(machine_id.to_string()))
    }
}

impl Drop for PassGuard {
    fn drop(&mut self) {
        if let Some(set) = DELIVERING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Delivers `machine_id`'s entries in order through `send` until one cannot be
/// carried. A reply settles an entry whatever it says: `Ok` is delivered, an error
/// reply (`Rejected`, or a refusal by the peer's transport table) is logged and
/// dropped, since resending it would be refused again. A link failure leaves the
/// entry and everything after it for the next pass. Returns at once when a pass for
/// this machine is already running.
pub async fn deliver_with<F, Fut>(path: &Path, machine_id: &str, mut send: F) -> Delivery
where
    F: FnMut(Entry) -> Fut,
    Fut: Future<Output = Result<Value, PeerError>>,
{
    let mut out = Delivery::default();
    let Some(_pass) = PassGuard::claim(machine_id) else { return out };
    loop {
        let waiting = {
            let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            pending_at(path, machine_id)
        };
        let Some(entry) = waiting.into_iter().next() else { return out };
        let (id, method, attempts) = (entry.id.clone(), entry.method.clone(), entry.attempts);
        let mut counts_as_attempt = false;
        let settled = match send(entry).await {
            Ok(_) => true,
            Err(e) if undecided(&e) && attempts + 1 >= MAX_UNDECIDED_ATTEMPTS => {
                log::warn!("subchats: {machine_id} gave no decision on the queued {method} in {MAX_UNDECIDED_ATTEMPTS} attempts ({e}); dropped");
                true
            }
            Err(PeerError::Rejected { code, message }) if code != PEER_INTERNAL_ERROR && code != PEER_METHOD_REFUSED => {
                log::warn!("subchats: {machine_id} refused the queued {method} ({code}): {message}; dropped");
                true
            }
            Err(e) => {
                log::debug!("subchats: the queued {method} for {machine_id} waits: {e}");
                // Only a reply that decided nothing counts toward the limit, never a link that was down.
                counts_as_attempt = undecided(&e);
                false
            }
        };
        let write = {
            let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            if settled || counts_as_attempt {
                settle_at(path, &id, settled)
            } else {
                nothing_at(path, &id)
            }
        };
        if let Err(e) = write {
            log::warn!("subchats: could not update the outbox after {method}: {e}");
            out.stalled = true;
            return out;
        }
        if !settled {
            out.stalled = true;
            return out;
        }
        out.settled += 1;
    }
}

/// [`deliver_with`] over the real outbox file and the paired link to `machine_id`.
pub async fn deliver(state: &std::sync::Arc<crate::daemon::state::DaemonState>, machine_id: &str) -> Delivery {
    let Some(path) = file_path() else { return Delivery::default() };
    // A machine that is not paired any more can never be reached: its entries would
    // block the queue behind them until the cap rotated them out.
    if state.machines.get().is_some_and(|r| r.peer(machine_id).is_none()) {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        match drop_machine_at(&path, machine_id) {
            Ok(0) => {}
            Ok(n) => log::warn!("subchats: {machine_id} is not paired any more, dropped its {n} queued call(s)"),
            Err(e) => log::warn!("subchats: could not drop the outbox of the unpaired machine {machine_id}: {e}"),
        }
        return Delivery::default();
    }
    deliver_with(&path, machine_id, |entry| {
        let state = state.clone();
        async move {
            let Some(peer) = state.machines.get().and_then(|r| r.peer(&entry.machine_id)) else {
                return Err(PeerError::Unreachable("that machine is no longer paired".to_string()));
            };
            let client = crate::daemon::machines::client_for(&state, &peer).await?;
            client.call_with_timeout(&entry.method, entry.params.clone(), std::time::Duration::from_secs(30)).await
        }
    })
    .await
}

/// Starts a delivery pass for every machine something waits for, detached. The
/// busy_watchdog tick and a connecting peer link call this; with no runtime there
/// is nothing to send with and the next tick finds the entries.
pub fn flush_in_background(state: &std::sync::Arc<crate::daemon::state::DaemonState>) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    for machine_id in machines_waiting() {
        let state = state.clone();
        handle.spawn(async move {
            deliver(&state, &machine_id).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subchats").join("outbox-test.json");
        (dir, path)
    }

    fn methods(path: &Path, machine: &str) -> Vec<String> {
        pending_at(path, machine).into_iter().map(|e| e.method).collect()
    }

    #[test]
    fn an_entry_is_on_disk_before_any_send_and_keeps_its_order_per_machine() {
        let (_d, path) = file();
        enqueue_at(&path, "mac", "a", json!({})).unwrap();
        enqueue_at(&path, "other", "x", json!({})).unwrap();
        enqueue_at(&path, "mac", "b", json!({})).unwrap();
        assert_eq!(methods(&path, "mac"), ["a", "b"]);
        assert_eq!(methods(&path, "other"), ["x"]);
        assert!(methods(&path, "nobody").is_empty());
    }

    #[test]
    fn event_numbers_rise_per_sub_and_are_never_reused_after_delivery() {
        let (_d, path) = file();
        let (_, first) = enqueue_event_at(&path, "pc", "sub-1", json!({"kind": "ended"})).unwrap();
        let (_, second) = enqueue_event_at(&path, "pc", "sub-1", json!({"kind": "ended"})).unwrap();
        assert!(second > first, "{first} then {second}");
        // Delivered and removed: the table still remembers the number.
        for e in pending_at(&path, "pc") {
            settle_at(&path, &e.id, true).unwrap();
        }
        let (_, third) = enqueue_event_at(&path, "pc", "sub-1", json!({"kind": "ended"})).unwrap();
        assert!(third > second, "a delivered event's number is not handed out again");
    }

    #[test]
    fn a_lost_number_table_restarts_above_the_clock_not_at_one() {
        let (_d, path) = file();
        let (_, seq) = enqueue_event_at(&path, "pc", "sub-1", json!({})).unwrap();
        assert!(seq >= now_ms() - 5_000, "{seq}");
    }

    #[test]
    fn a_call_over_the_size_cap_is_refused_and_writes_nothing() {
        let (_d, path) = file();
        let big = json!({ "blob": "x".repeat(MAX_PARAMS_BYTES + 1) });
        let err = enqueue_at(&path, "mac", "sub_event", big).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(pending_at(&path, "mac").is_empty());
    }

    #[test]
    fn a_machine_over_its_share_loses_its_oldest_entry_and_no_other_machines() {
        let (_d, path) = file();
        enqueue_at(&path, "other", "keep", json!({})).unwrap();
        for n in 0..=MAX_PER_MACHINE {
            enqueue_at(&path, "mac", &format!("m{n}"), json!({})).unwrap();
        }
        let mac = methods(&path, "mac");
        assert_eq!(mac.len(), MAX_PER_MACHINE);
        assert_eq!(mac[0], "m1", "m0 was the oldest");
        assert_eq!(methods(&path, "other"), ["keep"]);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_an_unreadable_entry_costs_only_itself() {
        let (_d, path) = file();
        enqueue_at(&path, "mac", "good", json!({})).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let mut v: Value = serde_json::from_str(&text).unwrap();
        v["entries"].as_array_mut().unwrap().push(json!({ "id": 7 }));
        std::fs::write(&path, v.to_string()).unwrap();
        assert_eq!(methods(&path, "mac"), ["good"], "the entry that will not decode is skipped");
        let kept = |p: &Path| {
            std::fs::read_dir(p.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".bad")).count()
        };
        assert_eq!(kept(&path), 1, "the whole text was kept before anything was rewritten");
        std::fs::write(&path, "{not json").unwrap();
        assert!(pending_at(&path, "mac").is_empty());
        assert_eq!(kept(&path), 2);
    }

    #[tokio::test]
    async fn delivery_goes_in_order_and_removes_each_entry_on_a_reply() {
        let (_d, path) = file();
        for m in ["a", "b", "c"] {
            enqueue_at(&path, "mac-delivery_goes_in_ord", m, json!({})).unwrap();
        }
        let sent = Arc::new(Mutex::new(Vec::new()));
        let log = sent.clone();
        let out = deliver_with(&path, "mac-delivery_goes_in_ord", |e| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(e.method);
                Ok(json!({"ok": true}))
            }
        })
        .await;
        assert_eq!(out, Delivery { settled: 3, stalled: false });
        assert_eq!(sent.lock().unwrap().as_slice(), ["a", "b", "c"]);
        assert!(pending_at(&path, "mac-delivery_goes_in_ord").is_empty());
    }

    #[tokio::test]
    async fn a_down_link_stops_the_pass_at_the_first_entry_and_keeps_the_rest_behind_it() {
        let (_d, path) = file();
        for m in ["a", "b"] {
            enqueue_at(&path, "mac-a_down_link_stops_th", m, json!({})).unwrap();
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let out = deliver_with(&path, "mac-a_down_link_stops_th", |_| {
            n.fetch_add(1, Ordering::SeqCst);
            async { Err(PeerError::NotSent("down".into())) }
        })
        .await;
        assert_eq!(out, Delivery { settled: 0, stalled: true });
        assert_eq!(calls.load(Ordering::SeqCst), 1, "b is never tried ahead of a");
        let left = pending_at(&path, "mac-a_down_link_stops_th");
        assert_eq!(left.iter().map(|e| e.method.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!((left[0].attempts, left[1].attempts), (0, 0), "a link that was down says nothing about the entry");
    }

    #[tokio::test]
    async fn an_error_reply_drops_that_entry_and_the_pass_goes_on() {
        let (_d, path) = file();
        for m in ["refused", "next"] {
            enqueue_at(&path, "mac-an_error_reply_drops", m, json!({})).unwrap();
        }
        let out = deliver_with(&path, "mac-an_error_reply_drops", |e| async move {
            if e.method == "refused" {
                Err(PeerError::Rejected { code: -32602, message: "not your sub".into() })
            } else {
                Ok(json!({}))
            }
        })
        .await;
        assert_eq!(out, Delivery { settled: 2, stalled: false });
        assert!(pending_at(&path, "mac-an_error_reply_drops").is_empty(), "an error reply is dropped, not retried for ever");
    }

    #[tokio::test]
    async fn a_peer_that_never_answers_readably_is_dropped_after_its_attempts() {
        let (_d, path) = file();
        enqueue_at(&path, "mac-a_peer_that_never_an", "junk", json!({})).unwrap();
        for _ in 0..MAX_UNDECIDED_ATTEMPTS - 1 {
            let out = deliver_with(&path, "mac-a_peer_that_never_an", |_| async { Err(PeerError::Protocol("not json".into())) }).await;
            assert!(out.stalled);
        }
        assert_eq!(pending_at(&path, "mac-a_peer_that_never_an").len(), 1);
        let out = deliver_with(&path, "mac-a_peer_that_never_an", |_| async { Err(PeerError::Protocol("not json".into())) }).await;
        assert_eq!(out, Delivery { settled: 1, stalled: false });
        assert!(pending_at(&path, "mac-a_peer_that_never_an").is_empty());
    }

    #[tokio::test]
    async fn the_peers_own_failure_is_retried_and_its_refusal_is_not() {
        let (_d, path) = file();
        enqueue_at(&path, "mac-the_peers_own_failure", "ev", json!({})).unwrap();
        // Its disk write failed: a later attempt may get past that.
        let out = deliver_with(&path, "mac-the_peers_own_failure", |_| async { Err(PeerError::Rejected { code: PEER_INTERNAL_ERROR, message: "disk".into() }) }).await;
        assert_eq!(out, Delivery { settled: 0, stalled: true });
        assert_eq!(pending_at(&path, "mac-the_peers_own_failure")[0].attempts, 1);
    }

    /// A long outage must not use up the attempts a peer's real failure is allowed.
    #[tokio::test]
    async fn an_outage_of_many_passes_does_not_spend_the_attempts_of_a_later_bad_reply() {
        let (_d, path) = file();
        let m = "mac-an_outage_of_many_passes";
        enqueue_at(&path, m, "sub_event", json!({})).unwrap();
        for _ in 0..MAX_UNDECIDED_ATTEMPTS + 5 {
            let out = deliver_with(&path, m, |_| async { Err(PeerError::Unreachable("asleep".into())) }).await;
            assert!(out.stalled);
        }
        let out = deliver_with(&path, m, |_| async { Err(PeerError::Protocol("not json".into())) }).await;
        assert_eq!(out, Delivery { settled: 0, stalled: true });
        assert_eq!(pending_at(&path, m).len(), 1, "one bad reply after an outage keeps the entry");
    }

    #[tokio::test]
    async fn a_peer_that_does_not_know_the_method_yet_is_retried_not_dropped_at_once() {
        let (_d, path) = file();
        let m = "mac-a_peer_that_does_not_know";
        enqueue_at(&path, m, "sub_event", json!({})).unwrap();
        let out = deliver_with(&path, m, |_| async { Err(PeerError::Rejected { code: PEER_METHOD_REFUSED, message: "method not found".into() }) }).await;
        assert_eq!(out, Delivery { settled: 0, stalled: true });
        assert_eq!(pending_at(&path, m).len(), 1);
    }

    #[test]
    fn the_calls_for_an_unpaired_machine_can_be_dropped_without_touching_the_others() {
        let (_d, path) = file();
        enqueue_at(&path, "gone", "a", json!({})).unwrap();
        enqueue_at(&path, "gone", "b", json!({})).unwrap();
        enqueue_at(&path, "kept", "c", json!({})).unwrap();
        assert_eq!(drop_machine_at(&path, "gone").unwrap(), 2);
        assert_eq!(drop_machine_at(&path, "gone").unwrap(), 0);
        assert_eq!(methods(&path, "kept"), ["c"]);
    }

    #[tokio::test]
    async fn a_second_pass_for_the_same_machine_while_one_runs_sends_nothing() {
        let (_d, path) = file();
        enqueue_at(&path, "mac-a_second_pass_for_th", "a", json!({})).unwrap();
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let gate = Arc::new(tokio::sync::Mutex::new(Some(gate)));
        let first = {
            let path = path.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                deliver_with(&path, "mac-a_second_pass_for_th", |_| {
                    let gate = gate.clone();
                    async move {
                        let g = gate.lock().await.take();
                        if let Some(g) = g {
                            let _ = g.await;
                        }
                        Ok(json!({}))
                    }
                })
                .await
            })
        };
        // Let the first pass reach its send and park there.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let sent = Arc::new(AtomicUsize::new(0));
        let n = sent.clone();
        let second = deliver_with(&path, "mac-a_second_pass_for_th", |_| {
            n.fetch_add(1, Ordering::SeqCst);
            async { Ok(json!({})) }
        })
        .await;
        assert_eq!(second, Delivery::default());
        assert_eq!(sent.load(Ordering::SeqCst), 0, "the entry in flight is not sent twice");
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().settled, 1);
    }
}
