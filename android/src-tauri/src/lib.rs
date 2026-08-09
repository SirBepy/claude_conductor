mod iroh_tunnel;

use iroh_tunnel::{start_iroh_tunnel, IrohTunnelState, LOOPBACK_PORT};

/// Bundled-shell entry point; the setup/health-check/handoff logic is in android/src/app.js.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(LOOPBACK_PORT) {
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

    #[test]
    fn allows_the_iroh_loopback_origin() {
        assert!(allow_navigation(
            &Url::parse("http://127.0.0.1:27184/index.html").unwrap()
        ));
    }

    /// The port must be the fixed one, not any loopback port - else the
    /// guard's third branch would be a general http-on-localhost hole.
    #[test]
    fn rejects_loopback_on_the_wrong_port() {
        assert!(!allow_navigation(&Url::parse("http://127.0.0.1:9999/").unwrap()));
    }

    #[test]
    fn rejects_the_right_port_on_a_non_loopback_host() {
        assert!(!allow_navigation(
            &Url::parse("http://example.com:27184/").unwrap()
        ));
    }
}
