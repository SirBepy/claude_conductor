//! Settings' "Show Claude's browser" RPCs. Desktop-pipe only (absent from
//! `remote_transport_table::TRANSPORT_TABLE`): the window opens on this PC's
//! screen, so neither the phone nor a paired machine has a use for it.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::rpc::{Router, RpcError};

#[derive(Deserialize)]
struct SetShownParams {
    shown: bool,
}

pub fn register(router: &mut Router) {
    router.register("browser_status", |_params, _ctx| async move {
        let chrome = super::get().chrome();
        Ok(json!({
            "running": chrome.port_if_running().await.is_some(),
            "shown": chrome.is_shown(),
        }))
    });

    router.register("browser_set_shown", |params, _ctx| async move {
        let req: SetShownParams = serde_json::from_value(params.unwrap_or(Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        super::get().chrome().set_shown(req.shown).await.map_err(RpcError::internal)?;
        Ok(json!({ "ok": true, "shown": req.shown }))
    });
}
