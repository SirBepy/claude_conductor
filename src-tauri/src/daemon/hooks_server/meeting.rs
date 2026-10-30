//! `/meeting/status`: HTTP half of the `in_meeting` MCP tool. Read-only and
//! stateless on disk: it samples the OS signals now and answers, and asks the
//! monitor to keep polling for a while so `since` stays meaningful.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::meeting_monitor::TOOL_LINGER;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct MeetingStatusBody {
    session_id: String,
}

pub(super) async fn on_meeting_status(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<MeetingStatusBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    ctx.state.meeting.demand(TOOL_LINGER);
    // A fresh reading, not the poller's last one: the poller may have been
    // started by this very call and not have sampled yet.
    let snap = ctx.state.meeting.sample_blocking().await;
    (StatusCode::OK, Json(snap.status_json()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::meeting::{SignalSource, Sources};
    use crate::types::Settings;
    use serde_json::{json, Value};

    struct Fixed(Sources);
    impl SignalSource for Fixed {
        fn camera_in_use(&self) -> bool {
            self.0.camera
        }
        fn mic_in_use(&self) -> bool {
            self.0.mic
        }
        fn meeting_app_audio_active(&self, _allow: &[String]) -> bool {
            self.0.audio
        }
    }

    async fn call(sources: Sources) -> Value {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.meeting.set_source(Box::new(Fixed(sources)));
        let ctx = Arc::new(HookCtx { state });
        let body = MeetingStatusBody { session_id: "no-such-session".to_string() };
        let resp = on_meeting_status(AxState(ctx), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn no_meeting_answers_inactive_with_no_sources_and_a_null_since() {
        let v = call(Sources::default()).await;
        assert_eq!(v, json!({"active": false, "sources": [], "since": null}));
    }

    #[tokio::test]
    async fn a_live_call_answers_active_with_the_signals_that_fired() {
        let v = call(Sources { camera: true, mic: true, audio: false }).await;
        assert_eq!(v["active"], true);
        assert_eq!(v["sources"], json!(["camera", "mic"]));
        assert!(v["since"].as_str().is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()), "{v}");
    }
}
