//! API token broker (see docs/api-broker-plan.md): the engine that makes
//! authenticated calls for a chat so no token ever reaches model-readable text.
//!
//! Built in steps; `mask` is step 2 and is what every later part of the broker
//! runs a response body, header value, error string and `out_file` text through
//! before anything leaves the daemon.

pub mod mask;
