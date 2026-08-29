//! Idempotency guard for `start_session` (todo 228). A connection dying mid-RPC
//! never cancels the spawn - the child boots and registers, only the reply is
//! lost - so a retry would otherwise produce a second chat plus an orphan. A
//! claim locks the caller's token across the spawn; a retry waits, then reads it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// How long a spawn outcome stays resolvable: covers a pipe drop, the app's
/// reconnect, and a hand retry a beat later.
const TTL: Duration = Duration::from_secs(120);

struct Record {
    session_id: String,
    at: Instant,
}

#[derive(Default)]
pub struct StartTokens {
    slots: Mutex<HashMap<String, Arc<Mutex<Option<Record>>>>>,
}

/// Exclusive hold on one token. Keep it alive for the whole spawn.
pub struct Claim {
    cell: OwnedMutexGuard<Option<Record>>,
}

impl Claim {
    /// The session a previous call under this token already spawned, if still
    /// within [`TTL`]. `None` means the caller should spawn.
    pub fn existing(&self) -> Option<&str> {
        self.cell
            .as_ref()
            .filter(|r| r.at.elapsed() < TTL)
            .map(|r| r.session_id.as_str())
    }

    pub fn record(&mut self, session_id: &str) {
        *self.cell = Some(Record { session_id: session_id.to_string(), at: Instant::now() });
    }
}

impl StartTokens {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn claim(&self, token: &str) -> Claim {
        let cell = {
            let mut slots = self.slots.lock().await;
            // One placeholder id per new chat, so without this the map grows for
            // the daemon's whole lifetime.
            slots.retain(|_, cell| {
                Arc::strong_count(cell) > 1
                    || cell.try_lock().is_ok_and(|r| {
                        r.as_ref().is_some_and(|rec| rec.at.elapsed() < TTL)
                    })
            });
            slots.entry(token.to_string()).or_default().clone()
        };
        Claim { cell: cell.lock_owned().await }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn second_claim_sees_the_first_spawn() {
        let tokens = StartTokens::new();
        {
            let mut c = tokens.claim("ph-1").await;
            assert_eq!(c.existing(), None);
            c.record("sess-a");
        }
        let c = tokens.claim("ph-1").await;
        assert_eq!(c.existing(), Some("sess-a"));
    }

    #[tokio::test]
    async fn distinct_tokens_do_not_share() {
        let tokens = StartTokens::new();
        tokens.claim("ph-1").await.record("sess-a");
        let c = tokens.claim("ph-2").await;
        assert_eq!(c.existing(), None);
    }

    /// A retry arriving while the original spawn is still in flight must wait,
    /// then resolve to the same session rather than spawning its own.
    #[tokio::test]
    async fn concurrent_claim_waits_for_the_in_flight_spawn() {
        let tokens = Arc::new(StartTokens::new());
        let mut first = tokens.claim("ph-1").await;

        let racer = {
            let tokens = tokens.clone();
            tokio::spawn(async move {
                let c = tokens.claim("ph-1").await;
                c.existing().map(str::to_string)
            })
        };

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!racer.is_finished(), "the second claim should still be blocked");
        first.record("sess-a");
        drop(first);

        assert_eq!(racer.await.unwrap().as_deref(), Some("sess-a"));
    }

    #[tokio::test]
    async fn empty_slots_are_pruned() {
        let tokens = StartTokens::new();
        drop(tokens.claim("ph-1").await);
        drop(tokens.claim("ph-2").await);
        assert!(tokens.slots.lock().await.len() <= 1, "unrecorded slots must not accumulate");
    }
}
