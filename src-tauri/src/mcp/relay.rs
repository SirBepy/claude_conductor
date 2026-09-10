//! HTTP transport for `dispatch.rs`'s relay arms: the retryable POST to the
//! daemon hooks server and the `Ctx` shape each arm builds a body against.

use serde_json::Value;

use super::server::tool_error_result;
use super::server::tool_result;

/// Overall cap on a single relay POST. The daemon hooks server holds a
/// permission/question prompt open for up to `PROMPT_TIMEOUT_SECS` (3600s, see
/// `daemon::hooks_server::permission`) so an AFK dev can answer later, then
/// always returns an answer or a graceful deny. This client MUST out-wait that
/// window, otherwise it aborts mid-prompt with "error sending request" and the
/// dev's eventual answer is dropped. 3600 + 60s slack so the server's response
/// always lands first; still bounded so a truly-wedged server can't hang the
/// MCP process forever.
const RELAY_TIMEOUT_SECS: u64 = 3660;

/// Retry policy for the relay POST (ai_todo 137, mirrors the curl hook path's
/// `--retry 2 --retry-delay 1` from todo 116): up to 2 retries with a 1s pause,
/// but ONLY for connection-level failures (daemon restarting between turns,
/// port briefly unavailable). Never retried: errors after a response arrived
/// (incl. 4xx/5xx bodies) and the overall relay timeout - the prompt may
/// already be registered server-side, and re-POSTing would duplicate it.
const RELAY_CONNECT_RETRIES: u32 = 2;
const RELAY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// True only for failures where the request never reached the daemon, so a
/// re-POST cannot double-register the prompt. `is_connect()` covers refused /
/// unreachable connections and connect-phase timeouts; the 3660s overall
/// timeout and body/decode errors report `is_connect() == false`.
fn is_retryable(e: &reqwest::Error) -> bool {
    e.is_connect()
}

// Diverges from daemon_client's reconnect on purpose (todo 714): this is a
// stateless per-request retry, not a persistent connection being rebuilt.

/// Transport seam (todo 707): tests pass a stub instead of `http_post` so
/// routing runs for real and only the network call is faked.
pub(super) type HttpPost = fn(&tokio::runtime::Runtime, &str, Value) -> Result<Value, String>;

pub(super) fn http_post(rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(RELAY_TIMEOUT_SECS))
            .build()
            .map_err(|e| e.to_string())?;
        let mut attempt: u32 = 0;
        loop {
            match client.post(url).json(&body).send().await {
                Ok(resp) => {
                    // Check status BEFORE decoding: a non-2xx body (e.g. a
                    // 404 from a daemon too old to serve this route) is often
                    // not JSON at all, so `.json()` on it fails with the
                    // opaque "error decoding response body" - which reads as
                    // this relay or the daemon being broken, when the real
                    // story is a version-skewed daemon that never had the
                    // route (todo 906).
                    let status = resp.status();
                    if !status.is_success() {
                        return Err(format!("HTTP {} from {url}", status.as_u16()));
                    }
                    return resp.json::<Value>().await.map_err(|e| e.to_string());
                }
                Err(e) if is_retryable(&e) && attempt < RELAY_CONNECT_RETRIES => {
                    attempt += 1;
                    eprintln!(
                        "mcp: relay connect to {url} failed ({e}); \
                         retry {attempt}/{RELAY_CONNECT_RETRIES} in {}s",
                        RELAY_RETRY_DELAY.as_secs()
                    );
                    tokio::time::sleep(RELAY_RETRY_DELAY).await;
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
}

/// Everything an arm needs beyond the tool name, so each group takes one param.
pub(super) struct Ctx<'a> {
    pub(super) rt: &'a tokio::runtime::Runtime,
    pub(super) id: &'a Value,
    pub(super) args: &'a Value,
    pub(super) session_id: &'a str,
    pub(super) port: u16,
    pub(super) post: HttpPost,
}

impl Ctx<'_> {
    /// Shared shape for every relay POST arm below. `fallback` opts into the
    /// `resp["ok"] == false` error check; `success` overrides the Ok text.
    /// Both `None` for arms that just relay `resp.to_string()` verbatim.
    pub(super) fn relay(
        &self,
        path: &str,
        body: Value,
        fallback: Option<&str>,
        success: Option<&str>,
    ) -> Value {
        let url = format!("http://127.0.0.1:{}{path}", self.port);
        match (self.post)(self.rt, &url, body) {
            Ok(resp) => {
                if let Some(fb) = fallback {
                    if resp["ok"].as_bool() == Some(false) {
                        let err = resp["error"].as_str().unwrap_or(fb);
                        return tool_error_result(self.id, err);
                    }
                }
                match success {
                    Some(text) => tool_result(self.id, text),
                    None => tool_result(self.id, &resp.to_string()),
                }
            }
            Err(e) => tool_error_result(self.id, &format!("relay error: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Todo 906: a non-2xx response used to fall straight into `.json()`,
    /// which reads a plain-text 404 body as "error decoding response body" -
    /// indistinguishable from real corruption. The status must be checked,
    /// and the code must be in the error, before any JSON decode is attempted.
    #[test]
    fn http_post_reports_the_status_code_on_a_non_2xx_non_json_body() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/plan/write")
            .with_status(404)
            .with_header("content-type", "text/plain")
            .with_body("no such route")
            .create();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let err = http_post(&rt, &format!("{}/plan/write", server.url()), serde_json::json!({}))
            .expect_err("a 404 must surface as an error");

        assert!(err.contains("404"), "expected the status code in the error, got: {err}");
        assert!(
            !err.contains("decoding response body"),
            "must not fall through to the opaque decode error, got: {err}"
        );
    }

    /// Control: a real 200 JSON body still round-trips normally, so the new
    /// status check does not regress the success path.
    #[test]
    fn http_post_still_decodes_json_on_success() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/plan/write")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"ok":true,"steps":1}"#)
            .create();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let resp = http_post(&rt, &format!("{}/plan/write", server.url()), serde_json::json!({}))
            .expect("a 200 JSON body must still decode");

        assert_eq!(resp["ok"], serde_json::json!(true));
        assert_eq!(resp["steps"], serde_json::json!(1));
    }
}
