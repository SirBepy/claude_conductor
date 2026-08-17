//! Typed views over `Settings.extra` for notification rules.
//! `TryFrom<&Settings>` never fails — malformed fields fall back to defaults.

use crate::types::Settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotifMode { Sound, Voice }
impl Default for NotifMode { fn default() -> Self { Self::Sound } }

#[derive(Clone, Debug, PartialEq)]
pub struct NotificationRule {
    pub enabled: bool,
    pub mode: NotifMode,
    pub sound_pack: String,
    pub sound_file: String,
    pub voice_name: Option<String>,
    pub template: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NotificationsConfig {
    pub work_finished: NotificationRule,
    pub question_asked: NotificationRule,
    pub threshold_crossed: NotificationRule,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            work_finished: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound1.mp3".into(), voice_name: None,
                template: "{name} is done".into(),
            },
            question_asked: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound3.mp3".into(), voice_name: None,
                template: "{name} is waiting".into(),
            },
            threshold_crossed: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound6.mp3".into(), voice_name: None,
                template: "{percent} threshold reached".into(),
            },
        }
    }
}

// -- TryFrom impls ------------------------------------------------------------

fn val_str(v: Option<&Value>) -> Option<&str> { v.and_then(|x| x.as_str()) }
fn val_bool(v: Option<&Value>) -> Option<bool> { v.and_then(|x| x.as_bool()) }

fn parse_enum<T: Default>(raw: Option<&Value>, map: &[(&str, T)]) -> T where T: Copy {
    let Some(key) = val_str(raw) else { return T::default(); };
    for (k, v) in map { if *k == key { return *v; } }
    T::default()
}

pub fn rule_from_public(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    rule_from(m, defaults)
}

fn rule_from(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    NotificationRule {
        enabled: val_bool(m.get("enabled")).unwrap_or(defaults.enabled),
        mode: parse_enum(m.get("mode"), &[
            ("sound", NotifMode::Sound),
            ("voice", NotifMode::Voice),
        ]),
        sound_pack: val_str(m.get("soundPack"))
            .map(String::from)
            .unwrap_or_else(|| "default".into()),
        sound_file: val_str(m.get("soundFile")).map(String::from).unwrap_or(defaults.sound_file),
        voice_name: val_str(m.get("voiceName")).map(String::from),
        template: val_str(m.get("template")).map(String::from).unwrap_or(defaults.template),
    }
}

impl TryFrom<&Settings> for NotificationsConfig {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let defaults = NotificationsConfig::default();
        let Some(n) = s.extra.get("notifications").and_then(|v| v.as_object()) else { return Ok(defaults); };
        Ok(NotificationsConfig {
            work_finished: n.get("workFinished").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.work_finished.clone())).unwrap_or(defaults.work_finished),
            question_asked: n.get("questionAsked").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.question_asked.clone())).unwrap_or(defaults.question_asked),
            threshold_crossed: n.get("thresholdCrossed").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.threshold_crossed.clone())).unwrap_or(defaults.threshold_crossed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;
    use serde_json::json;

    fn settings_with(extra: serde_json::Value) -> Settings {
        let obj = extra.as_object().unwrap().clone();
        let mut s = Settings::default();
        s.extra = obj;
        s
    }

    #[test]
    fn notif_rule_legacy_without_sound_pack_maps_to_default() {
        let s = settings_with(json!({
            "notifications": {
                "workFinished": { "enabled": true, "mode": "sound", "soundFile": "sound1.mp3" }
            }
        }));
        let cfg = NotificationsConfig::try_from(&s).unwrap();
        assert_eq!(cfg.work_finished.sound_pack, "default");
        assert_eq!(cfg.work_finished.sound_file, "sound1.mp3");
    }

    #[test]
    fn notif_rule_reads_explicit_sound_pack() {
        let s = settings_with(json!({
            "notifications": {
                "workFinished": { "mode": "sound", "soundPack": "peon", "soundFile": "work-work.mp3" }
            }
        }));
        let cfg = NotificationsConfig::try_from(&s).unwrap();
        assert_eq!(cfg.work_finished.sound_pack, "peon");
        assert_eq!(cfg.work_finished.sound_file, "work-work.mp3");
    }
}
