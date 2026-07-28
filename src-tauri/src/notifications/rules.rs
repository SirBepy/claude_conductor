//! Notification firing: workFinished / questionAsked / thresholdCrossed.

use crate::notifications::audio;
use crate::tray::{NotifMode, NotificationRule};
use crate::state::AppState;
use crate::types::{Avatar, Settings};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifKind { WorkFinished, QuestionAsked, ThresholdCrossed }

#[derive(Default, Debug)]
pub struct NotifContext {
    pub name: Option<String>,
    pub percent: Option<u32>,
    /// Account label for `{account}` (multi-account milestone 08), e.g.
    /// "Work" so a threshold alert reads "Work hit 80%". `None` on the legacy
    /// single-cookie poll path (no account context) - the template's
    /// `{account}` token renders as an empty string in that case.
    pub account: Option<String>,
}

/// Sentinel used in `NotificationRule.sound_pack` to indicate that
/// `sound_file` carries an absolute path resolved from a character slot.
pub const CHARACTER_PACK_SENTINEL: &str = "__character__";

/// Character-aware resolver. For `WorkFinished` / `QuestionAsked`:
/// 1. Prefers the SESSION character: when `session_id` is `Some` and
///    `settings.session_characters` has an entry for it, that char_id is used.
/// 2. Falls back to the project avatar at `cwd_key` (post-migration this will
///    be `Avatar::None` for most projects, yielding the default sound).
/// Returns a synthetic rule whose `sound_file` is an absolute path when a
/// character is resolved and its slot has a file; otherwise the global default.
/// `ThresholdCrossed` always returns the global default.
pub fn resolve_with_character(
    cfg: &crate::tray::NotificationsConfig,
    settings: &Settings,
    kind: NotifKind,
    session_id: Option<&str>,
    cwd_key: Option<&str>,
) -> NotificationRule {
    let default_rule = match kind {
        NotifKind::WorkFinished     => cfg.work_finished.clone(),
        NotifKind::QuestionAsked    => cfg.question_asked.clone(),
        NotifKind::ThresholdCrossed => cfg.threshold_crossed.clone(),
    };
    if matches!(kind, NotifKind::ThresholdCrossed) { return default_rule; }

    // 1. Prefer the session's character.
    let char_id: Option<String> = session_id
        .and_then(|sid| settings.session_characters.get(sid).cloned());

    // 2. Fall back to the project avatar.
    let char_id: Option<String> = char_id.or_else(|| {
        let key = cwd_key?;
        let normalized_key = crate::settings::store::project_key(std::path::Path::new(key));
        let proj = settings.projects.iter().find(|p| {
            crate::settings::store::project_key(&p.path) == normalized_key
        })?;
        match &proj.avatar {
            Avatar::Character(id) => Some(id.clone()),
            _ => None,
        }
    });

    let Some(char_id) = char_id else { return default_rule; };
    let Some(character) = crate::characters::get(&char_id) else { return default_rule; };
    let slot = match kind {
        NotifKind::WorkFinished  => crate::characters::slots::Slot::WorkFinished,
        NotifKind::QuestionAsked => crate::characters::slots::Slot::QuestionAsked,
        NotifKind::ThresholdCrossed => unreachable!(),
    };
    let files = character.slot_files(slot);
    let Some(pick) = crate::characters::slots::random_pick(files) else { return default_rule; };
    let abs = character.asset_path(pick);
    NotificationRule {
        enabled: true,
        mode: NotifMode::Sound,
        sound_pack: CHARACTER_PACK_SENTINEL.into(),
        sound_file: abs.to_string_lossy().into_owned(),
        voice_name: None,
        template: String::new(),
    }
}

pub(crate) fn should_suppress(settings: &Settings, mode: NotifMode) -> bool {
    if settings.mute_all() { return true; }
    matches!(mode, NotifMode::Sound | NotifMode::Voice) && settings.mute_sounds()
}

pub fn fire(
    app: &AppHandle,
    kind: NotifKind,
    ctx: NotifContext,
    session_id: Option<&str>,
    cwd_key: Option<&str>,
) {
    // A debug (`cargo tauri dev`) build never fires sound/voice notifications.
    // It shares the same machine (and often the same live moment) as the
    // installed production app, which already pings for the same events -
    // without this, every real notification plays twice.
    if cfg!(debug_assertions) {
        log::debug!("notification suppressed: debug build");
        return;
    }
    let state = app.state::<AppState>();
    let settings_snapshot = state.settings.lock().unwrap().clone();
    // Meeting gate: while a meeting is detected (camera/mic in use or a meeting
    // app producing audio) and the setting is on (default), drop the ping so it
    // doesn't interrupt the call. The meeting flag is always false off-Windows.
    if settings_snapshot.pause_notifications_in_meeting()
        && state.meeting_active.load(std::sync::atomic::Ordering::Relaxed)
    {
        log::debug!("notification suppressed: meeting active");
        return;
    }
    // Per-slot character-sound toggle (Settings > Sound). work_finished /
    // question_asked fire ONLY through this daemon-link path, so gate them here;
    // threshold_crossed is not a character slot.
    let slot_camel = match kind {
        NotifKind::WorkFinished => Some("workFinished"),
        NotifKind::QuestionAsked => Some("questionAsked"),
        NotifKind::ThresholdCrossed => None,
    };
    if let Some(camel) = slot_camel {
        if !settings_snapshot.character_slot_enabled(camel) { return; }
    }
    let cfg: crate::tray::NotificationsConfig = (&settings_snapshot).try_into().unwrap_or_default();
    let rule = resolve_with_character(&cfg, &settings_snapshot, kind, session_id, cwd_key);
    if !rule.enabled { return; }
    if should_suppress(&settings_snapshot, rule.mode) { return; }
    match rule.mode {
        NotifMode::Sound => {
            if rule.sound_pack == CHARACTER_PACK_SENTINEL {
                audio::play_path(app, std::path::Path::new(&rule.sound_file));
            } else {
                audio::play_sound_file(app, &rule.sound_file);
            }
        }
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            speak(app, &text, rule.voice_name.as_deref());
        }
    }
}

pub fn render_template(tpl: &str, ctx: &NotifContext) -> String {
    let name = sanitize(ctx.name.as_deref().unwrap_or(""));
    let pct = ctx.percent.map(|p| format!("{p}%")).unwrap_or_default();
    let account = sanitize(ctx.account.as_deref().unwrap_or(""));
    sanitize(
        &tpl.replace("{name}", &name)
            .replace("{percent}", &pct)
            .replace("{account}", &account),
    )
}

fn sanitize(s: &str) -> String {
    let mapped: String = s.chars()
        .map(|c| if matches!(c, '_' | '-') { ' ' } else { c })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn project_name_from_cwd(cwd: &str) -> Option<String> {
    let last = cwd.rsplit(|c| c == '/' || c == '\\').next()?.to_string();
    if last.is_empty() { None } else { Some(last) }
}

fn speak(app: &AppHandle, text: &str, voice: Option<&str>) {
    if let Some(v) = voice {
        let status = crate::notifications::piper::status();
        let has_voice = status.voices.iter().any(|e| e.id == v && e.installed);
        if status.installed && has_voice {
            let app = app.clone();
            let text = text.to_string();
            let voice = v.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::notifications::piper::synthesize(&text, &voice).await {
                    Ok(wav) => audio::play_wav(&app, &wav),
                    Err(e) => {
                        log::warn!("piper synth failed: {e}; falling back to web speech");
                        let _ = app.emit("speak-fallback", serde_json::json!({
                            "text": text, "voiceName": voice,
                        }));
                    }
                }
            });
            return;
        }
    }
    let _ = app.emit("speak-fallback", serde_json::json!({
        "text": text, "voiceName": voice,
    }));
}

pub fn speak_public(app: &AppHandle, text: &str, voice: Option<&str>) { speak(app, text, voice) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::NotificationsConfig;
    use crate::types::{Avatar, ProjectConfig};

    fn settings_with_project(path: &str, character_id: Option<&str>) -> Settings {
        let mut s = Settings::default();
        let avatar = match character_id {
            Some(id) => Avatar::Character(id.into()),
            None => Avatar::None,
        };
        s.projects.push(ProjectConfig {
            id: "test-id".into(),
            path: std::path::PathBuf::from(path),
            name: "test".into(),
            avatar,
            automation: None,
            created_at: "2026-05-02T00:00:00Z".into(),
            last_active_at: None,
            whitelist: crate::types::CharacterWhitelist::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
        });
        s
    }

    #[test]
    fn should_suppress_returns_false_when_all_flags_off() {
        let s = Settings::default();
        assert!(!should_suppress(&s, NotifMode::Sound));
        assert!(!should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn should_suppress_returns_true_when_mute_all_regardless_of_mode() {
        let mut s = Settings::default();
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(true));
        assert!(should_suppress(&s, NotifMode::Sound));
        assert!(should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn should_suppress_mutes_sound_and_voice_when_mute_sounds() {
        let mut s = Settings::default();
        s.extra.insert("muteSounds".into(), serde_json::Value::Bool(true));
        assert!(should_suppress(&s, NotifMode::Sound));
        assert!(should_suppress(&s, NotifMode::Voice));
    }

    #[test]
    fn template_substitutes_name() {
        let out = render_template("{name} is done", &NotifContext {
            name: Some("my_project".into()), percent: None, account: None,
        });
        assert_eq!(out, "my project is done");
    }

    #[test]
    fn template_substitutes_percent() {
        let out = render_template("{percent} threshold", &NotifContext {
            name: None, percent: Some(80), account: None,
        });
        assert_eq!(out, "80% threshold");
    }

    /// Milestone 08: `{account}` lets a threshold template distinguish which
    /// account crossed ("Work hit 80%").
    #[test]
    fn template_substitutes_account() {
        let out = render_template("{account} hit {percent}", &NotifContext {
            name: None, percent: Some(80), account: Some("Work".into()),
        });
        assert_eq!(out, "Work hit 80%");
    }

    /// Legacy single-cookie poll path has no account context - `{account}`
    /// must render as empty rather than leaving the literal token behind.
    #[test]
    fn template_account_token_empty_on_legacy_path() {
        let out = render_template("{account}{percent} threshold reached", &NotifContext {
            name: None, percent: Some(50), account: None,
        });
        assert_eq!(out, "50% threshold reached");
    }

    #[test]
    fn sanitize_collapses_whitespace_and_underscores() {
        assert_eq!(sanitize("foo_bar   baz-quux"), "foo bar baz quux");
    }

    #[test]
    fn project_name_last_path_component() {
        assert_eq!(project_name_from_cwd("C:\\Users\\tecno\\Desktop\\alpha"), Some("alpha".into()));
        assert_eq!(project_name_from_cwd("/home/tecno/beta"), Some("beta".into()));
        assert_eq!(project_name_from_cwd(""), None);
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_no_cwd() {
        let cfg = NotificationsConfig::default();
        let s = Settings::default();
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None, None);
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_no_project_match() {
        let cfg = NotificationsConfig::default();
        let s = Settings::default();
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None, Some("C:/missing"));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_avatar_is_not_character() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", None);
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_returns_global_for_threshold_crossed_even_with_character() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", Some("peon"));
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::ThresholdCrossed, None, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }

    #[test]
    fn character_resolver_falls_back_to_global_when_character_not_installed() {
        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", Some("nonexistent-character"));
        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None, Some(&key));
        assert_eq!(rule.sound_pack, "default");
    }

    /// Happy path: project has `Avatar::Character(id)`, that character is
    /// in the cache, and its `WorkFinished` slot has a file. Resolver must
    /// return a synthetic rule with `CHARACTER_PACK_SENTINEL` and an
    /// absolute `sound_file` path. (Bonus from ai_todo #03.)
    #[test]
    fn character_resolver_returns_synthetic_rule_for_valid_character_with_slot_file() {
        use std::collections::HashMap;
        use std::path::PathBuf;

        let cfg = NotificationsConfig::default();
        let s = settings_with_project("C:/proj", Some("happy-peon"));

        // Inject a character directly into the cache so the resolver
        // doesn't try to read from disk. Slot points at a relative file
        // under a fake `dir`; the resolver joins them via `asset_path`.
        let mut slots = HashMap::new();
        slots.insert("work_finished".into(), vec!["sounds/done.wav".into()]);
        let character = crate::characters::Character {
            id: "happy-peon".into(),
            label: "Happy Peon".into(),
            version: 1,
            icon: "icon.png".into(),
            game: None,
            game_label: None,
            shared: false,
            dir: PathBuf::from("/fake/chars/happy-peon"),
            slots,
        };
        crate::characters::cache::invalidate();
        crate::characters::cache::set_for_test(vec![character]);

        let key = crate::settings::store::project_key(std::path::Path::new("C:/proj"));
        let rule = resolve_with_character(&cfg, &s, NotifKind::WorkFinished, None, Some(&key));

        assert_eq!(rule.sound_pack, CHARACTER_PACK_SENTINEL);
        assert_eq!(rule.mode, NotifMode::Sound);
        assert!(rule.enabled);
        // sound_file should be the asset_path (dir join slot file).
        assert!(
            rule.sound_file.contains("happy-peon"),
            "expected character dir in path, got {}",
            rule.sound_file
        );
        assert!(rule.sound_file.ends_with("done.wav"), "got {}", rule.sound_file);

        crate::characters::cache::invalidate();
    }
}
