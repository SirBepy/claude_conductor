mod iroh_tunnel;

use iroh_tunnel::{is_tunnel_port, start_iroh_tunnel, IrohTunnelState};

/// Bundled-shell entry point; the setup/health-check/handoff logic is in android/src/app.js.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Without this, iroh_tunnel's log::error!/info! calls are pure no-ops on
    // Android - the `log` crate has no backend until one is installed (see
    // todo 563: the tunnel's failures were invisible on-device for this reason).
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info),
    );

    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| allow_navigation(url))
                .build(),
        )
        .manage(IrohTunnelState::default())
        .invoke_handler(tauri::generate_handler![start_iroh_tunnel])
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The bundled shell is served from http://tauri.localhost on Android (useHttpsScheme
/// is false), so an https-only guard silently refuses our own first page load.
fn allow_navigation(url: &tauri::Url) -> bool {
    if url.host_str() == Some("tauri.localhost") {
        return true;
    }
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some_and(is_tunnel_port) {
        return true;
    }
    url.scheme() == "https"
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Url;

    #[test]
    fn allows_https() {
        assert!(allow_navigation(&Url::parse("https://example.ts.net/api/health").unwrap()));
        assert!(allow_navigation(&Url::parse("https://tauri.localhost/index.html").unwrap()));
    }

    /// Android serves the bundled shell over http, so refusing this is a blank white app.
    #[test]
    fn allows_the_local_asset_origin_over_http() {
        assert!(allow_navigation(&Url::parse("http://tauri.localhost/index.html").unwrap()));
    }

    #[test]
    fn rejects_non_https() {
        assert!(!allow_navigation(&Url::parse("http://example.com").unwrap()));
        assert!(!allow_navigation(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(!allow_navigation(
            &Url::parse("javascript:alert(1)").unwrap()
        ));
    }

    /// A derived per-endpoint port is allowed once its tunnel is live, and
    /// never before: any other loopback port would be a general
    /// http-on-localhost hole.
    #[test]
    fn allows_a_live_tunnel_port_and_no_other_loopback_port() {
        let id = iroh::SecretKey::from_bytes(&[9; 32]).public();
        let port = iroh_tunnel::derived_port(&id);
        assert!(!allow_navigation(&Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()));
        iroh_tunnel::mark_live_for_test(port);
        assert!(allow_navigation(&Url::parse(&format!("http://127.0.0.1:{port}/index.html")).unwrap()));
        assert!(!allow_navigation(&Url::parse("http://127.0.0.1:9999/").unwrap()));
        assert!(!allow_navigation(&Url::parse(&format!("http://example.com:{port}/")).unwrap()));
    }
}
