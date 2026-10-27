//! Settings' browser status RPC. Desktop-pipe only (absent from
//! `remote_transport_table::TRANSPORT_TABLE`): it reports this PC's browsers,
//! so neither the phone nor a paired machine has a use for it.

use serde_json::json;

use crate::daemon::rpc::Router;

pub fn register(router: &mut Router) {
    router.register("browser_status", |_params, _ctx| async move {
        let chrome = super::get().chrome();
        Ok(json!({
            "running": chrome.port_if_running().await.is_some(),
            "bridgeConnected": super::bridge::get().connected_browsers(),
            "extensionDir": super::bridge::extension_dir(),
        }))
    });
}
