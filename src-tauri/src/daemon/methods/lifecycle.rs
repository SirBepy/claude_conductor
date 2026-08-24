//! Session-lifecycle RPC methods: start/send/cancel/end/attach/detach plus the
//! global notifier subscription and settings replacement. Each method is wired
//! into the Router with the SessionMap captured by the closure. Split by
//! register group into `lifecycle/` submodules (todo 747), mirroring
//! `methods/registry.rs`'s split (todo 723); this file just wires them.

mod account_move;
mod attach;
mod core;
#[cfg(debug_assertions)]
mod debug;
mod notifier;
mod settings;
mod shutdown;

use crate::daemon::lifecycle::LifecycleError;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use std::sync::Arc;

pub use notifier::register_notifier;
pub use settings::register_settings;

#[derive(Debug, Deserialize)]
struct SessionIdOnly {
    session_id: String,
}

pub(super) fn err_to_rpc(e: LifecycleError) -> RpcError {
    use LifecycleError::*;
    match e {
        InvalidConfig(_, _)
        | CwdMissing(_)
        | NoAccounts
        | NoDefault
        | AccountNotFound(_)
        | AccountDrift(_)
        | AccountCredentials(_)
        | Frozen(_) => RpcError::invalid_params(e.to_string()),
        NotFound(_) => RpcError {
            code: -32004,
            message: e.to_string(),
            data: None,
        },
        AlreadyExists(_) => RpcError {
            code: -32005,
            message: e.to_string(),
            data: None,
        },
        MeteredBilling(_) | Io(_) => RpcError::internal(e.to_string()),
    }
}

/// Thin dispatcher: each sub-function below registers its own group of RPC
/// methods against the same `router`/`state`, mirroring the standalone shape
/// `register_notifier`/`register_settings` already use for their groups.
pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    core::register_core(router, state.clone());
    account_move::register_account_move(router, state.clone());
    #[cfg(debug_assertions)]
    debug::register_debug(router, state.clone());
    attach::register_attach(router, state.clone());
    shutdown::register_shutdown(router, state);
}
