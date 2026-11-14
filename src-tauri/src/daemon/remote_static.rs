//! SPA static-asset serving for the remote-access server, split out of
//! `remote_handlers.rs` (ai_todo 514) since it shares no state/helpers with
//! the chat/session core there.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// The compiled frontend SPA, embedded at compile time from `../dist` (the vite
/// build output). `$CARGO_MANIFEST_DIR` resolves to `src-tauri/`, so the path
/// reaches the repo-root `dist/` directory.
///
/// The SPA HTML/JS/CSS are served UNAUTHENTICATED: they contain no secrets and
/// the SPA JS authenticates every `/api` call with the bearer token the user
/// pastes in once. `/api/*` routes stay token-gated by `auth_mw` as before.
///
/// Debug builds read `../dist` from disk instead (see `read_asset`), so this
/// struct goes unused there - hence `#[allow(dead_code)]`.
#[allow(dead_code)]
#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

/// Reads one SPA asset by relative path. Debug: disk read of `../dist`, so
/// `vite build` alone updates it. Release: the compile-time embed, unreachable
/// disk code since this cfg is resolved at compile time.
#[cfg(debug_assertions)]
async fn read_asset(asset_path: &str) -> Option<(Vec<u8>, String)> {
    let dist_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");
    let asset_path = asset_path.to_string();
    // Confinement check is sync (std::fs), so it runs off the async runtime
    // thread the same way the old tokio::fs::canonicalize calls did.
    let resolved = tokio::task::spawn_blocking(move || {
        crate::util::path::confine(&dist_root, &asset_path)
    })
    .await
    .ok()?
    .ok()?;
    let bytes = tokio::fs::read(&resolved).await.ok()?;
    let mime = mime_guess::from_path(&resolved)
        .first_or_octet_stream()
        .to_string();
    Some((bytes, mime))
}

#[cfg(not(debug_assertions))]
async fn read_asset(asset_path: &str) -> Option<(Vec<u8>, String)> {
    let content = Assets::get(asset_path)?;
    let mime = mime_guess::from_path(asset_path)
        .first_or_octet_stream()
        .to_string();
    Some((content.data.into_owned(), mime))
}

/// SPA fallback: serves the embedded frontend bundle for any path that does not
/// match a named API route. Handles two cases:
///   1. A real asset path (JS, CSS, fonts, icons) - serve it with the correct
///      Content-Type derived from the file extension.
///   2. A client-side route (anything that doesn't map to a file) - serve
///      `index.html` so the SPA router takes over (SPA fallback pattern).
///
/// Path sanitization prevents directory traversal: requests with `..` or a
/// backslash are rejected with 404 before any embed lookup.
pub(super) async fn spa_fallback(req: axum::extract::Request) -> Response {
    let raw = req.uri().path();
    // Strip leading slash to match rust-embed keys (e.g. "/assets/main.js" -> "assets/main.js").
    let path = raw.trim_start_matches('/');

    // Defense-in-depth: reject traversal attempts.
    if path.contains("..") || path.contains('\\') {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Serve the real asset if it exists, otherwise fall back to index.html for
    // SPA client-side routing.
    let found = if path.is_empty() {
        None
    } else {
        read_asset(path).await
    };

    let (bytes, mime) = match found {
        Some(found) => found,
        // A hashed chunk the bundle no longer embeds. index.html here would load
        // as JavaScript and fail on its MIME type, and the service worker would
        // cache that page under the chunk's URL; a 404 is the honest answer.
        None if is_asset_path(path) => return StatusCode::NOT_FOUND.into_response(),
        None => match read_asset("index.html").await {
            Some((html, mime)) => (stamp_build(html), mime),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    // A direct hit on /index.html (the empty path took the fallback above).
    let bytes = if path == "index.html" { stamp_build(bytes) } else { bytes };

    (StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response()
}

/// Paths under `assets/` are the bundle's content-hashed files, never client routes.
fn is_asset_path(path: &str) -> bool {
    path.starts_with("assets/")
}

/// The id of the embedded frontend build: a hash of its `index.html`, whose
/// asset names are content-hashed, so it changes whenever the bundle does.
/// `None` when there is no bundle.
pub(super) async fn build_id() -> Option<String> {
    use sha2::{Digest, Sha256};
    let (html, _) = read_asset("index.html").await?;
    let digest = Sha256::digest(&html);
    Some(digest.iter().take(6).map(|b| format!("{b:02x}")).collect())
}

/// Adds `<meta name="cc-build">` to a served index.html so a page can tell which
/// build it was loaded from (`src/shared/build-check.ts` compares it with
/// `/api/health`'s `build`). Anything that is not UTF-8 HTML with a `<head>` is
/// returned unchanged.
fn stamp_build(html: Vec<u8>) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let id: String = Sha256::digest(&html).iter().take(6).map(|b| format!("{b:02x}")).collect();
    let Ok(text) = std::str::from_utf8(&html) else { return html };
    let Some(head) = text.find("<head") else { return html };
    let Some(close) = text[head..].find('>') else { return html };
    let at = head + close + 1;
    let mut out = String::with_capacity(text.len() + 48);
    out.push_str(&text[..at]);
    out.push_str(&format!("<meta name=\"cc-build\" content=\"{id}\">"));
    out.push_str(&text[at..]);
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(path: &str) -> Response {
        let req = axum::extract::Request::builder().uri(path).body(axum::body::Body::empty()).unwrap();
        spa_fallback(req).await
    }

    async fn body_text(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[tokio::test]
    async fn a_missing_hashed_chunk_is_a_404_not_index_html() {
        let resp = get("/assets/main-OLDHASH0.js").await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_client_route_still_gets_index_html_with_the_build_stamp() {
        let resp = get("/some/client/route").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let html = body_text(resp).await;
        let id = build_id().await.expect("a built frontend");
        assert!(html.contains(&format!("<meta name=\"cc-build\" content=\"{id}\">")), "stamped with the build id");
    }

    #[tokio::test]
    async fn the_root_page_carries_the_same_stamp() {
        let html = body_text(get("/").await).await;
        let id = build_id().await.expect("a built frontend");
        assert!(html.contains(&format!("content=\"{id}\"")));
    }

    #[test]
    fn stamping_leaves_a_page_without_a_head_alone() {
        assert_eq!(stamp_build(b"plain".to_vec()), b"plain".to_vec());
        let stamped = String::from_utf8(stamp_build(b"<html><head lang=\"en\"><title>x</title></head></html>".to_vec())).unwrap();
        assert!(stamped.starts_with("<html><head lang=\"en\"><meta name=\"cc-build\""));
    }

    #[test]
    fn spa_assets_embed_index_html() {
        // Verifies that the rust-embed compile-time embedding captured the real
        // frontend build. If dist/ was absent at compile time this will be None.
        assert!(
            Assets::get("index.html").is_some(),
            "index.html not found in embedded assets - run `pnpm build` before `cargo build`"
        );
    }
}
