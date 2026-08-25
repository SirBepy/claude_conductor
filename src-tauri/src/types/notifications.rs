use serde::{Deserialize, Serialize};
use super::project::{CharacterWhitelist, ProjectConfig, ProjectsSortBy};

/// How the app reacts to new releases.
///
/// Custom `Deserialize` accepts the new string form
/// (`"never" | "onStartup" | "immediate"`) and the legacy bool form
/// (`true` → Immediate, `false` → Never) so settings written by older builds
/// still load. Done as a manual impl instead of `deserialize_with` so ts-rs
/// can parse the surrounding serde attributes without warnings.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum AutoUpdateMode {
    Never,
    OnStartup,
    Immediate,
}

impl Default for AutoUpdateMode {
    fn default() -> Self { Self::Immediate }
}

impl<'de> Deserialize<'de> for AutoUpdateMode {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where D: serde::Deserializer<'de>,
    {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(d)?;
        match v {
            serde_json::Value::Bool(true) => Ok(AutoUpdateMode::Immediate),
            serde_json::Value::Bool(false) => Ok(AutoUpdateMode::Never),
            serde_json::Value::String(s) => match s.as_str() {
                "never" => Ok(AutoUpdateMode::Never),
                "onStartup" => Ok(AutoUpdateMode::OnStartup),
                "immediate" => Ok(AutoUpdateMode::Immediate),
                other => Err(D::Error::custom(format!("unknown autoUpdate value: {other}"))),
            },
            serde_json::Value::Null => Ok(AutoUpdateMode::default()),
            _ => Err(D::Error::custom("autoUpdate must be bool or string")),
        }
    }
}

/// User-configurable app settings.
///
/// The dashboard owns a LOT of UI state (theme, project aliases + blacklist,
/// color thresholds, notification config, ...) that the Rust side has no
/// reason to inspect. `extra` catches every field the dashboard sends that
/// isn't named below, so a save→load round-trip preserves them verbatim.
/// Without this, each `saveSettings` would silently drop ~25 fields.
///
/// Todo 785's reachable-struct audit lives in the commit message.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Settings {
    pub poll_interval_secs: u64,
    pub autostart: bool,
    #[serde(rename = "autoUpdate")]
    pub auto_update: AutoUpdateMode,
    pub hook_port: Option<u16>,
    #[serde(default, deserialize_with = "deserialize_lenient_projects")]
    pub projects: Vec<ProjectConfig>,
    pub projects_sort_by: ProjectsSortBy,
    pub hooks_registered: bool,
    pub hook_registration_declined: bool,
    /// Bumped whenever the shape of the hook entry we write into
    /// `~/.claude/settings.json` changes. On startup, if `hooks_registered`
    /// is true but this is behind `hook_installer::CURRENT_INSTALL_VERSION`,
    /// we re-run `install()` to heal existing users in place.
    pub hook_install_version: u32,
    pub legacy_obsidian_import_handled: bool,
    #[serde(rename = "audioOutputDevice", default)]
    pub audio_output_device: Option<String>,
    #[serde(rename = "defaultCharacterWhitelist", default = "default_character_whitelist")]
    pub default_character_whitelist: CharacterWhitelist,
    #[serde(rename = "sessionCharacters", default)]
    pub session_characters: std::collections::HashMap<String, String>,
    /// Per-dataset retention policies for the SQLite storage layer. Absent in
    /// older settings.json files; `default` fills in the legacy behavior
    /// (usage + token = 90 days, skill events kept forever).
    #[serde(default)]
    pub retention: crate::storage::RetentionPolicies,
    /// Whether the phone remote-access reverse proxy (`tailscale serve`) is
    /// enabled. Absent in older settings files; `default` (false) keeps remote
    /// access off until the user opts in from Settings.
    #[serde(default)]
    pub remote_access_enabled: bool,
    /// Fallback account for unbound projects and the tray. `None` until the
    /// first account is added (milestone 01) or when the last account is
    /// removed. There is no "default account is special" code path beyond
    /// this fallback (00-overview.md, locked decision).
    #[serde(default)]
    pub default_account_id: Option<String>,
    /// Session id of the singleton Jarvis orchestrator (todo 272). `None`
    /// until `ensure_jarvis_session` spawns it for the first time. Written by
    /// the daemon via the `jarvis_session_created` notification (mirrors how
    /// `project_created` / `session_character_assigned` let a daemon-side
    /// mutation reach the app-process-owned `settings.json`), so it survives
    /// the frontend's `save_settings` full-replace the same way
    /// `default_account_id` does: as long as this field round-trips through
    /// the JS settings object untouched, an unrelated save can't clobber it.
    #[serde(default)]
    pub jarvis_session_id: Option<String>,
    /// User dismissed the one-time "set up your accounts" migration prompt
    /// (milestone 08 - shown when a legacy `session.txt` exists and the
    /// accounts registry is still empty). `false` until dismissed; the prompt
    /// also stops showing on its own once an account is registered, since
    /// `get_accounts_setup_prompt_state` requires BOTH conditions.
    #[serde(default)]
    pub accounts_setup_prompt_dismissed: bool,
    /// Grace window (seconds) for a missed scheduled item: on daemon
    /// wake/tick, a Pending item whose `fire_at` is at most this many
    /// seconds in the past still fires; older ones are marked `Missed`
    /// instead (see `daemon::schedule`). `None` (unset) means the default of
    /// 3600 (1h) applies - computed at the read site, matching
    /// `poll_interval_secs`'s `.max(60)` idiom rather than a stored default.
    #[serde(default)]
    pub schedule_grace_secs: Option<u64>,
    /// Everything the dashboard persists that Rust doesn't need to read —
    /// project aliases, blacklist, colour thresholds, themes, etc. Stored
    /// verbatim so renames / hides / theme changes actually stick.
    #[serde(flatten, default)]
    #[ts(skip)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Parses `projects` leniently: one entry failing to match `ProjectConfig`
/// drops only that entry, instead of `Vec<ProjectConfig>`'s normal
/// all-or-nothing deserialize wiping every project via `salvage_fields`'s
/// whole-`projects`-key granularity.
fn deserialize_lenient_projects<'de, D>(d: D) -> Result<Vec<ProjectConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| match serde_json::from_value::<ProjectConfig>(v) {
            Ok(p) => Some(p),
            Err(err) => {
                log::error!("[settings] dropped unparsable project entry: {err}");
                None
            }
        })
        .collect())
}

fn default_character_whitelist() -> CharacterWhitelist {
    CharacterWhitelist::Custom {
        games: vec!["heroes-of-the-storm".to_string()],
        ids: Vec::new(),
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_secs: 600,
            autostart: true,
            auto_update: AutoUpdateMode::default(),
            hook_port: None,
            projects: Vec::new(),
            projects_sort_by: ProjectsSortBy::Recent,
            hooks_registered: false,
            hook_registration_declined: false,
            hook_install_version: 0,
            legacy_obsidian_import_handled: false,
            audio_output_device: None,
            default_character_whitelist: default_character_whitelist(),
            session_characters: std::collections::HashMap::new(),
            retention: crate::storage::RetentionPolicies::default(),
            remote_access_enabled: false,
            default_account_id: None,
            jarvis_session_id: None,
            accounts_setup_prompt_dismissed: false,
            schedule_grace_secs: None,
            extra: serde_json::Map::new(),
        }
    }
}

impl Settings {
    pub fn mute_all(&self) -> bool { self.bool_extra("muteAll") }
    pub fn mute_sounds(&self) -> bool { self.bool_extra("muteSounds") }
    pub fn mute_system_notifications(&self) -> bool { self.bool_extra("muteSystemNotifications") }

    /// Suppress sound/voice notifications while a meeting is detected.
    /// Defaults to `true` (on) when the key is absent, unlike the mute flags.
    pub fn pause_notifications_in_meeting(&self) -> bool {
        self.extra.get("pauseInMeeting").and_then(|v| v.as_bool()).unwrap_or(true)
    }

    /// Exclude app windows from screen capture while a meeting is detected
    /// (`SetWindowDisplayAffinity`). Defaults to `false` (off) when absent.
    pub fn hide_in_meeting(&self) -> bool { self.bool_extra("hideInMeeting") }

    /// Whether a given character-sound slot is enabled. `camel_key` is the
    /// slot's camelCase key (e.g. "workFinished"). Defaults to `true` (on) when
    /// the key is absent, so existing users keep hearing every slot.
    pub fn character_slot_enabled(&self, camel_key: &str) -> bool {
        self.extra
            .get("characterSoundSlots")
            .and_then(|m| m.get(camel_key))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// Whether clicking a session in the sidebar plays its character's `select`
    /// sound. Defaults to `false` (off) when absent.
    pub fn select_on_session_click(&self) -> bool { self.bool_extra("selectOnSessionClick") }

    fn bool_extra(&self, key: &str) -> bool {
        self.extra.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::project::ProjectsSortBy;

    #[test]
    fn settings_defaults_roundtrip_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_round_trip_preserves_extra_fields_from_dashboard() {
        let raw = r#"{
            "poll_interval_secs": 600,
            "autostart": true,
            "theme": "void",
            "projectAliases": { "C:/a": { "name": "Alpha" } },
            "projectBlacklist": ["C:/dead"],
            "notifications": { "workFinished": { "enabled": true } }
        }"#;
        let parsed: Settings = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&parsed).unwrap();

        assert_eq!(out["theme"], "void");
        assert_eq!(out["projectAliases"]["C:/a"]["name"], "Alpha");
        assert_eq!(out["projectBlacklist"][0], "C:/dead");
        assert_eq!(out["notifications"]["workFinished"]["enabled"], true);
    }

    /// Multi-account milestone 07: `display_mode`, `threshold_warn`, and
    /// `threshold_crit` were dropped as typed fields (dead - never read by
    /// any behavior, see docs/multi-account/07-settings.md). Existing
    /// settings.json files written by older builds still carry these keys;
    /// they must fall through to `extra` (the flattened passthrough) rather
    /// than breaking deserialization, and a fresh `Settings::default()` must
    /// no longer expose them at all.
    #[test]
    fn removed_legacy_fields_land_in_extra_and_do_not_break_old_settings_files() {
        let raw = r#"{
            "poll_interval_secs": 600,
            "display_mode": "rings",
            "threshold_warn": 50.0,
            "threshold_crit": 80.0,
            "autostart": true
        }"#;
        let parsed: Settings = serde_json::from_str(raw).expect("legacy settings.json must still load");
        assert_eq!(parsed.extra.get("display_mode"), Some(&serde_json::json!("rings")));
        assert_eq!(parsed.extra.get("threshold_warn"), Some(&serde_json::json!(50.0)));
        assert_eq!(parsed.extra.get("threshold_crit"), Some(&serde_json::json!(80.0)));
        assert!(parsed.autostart);
    }

    #[test]
    fn settings_default_has_no_legacy_removed_fields() {
        let s = Settings::default();
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("display_mode").is_none());
        assert!(out.get("threshold_warn").is_none());
        assert!(out.get("threshold_crit").is_none());
        assert!(out.get("sync").is_none());
    }

    #[test]
    fn settings_from_dashboard_payload_without_snake_case_fields() {
        let raw = r#"{
            "theme": "void",
            "defaultDisplay": "session",
            "iconStyle": "bars",
            "colorMode": "pace",
            "launchAtLogin": true,
            "autoUpdate": true,
            "colorThresholds": [],
            "notifications": {}
        }"#;
        let parsed: Settings = serde_json::from_str(raw).expect("must not fail");
        assert_eq!(parsed.extra["iconStyle"], "bars");
        assert_eq!(parsed.extra["defaultDisplay"], "session");
        assert_eq!(parsed.poll_interval_secs, 600);
        assert!(parsed.autostart);
        assert_eq!(parsed.auto_update, AutoUpdateMode::Immediate);
    }

    #[test]
    fn auto_update_legacy_bool_true_maps_to_immediate() {
        let raw = r#"{ "autoUpdate": true }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Immediate);
    }

    #[test]
    fn auto_update_legacy_bool_false_maps_to_never() {
        let raw = r#"{ "autoUpdate": false }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Never);
    }

    #[test]
    fn auto_update_string_variants_parse() {
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "never" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Never);
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "onStartup" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::OnStartup);
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "immediate" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Immediate);
    }

    #[test]
    fn mute_flags_default_false_when_keys_missing() {
        let s = Settings::default();
        assert!(!s.mute_all());
        assert!(!s.mute_sounds());
        assert!(!s.mute_system_notifications());
    }

    #[test]
    fn pause_in_meeting_defaults_on_and_can_be_disabled() {
        // Absent key -> on (opposite of the mute flags).
        assert!(Settings::default().pause_notifications_in_meeting());
        let s: Settings = serde_json::from_str(r#"{ "pauseInMeeting": false }"#).unwrap();
        assert!(!s.pause_notifications_in_meeting());
        let s: Settings = serde_json::from_str(r#"{ "pauseInMeeting": true }"#).unwrap();
        assert!(s.pause_notifications_in_meeting());
    }

    #[test]
    fn character_slot_enabled_defaults_true_when_absent() {
        let s = Settings::default();
        assert!(s.character_slot_enabled("workFinished"));
        assert!(s.character_slot_enabled("death"));
        assert!(!s.select_on_session_click());
    }

    #[test]
    fn character_slot_enabled_reads_nested_object() {
        let raw = r#"{
            "characterSoundSlots": { "workFinished": false, "ready": true },
            "selectOnSessionClick": true
        }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(!s.character_slot_enabled("workFinished"));
        assert!(s.character_slot_enabled("ready"));
        // Absent slot key falls back to enabled.
        assert!(s.character_slot_enabled("death"));
        assert!(s.select_on_session_click());
    }

    #[test]
    fn mute_flags_read_from_extra_camel_case() {
        let raw = r#"{
            "muteAll": true,
            "muteSounds": false,
            "muteSystemNotifications": true
        }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(s.mute_all());
        assert!(!s.mute_sounds());
        assert!(s.mute_system_notifications());
    }

    #[test]
    fn mute_flags_treat_wrong_type_as_false() {
        let raw = r#"{ "muteAll": "yes", "muteSounds": 1 }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(!s.mute_all());
        assert!(!s.mute_sounds());
    }

    #[test]
    fn settings_defaults_expose_new_fields() {
        let s = Settings::default();
        assert!(s.projects.is_empty());
        assert_eq!(s.projects_sort_by, ProjectsSortBy::Recent);
        assert!(!s.hooks_registered);
        assert!(!s.hook_registration_declined);
        assert_eq!(s.hook_install_version, 0);
    }

    #[test]
    fn audio_output_device_field_roundtrips() {
        let raw = r#"{ "audioOutputDevice": "Speakers (Realtek Audio)" }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.audio_output_device.as_deref(), Some("Speakers (Realtek Audio)"));
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.audio_output_device.as_deref(), Some("Speakers (Realtek Audio)"));
    }

    #[test]
    fn audio_output_device_defaults_to_none() {
        let s = Settings::default();
        assert_eq!(s.audio_output_device, None);
        let parsed: Settings = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(parsed.audio_output_device, None);
    }

    /// The `ProjectConfig` half of todo 785: a project entry missing a
    /// required field (here `id`, standing in for any field a future
    /// version might add without `#[serde(default)]`) must not cost the
    /// user every OTHER project or any unrelated top-level key.
    #[test]
    fn projects_array_drops_only_the_unparsable_entry() {
        let raw = serde_json::json!({
            "projects": [
                { "id": "keep-1", "path": "C:/keep1", "name": "keep1", "created_at": "2026-01-01T00:00:00Z" },
                { "path": "C:/broken", "name": "broken", "created_at": "2026-01-01T00:00:00Z" },
                { "id": "keep-2", "path": "C:/keep2", "name": "keep2", "created_at": "2026-01-01T00:00:00Z" }
            ],
            "theme": "void"
        });
        let s: Settings = serde_json::from_value(raw).expect("one bad project must not fail the document");
        assert_eq!(s.projects.len(), 2, "only the unparsable entry drops");
        assert_eq!(s.projects[0].id, "keep-1");
        assert_eq!(s.projects[1].id, "keep-2");
        assert_eq!(s.extra.get("theme"), Some(&serde_json::json!("void")));
    }

    #[test]
    fn legacy_use_daemon_key_lands_in_extra_and_does_not_break_deserialize() {
        // Phase 7 removed the `useDaemon` typed field. Existing settings.json
        // files still carry the key; it must fall through to `extra` (the
        // flattened passthrough) and not break deserialization.
        let v = serde_json::json!({
            "useDaemon": true,
            "autostart": true,
            "muteAll": false,
        });
        let s: Settings = serde_json::from_value(v).expect("must deserialize with legacy useDaemon key");
        assert_eq!(s.extra.get("useDaemon"), Some(&serde_json::json!(true)));
    }
}
