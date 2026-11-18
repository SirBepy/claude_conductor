//! API token broker (see docs/api-broker-plan.md): the engine that makes
//! authenticated calls for a chat so no token ever reaches model-readable text.
//!
//! Built in steps. Read docs/architecture/api-broker.md before editing.
//!
//! - `mask` (step 2): every result runs through it before anything leaves.
//! - `engine` (step 3a): `Engine::call`, the one entry point, with
//!   `services` (host and auth shape per service), `guards` (request rules),
//!   `graphql` (Linear's narrow document reader), `ownership` (Shortcut and
//!   Linear), `audit` (append-only JSONL), `store` (where secrets come from)
//!   and `policy` (the trait step 3b implements).

pub mod audit;
pub mod engine;
pub mod graphql;
pub mod guards;
pub mod mask;
pub mod ownership;
pub mod policy;
pub mod services;
pub mod store;

#[cfg(test)]
mod engine_tests;
