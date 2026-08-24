//! Settings snapshot fetch/replace, independent of any single session.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::settings_cache::SettingsCache;

pub fn register_settings(router: &mut Router, cache: SettingsCache) {
    let cache_get = cache.clone();
    router.register("get_settings", move |_params, _ctx| {
        let cache = cache_get.clone();
        async move {
            let snap = cache.snapshot();
            serde_json::to_value(&snap).map_err(|e| RpcError::internal(e.to_string()))
        }
    });
    router.register("set_settings", move |params, _ctx| {
        let cache = cache.clone();
        async move {
            let v = params.unwrap_or(serde_json::Value::Null);
            let s: crate::types::Settings = serde_json::from_value(v)
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            cache.replace(s);
            Ok(serde_json::json!({"ok": true}))
        }
    });
}
