use crate::daemon::rpc::Router;
use serde_json::json;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// What this daemon reports as its release version. A local build carries the
/// committed (stale on purpose) Cargo version, so only a CI build, whose release
/// job rewrites it, reports a number; same rule as `ipc::misc::get_app_version`.
fn release_version() -> &'static str {
    if option_env!("CI").is_none() { "local-build" } else { DAEMON_VERSION }
}

pub fn register(router: &mut Router) {
    router.register("health", |_params, _ctx| async move {
        Ok(json!({
            "daemon_version": DAEMON_VERSION,
            "protocol_version": PROTOCOL_VERSION,
        }))
    });
    // The phone's About page asks this by the same name the desktop's Tauri
    // command answers to, so the page needs no phone-only call. The daemon is
    // the PC app's own exe, so its version is the version the phone is talking to.
    router.register("get_version_info", |_params, _ctx| async move {
        Ok(json!({
            "version": release_version(),
            "build_date": option_env!("BUILD_DATE").unwrap_or("unknown"),
            "installed_at": null,
        }))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    #[tokio::test]
    async fn health_returns_versions() {
        let mut r = Router::new();
        register(&mut r);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "health".into(),
            params: None,
        }, dummy_ctx()).await;
        let result = resp.result.expect("result");
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));
        assert_eq!(result["daemon_version"], json!(DAEMON_VERSION));
    }

    #[tokio::test]
    async fn get_version_info_matches_the_desktop_command_shape() {
        let mut r = Router::new();
        register(&mut r);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_version_info".into(),
            params: None,
        }, dummy_ctx()).await;
        let result = resp.result.expect("result");
        assert_eq!(result["version"], json!(release_version()));
        assert!(result["build_date"].is_string());
        assert!(result["installed_at"].is_null());
    }
}
