//! `POST /hooks/preview`: unauthenticated, localhost-trusted like every other
//! endpoint on this server (see `mod.rs`'s module doc + `hooks_server/mod.rs:1-6`).
//! Mirrors the existing relay handlers' shape. Both terminal Claude (curl) and
//! the in-app chat AI push HTML snapshots here (ai_todo 138); stored via
//! `daemon::preview` and broadcast on the daemon-wide `preview` notifier
//! channel so a connected window can refresh without polling.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Debug)]
pub(super) struct PreviewPushBody {
    title: String,
    #[serde(default)]
    slug: Option<String>,
    html: String,
    /// Defaults to `"terminal"` (the curl-from-terminal-Claude case) when
    /// omitted; the in-app chat AI path sends `"chat"` explicitly.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

pub(super) async fn on_preview_push(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<PreviewPushBody>,
) -> impl IntoResponse {
    let source = body.source.filter(|s| !s.is_empty()).unwrap_or_else(|| "terminal".to_string());
    log::info!(
        "hook /hooks/preview: title={} slug={} source={source} bytes={}",
        body.title,
        body.slug.as_deref().unwrap_or("-"),
        body.html.len(),
    );

    // Only the inline card path: the panel push of a gallery carries no such
    // iframe, and a terminal curl owns its own html.
    if source == crate::daemon::preview::PREVIEW_SOURCE_CHAT_CARD {
        if let Some(id) = super::preview_render::stale_render_reference(&body.html) {
            log::warn!("hook /hooks/preview rejected: card iframes expired render id {id}");
            return (
                StatusCode::GONE,
                Json(json!({
                    "ok": false,
                    "error": format!(
                        "the card's iframe points at render id {id}, which the daemon no longer holds, so the card would load blank. Re-run the gallery --post for a fresh render-url, or inline the content as a data: URL."
                    ),
                })),
            )
                .into_response();
        }
    }

    match crate::daemon::preview::push_and_notify(&ctx.state, body.title, body.slug, body.html, source, body.session_id) {
        Ok(id) => (StatusCode::OK, Json(json!({ "id": id }))).into_response(),
        Err(e) => {
            log::warn!("hook /hooks/preview rejected: {e}");
            (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": e.to_string() }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::preview::PREVIEW_SOURCE_CHAT_CARD;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    #[tokio::test]
    async fn a_card_push_iframing_an_expired_render_id_is_refused_not_acknowledged() {
        let ctx = Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        });
        let body = PreviewPushBody {
            title: "Checker".into(),
            slug: Some("checker-card".into()),
            html: r#"<iframe src="http://127.0.0.1:27182/hooks/preview-render/expired-id"></iframe>"#.into(),
            source: Some(PREVIEW_SOURCE_CHAT_CARD.into()),
            session_id: None,
        };
        let resp = on_preview_push(AxState(ctx), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::GONE);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["error"].as_str().unwrap().contains("expired-id"), "got: {v}");
    }
}
