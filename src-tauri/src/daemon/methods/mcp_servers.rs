//! Sign-in RPCs for a project's own MCP servers (`daemon::mcp_oauth`). Both
//! are desktop-pipe only (absent from `remote_transport_table`): a phone or
//! peer machine has no business starting a browser sign-in on this PC.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::rpc::{Router, RpcError};

#[derive(Deserialize)]
struct UrlParams {
    url: String,
}

#[derive(Deserialize)]
struct UrlsParams {
    urls: Vec<String>,
}

pub fn register_mcp_servers(router: &mut Router) {
    // Returns the URL to open; the token lands in the store when the browser
    // comes back, which `mcp_signed_in` reports.
    router.register("mcp_sign_in", |params, _ctx| async move {
        let req: UrlParams = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let path = crate::daemon::mcp_oauth::store_path()
            .ok_or_else(|| RpcError::invalid_params("no data dir".to_string()))?;
        let auth_url = crate::daemon::mcp_oauth::begin_sign_in(path, req.url)
            .await
            .map_err(RpcError::invalid_params)?;
        Ok(json!({ "auth_url": auth_url }))
    });

    router.register("mcp_signed_in", |params, _ctx| async move {
        let req: UrlsParams = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let path = crate::daemon::mcp_oauth::store_path();
        let map: serde_json::Map<String, Value> = req
            .urls
            .into_iter()
            .map(|u| {
                let on = path.as_deref().is_some_and(|p| crate::daemon::mcp_oauth::signed_in(p, &u));
                (u, Value::Bool(on))
            })
            .collect();
        Ok(Value::Object(map))
    });
}
