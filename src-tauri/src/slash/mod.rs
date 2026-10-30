use serde::Serialize;
use ts_rs::TS;

pub mod parse;
pub mod builtins;
pub mod enumerate;
pub mod mentions;
pub mod scope;
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
    /// Left out of the composer's slash popup but still a known command, so a
    /// typed or rendered mention of it resolves and /help lists it (`/pickup`
    /// while its PLAN.md has nothing to pick, see `enumerate::scan_menu`).
    pub menu_hidden: bool,
    /// The key `scope::SETTINGS_KEY` scopes this entry under: a user skill's
    /// name, or a plugin's `<plugin>@<marketplace>`. `None` for everything
    /// that can't be scoped (builtins, commands, project skills).
    pub scope_key: Option<String>,
    /// Scoped to other projects, so the chat's `claude` doesn't have it. The
    /// popup still lists it (dimmed) and the composer offers "Enable here".
    pub off_here: bool,
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
