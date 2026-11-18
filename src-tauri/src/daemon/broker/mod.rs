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
//! - `session` + `binding` (step 4): the per-session HMAC token (`CC_BROKER_TOKEN`),
//!   its revocation when a chat closes, and the service set a chat is bound to
//!   (`ProjectConfig.broker_services`, a sub inheriting its parent's).
//! - `front` (step 5): the logic behind the MCP tools `api_read` and `api_write`, and the
//!   daemon's one `Engine` (`front::daemon_engine`).
//! - `out_file` (step 6): where the loopback HTTP front (`hooks_server/api_broker_http.rs`,
//!   `front::run_script`) may write a response.
//! - `card_ops` + `cards` (step 7): what the three cards do (import, add/replace, policy row)
//!   and how they are raised and answered; only Joe's own UI action answers one.
//! - `policy_rules` + `policy_file` (step 3b): the rows, `FilePolicy` (the
//!   `Policy` that reads and hot-reloads `<data_dir>/broker-policy.json`, seeded
//!   from `broker-policy-seed.json`) and the one write function the card calls.

pub mod audit;
pub mod binding;
pub mod card_ops;
pub mod carry;
pub mod cards;
pub mod engine;
pub mod friction;
pub mod front;
pub mod graphql;
pub mod guards;
pub mod mask;
pub mod out_file;
pub mod ownership;
pub mod policy;
pub mod policy_file;
pub mod policy_rules;
pub mod services;
pub mod session;
pub mod store;

#[cfg(test)]
mod cards_tests;
#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod scope_tests;
