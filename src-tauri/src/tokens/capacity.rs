//! Self-calibrating estimate of ONE window's capacity, measured in cost-weighted
//! drain units. Anthropic never exposes the absolute token cap of a 5h / weekly
//! window — only a utilization percent — so we back the capacity out by division:
//! `capacity ≈ (visible drain in the window) / (utilization fraction)`. We only
//! trust samples above a utilization floor (below it the division is dominated by
//! noise and explodes) and smooth with a light EWMA so one reading can't swing
//! the displayed size. Persisted so a chat's "% of a 5h session" shows a stable
//! value across restarts and while the live utilization happens to be low.
//!
//! This is the honest, subscription-friendly successor to the old USD quota: the
//! unit is a relative cost-weight, never a dollar, and it is used only as the
//! denominator of a size ratio.

use std::path::Path;

/// EWMA smoothing factor. Higher = snappier, lower = steadier.
const ALPHA: f64 = 0.3;
/// Minimum utilization (percent) before we trust a window's sample. Below this,
/// `drain / (util/100)` divides by near-noise and the estimate explodes, so we
/// carry the previous capacity instead. Higher than a bare noise floor because a
/// stable size ruler matters more than reacting to every faint sample.
pub const UTIL_FLOOR_PCT: f64 = 15.0;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapacityEstimate {
    /// Estimated capacity of one 5h window, in cost-weighted drain units.
    pub capacity_5h_units: f64,
    /// Estimated capacity of one weekly window, in cost-weighted drain units.
    pub capacity_weekly_units: f64,
    pub samples: u32,
    /// RFC 3339; used to rate-limit the expensive recalibration.
    pub updated_at: String,
}

/// Loads the persisted estimate. A missing or corrupt file yields the all-zero
/// `Default` — never an error, never a panic.
pub fn load(path: &Path) -> CapacityEstimate {
    let Ok(raw) = std::fs::read_to_string(path) else { return CapacityEstimate::default() };
    if raw.trim().is_empty() { return CapacityEstimate::default() }
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persists the estimate atomically (tmp-then-rename via `write_json_atomic`,
/// which also creates the parent dir if needed).
pub fn save(path: &Path, c: &CapacityEstimate) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(c)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    crate::util::write_json_atomic(path, &json)
}

/// EWMA one window's capacity toward its instantaneous estimate. Below the
/// utilization floor (or with no visible drain) the instantaneous estimate is
/// divide-by-noise, so we carry `prev`. `visible_drain` is the summed
/// cost-weighted drain of all visible chats since the window started;
/// `util_pct` is a PERCENT (26.0 = 26%).
pub fn calibrate_window(prev: f64, visible_drain: f64, util_pct: f64) -> f64 {
    if util_pct < UTIL_FLOOR_PCT || visible_drain <= 0.0 {
        return prev;
    }
    let instantaneous = visible_drain / (util_pct / 100.0);
    if prev <= 0.0 {
        // First real sample seeds the EWMA directly rather than crawling from 0.
        instantaneous
    } else {
        prev + ALPHA * (instantaneous - prev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_missing_or_corrupt_is_default() {
        let dir = tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.json")).samples, 0);
        let corrupt = dir.path().join("c.json");
        std::fs::write(&corrupt, "{ not json").unwrap();
        let c = load(&corrupt);
        assert_eq!(c.samples, 0);
        assert_eq!(c.capacity_5h_units, 0.0);
    }

    #[test]
    fn save_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session-capacity.json");
        let c = CapacityEstimate {
            capacity_5h_units: 12.5,
            capacity_weekly_units: 300.0,
            samples: 7,
            updated_at: "2026-06-22T00:00:00+00:00".into(),
        };
        save(&path, &c).unwrap();
        let back = load(&path);
        assert_eq!(back.capacity_5h_units, 12.5);
        assert_eq!(back.capacity_weekly_units, 300.0);
        assert_eq!(back.samples, 7);
        // write_json_atomic renames its tmp sibling away on success; a leftover
        // here would mean the write never completed atomically.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn below_floor_carries_previous() {
        // 10% util is under the 15% floor: capacity must be carried verbatim.
        assert_eq!(calibrate_window(20.0, 0.5, 10.0), 20.0);
        // Zero visible drain also carries previous, even above the floor.
        assert_eq!(calibrate_window(20.0, 0.0, 50.0), 20.0);
    }

    #[test]
    fn first_sample_seeds_directly() {
        // prev 0, drain 5 units at 50% util -> instantaneous 10. Seeds at 10.
        let c = calibrate_window(0.0, 5.0, 50.0);
        assert!((c - 10.0).abs() < 1e-9, "got {c}");
    }

    #[test]
    fn above_floor_moves_toward_instantaneous() {
        // prev 10, drain 5 at 50% -> instantaneous 10... pick a moving case:
        // prev 10, drain 10 at 50% -> instantaneous 20. EWMA: 10 + 0.3*(20-10)=13.
        let c = calibrate_window(10.0, 10.0, 50.0);
        assert!((c - 13.0).abs() < 1e-9, "got {c}");
    }
}
