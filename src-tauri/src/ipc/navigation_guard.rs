//! Keeps every window's top-level page on the app's own entry pages.
//!
//! The app's origin serves the SPA shell (or whatever file it has) for any path, so
//! a navigation to `<origin>/notes.md`, or to a file dropped on the window, replaced
//! the whole app with a page that has no way back but quitting (pc-1746). The click
//! guard in `src/shared/external-links.ts` stops a link; this stops everything else
//! (a script's `location`, a form, a drop). It is one plugin hook, so every window,
//! however it is built, is covered.
//!
//! Allowed: `about:blank` (the load-failure panel parks the window there before it
//! writes its own page) and the entry pages `index.html` and `overlay.html` on the
//! app's origin, with any query or fragment (every `WebviewUrl::App` window and
//! every reload in `ipc::ready` and `bootstrap::watchdogs` lands on one of those).
//! Iframes are not top-level navigations, so a preview frame is unaffected.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Paths of the pages the windows are built with (`/` is the origin's index).
const ENTRY_PATHS: [&str; 3] = ["/", "/index.html", "/overlay.html"];

/// Whether a top-level navigation to `url` may proceed, given the app's `origin`.
pub(crate) fn allows(url: &Url, origin: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port() == origin.port()
        && ENTRY_PATHS.contains(&url.path())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let Ok(origin) = crate::ipc::ready::app_url("").parse::<Url>() else { return true };
            let ok = allows(url, &origin);
            if !ok {
                log::warn!("navigation-guard: {} refused a navigation to {url}", webview.label());
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    fn check(origin: &str, target: &str) -> bool {
        allows(&url(target), &url(origin))
    }

    #[test]
    fn the_entry_pages_load_with_any_query_or_fragment() {
        for origin in ["http://tauri.localhost/", "tauri://localhost/", "http://localhost:1420/"] {
            for page in ["", "index.html", "index.html?chatswindow=1#sessions", "overlay.html", "index.html#detached-x"] {
                let target = format!("{origin}{page}");
                assert!(check(origin, &target), "{target}");
            }
        }
    }

    #[test]
    fn another_path_on_the_app_origin_is_refused() {
        for target in [
            "http://tauri.localhost/feedback_x.md",
            "http://tauri.localhost/old-dashboard.html",
            "http://tauri.localhost/assets/main.js",
            "http://tauri.localhost/index.html/../notes.md",
            "http://tauri.localhost//evil",
        ] {
            assert!(!check("http://tauri.localhost/", target), "{target}");
        }
    }

    #[test]
    fn another_origin_or_scheme_is_refused() {
        let origin = "http://tauri.localhost/";
        for target in [
            "https://example.com/",
            "http://tauri.localhost.evil.com/index.html",
            "http://localhost:1420/index.html",
            "file:///C:/Users/x/a.md",
            "https://tauri.localhost/index.html",
            "data:text/html,<p>x</p>",
        ] {
            assert!(!check(origin, target), "{target}");
        }
    }

    #[test]
    fn the_load_failure_panel_may_park_the_window_on_about_blank() {
        assert!(check("http://tauri.localhost/", "about:blank"));
        assert!(!check("http://tauri.localhost/", "about:srcdoc"));
    }
}
