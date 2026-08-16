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
    let candidate = dist_root.join(asset_path);
    let root = tokio::fs::canonicalize(&dist_root).await.ok()?;
    let resolved = tokio::fs::canonicalize(&candidate).await.ok()?;
    // Reject anything canonicalizing outside dist_root (symlinks, traversal).
    if !resolved.starts_with(&root) {
        return None;
    }
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
        None => match read_asset("index.html").await {
            Some(found) => found,
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };

    (StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

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
