//! Durable store for draft messages Claude writes for the user to send
//! elsewhere (todo 666). File `<app-data>/message-drafts/<project_id>.json`,
//! daemon is sole writer, same shape and trust model as `user_todos`.
//! One card is one TOPIC; recipients are variants inside it.

mod api;
mod persistence;
mod types;

pub use api::*;
pub use types::*;
