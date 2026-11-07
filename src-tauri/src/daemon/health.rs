use crate::daemon::rpc::Router;
use serde_json::json;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The release version string the app reports, for the desktop About page
/// (`ipc::misc::get_app_version`) and the phone's (`get_version_info` below), so
/// the two cannot drift. A local build carries the committed (stale on purpose)
/// version, so only a CI build, whose release job rewrites it, reports a number.
/// `config_version` is the Tauri config's version, which only the desktop app can
/// read (the daemon has no `AppHandle`); a blank or missing one falls back to
/// the Cargo version.
pub(crate) fn release_version(is_ci: bool, config_version: Option<&str>) -> String {
    if !is_ci {
        return "local-build".to_string();
    }
    config_version.filter(|v| !v.is_empty()).unwrap_or(DAEMON_VERSION).to_string()
}

/// `release_version` for this binary: CI-ness is fixed when it is compiled.
pub(crate) fn build_release_version(config_version: Option<&str>) -> String {
    release_version(option_env!("CI").is_some(), config_version)
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
            "version": build_release_version(None),
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
        assert_eq!(result["version"], json!(build_release_version(None)));
        assert!(result["build_date"].is_string());
        assert!(result["installed_at"].is_null());
    }

    #[test]
    fn a_non_ci_build_reports_local_build_whatever_the_config_says() {
        assert_eq!(release_version(false, None), "local-build");
        assert_eq!(release_version(false, Some("9.9.9")), "local-build");
    }

    #[test]
    fn a_ci_build_reports_the_config_version_and_falls_back_to_cargo_when_it_has_none() {
        assert_eq!(release_version(true, Some("1.2.3")), "1.2.3");
        assert_eq!(release_version(true, None), DAEMON_VERSION);
        assert_eq!(release_version(true, Some("")), DAEMON_VERSION, "a blank config version is no version");
    }

    /// The daemon (no `AppHandle`) passes no config version and the desktop passes
    /// the Tauri one, yet when the config carries the Cargo version, as CI makes
    /// it, both report the same string on either path.
    #[test]
    fn daemon_and_desktop_agree_when_ci_keeps_the_versions_in_step() {
        for is_ci in [false, true] {
            assert_eq!(release_version(is_ci, None), release_version(is_ci, Some(DAEMON_VERSION)));
        }
    }
}
