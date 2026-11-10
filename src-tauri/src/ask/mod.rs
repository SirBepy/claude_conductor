//! Side questions about a chat, answered by a read-only `claude -p` sidecar:
//! the threads behind the chat dashboard's Answers card. It never writes to a
//! live session's stdin, so nothing it produces reaches Claude's prompt stream;
//! the only way back in is a message Joe sends himself.

pub mod answer_state;
pub mod sidecar;
pub mod store;

pub use store::{AskMessage, AskThread};
