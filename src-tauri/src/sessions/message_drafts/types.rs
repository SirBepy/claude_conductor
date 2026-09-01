//! `DraftState`, `DraftAuthor`, `DraftReceipt`, `DraftVersion`, `DraftVariant`,
//! `MessageDraft`, and the private on-disk `Store` shape. See `message_drafts`
//! for the module's overall contract.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DraftState {
    /// Written or edited, not yet acted on.
    #[default]
    NeedsYou,
    Ready,
    /// Set when Copy is actually pressed. Inferred, never claimed - nothing
    /// here can see whether it reached Slack.
    Copied,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DraftAuthor {
    #[default]
    Ai,
    User,
}

/// Where one claim in the body came from: a `file:line`, a command's output, or
/// the user's own words. The reviewer (chunk 2) checks the text against these.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftReceipt {
    pub claim: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftVersion {
    pub n: u32,
    /// Markdown. Kept as text, not HTML, so a later diff against the user's
    /// edit is exact and the plain-text clipboard payload is free.
    pub body: String,
    pub author: DraftAuthor,
    pub note: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DraftVariant {
    pub recipient: String,
    /// The `#n` in "Bruno #2": per person, project-wide, never reused.
    pub handle_n: u32,
    pub versions: Vec<DraftVersion>,
    pub current: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct MessageDraft {
    pub id: String,
    pub topic: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub receipts: Vec<DraftReceipt>,
    pub variants: Vec<DraftVariant>,
    #[serde(default)]
    pub state: DraftState,
    pub origin_session_id: String,
    /// Registry `name` at write time, same rule as `UserTodo::origin_label`:
    /// a renamed session keeps the label its cards were written under.
    pub origin_label: String,
    pub created_at: String,
    pub updated_at: String,
    /// False after a user-side edit, true once a turn from the authoring
    /// session has been served the change. Same contract as `UserTodo`.
    #[serde(default)]
    pub seen_by_origin: bool,
}

/// Persisted as an object rather than a bare array because `handles` must
/// outlive the drafts it counted - a pruned card must not free its number.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct Store {
    #[serde(default)]
    pub(super) drafts: Vec<MessageDraft>,
    #[serde(default)]
    pub(super) handles: BTreeMap<String, u32>,
}
