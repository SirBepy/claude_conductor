//! Typed one-line RPC wrapper methods on `PersistentClient`. Split out of
//! `mod.rs` (which keeps the transport/connection plumbing: `connect`,
//! `call`, subscription bookkeeping, address construction, `ensure_daemon`)
//! purely to keep file size manageable - ai_todo 265. Split further by domain
//! into `methods/` submodules - ai_todo 601. Pure code motion, no behavior
//! change.

mod ask;
mod channels;
mod message_drafts;
mod misc;
mod permission;
mod preview;
mod user_todos;
mod schedule;
mod sessions;
