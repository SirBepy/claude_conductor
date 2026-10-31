//! Per-project skill and plugin visibility.
//!
//! `Settings.extra["skillScopes"]` maps a scope key to the Conductor project ids
//! it is available in:
//!
//! ```json
//! { "figma-tiles": { "projects": ["<project id>"], "elsewhere": "off" },
//!   "figma@claude-plugins-official": { "projects": ["<project id>"] } }
//! ```
//!
//! A local skill's key is its bare name; a plugin's key is its `enabledPlugins`
//! key (`<plugin>@<marketplace>`), so an `@` tells the two apart. No entry means
//! "every project". The scope never touches a repo's own settings: each chat
//! gets it through its per-chat `--settings` file (`chat_settings`), which
//! Claude Code merges per key over user and project settings (checked
//! 2026-10-30: a project-level `off` survived a per-chat `off` for another
//! skill, and a per-chat `enabledPlugins: true` re-enabled a plugin the user
//! settings had `false`).
//!
//! Plugins scope as a whole because `skillOverrides` has no effect on plugin
//! skills, and a plugin scope also covers that plugin's MCP servers.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{SlashEntry, SlashSource};
use crate::types::Settings;

pub const SETTINGS_KEY: &str = "skillScopes";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Elsewhere {
    /// Gone from Claude's listing and refused when typed.
    #[default]
    Off,
    /// Listed by name only, without its description.
    NameOnly,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillScope {
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub elsewhere: Elsewhere,
}

pub fn is_plugin_key(key: &str) -> bool {
    key.contains('@')
}

/// Reads the scopes out of settings. A malformed entry is skipped rather than
/// failing the whole map, so one bad hand-edit can't unhide every skill.
pub fn scopes(settings: &Settings) -> BTreeMap<String, SkillScope> {
    let Some(Value::Object(map)) = settings.extra.get(SETTINGS_KEY) else {
        return BTreeMap::new();
    };
    map.iter()
        .filter_map(|(k, v)| Some((k.clone(), serde_json::from_value(v.clone()).ok()?)))
        .collect()
}

/// The Conductor project id owning `dir` (worktrees map to their main repo).
pub fn project_id(settings: &Settings, dir: Option<&Path>) -> Option<String> {
    crate::settings::identity::resolve_project_id(&settings.projects, dir?)
}

/// Whether `key` is available in `project`. A project-less chat sees only the
/// unscoped ones.
pub fn enabled_in(scopes: &BTreeMap<String, SkillScope>, key: &str, project: Option<&str>) -> bool {
    match scopes.get(key) {
        None => true,
        Some(s) => project.is_some_and(|p| s.projects.iter().any(|x| x == p)),
    }
}

/// The `skillOverrides` / `enabledPlugins` keys for one chat's `--settings`
/// file. Empty when nothing is scoped, so an unscoped setup writes exactly what
/// it wrote before.
pub fn chat_settings(scopes: &BTreeMap<String, SkillScope>, project: Option<&str>) -> Map<String, Value> {
    let mut overrides = Map::new();
    let mut plugins = Map::new();
    for (key, scope) in scopes {
        let here = enabled_in(scopes, key, project);
        if is_plugin_key(key) {
            // `true` too, not just `false`: it re-enables a plugin the user
            // settings turned off everywhere (Figma) in the projects it's scoped to.
            plugins.insert(key.clone(), Value::Bool(here));
        } else if !here {
            let level = match scope.elsewhere {
                Elsewhere::Off => "off",
                Elsewhere::NameOnly => "name-only",
            };
            overrides.insert(key.clone(), Value::String(level.into()));
        }
    }
    let mut out = Map::new();
    if !overrides.is_empty() {
        out.insert("skillOverrides".into(), Value::Object(overrides));
    }
    if !plugins.is_empty() {
        out.insert("enabledPlugins".into(), Value::Object(plugins));
    }
    out
}

/// Adds `project` to `key`'s scope. Returns false when it was already there or
/// `key` is unscoped (already available everywhere). A malformed entry counts
/// as unscoped too, matching `scopes()`: rewriting it from defaults would turn
/// "available everywhere" into "only here" and drop its unknown fields.
pub fn add_project(settings: &mut Settings, key: &str, project: &str) -> bool {
    let Some(Value::Object(map)) = settings.extra.get_mut(SETTINGS_KEY) else { return false };
    let Some(entry) = map.get_mut(key) else { return false };
    let Ok(mut scope) = serde_json::from_value::<SkillScope>(entry.clone()) else { return false };
    if scope.projects.iter().any(|p| p == project) {
        return false;
    }
    scope.projects.push(project.to_string());
    *entry = serde_json::to_value(scope).unwrap_or(Value::Null);
    true
}

/// The `enabledPlugins` map from the user's own `~/.claude/settings.json`
/// (every profile dir symlinks its settings.json there, see
/// `accounts::profile::SYMLINK_FILES`).
pub fn user_enabled_plugins() -> Map<String, Value> {
    let Some(home) = dirs::home_dir() else { return Map::new() };
    user_enabled_plugins_at(&home.join(".claude").join("settings.json"))
}

pub fn user_enabled_plugins_at(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("enabledPlugins").cloned())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// Marks entries for one project's slash menu: a scoped skill or plugin not
/// enabled here gets `off_here` (still listed, so typing it can offer "Enable
/// here"), and a plugin the user settings turn off with no scope of its own is
/// left out of the menu, since Claude can't run it in any chat.
pub fn mark_entries(
    entries: &mut [SlashEntry],
    scopes: &BTreeMap<String, SkillScope>,
    project: Option<&str>,
    user_plugins: &Map<String, Value>,
) {
    for e in entries.iter_mut() {
        let Some(key) = e.scope_key.as_deref() else { continue };
        if scopes.contains_key(key) {
            e.off_here = !enabled_in(scopes, key, project);
        } else if is_plugin(&e.source) && user_plugins.get(key) == Some(&Value::Bool(false)) {
            e.menu_hidden = true;
        }
    }
}

fn is_plugin(source: &SlashSource) -> bool {
    matches!(source, SlashSource::PluginSkill { .. } | SlashSource::PluginCommand { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with(scopes: Value) -> Settings {
        let mut s = Settings::default();
        s.extra.insert(SETTINGS_KEY.into(), scopes);
        s
    }

    fn entry(name: &str, source: SlashSource, key: Option<&str>) -> SlashEntry {
        SlashEntry {
            name: name.into(),
            args: None,
            description: String::new(),
            source,
            path: None,
            menu_hidden: false,
            scope_key: key.map(str::to_string),
            off_here: false,
        }
    }

    #[test]
    fn unscoped_setup_writes_nothing() {
        assert!(chat_settings(&scopes(&Settings::default()), Some("p1")).is_empty());
    }

    #[test]
    fn a_skill_is_off_outside_its_projects_and_absent_inside() {
        let s = settings_with(json!({
            "figma-tiles": { "projects": ["p1"] },
            "android-drive": { "projects": ["p2"], "elsewhere": "name-only" }
        }));
        let sc = scopes(&s);
        assert_eq!(
            Value::Object(chat_settings(&sc, Some("p1"))),
            json!({ "skillOverrides": { "android-drive": "name-only" } })
        );
        assert_eq!(
            Value::Object(chat_settings(&sc, None)),
            json!({ "skillOverrides": { "figma-tiles": "off", "android-drive": "name-only" } })
        );
    }

    #[test]
    fn a_plugin_is_switched_on_in_its_projects_and_off_elsewhere() {
        let sc = scopes(&settings_with(json!({ "figma@claude-plugins-official": { "projects": ["p1"] } })));
        assert_eq!(
            Value::Object(chat_settings(&sc, Some("p1"))),
            json!({ "enabledPlugins": { "figma@claude-plugins-official": true } })
        );
        assert_eq!(
            Value::Object(chat_settings(&sc, Some("p2"))),
            json!({ "enabledPlugins": { "figma@claude-plugins-official": false } })
        );
    }

    #[test]
    fn a_malformed_entry_is_skipped_not_fatal() {
        let sc = scopes(&settings_with(json!({ "bad": 7, "good": { "projects": [] } })));
        assert_eq!(sc.keys().collect::<Vec<_>>(), vec!["good"]);
    }

    #[test]
    fn add_project_extends_an_existing_scope_once() {
        let mut s = settings_with(json!({ "figma-tiles": { "projects": ["p1"], "elsewhere": "name-only" } }));
        assert!(add_project(&mut s, "figma-tiles", "p2"));
        assert!(!add_project(&mut s, "figma-tiles", "p2"));
        assert!(!add_project(&mut s, "unscoped", "p2"));
        let sc = scopes(&s);
        assert_eq!(sc["figma-tiles"].projects, vec!["p1", "p2"]);
        assert_eq!(sc["figma-tiles"].elsewhere, Elsewhere::NameOnly);
    }

    #[test]
    fn add_project_leaves_a_malformed_entry_untouched() {
        let raw = json!({ "bad": 7, "worse": { "projects": "p1", "note": "keep" } });
        let mut s = settings_with(raw.clone());
        assert!(!add_project(&mut s, "bad", "p2"));
        assert!(!add_project(&mut s, "worse", "p2"));
        assert_eq!(s.extra[SETTINGS_KEY], raw);
    }

    #[test]
    fn menu_marks_off_here_and_hides_globally_disabled_plugins() {
        let sc = scopes(&settings_with(json!({
            "figma-tiles": { "projects": ["p1"] },
            "figma@claude-plugins-official": { "projects": ["p1"] }
        })));
        let plugin = |p: &str| SlashSource::PluginSkill { plugin: p.into() };
        let mut entries = vec![
            entry("figma-tiles", SlashSource::UserSkill, Some("figma-tiles")),
            entry("commit", SlashSource::UserSkill, Some("commit")),
            entry("figma-use", plugin("figma"), Some("figma@claude-plugins-official")),
            entry("brainstorming", plugin("superpowers"), Some("superpowers@claude-plugins-official")),
            entry("help", SlashSource::Builtin, None),
        ];
        let user = json!({
            "figma@claude-plugins-official": false,
            "superpowers@claude-plugins-official": false
        });
        let Value::Object(user) = user else { unreachable!() };
        mark_entries(&mut entries, &sc, Some("p2"), &user);
        let flags: Vec<(bool, bool)> = entries.iter().map(|e| (e.off_here, e.menu_hidden)).collect();
        assert_eq!(flags, vec![(true, false), (false, false), (true, false), (false, true), (false, false)]);

        for e in entries.iter_mut() {
            e.off_here = false;
            e.menu_hidden = false;
        }
        mark_entries(&mut entries, &sc, Some("p1"), &user);
        assert!(entries.iter().take(3).all(|e| !e.off_here && !e.menu_hidden));
    }

    #[test]
    fn user_enabled_plugins_reads_the_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, r#"{"enabledPlugins":{"figma@x":false}}"#).unwrap();
        assert_eq!(user_enabled_plugins_at(&p).get("figma@x"), Some(&Value::Bool(false)));
        assert!(user_enabled_plugins_at(&dir.path().join("missing.json")).is_empty());
    }
}
