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
use crate::util::sha256_hex;
use tokio::net::TcpListener;

use crate::daemon::device_registry::{DeviceKind, DeviceRegistry};
use crate::daemon::rpc::Transport;
use crate::daemon::state::DaemonState;

use super::remote_handlers::*;
use super::remote_pairing::pair_device;
use super::remote_preview_render::{on_preview_render, on_preview_render_get};
use super::remote_push::{push_subscribe, push_unsubscribe, push_vapid_key};
use super::remote_static::spa_fallback;
use super::remote_voice::transcribe_ws;

/// Default localhost port for the remote API; a non-default instance uses `resolve_port`.
pub const REMOTE_PORT: u16 = 27183;

/// Resolves the bind port: `CC_REMOTE_PORT` pins one explicitly, else a
/// non-default instance binds ephemeral (0) so it never fights `REMOTE_PORT`.
pub(super) fn resolve_port() -> u16 {
    if let Ok(v) = std::env::var("CC_REMOTE_PORT") {
        if let Ok(port) = v.parse::<u16>() {
            return port;
        }
    }
    if crate::daemon::instance::instance_suffix().is_empty() { REMOTE_PORT } else { 0 }
}

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
    // Machine identity (multi-machine federation foundation). Best-effort:
    // `MachineRegistry::load`/`ensure_self` never panic, so a failure here
    // just leaves `list_machines` reporting an unminted self.
    state.init_machines(app_data.clone());
    if let Some(reg) = state.machines.get() {
        reg.ensure_self();
    }
    // Reconnect every already-paired peer's mirror link on startup - without
    // this a daemon restart would leave every mirrored row gone until the
    // next pairing mutation happened to call sync_links again.
    crate::daemon::machines::MachineHub::sync_links(&state);
    let stt = crate::daemon::stt::SttSupervisor::new(app_data.clone());
    let stt_for_task = stt.clone();
    tokio::spawn(async move {
        let port = resolve_port();
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!(
                    "remote-access server: bind 127.0.0.1:{port} failed: {e}; remote access disabled this run"
                );
                return;
            }
        };
        // Strip the inherit flag so this socket never leaks into daemon-spawned
        // children (piped stdio forces handle inheritance on Windows). Without
        // this, an orphaned child holds the port after the daemon dies and every
        // request hangs with no response - the port-hostage incident, here for
        // the remote port. Mirrors the hook listener's protection.
        crate::util::process::mark_listener_non_inheritable(&listener);
        let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
        let ctx = Arc::new(RemoteCtx { state, app_data, router, stt: stt_for_task });
        let app = build_router(ctx);
        log::info!(
            "remote-access server listening on 127.0.0.1:{bound_port} (expose with `tailscale serve --bg --https=443 http://127.0.0.1:{bound_port}`)"
        );
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("remote-access server exited: {e}");
        }
    });
    stt
}

/// Test-only handle for a server started via `spawn_on`. Runs the server on
/// its OWN dedicated multi-thread runtime rather than a task on the test's
/// runtime, because `axum::serve` (see `axum::serve::Serve`'s `IntoFuture`)
/// spawns each accepted connection as its OWN detached `tokio::spawn` task -
/// aborting only the outer accept-loop task (a plain `JoinHandle`) leaves
/// already-established WebSocket connections running untouched, which a
/// "peer goes offline" test needs to actually kill. Dropping/shutting down
/// this dedicated runtime aborts every task on it, connections included.
#[cfg(test)]
pub(crate) struct TestServerHandle {
    runtime: Option<tokio::runtime::Runtime>,
}

#[cfg(test)]
impl TestServerHandle {
    /// Immediately tears down the dedicated runtime (and with it, every live
    /// connection) - simulates the peer process dying outright, unlike a
    /// graceful shutdown which would let in-flight connections finish.
    pub(crate) fn kill(mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

/// Test-only sibling of `spawn`: binds synchronously (so the caller learns
/// the real port immediately - `spawn` only logs it, from inside its own
/// spawned task) and skips `sync_links` (a federation integration test
/// drives pairing/linking itself). Used by the two-daemon mirroring test in
/// `daemon::machines::peer_link`.
#[cfg(test)]
pub(crate) fn spawn_on(
    state: Arc<DaemonState>,
    app_data: PathBuf,
    router: crate::daemon::rpc::Router,
    port: u16,
) -> (Arc<crate::daemon::stt::SttSupervisor>, u16, TestServerHandle) {
    DeviceRegistry::ensure_desktop_device(&app_data);
    state.init_machines(app_data.clone());
    if let Some(reg) = state.machines.get() {
        reg.ensure_self();
    }
    let stt = crate::daemon::stt::SttSupervisor::new(app_data.clone());
    let stt_for_task = stt.clone();
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("bind ephemeral port for test");
    std_listener.set_nonblocking(true).expect("set listener nonblocking for tokio adoption");
    let bound_port = std_listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let ctx = Arc::new(RemoteCtx { state, app_data, router, stt: stt_for_task });
    let app = build_router(ctx);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build dedicated test runtime");
    rt.spawn(async move {
        let listener = tokio::net::TcpListener::from_std(std_listener).expect("adopt std listener into tokio");
        crate::util::process::mark_listener_non_inheritable(&listener);
        let _ = axum::serve(listener, app).await;
    });
    (stt, bound_port, TestServerHandle { runtime: Some(rt) })
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
        // Preview-panel iframe staging (todo 715): POST is bearer-gated here;
        // the paired GET below is public because an <iframe src> can't carry
        // the header, and self-authenticates via `?token=` instead.
        .route("/api/preview-render", post(on_preview_render))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), auth_mw));

    // /api/health is unauthenticated (connectivity probe, reveals nothing).
    // The WS streams self-authenticate via their query token in the handler.
    // Static SPA assets are served unauthenticated (no secrets in them; the
    // SPA JS authenticates every /api call with the bearer token).
    // The fallback only fires when no named route matches, so /api/* and the
    // WS routes above are never shadowed by it.
    let public = Router::new()
        .route("/api/health", get(health))
        .route("/api/pair", post(pair_device))
        .route("/api/sessions/:id/stream", get(stream_ws))
        .route("/api/preview-render/:id", get(on_preview_render_get))
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

/// Connectivity probe, unauthenticated. Advertises this daemon's machine
/// identity (multi-machine federation) so a pairing peer's `pair_machine`
/// RPC can learn our `machine_id`/`label`/`os` before any token exists -
/// `null` until `DaemonState::init_machines` has run (see `spawn` above).
async fn health(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    let machine = ctx.state.machines.get().and_then(|r| r.self_machine());
    axum::Json(serde_json::json!({ "ok": true, "machine": machine })).into_response()
}

// ── Auth ────────────────────────────────────────────────────────────────────

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
    let resolved = bearer_token(req.headers())
        .and_then(|t| DeviceRegistry::resolve_token(&t, &ctx.app_data));
    let Some((kind, machine_id)) = resolved else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let transport = match kind {
        DeviceKind::Phone => Transport::Phone,
        DeviceKind::Machine => Transport::PeerMachine(machine_id.unwrap_or_default()),
    };
    // Scopes TRANSPORT so any ConnectionContext built while handling this
    // request (e.g. rpc_dispatch's start_session) tags is_remote correctly -
    // see `sessions::registry`.
    crate::daemon::rpc::TRANSPORT.scope(transport, next.run(req)).await
}

fn pairing_file(app_data: &Path) -> PathBuf {
    app_data.join("remote-pairing.json")
}

/// Check a pairing code without consuming it - callers must call
/// `consume_pairing_code` themselves, only after their own follow-up (e.g.
/// device registration) succeeds, so a failed follow-up leaves it retryable.
pub(super) fn check_pairing_code(code: &str, app_data: &Path) -> Result<(), &'static str> {
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
    Ok(())
}

/// Consume (delete) the one-time pairing file. Call only after the
/// follow-up action gated by `check_pairing_code` has actually succeeded.
pub(super) fn consume_pairing_code(app_data: &Path) {
    let _ = std::fs::remove_file(pairing_file(app_data));
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

    #[tokio::test]
    async fn health_includes_machine_identity_when_registry_initialised() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::types::Settings;

        let dir = tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();
        let ctx = Arc::new(RemoteCtx {
            state,
            app_data: dir.path().to_path_buf(),
            router: crate::daemon::rpc::Router::new(),
            stt: crate::daemon::stt::SttSupervisor::new(std::env::temp_dir()),
        });
        let resp = health(State(ctx)).await;
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["machine"]["machine_id"].as_str().unwrap(), mine.machine_id);
        assert_eq!(v["ok"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn health_machine_is_null_without_a_registry() {
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
        let resp = health(State(ctx)).await;
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["machine"].is_null());
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

        let result = check_pairing_code(code, dir.path());
        assert!(result.is_ok());
        // Checking alone must not consume the code (deferred-delete fix).
        assert!(dir.path().join("remote-pairing.json").exists());

        consume_pairing_code(dir.path());
        assert!(!dir.path().join("remote-pairing.json").exists());

        let result2 = check_pairing_code(code, dir.path());
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
        assert!(check_pairing_code(code, dir.path()).is_err());
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
        assert!(check_pairing_code("wrongcode", dir.path()).is_err());
        assert!(dir.path().join("remote-pairing.json").exists());
    }
}
