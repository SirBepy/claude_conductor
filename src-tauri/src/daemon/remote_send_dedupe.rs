//! Idempotency store for the phone's `POST /api/sessions/:id/send`.
//!
//! The phone shows "Failed to send" when a response is lost, and its Retry (or
//! the held-queue re-stage after a 409) posts the same text again. Each send
//! carries a `client_msg_id`; a repeat of an id that already succeeded for that
//! session answers 200 and sends nothing.
//!
//! Memory only, on purpose: a daemon restart inside the 30 minute window may
//! deliver one message twice, which is cheaper than a persistence layer for a
//! window this short. Only a success is remembered, so a 409/402/404/500
//! attempt leaves the id reusable and the phone's held-queue retry keeps working.
//! Expiry and the size cap are checked lazily on insert; there is no sweeper task.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

/// How long a delivered id keeps answering "already sent".
pub(super) const SUCCESS_TTL_MS: i64 = 30 * 60 * 1000;
/// Entry cap; the oldest succeeded entry goes first.
pub(super) const MAX_ENTRIES: usize = 512;
/// How long a repeat waits for the first copy still in flight.
pub(super) const WAIT_LIMIT: Duration = Duration::from_secs(30);

/// `Some(id)` only for 1-64 chars of `[A-Za-z0-9_-]`. An absent or malformed id
/// means "no dedupe", never an error: older pages send none.
pub(super) fn valid_id(raw: Option<&str>) -> Option<&str> {
    let id = raw?;
    let ok = (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then_some(id)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Flight {
    Pending,
    Succeeded,
    Failed,
}

enum Entry {
    InFlight { seq: u64, tx: watch::Sender<Flight> },
    Succeeded { seq: u64, at_ms: i64 },
}

impl Entry {
    fn seq(&self) -> u64 {
        match self {
            Entry::InFlight { seq, .. } | Entry::Succeeded { seq, .. } => *seq,
        }
    }
}

#[derive(Default)]
struct Inner {
    map: HashMap<(String, String), Entry>,
    next_seq: u64,
}

#[derive(Default)]
pub(super) struct SendDedupe {
    inner: Arc<Mutex<Inner>>,
}

pub(super) enum Begin {
    /// First copy: deliver, then call `SendGuard::succeed`. Dropping the guard
    /// any other way forgets the id.
    Fresh(SendGuard),
    /// The first copy is still running.
    InFlight(Waiter),
    /// A copy already delivered.
    AlreadySent,
}

pub(super) enum Waited {
    Succeeded,
    /// The first copy failed; the caller runs as a fresh attempt.
    Failed,
    /// Still running after `WAIT_LIMIT`; the caller answers 409 so the phone
    /// re-stages the send and the retry then finds the id delivered.
    TimedOut,
}

pub(super) struct Waiter {
    rx: watch::Receiver<Flight>,
}

impl Waiter {
    pub(super) async fn wait(mut self, limit: Duration) -> Waited {
        let settled = tokio::time::timeout(limit, self.rx.wait_for(|f| *f != Flight::Pending)).await;
        match settled {
            Err(_) => Waited::TimedOut,
            Ok(Ok(f)) if *f == Flight::Succeeded => Waited::Succeeded,
            // A closed channel means the guard went away without a verdict.
            Ok(_) => Waited::Failed,
        }
    }
}

pub(super) struct SendGuard {
    inner: Arc<Mutex<Inner>>,
    key: (String, String),
    seq: u64,
    now_ms: i64,
    tx: watch::Sender<Flight>,
    done: bool,
}

impl SendGuard {
    pub(super) fn succeed(mut self) {
        self.done = true;
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if g.map.get(&self.key).map(Entry::seq) == Some(self.seq) {
                g.map.insert(self.key.clone(), Entry::Succeeded { seq: self.seq, at_ms: self.now_ms });
            }
        }
        self.tx.send_replace(Flight::Succeeded);
    }
}

impl Drop for SendGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if g.map.get(&self.key).map(Entry::seq) == Some(self.seq) {
                g.map.remove(&self.key);
            }
        }
        self.tx.send_replace(Flight::Failed);
    }
}

impl SendDedupe {
    /// `now_ms` is passed in so expiry is testable without sleeping.
    pub(super) fn begin(&self, session_id: &str, client_msg_id: &str, now_ms: i64) -> Begin {
        let key = (session_id.to_string(), client_msg_id.to_string());
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.map.retain(|_, e| match e {
            Entry::Succeeded { at_ms, .. } => now_ms - *at_ms < SUCCESS_TTL_MS,
            Entry::InFlight { .. } => true,
        });
        match g.map.get(&key) {
            Some(Entry::Succeeded { .. }) => return Begin::AlreadySent,
            Some(Entry::InFlight { tx, .. }) => return Begin::InFlight(Waiter { rx: tx.subscribe() }),
            None => {}
        }
        // Only succeeded entries are evicted: an in-flight one is bounded by
        // the server's own in-flight request limit and its guard still owns it.
        while g.map.len() >= MAX_ENTRIES {
            let oldest = g
                .map
                .iter()
                .filter(|(_, e)| matches!(e, Entry::Succeeded { .. }))
                .min_by_key(|(_, e)| e.seq())
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    g.map.remove(&k);
                }
                None => break,
            }
        }
        let seq = g.next_seq;
        g.next_seq += 1;
        let (tx, _rx) = watch::channel(Flight::Pending);
        g.map.insert(key.clone(), Entry::InFlight { seq, tx: tx.clone() });
        Begin::Fresh(SendGuard { inner: self.inner.clone(), key, seq, now_ms, tx, done: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(b: Begin) -> SendGuard {
        match b {
            Begin::Fresh(g) => g,
            Begin::InFlight(_) => panic!("expected Fresh, got InFlight"),
            Begin::AlreadySent => panic!("expected Fresh, got AlreadySent"),
        }
    }

    #[test]
    fn a_repeat_of_a_succeeded_id_is_already_sent() {
        let d = SendDedupe::default();
        fresh(d.begin("s1", "m1", 0)).succeed();
        assert!(matches!(d.begin("s1", "m1", 1000), Begin::AlreadySent));
        // Another session's identical id is a different send.
        assert!(matches!(d.begin("s2", "m1", 1000), Begin::Fresh(_)));
    }

    #[test]
    fn a_failed_attempt_leaves_the_id_reusable() {
        let d = SendDedupe::default();
        drop(fresh(d.begin("s1", "m1", 0)));
        assert!(matches!(d.begin("s1", "m1", 1), Begin::Fresh(_)));
    }

    #[tokio::test]
    async fn a_repeat_during_flight_waits_and_sees_the_success() {
        let d = SendDedupe::default();
        let guard = fresh(d.begin("s1", "m1", 0));
        let Begin::InFlight(w) = d.begin("s1", "m1", 1) else { panic!("expected InFlight") };
        let waiting = tokio::spawn(w.wait(Duration::from_secs(5)));
        tokio::task::yield_now().await;
        guard.succeed();
        assert!(matches!(waiting.await.unwrap(), Waited::Succeeded));
    }

    #[tokio::test]
    async fn a_repeat_during_flight_sees_the_first_copys_failure() {
        let d = SendDedupe::default();
        let guard = fresh(d.begin("s1", "m1", 0));
        let Begin::InFlight(w) = d.begin("s1", "m1", 1) else { panic!("expected InFlight") };
        drop(guard);
        assert!(matches!(w.wait(Duration::from_secs(5)).await, Waited::Failed));
    }

    #[tokio::test]
    async fn a_wait_is_bounded() {
        let d = SendDedupe::default();
        let _guard = fresh(d.begin("s1", "m1", 0));
        let Begin::InFlight(w) = d.begin("s1", "m1", 1) else { panic!("expected InFlight") };
        assert!(matches!(w.wait(Duration::from_millis(20)).await, Waited::TimedOut));
    }

    #[test]
    fn an_entry_older_than_the_ttl_is_forgotten() {
        let d = SendDedupe::default();
        fresh(d.begin("s1", "m1", 0)).succeed();
        assert!(matches!(d.begin("s1", "m1", SUCCESS_TTL_MS - 1), Begin::AlreadySent));
        assert!(matches!(d.begin("s1", "m1", SUCCESS_TTL_MS), Begin::Fresh(_)));
    }

    #[test]
    fn the_cap_evicts_the_oldest() {
        let d = SendDedupe::default();
        for i in 0..MAX_ENTRIES {
            fresh(d.begin("s1", &format!("m{i}"), 0)).succeed();
        }
        fresh(d.begin("s1", "overflow", 0)).succeed();
        assert!(matches!(d.begin("s1", "m0", 1), Begin::Fresh(_)), "the oldest was evicted");
        assert!(matches!(d.begin("s1", "overflow", 1), Begin::AlreadySent));
        assert!(matches!(d.begin("s1", &format!("m{}", MAX_ENTRIES - 1), 1), Begin::AlreadySent));
    }

    #[test]
    fn an_invalid_id_is_treated_as_absent() {
        assert_eq!(valid_id(None), None);
        assert_eq!(valid_id(Some("")), None);
        assert_eq!(valid_id(Some(&"a".repeat(65))), None);
        assert_eq!(valid_id(Some("has space")), None);
        assert_eq!(valid_id(Some("a/b")), None);
        assert_eq!(valid_id(Some(&"a".repeat(64))), Some("a".repeat(64)).as_deref());
        assert_eq!(valid_id(Some("Ab_9-z")), Some("Ab_9-z"));
    }
}
