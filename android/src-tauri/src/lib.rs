/// Bundled-shell entry point; the setup/health-check/handoff logic is in android/src/app.js.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| allow_navigation(url))
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Host varies per user, so scheme is all we can pin. https covers both the local
/// asset origin (tauri.localhost on Android) and whichever server the user enters.
fn allow_navigation(url: &tauri::Url) -> bool {
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

    #[test]
    fn rejects_non_https() {
        assert!(!allow_navigation(&Url::parse("http://example.com").unwrap()));
        assert!(!allow_navigation(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(!allow_navigation(
            &Url::parse("javascript:alert(1)").unwrap()
        ));
    }
}
