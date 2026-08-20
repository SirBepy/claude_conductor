//! `tools/call` dispatch for the stdio MCP server. Every arm has the same shape:
//! build a hooks-server URL, build a JSON body from `arguments`, hand off to
//! `relay`. Arms are grouped by domain so a new tool has an obvious home.

use serde_json::{json, Value};

use super::server::{mcp_error, tool_error_result, tool_result, waiting_target};
use super::tool_schemas::{
    TOOL_APPROVAL, TOOL_CLOSE, TOOL_FLEET_STATUS, TOOL_LIST_PEERS, TOOL_POST_MESSAGE, TOOL_QUESTION,
    TOOL_READ_MESSAGES, TOOL_REPORT_STATUS, TOOL_RESPOND_WORKER_PROMPT, TOOL_SEND_MESSAGE,
    TOOL_SEND_TO_SESSION, TOOL_SPAWN_CHAT, TOOL_SPAWN_WORKER, TOOL_UPDATE_MESSAGE,
    TOOL_WRITE_USER_TODO,
};

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

/// Transport seam (todo 707): tests pass a stub instead of `http_post` so
/// routing runs for real and only the network call is faked.
pub(super) type HttpPost = fn(&tokio::runtime::Runtime, &str, Value) -> Result<Value, String>;

fn http_post(rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(RELAY_TIMEOUT_SECS))
            .build()
            .map_err(|e| e.to_string())?;
        let mut attempt: u32 = 0;
        loop {
            match client.post(url).json(&body).send().await {
                Ok(resp) => return resp.json::<Value>().await.map_err(|e| e.to_string()),
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
struct Ctx<'a> {
    rt: &'a tokio::runtime::Runtime,
    id: &'a Value,
    args: &'a Value,
    session_id: &'a str,
    port: u16,
    post: HttpPost,
}

impl Ctx<'_> {
    /// Shared shape for every relay POST arm below. `fallback` opts into the
    /// `resp["ok"] == false` error check; `success` overrides the Ok text.
    /// Both `None` for arms that just relay `resp.to_string()` verbatim.
    fn relay(
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

/// Route one `tools/call` to its hooks-server endpoint.
pub(super) fn dispatch_tool(
    rt: &tokio::runtime::Runtime,
    id: &Value,
    name: &str,
    arguments: &Value,
    session_id: &str,
    port: u16,
) -> Value {
    dispatch_tool_with(rt, id, name, arguments, session_id, port, http_post)
}

/// Same routing as `dispatch_tool`, with the HTTP transport swapped for
/// `post` (todo 707's test seam).
pub(super) fn dispatch_tool_with(
    rt: &tokio::runtime::Runtime,
    id: &Value,
    name: &str,
    arguments: &Value,
    session_id: &str,
    port: u16,
    post: HttpPost,
) -> Value {
    let ctx = Ctx {
        rt,
        id,
        args: arguments,
        session_id,
        port,
        post,
    };
    prompt_tools(&ctx, name)
        .or_else(|| session_tools(&ctx, name))
        .or_else(|| channel_tools(&ctx, name))
        .or_else(|| user_facing_tools(&ctx, name))
        .or_else(|| jarvis_tools(&ctx, name))
        .unwrap_or_else(|| mcp_error(id, -32601, "unknown tool"))
}

/// The two prompts that block the turn until the dev answers.
fn prompt_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    let request_id = uuid::Uuid::new_v4().to_string();
    match name {
        TOOL_APPROVAL => {
            let tool_name = ctx.args["tool_name"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let input = ctx.args["input"].clone();
            let body = json!({
                "id": request_id,
                "tool_name": tool_name,
                "input": input,
                "session_id": ctx.session_id,
            });
            Some(ctx.relay("/permissions/request", body, None, None))
        }
        TOOL_QUESTION => {
            let questions = ctx.args["questions"].clone();
            let body = json!({
                "id": request_id,
                "questions": questions,
                "session_id": ctx.session_id,
            });
            Some(ctx.relay("/questions/request", body, None, None))
        }
        _ => None,
    }
}

/// Session lifecycle: end this one, or spawn a sibling chat.
fn session_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_CLOSE => {
            // Fire-and-confirm: the daemon records the close and
            // tears down at turn end (session_id comes from the
            // per-session CC_SESSION_ID env, not tool args).
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay(
                "/sessions/close-confirm",
                body,
                None,
                Some("close confirmed; session will end at turn completion"),
            ))
        }
        TOOL_SPAWN_CHAT => {
            let body = json!({
                "session_id": ctx.session_id,
                "cwd": ctx.args["cwd"],
                "prompt": ctx.args["prompt"],
                "model": ctx.args.get("model"),
                "effort": ctx.args.get("effort"),
                "name": ctx.args.get("name"),
            });
            Some(ctx.relay("/chat/spawn", body, None, None))
        }
        _ => None,
    }
}

/// `post_message`'s optional `target` (todo 698): one session id or a list,
/// normalized to an array so the daemon body shape is stable. Absent, blank or
/// non-string stays null, which the daemon reads as today's broadcast.
fn normalize_targets(raw: Option<&Value>) -> Value {
    let ids: Vec<Value> = match raw {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => return Value::Null,
    }
    .into_iter()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| Value::String(s.to_string()))
    .collect();
    if ids.is_empty() {
        Value::Null
    } else {
        Value::Array(ids)
    }
}

/// Inter-agent coordination channel, scoped per project.
fn channel_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_LIST_PEERS => {
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay("/channel/list-peers", body, None, None))
        }
        TOOL_POST_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "text": ctx.args["text"],
                "target": normalize_targets(ctx.args.get("target")),
            });
            Some(ctx.relay("/channel/post-message", body, None, None))
        }
        TOOL_READ_MESSAGES => {
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay("/channel/read-messages", body, None, None))
        }
        _ => None,
    }
}

/// Body for `/turn/report-status` (todo 675). `waitingOn` is null unless the
/// caller passed the optional waiting-target params AND they survive the
/// `waiting_target` guard, so an omitting caller is byte-identical to before.
fn report_status_body(args: &Value, session_id: &str, roots: &[std::path::PathBuf]) -> Value {
    let waiting_on = waiting_target::sanitize(
        args.get("waiting_on_label").and_then(Value::as_str),
        args.get("waiting_on_kind").and_then(Value::as_str),
        args.get("waiting_on_href").and_then(Value::as_str),
        roots,
    );
    json!({
        "session_id": session_id,
        "status": args["status"],
        "title": args.get("title"),
        "waitingOn": waiting_on,
    })
}

/// Turn status/title, chat messages, and the Your Todos panel.
fn user_facing_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_REPORT_STATUS => {
            let body =
                report_status_body(ctx.args, ctx.session_id, &waiting_target::default_roots());
            Some(ctx.relay("/turn/report-status", body, Some("invalid status"), None))
        }
        TOOL_SEND_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "text": ctx.args["text"],
            });
            Some(ctx.relay("/messages/send", body, Some("invalid message"), None))
        }
        TOOL_UPDATE_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "message": ctx.args["message"],
                "text": ctx.args.get("text"),
                "retract": ctx.args.get("retract").and_then(|v| v.as_bool()).unwrap_or(false),
            });
            Some(ctx.relay("/messages/update", body, Some("invalid update"), None))
        }
        TOOL_WRITE_USER_TODO => {
            let body = json!({
                "session_id": ctx.session_id,
                "action": ctx.args["action"],
                "id": ctx.args.get("id"),
                "text": ctx.args.get("text"),
                "reason": ctx.args.get("reason"),
            });
            Some(ctx.relay("/todos/write", body, Some("invalid todo write"), None))
        }
        _ => None,
    }
}

/// Only advertised to a Jarvis child's `tools/list` (see `is_jarvis` in
/// `server`), but a `tools/call` for a never-shown tool still lands here, so
/// every daemon route re-validates that `session_id` (this child's own
/// CC_SESSION_ID) is the registry's Jarvis session before doing anything.
fn jarvis_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_SPAWN_WORKER => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "cwd": ctx.args["cwd"],
                "task": ctx.args["task"],
                "name": ctx.args.get("name"),
                "model": ctx.args.get("model"),
                "account": ctx.args.get("account"),
            });
            Some(ctx.relay("/jarvis/spawn-worker", body, None, None))
        }
        TOOL_SEND_TO_SESSION => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "session_id": ctx.args["session_id"],
                "text": ctx.args["text"],
            });
            Some(ctx.relay("/jarvis/send-to-session", body, None, None))
        }
        TOOL_FLEET_STATUS => {
            let body = json!({ "jarvis_session_id": ctx.session_id });
            Some(ctx.relay("/jarvis/fleet-status", body, None, None))
        }
        TOOL_RESPOND_WORKER_PROMPT => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "request_id": ctx.args["request_id"],
                "allow": ctx.args["allow"],
                "message": ctx.args.get("message"),
                "updated_input": ctx.args.get("updated_input"),
            });
            Some(ctx.relay("/jarvis/respond-worker-prompt", body, None, None))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_status_without_the_new_params_still_validates() {
        let args = json!({"status": "done", "title": "Fix bug"});
        let body = report_status_body(&args, "sess-1", &[]);
        assert_eq!(body["status"], json!("done"));
        assert_eq!(body["title"], json!("Fix bug"));
        assert_eq!(body["session_id"], json!("sess-1"));
        assert_eq!(body["waitingOn"], Value::Null);
    }

    #[test]
    fn report_status_with_no_title_at_all_still_validates() {
        let body = report_status_body(&json!({"status": "waiting"}), "s", &[]);
        assert_eq!(body["status"], json!("waiting"));
        assert_eq!(body["title"], Value::Null);
        assert_eq!(body["waitingOn"], Value::Null);
    }

    #[test]
    fn report_status_carries_a_guarded_ci_target() {
        let url = "https://github.com/o/r/actions/runs/32115742584";
        let args = json!({
            "status": "waiting",
            "waiting_on_label": "release CI",
            "waiting_on_kind": "ci",
            "waiting_on_href": url,
        });
        let body = report_status_body(&args, "s", &[]);
        assert_eq!(body["waitingOn"]["kind"], json!("ci"));
        assert_eq!(body["waitingOn"]["label"], json!("release CI"));
        assert_eq!(body["waitingOn"]["href"], json!(url));
    }

    #[test]
    fn report_status_strips_an_out_of_tree_local_path() {
        let args = json!({
            "status": "waiting",
            "waiting_on_label": "build",
            "waiting_on_kind": "local-process",
            "waiting_on_href": "/etc/passwd",
        });
        let body = report_status_body(&args, "s", &[]);
        assert_eq!(body["waitingOn"]["label"], json!("build"));
        assert_eq!(body["waitingOn"]["href"], Value::Null);
    }

    #[test]
    fn post_message_without_a_target_stays_a_broadcast() {
        assert_eq!(normalize_targets(None), Value::Null);
        assert_eq!(normalize_targets(Some(&json!([]))), Value::Null);
        assert_eq!(normalize_targets(Some(&json!("   "))), Value::Null);
        assert_eq!(normalize_targets(Some(&json!(7))), Value::Null);
    }

    #[test]
    fn post_message_target_normalizes_to_an_array() {
        assert_eq!(normalize_targets(Some(&json!("sess-a"))), json!(["sess-a"]));
        assert_eq!(
            normalize_targets(Some(&json!([" sess-a ", "", "sess-b", 3]))),
            json!(["sess-a", "sess-b"]),
            "blanks and non-strings dropped, ids trimmed"
        );
    }
}
