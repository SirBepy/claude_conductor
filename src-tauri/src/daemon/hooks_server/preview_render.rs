//! `POST /hooks/preview-render` + `GET /hooks/preview-render/:id`: serves the
//! panel's pre-built HTML doc over a real local origin instead of a `data:`
//! URL, so it gets its own CSP header instead of intersecting with the app
//! shell's. In-memory, bounded, evict-on-insert cache - not `preview.rs`'s disk-persisted history.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{
    extract::{Path as AxPath, State as AxState},
    http::{header, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use crate::daemon::render_cache::RenderCache;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex, OnceLock};

/// Own cell, separate from the remote server's: see `RenderCache::instance`.
fn cell() -> &'static Mutex<RenderCache> {
    static CELL: OnceLock<Mutex<RenderCache>> = OnceLock::new();
    RenderCache::instance(&CELL)
}

#[derive(Deserialize, Debug)]
pub(super) struct PreviewRenderBody {
    html: String,
}

pub(super) async fn on_preview_render(
    AxState(_ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<PreviewRenderBody>,
) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    cell().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), body.html);
    (StatusCode::OK, Json(json!({ "id": id })))
}

/// Deliberately wide-open: this doc is sandboxed (`allow-scripts`, no
/// `allow-same-origin`), so its policy is independent of the app shell's.
pub(crate) const RENDER_DOC_CSP: &str =
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; font-src * data:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval' blob:;";

pub(super) async fn on_preview_render_get(AxPath(id): AxPath<String>) -> Response {
    let html = {
        let cache = cell().lock().unwrap_or_else(|e| e.into_inner());
        cache.get(&id)
    };
    match html {
        Some(html) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                (HeaderName::from_static("content-security-policy"), RENDER_DOC_CSP.to_string()),
            ],
            html,
        )
            .into_response(),
        // Evicted or unknown id - frontend treats this as "nothing to show".
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
