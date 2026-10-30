use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "lowercase")]
pub enum InvocationSource {
    Manual,
    Skill,
    Auto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TokenBreakdown {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
}

impl TokenBreakdown {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_create
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SkillUsageEvent {
    pub ts: String,
    pub skill: String,
    pub session_id: String,
    pub project: String,
    pub source: InvocationSource,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct InvocationCounts {
    pub total: u32,
    pub manual: u32,
    pub skill: u32,
    pub auto: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SkillUsageEntry {
    pub skill: String,
    pub invocations: InvocationCounts,
    pub chats: u32,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SkillUsageWeek {
    pub entries: Vec<SkillUsageEntry>,
    pub total_sessions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SkillDetail {
    pub skill: String,
    pub invocations: InvocationCounts,
    pub events: Vec<SkillUsageEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct InstalledSkill {
    /// Canonical key matching what the Skill tool emits in `input.skill`.
    /// User skills: bare folder name (e.g. "commit"). Plugin skills:
    /// "<plugin>:<skill>" (e.g. "superpowers:brainstorming"). Project skills:
    /// bare folder name (project disambiguation is in `project`).
    pub skill: String,
    pub description: String,
    /// Plugin name when sourced from a plugin cache, else None.
    pub plugin: Option<String>,
    /// Project basename when sourced from a project's `.claude/skills/`, else None.
    pub project: Option<String>,
    /// The key its per-project scope is stored under (`slash::scope`): the
    /// skill's name, or the whole plugin's `<plugin>@<marketplace>`. `None`
    /// for project skills, which are already local to one project.
    pub scope_key: Option<String>,
}
