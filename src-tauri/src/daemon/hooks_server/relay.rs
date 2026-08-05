//! Relay endpoints: `/refresh`, `/notify`, `/quit`. These forward external
//! hook events to the app (poll/sound) and own the token-history append the
//! daemon now performs on its own.

use super::HookCtx;
use crate::storage::token_store;
use crate::tokens as token_stats;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// Payload shape used by the existing hook client in `~/.claude/hooks/*`
/// (unchanged from the app-hosted server so the hooks stay compatible).
#[derive(Deserialize, Debug, Default)]
pub(super) struct RefreshPayload {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    transcript_path: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    // origin.* fields are kept around for future notification-click focus
    // support but aren't used yet on the daemon side.
    #[serde(default)]
    #[allow(dead_code)]
    origin: Option<serde_json::Value>,
}

pub(super) async fn on_refresh(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<RefreshPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /refresh: session={} cwd={} transcript={}",
        payload.session_id.as_deref().unwrap_or("-"),
        payload.cwd.as_deref().unwrap_or("-"),
        payload.transcript_path.as_deref().unwrap_or("-"),
    );

    // Tell the app to kick a poll + play a sound. App handles audio + scraper.
    // Skip for daemon-managed sessions: lifecycle.rs already fires `turn_sound`
    // when the `result` line is detected, so publishing here would double the sound.
    let is_daemon_session = payload.session_id
        .as_deref()
        .map(|id| ctx.state.sessions.contains_key(id))
        .unwrap_or(false);
    if !is_daemon_session {
        ctx.state.notifier.publish(
            "refresh_requested",
            json!({"cwd": payload.cwd, "session_id": payload.session_id}),
        );
    }

    // Token-record persist in background. The daemon now writes to the shared
    // companion.db (was: token-history.json) via its own connection.
    if let (Some(session_id), Some(transcript_path)) =
        (payload.session_id.clone(), payload.transcript_path.clone())
    {
        let state = ctx.state.clone();
        let cwd = payload.cwd.clone();
        tokio::spawn(async move {
            let Some(db) = state.db.clone() else {
                // DB failed to open at daemon startup; nothing to persist to.
                return;
            };

            // Fires on every Stop hook, every session, machine-wide, but a
            // token record is written once per session_id - skip if so.
            let already = {
                let db = db.clone();
                let session_id = session_id.clone();
                tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                    token_store::token_record_exists(mgr.conn(), &session_id).unwrap_or(false)
                })
                .await
                .unwrap_or(false)
            };
            if already {
                return;
            }

            let transcript = PathBuf::from(transcript_path);
            let totals = tokio::task::spawn_blocking({
                let t = transcript.clone();
                move || token_stats::parse_transcript(&t)
            })
            .await
            .unwrap_or_default();

            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let record = token_stats::TokenRecord {
                session_id,
                cwd,
                date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: now.clone(),
                last_active_at: now.clone(),
                recorded_at: now,
                live: None,
                merged_subagents: None,
            };

            // Insert (idempotent on session_id, mirroring the old
            // `append_session`) then read the full history back so the
            // `token_history_updated` notify still carries the complete list the
            // app expects. All DB work runs on a blocking thread holding the
            // `std::sync::Mutex` only for synchronous statements.
            let history = tokio::task::spawn_blocking(move || {
                let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                let conn = mgr.conn();
                // Re-check under the insert's lock - the fast-path check
                // above released it first, so alone it can't rule out a race.
                let already = token_store::token_record_exists(conn, &record.session_id)
                    .unwrap_or(false);
                if !already {
                    if let Err(e) = token_store::insert_token_record(conn, &record) {
                        log::warn!("daemon: insert_token_record failed: {e:#}");
                    }
                }
                token_store::get_token_records(conn, 0).unwrap_or_default()
            })
            .await;

            if let Ok(history) = history {
                state
                    .notifier
                    .publish("token_history_updated", json!({"history": history}));
            }
        });
    }

    (StatusCode::NO_CONTENT, Json(json!({})))
}

pub(super) async fn on_notify(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<RefreshPayload>,
) -> impl IntoResponse {
    log::info!("hook /notify: cwd={}", payload.cwd.as_deref().unwrap_or("-"));
    ctx.state
        .notifier
        .publish("notify_requested", json!({"cwd": payload.cwd, "session_id": payload.session_id}));
    StatusCode::OK
}

pub(super) async fn on_quit(AxState(ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    log::info!("hook /quit received");
    ctx.state.notifier.publish("quit_requested", json!({}));
    (StatusCode::NO_CONTENT, Json(json!({})))
}
