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

    match crate::daemon::preview::push_and_notify(&ctx.state, body.title, body.slug, body.html, source, body.session_id) {
        Ok(id) => (StatusCode::OK, Json(json!({ "id": id }))).into_response(),
        Err(e) => {
            log::warn!("hook /hooks/preview rejected: {e}");
            (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": e.to_string() }))).into_response()
        }
    }
}
