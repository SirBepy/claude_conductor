//! stdio MCP server mode. Entered when the binary is spawned with
//! `--mcp-permission`. Implements MCP JSON-RPC 2.0 over stdin/stdout
//! (one JSON object per line). Exposes three tools:
//!   - `approval_prompt`: used as `--permission-prompt-tool` by the runner
//!   - `ask_user_question`: lets claude ask the user a question mid-turn
//!   - `close_session`: the `/close` skill confirms teardown; the daemon ends
//!     the session + kills the process at turn end
//!
//! HTTP coordination piggybacks on the existing hooks server.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const TOOL_APPROVAL: &str = "approval_prompt";
const TOOL_QUESTION: &str = "ask_user_question";
const TOOL_CLOSE: &str = "close_session";
// Jarvis-only fleet-orchestration tools (todo 272, chunk 2b). Only advertised
// in `tools/list` when the MCP child's env carries `CC_JARVIS=1` - see
// `tool_list_response` and `daemon::claude_config::write_mcp_config`.
const TOOL_SPAWN_WORKER: &str = "spawn_worker";
const TOOL_SEND_TO_SESSION: &str = "send_to_session";
const TOOL_FLEET_STATUS: &str = "fleet_status";
const TOOL_RESPOND_WORKER_PROMPT: &str = "respond_worker_prompt";

/// Read the hooks port from <app-data>/hooks_port.txt.
fn read_port() -> Option<u16> {
    crate::settings::paths::read_hook_port("")
}

/// HTTP POST helper (blocking via tokio runtime).
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

/// `is_jarvis` gates the four fleet-orchestration tools below - they're only
/// meaningful (and only wired server-side) for the Jarvis singleton, and
/// listing them for every session would be pure token cost for nothing. A
/// normal session's tool list must stay byte-identical to before these
/// existed (acceptance criterion, todo 272 chunk 2b).
fn tool_list_response(id: &Value, is_jarvis: bool) -> Value {
    let mut tools = vec![
        json!({
            "name": TOOL_APPROVAL,
            "description": "Permission relay. Returns {behavior:'allow'|'deny'}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string"},
                    "input": {"type": "object"}
                },
                "required": ["tool_name", "input"]
            }
        }),
        json!({
            "name": TOOL_QUESTION,
            "description": "Present questions to user. Returns answers.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string"},
                                            "description": {"type": "string"}
                                        }
                                    }
                                }
                            },
                            "required": ["question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }),
        json!({
            "name": TOOL_CLOSE,
            "description": "Confirm this chat's /close teardown so the host app ends the session and kills the process at turn end. Call ONLY from the /close skill's final close step, and never on --dont-close or a failed chain.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
    ];

    if is_jarvis {
        tools.push(json!({
            "name": TOOL_SPAWN_WORKER,
            "description": "Spawn a new worker chat session under your orchestration and send it its first task. Returns {ok, session_id} or {ok:false, error}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory for the worker."},
                    "task": {"type": "string", "description": "Full briefing prompt, sent as the worker's first message."},
                    "name": {"type": "string", "description": "Optional short label for the worker."},
                    "model": {"type": "string", "description": "Optional model id/alias; defaults to sonnet."}
                },
                "required": ["cwd", "task"]
            }
        }));
        tools.push(json!({
            "name": TOOL_SEND_TO_SESSION,
            "description": "Send a follow-up message to one of your worker sessions. Rejected if that worker is still mid-turn - retry once it goes idle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "text": {"type": "string"}
                },
                "required": ["session_id", "text"]
            }
        }));
        tools.push(json!({
            "name": TOOL_FLEET_STATUS,
            "description": "List your worker sessions with busy/awaiting state and any pending prompt ids.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }));
        tools.push(json!({
            "name": TOOL_RESPOND_WORKER_PROMPT,
            "description": "Answer a pending permission or question prompt raised by one of your workers. allow=true approves (optionally with updated_input); allow=false denies/answers using message.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request_id": {"type": "string"},
                    "allow": {"type": "boolean"},
                    "message": {"type": "string"},
                    "updated_input": {"type": "object"}
                },
                "required": ["request_id", "allow"]
            }
        }));
    }

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "tools": tools }
    })
}

fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

fn tool_result(id: &Value, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": false
        }
    })
}

fn tool_error_result(id: &Value, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": true
        }
    })
}

pub fn run_stdio() {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("mcp: failed to build runtime: {e}");
            return;
        }
    };

    let port = match read_port() {
        Some(p) => p,
        None => {
            eprintln!("mcp: could not read hooks_port.txt; permission relay unavailable");
            // Still serve the protocol so claude doesn't crash, but tool calls
            // will return errors.
            0
        }
    };

    let session_id = std::env::var("CC_SESSION_ID").unwrap_or_default();
    // Read once at startup, same as `session_id` above: this MCP child's env
    // is fixed for its whole lifetime (one child per turn - see
    // `write_mcp_config`), so there's no need to re-read it per request.
    let is_jarvis = std::env::var("CC_JARVIS").is_ok();

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req["method"].as_str().unwrap_or("");

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cc_conductor", "version": "0.1.0"}
                }
            }),
            "notifications/initialized" => continue,
            "tools/list" => tool_list_response(&id, is_jarvis),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let arguments = req["params"]["arguments"].clone();

                if port == 0 {
                    tool_error_result(&id, "hooks server port unavailable")
                } else {
                    let request_id = uuid::Uuid::new_v4().to_string();
                    match name {
                        TOOL_APPROVAL => {
                            let tool_name = arguments["tool_name"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string();
                            let input = arguments["input"].clone();
                            let url = format!("http://127.0.0.1:{port}/permissions/request");
                            let body = json!({
                                "id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "session_id": session_id,
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_QUESTION => {
                            let questions = arguments["questions"].clone();
                            let url = format!("http://127.0.0.1:{port}/questions/request");
                            let body = json!({
                                "id": request_id,
                                "questions": questions,
                                "session_id": session_id,
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_CLOSE => {
                            // Fire-and-confirm: the daemon records the close and
                            // tears down at turn end (session_id comes from the
                            // per-session CC_SESSION_ID env, not tool args).
                            let url = format!("http://127.0.0.1:{port}/sessions/close-confirm");
                            let body = json!({ "session_id": session_id });
                            match http_post(&rt, &url, body) {
                                Ok(_) => tool_result(&id, "close confirmed; session will end at turn completion"),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        // The four arms below are only ever advertised to a
                        // Jarvis child's `tools/list` (see `is_jarvis` above),
                        // but a `tools/call` for a tool the model was never
                        // shown would still reach here - so every route on the
                        // daemon side independently re-validates that
                        // `session_id` (this child's own CC_SESSION_ID) really
                        // is the registry's Jarvis session before doing
                        // anything (see `daemon::methods::jarvis::is_jarvis_caller`).
                        TOOL_SPAWN_WORKER => {
                            let url = format!("http://127.0.0.1:{port}/jarvis/spawn-worker");
                            let body = json!({
                                "jarvis_session_id": session_id,
                                "cwd": arguments["cwd"],
                                "task": arguments["task"],
                                "name": arguments.get("name"),
                                "model": arguments.get("model"),
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_SEND_TO_SESSION => {
                            let url = format!("http://127.0.0.1:{port}/jarvis/send-to-session");
                            let body = json!({
                                "jarvis_session_id": session_id,
                                "session_id": arguments["session_id"],
                                "text": arguments["text"],
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_FLEET_STATUS => {
                            let url = format!("http://127.0.0.1:{port}/jarvis/fleet-status");
                            let body = json!({ "jarvis_session_id": session_id });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_RESPOND_WORKER_PROMPT => {
                            let url = format!("http://127.0.0.1:{port}/jarvis/respond-worker-prompt");
                            let body = json!({
                                "jarvis_session_id": session_id,
                                "request_id": arguments["request_id"],
                                "allow": arguments["allow"],
                                "message": arguments.get("message"),
                                "updated_input": arguments.get("updated_input"),
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        _ => mcp_error(&id, -32601, "unknown tool"),
                    }
                }
            }
            _ => {
                // Unknown method: return method-not-found only for requests (have id).
                if id != Value::Null {
                    mcp_error(&id, -32601, "method not found")
                } else {
                    continue;
                }
            }
        };

        let line_out = match serde_json::to_string(&response) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = writeln!(out, "{line_out}");
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatch(req: &str, port: u16, session_id: &str) -> Value {
        dispatch_as(req, port, session_id, false)
    }

    fn dispatch_as(req: &str, port: u16, session_id: &str, is_jarvis: bool) -> Value {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let req: Value = serde_json::from_str(req).unwrap();
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req["method"].as_str().unwrap_or("");

        match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cc_conductor", "version": "0.1.0"}
                }
            }),
            "tools/list" => tool_list_response(&id, is_jarvis),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let _ = req["params"]["arguments"].clone();
                if port == 0 {
                    tool_error_result(&id, "hooks server port unavailable")
                } else {
                    // In unit tests we don't actually make HTTP calls.
                    tool_error_result(&id, "test-no-http")
                }
            }
            _ => mcp_error(&id, -32601, "method not found"),
        }
    }

    #[test]
    fn initialize_returns_server_info() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            27182,
            "",
        );
        assert_eq!(resp["result"]["serverInfo"]["name"], "cc_conductor");
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn tools_list_returns_three_tools() {
        // Non-jarvis (the default for every normal session): the list must
        // stay byte-identical to before the Jarvis fleet tools existed.
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            27182,
            "",
        );
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
        let names: Vec<&str> = tools.iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"approval_prompt"));
        assert!(names.contains(&"ask_user_question"));
        assert!(names.contains(&"close_session"));
    }

    #[test]
    fn tools_list_jarvis_adds_four_fleet_tools() {
        let resp = dispatch_as(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            27182,
            "",
            true,
        );
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 7, "3 base tools + 4 jarvis fleet tools");
        let names: Vec<&str> = tools.iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"approval_prompt"));
        assert!(names.contains(&"ask_user_question"));
        assert!(names.contains(&"close_session"));
        assert!(names.contains(&"spawn_worker"));
        assert!(names.contains(&"send_to_session"));
        assert!(names.contains(&"fleet_status"));
        assert!(names.contains(&"respond_worker_prompt"));
    }

    #[test]
    fn tools_call_unknown_tool_returns_error() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nonexistent","arguments":{}}}"#,
            0,
            "",
        );
        // port=0 → unavailable error
        assert_eq!(resp["result"]["isError"], true);
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":4,"method":"bogus","params":{}}"#,
            27182,
            "",
        );
        assert_eq!(resp["error"]["code"], -32601);
    }
}
