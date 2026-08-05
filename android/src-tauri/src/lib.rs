/// Bundled-shell entry point; the setup/health-check/handoff logic is in android/src/app.js.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| allow_navigation(url))
                .build(),
        )
        .setup(|app| {
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
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
}
