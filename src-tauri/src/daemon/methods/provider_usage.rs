//! `get_provider_usage`: the cached provider figures plus the transcript token
//! sums for every Endpoint account. Figures only: the key is read by the
//! fetcher inside `daemon::provider_usage` and never reaches a result.

use crate::daemon::provider_usage::{self, ProviderUsageView};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::tokens::account_usage::{account_tokens, AccountTokens};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// Token sums for every Endpoint account. Walks transcript files, so callers
/// run it off the async threads.
fn endpoint_tokens() -> HashMap<String, AccountTokens> {
    crate::accounts::load_registry()
        .into_iter()
        .filter(|a| a.is_endpoint())
        .map(|a| (a.id.clone(), account_tokens(&a)))
        .collect()
}

pub fn register_provider_usage(router: &mut Router, state: Arc<DaemonState>) {
    // Cached figures only: never waits on a provider. An account with no read
    // yet starts one in the background, so the page's next read has it.
    router.register("get_provider_usage", move |_params, _ctx| {
        let state = state.clone();
        async move {
            provider_usage::kick_missing(&state);
            let tokens = tokio::task::spawn_blocking(endpoint_tokens)
                .await
                .map_err(|e| RpcError::internal(format!("reading token totals: {e}")))?;
            Ok(json!(ProviderUsageView { usage: state.provider_usage.snapshot(), tokens }))
        }
    });
}
