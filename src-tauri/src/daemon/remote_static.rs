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
    let wants_gzip = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(accepts_gzip);
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

    let mut resp = Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, &mime);
    // The hashed files can never change under their name, so a WebView that has one
    // never asks the PC for it again, service worker or not.
    if is_asset_path(path) {
        resp = resp.header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    }
    let bytes = if wants_gzip && is_compressible(&mime) && bytes.len() >= MIN_GZIP_LEN {
        // A failed task is a 500 with no cache header, never an empty 200 that a service
        // worker or the WebView would then keep under `immutable`.
        let Some((out, zipped)) = gzipped(path, bytes).await else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        if zipped {
            resp = resp.header(header::CONTENT_ENCODING, "gzip");
        }
        out
    } else {
        bytes
    };
    // Vary on every text answer, zipped or not, so a shared cache never hands a
    // gzip body to a client that did not ask for it.
    if is_compressible(&mime) {
        resp = resp.header(header::VARY, "Accept-Encoding");
    }
    resp.body(axum::body::Body::from(bytes)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Below this a gzip header costs more than it saves.
const MIN_GZIP_LEN: usize = 1024;

/// Whether the client's `Accept-Encoding` lists gzip with a non-zero weight.
fn accepts_gzip(value: &str) -> bool {
    value.split(',').any(|part| {
        let mut bits = part.split(';');
        let coding = bits.next().unwrap_or("").trim();
        if !coding.eq_ignore_ascii_case("gzip") {
            return false;
        }
        bits.all(|p| match p.trim().strip_prefix("q=") {
            Some(q) => q.trim().parse::<f32>().map_or(true, |q| q > 0.0),
            None => true,
        })
    })
}

/// Text-shaped types shrink 3x or more; images, fonts and audio are already packed.
fn is_compressible(mime: &str) -> bool {
    let essence = mime.split(';').next().unwrap_or("").trim();
    essence.starts_with("text/")
        || essence == "application/json"
        || essence == "application/manifest+json"
        || essence == "application/wasm"
        || essence.ends_with("javascript")
        || essence.ends_with("+xml")
        || essence == "image/svg+xml"
}

/// Gzip of one served file, or the bytes unchanged (`false`) when compressing
/// fails, or `None` when the compressing task itself died. A hashed asset is
/// compressed once and kept for the life of the process: the bundle is embedded,
/// so a name never changes content and the set of names is fixed. Debug builds
/// read `../dist` from disk, where the file system may fold case, so a request
/// could mint endless key spellings: they keep nothing. index.html carries a
/// per-build stamp and is small, so it is not kept either.
async fn gzipped(path: &str, bytes: Vec<u8>) -> Option<(Vec<u8>, bool)> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static KEPT: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let keep = is_asset_path(path) && !cfg!(debug_assertions);
    if keep {
        if let Some(hit) = KEPT.get_or_init(Default::default).lock().ok().and_then(|m| m.get(path).cloned()) {
            return Some((hit, true));
        }
    }
    let joined = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(bytes.len() / 3), flate2::Compression::new(6));
        match enc.write_all(&bytes).ok().and_then(|()| enc.finish().ok()) {
            Some(zipped) => (zipped, true),
            None => (bytes, false),
        }
    })
    .await;
    let (out, zipped) = joined.ok()?;
    if keep && zipped {
        if let Ok(mut m) = KEPT.get_or_init(Default::default).lock() {
            m.insert(path.to_string(), out.clone());
        }
    }
    Some((out, zipped))
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
        spa_fallback(axum::extract::Request::builder().uri(path).body(axum::body::Body::empty()).unwrap()).await
    }

    async fn get_accepting(path: &str, accept_encoding: &str) -> Response {
        let req = axum::extract::Request::builder()
            .uri(path)
            .header(header::ACCEPT_ENCODING, accept_encoding)
            .body(axum::body::Body::empty())
            .unwrap();
        spa_fallback(req).await
    }

    /// The biggest embedded script: the page's own entry chunk, which a phone must pull before it draws.
    fn biggest_script() -> (String, usize) {
        Assets::iter()
            .filter(|n| n.starts_with("assets/") && n.ends_with(".js"))
            .map(|n| {
                let len = Assets::get(&n).map_or(0, |f| f.data.len());
                (format!("/{n}"), len)
            })
            .max_by_key(|(_, len)| *len)
            .expect("a built frontend with scripts")
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

    #[tokio::test]
    async fn a_script_is_gzipped_for_a_client_that_accepts_it_and_unpacks_to_the_same_bytes() {
        let (path, raw_len) = biggest_script();
        let resp = get_accepting(&path, "gzip, deflate, br").await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap()), Some("gzip"));
        assert_eq!(resp.headers().get(header::VARY).map(|v| v.to_str().unwrap()), Some("Accept-Encoding"));
        let zipped = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert!(zipped.len() * 2 < raw_len, "gzip must at least halve the script ({} of {raw_len} bytes)", zipped.len());
        let mut unpacked = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&zipped[..]), &mut unpacked).unwrap();
        assert_eq!(unpacked, Assets::get(path.trim_start_matches('/')).unwrap().data.as_ref());
        // A second ask returns the same bytes (a release build serves it from the kept copy; tests build with debug assertions, which keep none).
        let again = axum::body::to_bytes(get_accepting(&path, "gzip").await.into_body(), usize::MAX).await.unwrap();
        assert_eq!(again, zipped);
    }

    #[tokio::test]
    async fn a_client_that_does_not_ask_for_gzip_gets_the_raw_script() {
        let (path, raw_len) = biggest_script();
        for accept in [None, Some("identity"), Some("gzip;q=0, br")] {
            let resp = match accept {
                Some(a) => get_accepting(&path, a).await,
                None => get(&path).await,
            };
            assert!(resp.headers().get(header::CONTENT_ENCODING).is_none(), "{accept:?}");
            assert_eq!(axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap().len(), raw_len);
        }
    }

    #[tokio::test]
    async fn a_hashed_file_is_cached_for_good_and_the_page_itself_is_not() {
        let (path, _) = biggest_script();
        let hashed = get(&path).await;
        let cache = hashed.headers().get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap().to_string());
        assert_eq!(cache.as_deref(), Some("public, max-age=31536000, immutable"));
        assert!(get("/").await.headers().get(header::CACHE_CONTROL).is_none());
    }

    #[tokio::test]
    async fn the_page_is_gzipped_too_and_still_carries_the_build_stamp() {
        let resp = get_accepting("/", "gzip").await;
        assert_eq!(resp.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap()), Some("gzip"));
        let zipped = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let mut html = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&zipped[..]), &mut html).unwrap();
        let id = build_id().await.expect("a built frontend");
        assert!(html.contains(&format!("content=\"{id}\"")));
    }

    #[test]
    fn accept_encoding_parsing_honours_weights_and_case() {
        assert!(accepts_gzip("gzip"));
        assert!(accepts_gzip("br, GZip;q=0.5"));
        assert!(accepts_gzip("deflate,gzip;q=1.0"));
        assert!(!accepts_gzip("gzip;q=0"));
        assert!(!accepts_gzip("br, deflate"));
        assert!(!accepts_gzip("x-gzip-not"));
        assert!(!accepts_gzip(""));
    }

    #[test]
    fn only_text_shaped_types_are_compressed() {
        assert!(is_compressible("text/javascript"));
        assert!(is_compressible("text/css"));
        assert!(is_compressible("application/json"));
        assert!(is_compressible("image/svg+xml"));
        assert!(!is_compressible("image/png"));
        assert!(!is_compressible("font/woff2"));
        assert!(!is_compressible("application/octet-stream"));
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
