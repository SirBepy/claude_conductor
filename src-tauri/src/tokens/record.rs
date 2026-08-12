use serde::{Deserialize, Serialize};

/// One session's aggregated token counts, as persisted and returned to the UI.
#[derive(Serialize, Deserialize, Clone, Debug, Default, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// ISO date (YYYY-MM-DD) the session happened on.
    pub date: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
    #[serde(default)]
    pub turns: u64,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub last_active_at: String,
    #[serde(default)]
    pub recorded_at: String,
    /// Set on records produced by `active_sessions()` — the renderer uses
    /// this to style in-progress sessions.
    #[serde(default)]
    pub live: Option<bool>,
    /// Agent IDs whose subagent transcripts have been merged into this record.
    /// Kept for idempotency of repeated backfills.
    #[serde(default)]
    pub merged_subagents: Option<Vec<String>>,
    /// Session kind at record-append time (Interactive CLI vs Automated/External
    /// app-hosted). `None` on rows written before this field existed, or when the
    /// writer had no live `Instance` to read it from - treated as its own
    /// "unknown" bucket, never guessed.
    #[serde(default)]
    pub kind: Option<crate::sessions::kinds::InstanceKind>,
}

/// Summed token usage from a single transcript file.
#[derive(Clone, Debug, Default)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Count of model invocations (every line with a `usage` block).
    /// Includes each tool-call round-trip, so a single user prompt can
    /// produce many turns.
    pub turns: u64,
    /// Count of genuine human messages sent (real `user` turns, excluding
    /// `last-prompt` checkpoint dupes, tool_result continuations, and meta
    /// rows - see `title::is_real_user_turn`). A true "messages sent by me"
    /// count, unlike `turns`, which inflates with tool-call chatter.
    pub user_prompts: u64,
}

/// Result of a `backfill_all()` run — reported back to the renderer so it can
/// render "Done — X new, Y skipped".
#[derive(Serialize, Clone, Debug, Default, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct BackfillResult {
    pub processed: u32,
    pub skipped: u32,
    pub sub_processed: u32,
    pub sub_skipped: u32,
}
