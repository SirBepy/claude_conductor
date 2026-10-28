//! Data model for the per-project dashboard's stored config and card results.
//!
//! Every struct field carries `#[serde(default)]`: these types are read back
//! from a JSON file that outlives app versions, and one missing sub-field must
//! never fail deserialization of the whole file.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// The built-in cards every dashboard has; each can be hidden per scope.
/// A scope may still list a retired id (`needs_you`) as hidden; it matches no
/// card, so it is inert.
pub const BUILTIN_CARDS: [&str; 9] =
    ["your_todos", "chats", "next_up", "ship", "running", "usage", "todo_chart", "quick_actions", "reports"];

/// What a card (or a hidden-builtin entry) belongs to: one project, or a
/// multi-repo group.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
// ts-rs ignores serde's tag/rename_all, so the TS side is spelled out too.
#[ts(tag = "kind", rename_all = "snake_case", export_to = "../../src/types/ipc.generated.ts")]
pub enum Scope {
    Project {
        #[serde(default)]
        cwd: String,
    },
    Group {
        #[serde(default)]
        id: String,
    },
}

impl Default for Scope {
    fn default() -> Self {
        Scope::Project { cwd: String::new() }
    }
}

impl Scope {
    /// Stable string key used by `hidden_builtins`. A project cwd is run
    /// through the crate's cwd normaliser so `C:\x\app`, `C:/x/app` and
    /// `c:\x\app` (all seen for one folder) share one key.
    pub fn scope_key(&self) -> String {
        match self {
            Scope::Project { cwd } => format!("project:{}", cwd_key(cwd)),
            Scope::Group { id } => format!("group:{id}"),
        }
    }
}

/// Separator- and case-insensitive (on Windows/macOS) form of a path, for
/// comparing paths that reached us through different channels.
pub(crate) fn cwd_key(path: &str) -> String {
    crate::settings::identity::normalize_cwd_key(std::path::Path::new(path))
}

/// A group of repos shown as one dashboard (e.g. a client with several repos).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GroupDef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Project cwds.
    #[serde(default)]
    pub repos: Vec<String>,
    /// `"vault"` (seeded from a client note) or `"manual"`.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub vault_slug: Option<String>,
    /// Repos the dev removed from a vault group by hand; seeding never re-adds them.
    #[serde(default)]
    pub removed_repos: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind", rename_all = "snake_case", export_to = "../../src/types/ipc.generated.ts")]
pub enum CardSource {
    Http {
        #[serde(default)]
        method: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        body: Option<String>,
    },
    Command {
        #[serde(default)]
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        /// Extra environment for the child, each value rendered through the
        /// same templates as `args`. A secret belongs here rather than in
        /// `args`: other processes can read a command line, not this env.
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
}

impl Default for CardSource {
    fn default() -> Self {
        CardSource::Command { program: String::new(), args: Vec::new(), cwd: None, env: BTreeMap::new() }
    }
}

/// One headline number: `path` is evaluated against the response, `format`
/// is one of `number | text | count | duration_s | duration_ms | duration_iso
/// | relative_time`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct StatSpec {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub format: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind", rename_all = "snake_case", export_to = "../../src/types/ipc.generated.ts")]
pub enum CardDisplay {
    Stats {
        #[serde(default)]
        items: Vec<StatSpec>,
    },
    List {
        /// Path to the array; the other paths are evaluated per element.
        #[serde(default)]
        items_path: String,
        #[serde(default)]
        label_path: String,
        #[serde(default)]
        value_path: String,
        #[serde(default)]
        link_path: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// The card's own look: an HTML document rendered in a script-only
    /// sandboxed iframe with no network, fed the response as `window.CARD_DATA`.
    /// In the installed app the srcdoc frame inherits the app's CSP, so its
    /// inline script does not run and only the static HTML and CSS show.
    Html {
        #[serde(default)]
        template: String,
    },
}

impl Default for CardDisplay {
    fn default() -> Self {
        CardDisplay::Stats { items: Vec::new() }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub source: CardSource,
    #[serde(default)]
    pub display: CardDisplay,
    #[serde(default)]
    pub refresh_secs: Option<u32>,
    /// A button on the card that starts a new chat and sends `command`, then
    /// the card's current data, as its first message.
    #[serde(default)]
    pub action: Option<CardAction>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardAction {
    #[serde(default)]
    pub label: String,
    /// A slash command (leading slash included) or a plain prompt. Named
    /// `command` because stored cards already carry it under that key.
    #[serde(default)]
    pub command: String,
}

/// A progress bar a source computes itself (hours logged against hours due).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardProgress {
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub max: f64,
    #[serde(default)]
    pub label: String,
    /// Paints the bar as running late.
    #[serde(default)]
    pub behind: bool,
}

/// One slice of a segmented bar: `value` sizes it against the bar's `max`,
/// `text` is the figure the slice prints (the source formats it, e.g. "3:45").
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SegmentItem {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub text: String,
}

/// A bar split into labelled slices (a week of logged hours, one slice per
/// day) that a source computes itself (`_card.segments`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardSegments {
    #[serde(default)]
    pub items: Vec<SegmentItem>,
    /// What the whole bar stands for, in the same unit as the items' `value`.
    #[serde(default)]
    pub max: f64,
    /// Where the bar should be by now (a pace tick), same unit as `max`.
    #[serde(default)]
    pub marker: Option<f64>,
    /// A line under the bar, for the marker's verdict ("4:15 behind pace").
    #[serde(default)]
    pub note: String,
    /// `"warn"` or `"good"` colours `note`; any other value from a source is dropped.
    #[serde(default)]
    pub note_tone: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct LabelValue {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RowValue {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub link: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardResult {
    /// Unix epoch milliseconds. Spelled `number` for TS: ts-rs would emit
    /// `bigint` for an i64, which JSON never produces.
    #[serde(default)]
    #[ts(type = "number")]
    pub fetched_at_ms: i64,
    #[serde(default)]
    pub stats: Vec<LabelValue>,
    #[serde(default)]
    pub rows: Vec<RowValue>,
    #[serde(default)]
    pub error: Option<String>,
    /// One line the source computed for itself (`_card.headline`), shown above the stats.
    #[serde(default)]
    pub headline: Option<String>,
    /// `"warn"` or `"good"`; any other value from a source is dropped.
    #[serde(default)]
    pub headline_tone: Option<String>,
    #[serde(default)]
    pub progress: Option<CardProgress>,
    #[serde(default)]
    pub segments: Option<CardSegments>,
    /// The scrubbed response, kept only for an html display (its template
    /// reads it); every other display keeps just the values it extracted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub data: Option<serde_json::Value>,
}

/// A card's stored config next to its last cached result, so one call paints
/// a whole card list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CardView {
    #[serde(default)]
    pub config: CardConfig,
    #[serde(default)]
    pub result: Option<CardResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_key_formats() {
        assert_eq!(Scope::Group { id: "g1".into() }.scope_key(), "group:g1");
        let k = Scope::Project { cwd: "C:/x/app".into() }.scope_key();
        assert!(k.starts_with("project:"), "{k}");
    }

    #[test]
    fn project_scope_key_ignores_separator_style() {
        let a = Scope::Project { cwd: "C:\\x\\app".into() }.scope_key();
        let b = Scope::Project { cwd: "C:/x/app/".into() }.scope_key();
        assert_eq!(a, b);
    }

    #[test]
    fn tagged_enums_use_snake_case_kind() {
        let s = serde_json::to_value(Scope::Group { id: "g".into() }).unwrap();
        assert_eq!(s, serde_json::json!({"kind": "group", "id": "g"}));
        let c: CardSource = serde_json::from_value(serde_json::json!({
            "kind": "http", "url": "https://x"
        }))
        .unwrap();
        assert!(matches!(c, CardSource::Http { ref url, ref method, .. } if url == "https://x" && method.is_empty()));
    }

    #[test]
    fn missing_subfields_do_not_fail_deserialization() {
        let card: CardConfig = serde_json::from_str(r#"{"id":"a","display":{"kind":"list"}}"#).unwrap();
        assert_eq!(card.id, "a");
        assert!(!card.enabled);
        assert!(matches!(card.display, CardDisplay::List { ref items_path, .. } if items_path.is_empty()));
        let r: CardResult = serde_json::from_str("{}").unwrap();
        assert_eq!(r, CardResult::default());
        let g: GroupDef = serde_json::from_str(r#"{"id":"g"}"#).unwrap();
        assert!(g.repos.is_empty() && g.removed_repos.is_empty());
    }

    #[test]
    fn builtin_list_is_the_nine_cards() {
        assert_eq!(BUILTIN_CARDS.len(), 9);
        assert!(BUILTIN_CARDS.contains(&"usage"));
        assert!(BUILTIN_CARDS.contains(&"quick_actions"));
        assert!(!BUILTIN_CARDS.contains(&"needs_you"));
    }
}
