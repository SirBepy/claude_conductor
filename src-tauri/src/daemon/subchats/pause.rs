//! Why a sub that went quiet or stopped without finishing is not in trouble.
//! One answer for the Stop hook, the stuck sweep, the dead-process sweep, the
//! exit handler and the ceiling's busy clock, so they cannot drift apart.
//!
//! Three things pause a sub without the sub's say-so, and only one of them
//! sets `Instance::frozen`:
//! - a freeze: Joe's, or the auto-freeze a rate-limit rejection sets;
//! - the account being rate limited, which holds every sub on it, including one
//!   the rejection has not reached yet (`rate_limited_resets_at`);
//! - a gaming-mode park, which sends a message and freezes nothing.

use crate::types::Instance;

/// The account is blocked until a time still ahead of `now_ts` (unix seconds).
pub fn is_rate_limited(inst: &Instance, now_ts: i64) -> bool {
    inst.rate_limited_resets_at.is_some_and(|resets_at| resets_at > now_ts)
}

/// Whether `inst` is paused by something other than its own work.
pub fn is_paused(inst: &Instance, now_ts: i64) -> bool {
    inst.frozen || is_rate_limited(inst, now_ts) || crate::daemon::gaming_mode::is_parked(&inst.session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub() -> Instance {
        let reg = crate::sessions::registry::Registry::new();
        reg.upsert_interactive("pause-sub", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        reg.get("pause-sub").unwrap()
    }

    #[test]
    fn a_future_reset_pauses_a_sub_and_a_past_one_does_not() {
        let mut i = sub();
        assert!(!is_paused(&i, 1_000));
        i.rate_limited_resets_at = Some(2_000);
        assert!(is_paused(&i, 1_000), "blocked until 2000");
        assert!(!is_paused(&i, 2_000), "the window is over at the reset");
        assert!(!is_paused(&i, 3_000));
    }

    #[test]
    fn a_freeze_pauses_a_sub() {
        let mut i = sub();
        i.frozen = true;
        assert!(is_paused(&i, 0));
    }
}
