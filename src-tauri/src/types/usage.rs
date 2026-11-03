use serde::{Deserialize, Serialize};

/// A single usage poll result, captured at a point in time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UsageSnapshot {
    pub captured_at: String,           // RFC3339 / ISO8601
    pub five_hour: WindowUsage,
    /// False when the plan has no 5h limit at all (the usage API sends no
    /// `session` entry in `limits` and a null `five_hour`), as opposed to a
    /// 5h limit whose window simply is not running (`five_hour` idle at 0%).
    /// Rows saved before this field existed read as limited.
    #[serde(default = "default_true")]
    pub five_hour_limited: bool,
    pub seven_day: WindowUsage,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
    /// Which registered account this snapshot belongs to (multi-account
    /// milestone 03). `None` means the legacy single-cookie poll: either
    /// pre-multi-account history, or any tick where no registered account
    /// has a stored web cookie yet (the migration bridge in
    /// `docs/multi-account/03-per-account-usage.md`).
    #[serde(default)]
    pub account_id: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct WindowUsage {
    pub utilization: f64,
    // The API returns null for resets_at right after a window resets / goes
    // idle, which used to kill polling. Treat null/missing as "".
    #[serde(default, deserialize_with = "null_string_as_empty")]
    pub resets_at: String,
}

/// Deserialize a JSON string, mapping `null` (and absence) to an empty string.
fn null_string_as_empty<'de, D>(de: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(de)?.unwrap_or_default())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    // API returns null for these fields when extra_usage is disabled
    // on the account, so every numeric/string field is optional.
    #[serde(default)]
    pub monthly_limit: Option<f64>,
    #[serde(default)]
    pub used_credits: Option<f64>,
    #[serde(default)]
    pub utilization: Option<f64>,
    #[serde(default)]
    pub currency: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_snapshot_parses_real_api_shape() {
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 8500,
                "used_credits": 329, "utilization": 3.87, "currency": "EUR"
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 7.0);
        assert_eq!(parsed.extra_usage.as_ref().unwrap().monthly_limit, Some(8500.0));
    }

    #[test]
    fn a_snapshot_saved_before_five_hour_limited_existed_reads_as_limited() {
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert!(parsed.five_hour_limited);
    }

    #[test]
    fn window_tolerates_null_resets_at() {
        // Real API shape right after a window resets / goes idle: the 5h
        // window's resets_at comes back as null, which used to kill polling
        // (serde: invalid type: null, expected a string).
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 0.0, "resets_at": null },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 0.0);
        assert_eq!(parsed.five_hour.resets_at, "");
        assert_eq!(parsed.seven_day.resets_at, "2026-04-23T23:00:00Z");
    }

    #[test]
    fn extra_usage_tolerates_null_fields() {
        // Real API shape when extra_usage is disabled — every numeric
        // field comes back as null, which used to kill polling.
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": false, "monthly_limit": null,
                "used_credits": null, "utilization": null, "currency": null
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        let extra = parsed.extra_usage.unwrap();
        assert!(!extra.is_enabled);
        assert_eq!(extra.monthly_limit, None);
    }
}
