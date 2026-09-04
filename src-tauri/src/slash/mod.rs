use serde::Serialize;
use ts_rs::TS;

pub mod parse;
pub mod builtins;
pub mod enumerate;
pub mod mentions;
pub mod watcher;

#[derive(Debug, Clone, Serialize, TS)]
pub struct SlashEntry {
    pub name: String,
    pub args: Option<String>,
    pub description: String,
    pub source: SlashSource,
    /// Absolute path to the defining `SKILL.md` / command `.md`. `None` for
    /// builtins, which have no file. `mentions` hands this to the model so it
    /// can load a mid-message command it decides to run.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SlashSource {
    Builtin,
    UserCommand,
    ProjectCommand,
    UserSkill,
    /// Skill defined under a project's `.claude/skills/`. `project` is the
    /// project directory's basename (used as the display tag in the UI).
    ProjectSkill { project: String },
    PluginSkill { plugin: String },
    PluginCommand { plugin: String },
}
