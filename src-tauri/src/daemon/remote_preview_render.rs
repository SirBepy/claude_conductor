//! `POST /api/preview-render` + `GET /api/preview-render/:id`: same-origin
//! staging for the preview-panel iframe (todo 715), mirroring
//! `hooks_server/preview_render.rs`'s cache. Served from THIS origin so
//! `frame-src 'self'` covers it - the hook server (27182) is loopback-only.

use super::remote_server::RemoteCtx;
use crate::daemon::device_registry::DeviceRegistry;
use axum::{
    extract::{Path as AxPath, Query, State as AxState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

/// Rolling window, not a growable history - see `preview_render.rs`'s
/// identical cache for the rationale (fires on every re-render).
const MAX_RENDER_CACHE: usize = 10;

struct RenderCache {
    entries: HashMap<String, String>,
    order: VecDeque<String>,
}

fn cell() -> &'static Mutex<RenderCache> {
    static CELL: OnceLock<Mutex<RenderCache>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(RenderCache { entries: HashMap::new(), order: VecDeque::new() }))
}

#[derive(Deserialize)]
pub(super) struct PreviewRenderBody {
    html: String,
}

/// Staging POST. Lives in the `protected` router in `remote_server.rs`, so
/// it is bearer-gated by `auth_mw` like every other `/api/*` data route -
/// no separate auth check needed here.
pub(super) async fn on_preview_render(
    AxState(_ctx): AxState<Arc<RemoteCtx>>,
    Json(body): Json<PreviewRenderBody>,
) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    let mut cache = cell().lock().unwrap_or_else(|e| e.into_inner());
    if cache.order.len() >= MAX_RENDER_CACHE {
        if let Some(oldest) = cache.order.pop_front() {
            cache.entries.remove(&oldest);
        }
    }
    cache.entries.insert(id.clone(), body.html);
    cache.order.push_back(id.clone());
    (StatusCode::OK, Json(json!({ "id": id })))
}

#[derive(Deserialize)]
pub(super) struct RenderDocQuery {
    token: String,
}

/// Fetch GET. Public route (an `<iframe src>` can't set an Authorization
/// header), so it self-authenticates via `?token=` like `stream_ws`. Lookup
/// is by opaque cache id ONLY - no path/filename ever reaches disk, and an
/// unknown/malformed id is a plain 404 with none of the input echoed back.
pub(super) async fn on_preview_render_get(
    AxState(ctx): AxState<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<RenderDocQuery>,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let html = {
        let cache = cell().lock().unwrap_or_else(|e| e.into_inner());
        cache.entries.get(&id).cloned()
    };
    match html {
        Some(html) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                (
                    header::CONTENT_SECURITY_POLICY,
                    super::hooks_server::preview_render::RENDER_DOC_CSP.to_string(),
                ),
            ],
            html,
        )
            .into_response(),
        // Unknown or evicted id - no filesystem read, no reflected input.
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn test_ctx(app_data: std::path::PathBuf) -> Arc<RemoteCtx> {
        Arc::new(RemoteCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
            app_data,
            router: crate::daemon::rpc::Router::new(),
            stt: crate::daemon::stt::SttSupervisor::new(std::env::temp_dir()),
        })
    }

    #[tokio::test]
    async fn unknown_id_with_valid_token_is_404_not_disk_read() {
        let dir = tempdir().unwrap();
        let token = DeviceRegistry::add_device("Test", dir.path()).unwrap();
        let ctx = test_ctx(dir.path().to_path_buf());

        let resp = on_preview_render_get(
            AxState(ctx),
            AxPath("../../../etc/passwd".to_string()),
            Query(RenderDocQuery { token }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert!(bytes.is_empty(), "404 body must not reflect the requested id");
    }

    #[tokio::test]
    async fn invalid_token_is_401_before_any_lookup() {
        let dir = tempdir().unwrap();
        let ctx = test_ctx(dir.path().to_path_buf());

        let resp = on_preview_render_get(
            AxState(ctx),
            AxPath("some-id".to_string()),
            Query(RenderDocQuery { token: "wrong".to_string() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn staged_html_is_fetchable_by_its_returned_id() {
        let dir = tempdir().unwrap();
        let token = DeviceRegistry::add_device("Test", dir.path()).unwrap();
        let ctx = test_ctx(dir.path().to_path_buf());

        let staged = on_preview_render(
            AxState(ctx.clone()),
            Json(PreviewRenderBody { html: "<h1>hi</h1>".to_string() }),
        )
        .await
        .into_response();
        let bytes = axum::body::to_bytes(staged.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = v["id"].as_str().unwrap().to_string();

        let resp = on_preview_render_get(AxState(ctx), AxPath(id), Query(RenderDocQuery { token }))
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, "<h1>hi</h1>".as_bytes());
    }
}
