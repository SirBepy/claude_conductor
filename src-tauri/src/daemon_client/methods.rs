//! Typed one-line RPC wrapper methods on `PersistentClient`. Split out of
//! `mod.rs` (which keeps the transport/connection plumbing: `connect`,
//! `call`, subscription bookkeeping, address construction, `ensure_daemon`)
//! purely to keep file size manageable - ai_todo 265. Split further by domain
//! into `methods/` submodules - ai_todo 601. Pure code motion, no behavior
//! change.

mod api_credit;
mod ask;
mod attachments;
mod claude_ai_publish;
mod gaming_mode;
mod git;
mod hidden_chats;
mod history;
mod message_drafts;
mod misc;
mod permission;
mod preview;
mod project_dashboard;
mod user_todos;
mod schedule;
mod sessions;
mod voice;

use super::ClientError;

/// The error for a result whose JSON did not deserialize into the wrapper's
/// return type, named by RPC method so a daemon/desktop version skew is
/// traceable from the message alone.
pub(super) fn bad_shape(method: &str, e: serde_json::Error) -> ClientError {
    ClientError::Rpc { code: -32000, message: format!("{method}: bad result shape: {e}") }
}
