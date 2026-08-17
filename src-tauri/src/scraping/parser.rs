//! Pure math + formatting helpers. No Tauri deps. `now` is always injected
//! so tests stay deterministic.

use crate::types::UsageSnapshot;
use chrono::{DateTime, Utc};

pub const FIVE_HOUR_MS: i64 = 5 * 3_600_000;
pub const SEVEN_DAY_MS: i64 = 7 * 24 * 3_600_000;

pub fn session_pct(snap: &UsageSnapshot) -> f32 { snap.five_hour.utilization as f32 }
pub fn weekly_pct(snap: &UsageSnapshot) -> f32 { snap.seven_day.utilization as f32 }

pub fn calc_safe_pct(resets_at: &str, window_ms: i64, now: DateTime<Utc>) -> Option<f32> {
    let resets = DateTime::parse_from_rfc3339(resets_at).ok()?.with_timezone(&Utc);
    let elapsed = window_ms - (resets - now).num_milliseconds();
    if elapsed < 0 || elapsed > window_ms { return None; }
    Some((elapsed as f32 / window_ms as f32) * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn calc_safe_pct_at_window_start_is_zero() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!(safe < 0.1);
    }

    #[test]
    fn calc_safe_pct_at_halfway_is_fifty() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 12, 30, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!((safe - 50.0).abs() < 0.1);
    }

    #[test]
    fn calc_safe_pct_after_reset_returns_none() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 16, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        assert!(calc_safe_pct(resets, FIVE_HOUR_MS, now).is_none());
    }
}
