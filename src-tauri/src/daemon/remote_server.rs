//! Remote-access server: the daemon-side HTTP/WS API that a phone (or any
//! browser on the tailnet) uses to drive in-app chats. This is the Phase 1
//! vertical slice of the "remote phone cockpit" (see ai_todo 103 + the design
//! spec). SECURITY-CRITICAL: every authed route can send input to a `claude`
//! process that holds Bash/Edit/Read tools, so a bypass here is RCE.
//!
//! Security boundary (review this):
//!   1. Binds 127.0.0.1 ONLY (never 0.0.0.0). It is NOT internet-reachable on
//!      its own; remote access is opt-in by the user running `tailscale serve`
//!      to reverse-proxy it over the tailnet with Tailscale-managed HTTPS.
//!   2. Per-request bearer-token auth on every data route (defense in depth on
//!      top of the tailnet). The token's SHA-256 hash is stored in a
//!      daemon-owned file; the plaintext is never persisted by the server
//!      except the one-time bootstrap handoff file the user copies + deletes.
//!   3. Fail-closed: if no token hash exists, every authed route returns 401.
//!   4. WebSocket auth uses a `?token=` query param (browsers cannot set the
//!      Authorization header on a WS handshake); validated identically before
//!      the upgrade completes.
//!
//! Token bootstrap is intentionally minimal for Phase 1 (manual token). QR
//! pairing + a device registry + rotation/kill-switch UI are Phase 2 (ai_todo
//! 104); they will write the same hash file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::state::DaemonState;

use super::remote_handlers::*;
use super::remote_pairing::pair_device;
use super::remote_push::{push_subscribe, push_unsubscribe, push_vapid_key};
use super::remote_static::spa_fallback;
use super::remote_voice::transcribe_ws;

/// Fixed localhost port for the remote API. Stable so the user's
/// `tailscale serve` config can target it. Distinct from the hook port (27182).
pub const REMOTE_PORT: u16 = 27183;

/// Body-size cap for `/api/rpc` (raises axum's 2 MiB default). Phone photos
/// arrive as base64 JSON (~1.33x raw size) and routinely exceed 2 MiB raw on
/// stock Android cameras; 30 MiB covers a ~22 MiB raw file.
const MAX_RPC_BODY_BYTES: usize = 30 * 1024 * 1024;

pub(super) struct RemoteCtx {
    pub(super) state: Arc<DaemonState>,
    pub(super) app_data: PathBuf,
    pub(super) router: crate::daemon::rpc::Router,
    pub(super) stt: Arc<crate::daemon::stt::SttSupervisor>,
}

/// Start the remote-access server. Best-effort: a bind failure disables remote
/// access for this run but never takes down the daemon. Call once at startup.
///
/// Returns the STT sidecar supervisor so the daemon main loop can drive its
/// idle-shutdown tick and kill it on graceful exit.
pub fn spawn(
    state: Arc<DaemonState>,
    app_data: PathBuf,
    router: crate::daemon::rpc::Router,
) -> Arc<crate::daemon::stt::SttSupervisor> {
    DeviceRegistry::ensure_desktop_device(&app_data);
    let stt = crate::daemon::stt::SttSupervisor::new(app_data.clone());
    let stt_for_task = stt.clone();
    tokio::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", REMOTE_PORT)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!(
                    "remote-access server: bind 127.0.0.1:{REMOTE_PORT} failed: {e}; remote access disabled this run"
                );
                return;
            }
        };
        // Strip the inherit flag so this socket never leaks into daemon-spawned
        // children (piped stdio forces handle inheritance on Windows). Without
        // this, an orphaned child holds 27183 after the daemon dies and every
        // request hangs with no response - the port-hostage incident, here for
        // the remote port. Mirrors the hook listener's protection.
        crate::util::process::mark_listener_non_inheritable(&listener);
        let ctx = Arc::new(RemoteCtx { state, app_data, router, stt: stt_for_task });
        let app = build_router(ctx);
        log::info!(
            "remote-access server listening on 127.0.0.1:{REMOTE_PORT} (expose with `tailscale serve --bg --https=443 http://127.0.0.1:{REMOTE_PORT}`)"
        );
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("remote-access server exited: {e}");
        }
    });
    stt
}

fn build_router(ctx: Arc<RemoteCtx>) -> Router {
    // Data routes require a valid bearer token (checked before any extractor
    // runs, so a malformed body can't reach a handler unauthenticated).
    let protected = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/:id/send", post(send_message))
        .route("/api/sessions/:id/cancel", post(cancel_turn))
        .route(
            "/api/rpc",
            post(rpc_dispatch).layer(DefaultBodyLimit::max(MAX_RPC_BODY_BYTES)),
        )
        // Web Push enrolment (ai_todo 119). Token-gated like the rest.
        .route("/api/push/vapid-public-key", get(push_vapid_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), auth_mw));

    // /api/health is unauthenticated (connectivity probe, reveals nothing).
    // The WS streams self-authenticate via their query token in the handler.
    // Static SPA assets are served unauthenticated (no secrets in them; the
    // SPA JS authenticates every /api call with the bearer token).
    // The fallback only fires when no named route matches, so /api/* and the
    // WS routes above are never shadowed by it.
    let public = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/pair", post(pair_device))
        .route("/api/sessions/:id/stream", get(stream_ws))
        // Global (not session-scoped) live-state stream: the remote
        // equivalent of the internal daemon<->app `subscribe_global` pipe
        // link, so a second remote window sees instances/schedule changes
        // in real time instead of the 3.5s http-transport.ts poll.
        .route("/api/global/stream", get(global_stream_ws))
        .route("/ws/transcribe", get(transcribe_ws));

    protected
        .merge(public)
        .fallback(spa_fallback)
        .with_state(ctx)
}

// ── Auth ────────────────────────────────────────────────────────────────────

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

/// Auth middleware for the protected routes. Runs before request extractors.
async fn auth_mw(State(ctx): State<Arc<RemoteCtx>>, req: Request, next: Next) -> Response {
    if !DeviceRegistry::is_enabled(&ctx.app_data) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let ok = bearer_token(req.headers())
        .map(|t| DeviceRegistry::validate_token(&t, &ctx.app_data))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

fn pairing_file(app_data: &Path) -> PathBuf {
    app_data.join("remote-pairing.json")
}

/// Validate a one-time pairing code against remote-pairing.json.
/// On success, deletes the file (single-use). Returns Err with reason on failure.
pub(super) fn validate_pairing_code(code: &str, app_data: &Path) -> Result<(), &'static str> {
    let raw = std::fs::read_to_string(pairing_file(app_data))
        .map_err(|_| "no active pairing code")?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "malformed pairing file")?;

    let expected_hash = v.get("code_hash").and_then(|h| h.as_str()).unwrap_or("");
    let expires_at = v.get("expires_at").and_then(|e| e.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if now > expires_at {
        let _ = std::fs::remove_file(pairing_file(app_data));
        return Err("pairing code expired");
    }
    if sha256_hex(code) != expected_hash {
        return Err("invalid pairing code");
    }
    let _ = std::fs::remove_file(pairing_file(app_data));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Route-registration smoke test: `build_router` must not panic when the
    /// new `/api/global/stream` route is wired into the public router
    /// alongside the existing REST + per-session-stream routes.
    #[test]
    fn build_router_registers_global_stream_route() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::types::Settings;

        let ctx = Arc::new(RemoteCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
            app_data: std::env::temp_dir(),
            router: crate::daemon::rpc::Router::new(),
            stt: crate::daemon::stt::SttSupervisor::new(std::env::temp_dir()),
        });
        let _app = build_router(ctx);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn pair_device_validates_code_hash_and_ttl() {
        let dir = tempdir().unwrap();
        let code = "abc123testcode";
        let hash = sha256_hex(code);
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() + 120;
        let body = serde_json::json!({ "code_hash": hash, "expires_at": expires_at });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();

        let result = validate_pairing_code(code, dir.path());
        assert!(result.is_ok());
        assert!(!dir.path().join("remote-pairing.json").exists());

        let result2 = validate_pairing_code(code, dir.path());
        assert!(result2.is_err());
    }

    #[test]
    fn pair_device_rejects_expired_code() {
        let dir = tempdir().unwrap();
        let code = "expiredcode";
        let body = serde_json::json!({
            "code_hash": sha256_hex(code),
            "expires_at": 1u64
        });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();
        assert!(validate_pairing_code(code, dir.path()).is_err());
    }

    #[test]
    fn pair_device_rejects_wrong_code() {
        let dir = tempdir().unwrap();
        let real_code = "realcode";
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() + 120;
        let body = serde_json::json!({ "code_hash": sha256_hex(real_code), "expires_at": expires_at });
        std::fs::write(dir.path().join("remote-pairing.json"), body.to_string()).unwrap();
        assert!(validate_pairing_code("wrongcode", dir.path()).is_err());
        assert!(dir.path().join("remote-pairing.json").exists());
    }
}
