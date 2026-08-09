//! Hook HTTP server hosted by the daemon. Receives stop/notify/permission
//! requests from external claude processes (via global ~/.claude hook scripts
//! and per-session MCP children) and from `claude -p` subprocesses spawned by
//! the daemon itself. Same endpoint shape as the previous app-hosted server
//! (`src/hooks/server.rs`); HookCtx swaps `AppHandle` for `Arc<DaemonState>`
//! and event emission for daemon notifier publishes.
//!
//! Endpoints are grouped by category into submodules; this file owns the
//! boot scaffolding (HookCtx, HOOK_PORT, health, spawn) and the route table,
//! the only place that "sees" every category at once.

mod channel;
mod commit_lock;
mod context;
mod decision;
mod jarvis;
mod lifecycle;
mod messages;
mod permission;
mod preview;
mod preview_render;
mod relay;
mod stop;
mod turn_status;

use crate::daemon::state::DaemonState;
use crate::settings::paths;
use axum::{
    extract::State as AxState,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

/// Why the hook server could not bind its port. `run_daemon_main` exits
/// quietly on `HealthyDaemonExists` (normal duplicate-spawn race) and loudly
/// on `ZombiePort` (the 2026-06-12 incident: a killed daemon's children held
/// an inherited copy of the listen socket, so every new daemon died on bind
/// until the orphans were killed).
#[derive(Debug, thiserror::Error)]
pub enum HookBindError {
    #[error("another healthy daemon already serves 127.0.0.1:{0}")]
    HealthyDaemonExists(u16),
    #[error(
        "port 127.0.0.1:{0} is bound but no daemon answers /health on it. \
         Likely orphaned children of a dead daemon are holding an inherited \
         copy of the listen socket: look for claude.exe / claude-conductor.exe \
         processes whose parent is gone and kill them to free the port"
    )]
    ZombiePort(u16),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub(crate) struct HookCtx {
    pub state: Arc<DaemonState>,
}

async fn health_endpoint(AxState(_ctx): AxState<Arc<HookCtx>>) -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"daemon": "ok"})))
}

/// Fixed port matching the Electron app + README + installer + global hook
/// scripts at `~/.claude/aiusage-hook.{ps1,sh}`. Pinned; do not change.
pub const HOOK_PORT: u16 = 27182;

/// Bind the hook listener and mark it non-inheritable. The daemon spawns
/// children with piped stdio, which on Windows forces `bInheritHandles=TRUE`:
/// every inheritable handle in this process leaks into every child (chat
/// `claude -p` processes, pty channels, and their MCP grandchildren). If this
/// listener leaks, killing the daemon leaves the port bound by its surviving
/// children and no new daemon can ever bind it. Stripping the inherit flag
/// right at creation - before any child can be spawned - closes that whole
/// class of failure.
pub async fn bind_hook_listener(port: u16) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    crate::util::process::mark_listener_non_inheritable(&listener);
    Ok(listener)
}

/// True if a healthy daemon answers `/health` on the port. Used to classify a
/// bind failure: address-in-use can be a live daemon (normal race - exit
/// quietly) or a zombie socket held open by orphans of a dead daemon (nothing
/// accepts, the probe times out).
async fn healthy_daemon_at(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    match client.get(format!("http://127.0.0.1:{port}/health")).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

pub async fn spawn(state: Arc<DaemonState>) -> Result<u16, HookBindError> {
    // A test instance (CC_DAEMON_INSTANCE set) binds an ephemeral port instead
    // of the fixed HOOK_PORT so it never fights the production daemon for 27182,
    // and writes its port to a SUFFIXED file (e.g. hooks_port-test-hooks.txt) so
    // it doesn't clobber the production hooks_port.txt and tests can still
    // discover the port (ai_todo 71).
    let suffix = crate::daemon::instance::instance_suffix();
    let bind_port = if suffix.is_empty() { HOOK_PORT } else { 0 };
    let listener = match bind_hook_listener(bind_port).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(if healthy_daemon_at(bind_port).await {
                HookBindError::HealthyDaemonExists(bind_port)
            } else {
                HookBindError::ZombiePort(bind_port)
            });
        }
        Err(e) => return Err(e.into()),
    };
    let port = listener.local_addr()?.port();
    log::info!("daemon hook server listening on 127.0.0.1:{port}");

    if let Ok(port_file) = paths::hooks_port_file() {
        let port_file = if suffix.is_empty() {
            port_file
        } else {
            port_file.with_file_name(format!("hooks_port{suffix}.txt"))
        };
        let _ = std::fs::write(&port_file, port.to_string());
    }

    let ctx = Arc::new(HookCtx { state });
    let router = Router::new()
        .route("/health", get(health_endpoint))
        .route("/context", get(context::on_context))
        .route("/refresh", post(relay::on_refresh))
        .route("/notify", post(relay::on_notify))
        .route("/quit", post(relay::on_quit))
        .route("/hooks/session-start", post(lifecycle::on_session_start))
        .route("/hooks/session-end", post(lifecycle::on_session_end))
        .route("/sessions/close-confirm", post(lifecycle::on_close_confirm))
        .route("/hooks/stop", post(stop::on_stop))
        .route("/hooks/preview", post(preview::on_preview_push))
        .route("/hooks/preview-render", post(preview_render::on_preview_render))
        .route("/hooks/preview-render/:id", get(preview_render::on_preview_render_get))
        .route("/permissions/request", post(permission::on_permission_request))
        .route("/questions/request", post(permission::on_question_request))
        .route("/hooks/ask-question", post(permission::on_ask_question_hook))
        .route("/hooks/commit-lock-request", post(commit_lock::on_commit_lock_request))
        .route("/hooks/commit-lock-release", post(commit_lock::on_commit_lock_release))
        .route("/jarvis/spawn-worker", post(jarvis::on_spawn_worker))
        .route("/jarvis/send-to-session", post(jarvis::on_send_to_session))
        .route("/jarvis/fleet-status", post(jarvis::on_fleet_status))
        .route("/jarvis/respond-worker-prompt", post(jarvis::on_respond_worker_prompt))
        .route("/channel/list-peers", post(channel::on_list_peers))
        .route("/channel/read-messages", post(channel::on_read_messages))
        .route("/channel/post-message", post(channel::on_post_message))
        .route("/turn/report-status", post(turn_status::on_report_status))
        .route("/messages/send", post(messages::on_send_message))
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            log::error!("daemon hook server exited: {e}");
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::healthy_daemon_at;

    #[tokio::test]
    async fn probe_is_false_when_nothing_listens() {
        // Bind+drop an ephemeral port so we know nothing listens on it.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert!(!healthy_daemon_at(port).await);
    }

    #[tokio::test]
    async fn probe_is_true_for_responding_health_endpoint() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = axum::Router::new().route("/health", axum::routing::get(|| async { "ok" }));
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        assert!(healthy_daemon_at(port).await);
    }

    #[tokio::test]
    async fn probe_is_false_for_zombie_socket_that_never_answers() {
        // Bound socket whose owner never accepts: connects land in the backlog
        // but no HTTP response ever comes - the incident's exact signature.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let healthy = healthy_daemon_at(port).await;
        drop(listener);
        assert!(!healthy);
    }
}
