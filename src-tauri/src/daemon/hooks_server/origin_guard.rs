//! Host + Origin guard, layered over the whole hooks-server router
//! (`mod.rs`'s route table). Closes the two browser-reachable gaps from the
//! security audit: DNS rebinding (a page on an attacker-controlled hostname
//! that resolves to 127.0.0.1) and a plain cross-site `fetch`/XHR to a
//! same-origin-shaped route like `/quit`.
//!
//! Deliberately does NOT add a per-run secret. Every live `claude` child and
//! the curl commands `hooks/installer.rs` writes into the global
//! `~/.claude/settings.json` call this server; a secret mismatch between an
//! installed build and those already-written commands would break every
//! chat, hook and MCP tool call for a threat (another local Windows account)
//! that's negligible on a single-user machine. Host + Origin fully close the
//! browser vectors on their own.

use axum::{
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// `Host` header's hostname, lowercased and with any `:port` suffix
/// stripped, must be `127.0.0.1` or `localhost`. The listener only ever
/// binds IPv4 loopback (`bind_hook_listener`), so there's no `[::1]` case to
/// accept. The port itself isn't checked: only one port is ever listening,
/// so the hostname check alone already rules out a DNS-rebound name like
/// `evil.example`, which the browser can never substitute for `127.0.0.1`
/// no matter what the attacker's DNS answers with for that hostname.
fn host_is_allowed(host_header: &HeaderValue) -> bool {
    let Ok(s) = host_header.to_str() else { return false };
    let host = s.rsplit_once(':').map(|(h, _)| h).unwrap_or(s);
    host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost")
}

/// Rejects a request before it reaches any route handler.
///
/// Host: curl, reqwest (`render_preview_doc`'s server-to-server POST to
/// `/hooks/preview-render`) and the `claude` CLI's HTTP hooks all send a
/// `Host` header, since it's mandatory in HTTP/1.1 - there is no legitimate
/// caller with a missing one, so a missing header is rejected the same as a
/// wrong one rather than let through.
///
/// Origin: a browser attaches `Origin` to every cross-origin `fetch`/XHR
/// (including a `mode: "no-cors"` one with no custom headers, the shape that
/// needs no CORS preflight - the `/quit` vector from the audit) and to every
/// non-GET same-origin one. The only webview code that reaches this server
/// directly is the preview panel's iframe `src` navigation to
/// `GET /hooks/preview-render/:id` (`src/views/sessions/preview-panel.ts`);
/// a plain-GET navigation never gets an `Origin` header appended (the fetch
/// spec only adds one for a `cors`-tainted or non-GET/HEAD request). Every
/// other caller found by grepping `src/`, `src-tauri/src` and `android/` for
/// the hooks port goes through a Tauri IPC command instead, so it's `reqwest`
/// on the Rust side, which also sends no `Origin`. That means no caller needs
/// an allowlist entry: any `Origin` header at all means a browser made the
/// request, not one of ours.
pub(super) async fn guard(req: Request, next: Next) -> Response {
    let Some(host) = req.headers().get(header::HOST) else {
        return (StatusCode::FORBIDDEN, "missing Host header").into_response();
    };
    if !host_is_allowed(host) {
        return (StatusCode::FORBIDDEN, "untrusted Host header").into_response();
    }
    if req.headers().contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, "unexpected Origin header").into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::hooks_server::relay::on_quit;
    use crate::daemon::hooks_server::HookCtx;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use axum::routing::post;
    use axum::{middleware, Router};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    #[test]
    fn host_header_with_port_matches_on_hostname_only() {
        assert!(host_is_allowed(&HeaderValue::from_static("127.0.0.1:27182")));
        assert!(host_is_allowed(&HeaderValue::from_static("localhost:27182")));
        assert!(host_is_allowed(&HeaderValue::from_static("127.0.0.1")));
    }

    #[test]
    fn rebound_hostname_is_rejected_even_though_it_resolves_here() {
        assert!(!host_is_allowed(&HeaderValue::from_static("evil.example:27182")));
        assert!(!host_is_allowed(&HeaderValue::from_static("evil.example")));
    }

    fn test_ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    /// Mirrors the real route table's `/quit` entry plus this guard, bound to
    /// an ephemeral port (same pattern as `mod.rs`'s own `healthy_daemon_at`
    /// tests) rather than fighting the production daemon for the fixed port.
    async fn spawn_guarded_quit_server(ctx: Arc<HookCtx>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new()
            .route("/quit", post(on_quit))
            .layer(middleware::from_fn(guard))
            .with_state(ctx);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        port
    }

    #[tokio::test]
    async fn quit_with_evil_origin_is_rejected_and_never_publishes() {
        let ctx = test_ctx();
        let mut rx = ctx.state.notifier.subscribe();
        let port = spawn_guarded_quit_server(ctx).await;
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{port}/quit"))
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
        assert!(
            rx.try_recv().is_err(),
            "quit_requested must not be published when Origin is rejected"
        );
    }

    #[tokio::test]
    async fn quit_with_rebound_host_is_rejected() {
        let ctx = test_ctx();
        let port = spawn_guarded_quit_server(ctx).await;
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{port}/quit"))
            .header("Host", "evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
    }

    #[tokio::test]
    async fn quit_with_missing_host_is_rejected() {
        // reqwest always fills in `Host` from the URL, so the only way to
        // send a request with none is a raw socket write. HTTP/1.0 doesn't
        // require `Host` at all, which is the shape this exercises.
        let ctx = test_ctx();
        let port = spawn_guarded_quit_server(ctx).await;
        let mut stream = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .unwrap()
        .unwrap();
        stream.write_all(b"POST /quit HTTP/1.0\r\n\r\n").await.unwrap();
        let mut buf = [0u8; 64];
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8_lossy(&buf[..n]);
        assert!(response.contains(" 403 "), "got: {response}");
    }

    #[tokio::test]
    async fn curl_shaped_quit_request_still_works() {
        let ctx = test_ctx();
        let mut rx = ctx.state.notifier.subscribe();
        let port = spawn_guarded_quit_server(ctx).await;
        let client = reqwest::Client::new();
        let resp = client.post(format!("http://127.0.0.1:{port}/quit")).send().await.unwrap();
        assert_eq!(resp.status(), 204);
        assert!(rx.try_recv().is_ok(), "quit_requested should publish for a trusted request");
    }
}
