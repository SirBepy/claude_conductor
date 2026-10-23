//! Keeps the dashboard's vault-seeded groups current without re-reading the
//! Obsidian vault on every call: the vault only changes when the dev edits a
//! client note, so a minute of lag is invisible and a vault scan per
//! dashboard read would not be.

use crate::daemon::state::DaemonState;
use crate::project_dashboard::{seed_groups, store};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SEED_INTERVAL: Duration = Duration::from_secs(60);

static LAST_SEED: Mutex<Option<Instant>> = Mutex::new(None);

/// Pure so the throttle is testable without sleeping.
fn due(last: Option<Instant>, now: Instant) -> bool {
    match last {
        None => true,
        Some(t) => now.saturating_duration_since(t) >= SEED_INTERVAL,
    }
}

/// Seeds vault client groups into the store, at most once per minute per
/// process. Takes the daemon state (not nothing) because the known project
/// paths come from its settings cache, the one read-only settings source a
/// daemon method has.
pub(crate) fn ensure_seeded(state: &DaemonState) {
    {
        let mut last = LAST_SEED.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if !due(*last, now) {
            return;
        }
        // Stamped before the work, so a vault that is missing or slow to read
        // is retried a minute later rather than on every call.
        *last = Some(now);
    }
    let Some(vault) = crate::people::vault_dir() else { return };
    let clients = crate::people::clients_at(&vault);
    if clients.is_empty() {
        return;
    }
    let paths: Vec<String> =
        state.settings.snapshot().projects.iter().map(|p| p.path.to_string_lossy().into_owned()).collect();
    store::update(|s| seed_groups(s, &clients, &paths));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_call_is_always_due() {
        assert!(due(None, Instant::now()));
    }

    #[test]
    fn a_call_inside_the_minute_is_throttled() {
        let t0 = Instant::now();
        assert!(!due(Some(t0), t0));
        assert!(!due(Some(t0), t0 + Duration::from_secs(59)));
    }

    #[test]
    fn a_call_at_or_after_the_minute_is_due() {
        let t0 = Instant::now();
        assert!(due(Some(t0), t0 + Duration::from_secs(60)));
        assert!(due(Some(t0), t0 + Duration::from_secs(600)));
    }

    #[test]
    fn a_clock_that_runs_backwards_does_not_panic_or_fire() {
        let t0 = Instant::now() + Duration::from_secs(10);
        assert!(!due(Some(t0), t0 - Duration::from_secs(5)));
    }
}
