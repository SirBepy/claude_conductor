//! HTML preview window RPCs (ai_todo 138): `list_previews`/`get_preview` are
//! read-only mirrors of `daemon::preview`'s store, exposed over both the
//! daemon's own pipe RPC (desktop IPC proxy) and the remote-access API
//! (`SAFE_METHODS` in `remote_handlers.rs`) so the phone can read the same
//! timeline with no store rewrite.
//!
//! `push_preview` is registered on the pipe Router ONLY (the desktop
//! `push_preview` command's proxy target) and is deliberately EXCLUDED from
//! `SAFE_METHODS`: the phone/remote write path is a separate reviewed
//! decision. Terminal Claude and the in-app chat AI both push via the
//! UNAUTHENTICATED `/hooks/preview` hook-server endpoint instead (see
//! `hooks_server/preview.rs`), which shares `preview::push_and_notify` with
//! this handler so both write paths stay in sync.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_preview(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("push_preview", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    title: String,
                    #[serde(default)]
                    slug: Option<String>,
                    html: String,
                    #[serde(default)]
                    source: Option<String>,
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let source = p.source.filter(|s| !s.is_empty()).unwrap_or_else(|| "terminal".to_string());
                let id = crate::daemon::preview::push_and_notify(&state, p.title, p.slug, p.html, source, p.session_id)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({ "id": id }))
            }
        });
    }
    // Mirrors the desktop `list_previews` command -> Vec<PreviewMeta>, newest
    // (most-recently-pushed/replaced) first. No html - see PreviewMeta.
    router.register("list_previews", move |_params, _ctx| {
        async move { Ok(json!(crate::daemon::preview::list())) }
    });
    // Mirrors the desktop `get_preview` command (params: id) -> PreviewSnapshot
    // (html included), for the iframe render.
    router.register("get_preview", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { id: String }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            match crate::daemon::preview::get(&p.id) {
                Some(snap) => Ok(json!(snap)),
                None => Err(RpcError::internal(format!("no such preview: {}", p.id))),
            }
        }
    });
}
