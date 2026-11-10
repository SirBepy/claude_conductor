//! `/hooks/main-chat-retro`: the `main_chat_retro` MCP tool. The route hands the
//! five sections to `daemon::subchats::retro`, which checks the caller is a main
//! chat, validates the caps and stamps the frontmatter itself. Every refusal is
//! an `ok:false` naming the fix, never a decode error: every section is optional
//! here so a chat that leaves one out learns which one.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::subchats::retro::{self, Sections};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Default)]
pub(super) struct RetroBody {
    session_id: String,
    #[serde(default)]
    did: Option<String>,
    #[serde(default)]
    efficient: Option<String>,
    #[serde(default)]
    slow: Option<String>,
    #[serde(default)]
    wrong: Option<String>,
    #[serde(default)]
    ideas: Option<String>,
}

pub(super) async fn on_main_chat_retro(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<RetroBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let sections = Sections::from_fields(body.did, body.efficient, body.slow, body.wrong, body.ideas);
    match retro::write(&ctx.state, &body.session_id, &sections) {
        Ok(w) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "path": w.path.to_string_lossy(),
                "version": w.version,
                "rewritten": w.rewritten,
            })),
        ),
        Err(e) => rejected_sends::reply("/hooks/main-chat-retro", &body.session_id, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    async fn call(c: &Arc<HookCtx>, v: serde_json::Value) -> serde_json::Value {
        let body: RetroBody = serde_json::from_value(v).unwrap();
        let resp = on_main_chat_retro(AxState(c.clone()), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn five(session: &str) -> serde_json::Value {
        json!({"session_id": session, "did": "d", "efficient": "e", "slow": "s", "wrong": "w", "ideas": "i"})
    }

    /// The real route: a main chat's call writes the file and reports the
    /// daemon's version; a plain chat's call is an ok:false and writes nothing.
    #[tokio::test]
    async fn the_route_writes_for_a_main_chat_and_refuses_a_plain_one() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["retro-main", "retro-plain"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-06T08:00:00+00:00");
        }
        crate::sessions::chat_config::set_subchats_on("retro-main", true);

        let ok = call(&c, five("retro-main")).await;
        assert_eq!(ok["ok"], json!(true), "{ok}");
        assert_eq!(ok["version"], json!(crate::daemon::health::DAEMON_VERSION));
        assert!(std::path::Path::new(ok["path"].as_str().unwrap()).is_file());

        let no = call(&c, five("retro-plain")).await;
        assert_eq!(no["ok"], json!(false));
        assert_eq!(no["error"], json!(retro::NOT_A_MAIN_CHAT));

        // A section left out is an ok:false naming it, never a decode error.
        let mut missing = five("retro-main");
        missing.as_object_mut().unwrap().remove("wrong");
        let e = call(&c, missing).await;
        assert!(e["error"].as_str().unwrap().starts_with("wrong is missing"), "{e}");
    }
}
