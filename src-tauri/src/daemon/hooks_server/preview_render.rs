//! `POST /hooks/preview-render` + `GET /hooks/preview-render/:id`: serves the
//! panel's pre-built HTML doc over a real local origin instead of a `data:`
//! URL, so it gets its own CSP header instead of intersecting with the app
//! shell's. Served from a byte-budgeted in-memory least-recently-served store
//! (`render_cache.rs`) first, then from `preview.rs`'s disk-persisted panel
//! entries by id, which is what `POST /hooks/preview` answers with.

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

/// First render id in `html` that this server no longer holds, if any. An inline
/// card embeds the gallery's `render-url` as an iframe, and the card draws from the
/// pushed html alone, so an expired id would show a blank frame with no signal
/// back to the session that wrote it.
pub(super) fn stale_render_reference(html: &str) -> Option<String> {
    const MARKER: &str = "/hooks/preview-render/";
    let cache = cell().lock().unwrap_or_else(|e| e.into_inner());
    html.match_indices(MARKER).find_map(|(at, _)| {
        let id: String = html[at + MARKER.len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        (!id.is_empty() && !cache.contains(&id) && crate::daemon::preview::get(&id).is_none()).then_some(id)
    })
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
    // `POST /hooks/preview` answers with the panel entry's id, and a gallery's
    // `render-url` is built from that answer, so it must serve the entry's page.
    // The entry lives in the disk-persisted history, which also outlasts a daemon
    // restart that empties the in-memory cache above.
    let html = html.or_else(|| crate::daemon::preview::get(&id).map(|s| s.html));
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
        // Evicted from both stores or never staged - frontend treats this as "nothing to show".
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card_html(id: &str) -> String {
        format!(r#"<iframe src="http://127.0.0.1:27182/hooks/preview-render/{id}" style="width:100%"></iframe>"#)
    }

    #[test]
    fn a_card_iframing_a_held_render_id_is_not_stale() {
        cell().lock().unwrap().insert("pr-held-1".into(), "<p>gallery</p>".into());
        assert_eq!(stale_render_reference(&card_html("pr-held-1")), None);
    }

    #[test]
    fn a_card_iframing_an_unknown_render_id_is_stale() {
        assert_eq!(
            stale_render_reference(&card_html("pr-never-staged")).as_deref(),
            Some("pr-never-staged"),
        );
    }

    #[test]
    fn html_without_a_render_reference_is_never_stale() {
        assert_eq!(stale_render_reference("<p>hello</p>"), None);
        // The path quoted as prose has no id after it.
        assert_eq!(stale_render_reference("served at /hooks/preview-render/<id>"), None);
    }

    /// A gallery's `render-url` is built from `/hooks/preview`'s answer, the panel
    /// entry's id, and the in-memory cache never held that id: every such URL 404ed.
    #[tokio::test]
    async fn a_panel_entry_id_serves_its_page_and_is_not_stale() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let id = crate::daemon::preview::push(
            "Gallery".into(),
            Some("entry-serves".into()),
            "<p>entry page</p>".into(),
            "terminal".into(),
            None,
        )
        .unwrap();
        assert_eq!(stale_render_reference(&card_html(&id)), None);
        let resp = on_preview_render_get(AxPath(id)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"<p>entry page</p>");
    }

    #[tokio::test]
    async fn an_id_in_neither_store_is_still_a_404() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let resp = on_preview_render_get(AxPath("no-such-id".into())).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_second_reference_is_checked_too() {
        cell().lock().unwrap().insert("pr-held-2".into(), "<p>gallery</p>".into());
        let html = format!("{}{}", card_html("pr-held-2"), card_html("pr-gone-2"));
        assert_eq!(stale_render_reference(&html).as_deref(), Some("pr-gone-2"));
    }
}
