//! `/mcp-proxy/:id`: a project MCP server's requests, forwarded with a fresh
//! bearer. The work is in `daemon::project_mcp_proxy`.

use axum::{
    body::Bytes,
    extract::Path,
    http::{HeaderMap, Method},
    response::Response,
};

/// A tool call's arguments can be large (attached text), and the default 2 MB cap would
/// turn one into a silent 413 the model reads as a broken server.
pub(super) const BODY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

pub(super) async fn on_mcp_proxy(Path(id): Path<String>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    let store = crate::daemon::mcp_oauth::store_path();
    crate::daemon::project_mcp_proxy::forward(store.as_deref(), &id, method, &headers, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::any;

    /// The route as `mod.rs` mounts it, so the `:id` capture, every method and the body cap
    /// are the ones a real child hits.
    #[tokio::test]
    async fn the_mounted_route_answers_any_method_and_hides_an_unknown_id() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = axum::Router::new().route(
            "/mcp-proxy/:id",
            any(on_mcp_proxy).layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT_BYTES)),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let c = reqwest::Client::new();
        for m in [reqwest::Method::POST, reqwest::Method::GET, reqwest::Method::DELETE] {
            let r = c.request(m, format!("http://127.0.0.1:{port}/mcp-proxy/nope")).body("{}").send().await.unwrap();
            assert_eq!(r.status(), 404);
        }
    }
}
