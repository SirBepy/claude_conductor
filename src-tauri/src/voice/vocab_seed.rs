//! Seeds the dictation vocabulary with the speaker's own project names, so
//! words like "zng-app" reach Whisper's hotwords and the rewrite prompt without
//! being typed in. Only project names and folder names: never a person's name
//! or any note content (people reach a third-party model only after Joe OKs it).
//!
//! `voice-vocab.json` keeps two lists: `terms` is the user's own and is never
//! touched here, `seeded` is replaced wholesale on every seed.

use crate::types::ProjectConfig;
use std::path::Path;

/// Shortest and longest seeded term. Under 3 characters is noise; the cap
/// keeps one pasted-sentence project name from eating the hotword budget.
const MIN_LEN: usize = 3;
const MAX_LEN: usize = 40;
/// Most seeded terms kept. The sidecar applies its own character budget on top.
const MAX_SEEDED: usize = 60;

/// Folder names that name a place, not a project.
const GENERIC: [&str; 6] = ["src", "app", "code", "projects", "desktop", "documents"];

/// Project and folder names, most recently active project first, deduplicated
/// case-insensitively.
pub fn seed_terms(projects: &[ProjectConfig]) -> Vec<String> {
    let mut ranked: Vec<&ProjectConfig> = projects.iter().collect();
    ranked.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let t = raw.trim();
        let len = t.chars().count();
        if !(MIN_LEN..=MAX_LEN).contains(&len) || t.chars().any(|c| c.is_control()) {
            return;
        }
        if GENERIC.contains(&t.to_lowercase().as_str()) {
            return;
        }
        if !out.iter().any(|e| e.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    };
    for p in ranked {
        push(&p.name);
        if let Some(folder) = p.path.file_name().and_then(|f| f.to_str()) {
            push(folder);
        }
    }
    out.truncate(MAX_SEEDED);
    out
}

/// Writes `seeded` into `<voice_dir>/voice-vocab.json`, leaving `terms` and any
/// other key alone. An existing file that does not parse is left untouched
/// (never read as empty and overwritten), as the user's own terms may be in it.
pub fn write_seeded(voice_dir: &Path, seeded: &[String]) -> std::io::Result<()> {
    std::fs::create_dir_all(voice_dir)?;
    let file = voice_dir.join("voice-vocab.json");
    let mut doc = match std::fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str::<serde_json::Value>(&s)
            .ok()
            .filter(|v| v.is_object())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "voice-vocab.json does not parse"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({ "terms": [] }),
        Err(e) => return Err(e),
    };
    doc["seeded"] = serde_json::json!(seeded);
    let text = serde_json::to_string_pretty(&doc).map_err(std::io::Error::other)?;
    let tmp = voice_dir.join("voice-vocab.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &file)
}

/// Daemon start: seed from the projects in settings. Best effort, a failure
/// only means the previous seed (or none) stays.
pub fn seed_from_settings(app_data: &Path) {
    let Ok(path) = crate::settings::paths::settings_file() else { return };
    let projects = crate::settings::load(&path).projects;
    let seeded = seed_terms(&projects);
    if let Err(e) = write_seeded(&app_data.join("voice"), &seeded) {
        log::warn!("[voice] could not seed vocabulary: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project(name: &str, path: &str, last: Option<&str>) -> ProjectConfig {
        let mut p: ProjectConfig = serde_json::from_value(serde_json::json!({
            "id": name, "path": path, "name": name, "created_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        p.last_active_at = last.map(str::to_string);
        p
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-vocab-seed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn seeds_names_and_folders_most_recent_first_without_duplicates() {
        let ps = [
            project("Old thing", "C:/p/old_thing", Some("2026-01-02T00:00:00Z")),
            project("zng-app", "C:/p/zng-app", Some("2026-11-01T00:00:00Z")),
        ];
        assert_eq!(seed_terms(&ps), vec!["zng-app", "Old thing", "old_thing"]);
    }

    #[test]
    fn skips_short_long_generic_and_control_names() {
        let ps = [
            project("ab", "C:/x/src", None),
            project(&"n".repeat(41), "C:/x/app", None),
            project("bad\nname", "C:/x/Desktop", None),
        ];
        assert!(seed_terms(&ps).is_empty());
    }

    #[test]
    fn write_seeded_keeps_user_terms_and_replaces_the_seeded_list() {
        let d = scratch("keep");
        std::fs::write(d.join("voice-vocab.json"), r#"{"terms":["zirtue"],"seeded":["old"]}"#).unwrap();
        write_seeded(&d, &["zng-app".to_string()]).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("voice-vocab.json")).unwrap()).unwrap();
        assert_eq!(v["terms"], serde_json::json!(["zirtue"]));
        assert_eq!(v["seeded"], serde_json::json!(["zng-app"]));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn write_seeded_creates_the_file_when_missing() {
        let d = scratch("missing");
        write_seeded(&d.join("voice"), &["zng-app".to_string()]).unwrap();
        assert!(d.join("voice").join("voice-vocab.json").is_file());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn write_seeded_never_overwrites_a_file_that_does_not_parse() {
        let d = scratch("corrupt");
        std::fs::write(d.join("voice-vocab.json"), "{not json").unwrap();
        assert!(write_seeded(&d, &["x".to_string()]).is_err());
        assert_eq!(std::fs::read_to_string(d.join("voice-vocab.json")).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(&d);
    }
}
