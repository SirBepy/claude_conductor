//! stdio MCP server mode. Entered when the binary is spawned with
//! `--mcp-permission`. Implements MCP JSON-RPC 2.0 over stdin/stdout
//! (one JSON object per line). Exposes eight tools unconditionally:
//!   - `approval_prompt`: used as `--permission-prompt-tool` by the runner
//!   - `ask_user_question`: lets claude ask the user a question mid-turn
//!   - `close_session`: the `/close` skill confirms teardown; the daemon ends
//!     the session + kills the process at turn end
//!   - `list_peers` / `post_message` / `read_messages`: inter-agent
//!     coordination channel, scoped per project (see `daemon::methods::channel`)
//!   - `report_turn_status`: self-reported status/title, replacing the
//!     `<cc-status:..>`/`<cc-title:..>` text markers (todo 435, see
//!     `daemon::methods::turn_status`)
//!   - `send_message`: the only channel that reaches Joe by default, since
//!     chat prose/tool narration is hidden from the chat view
//!
//! HTTP coordination piggybacks on the existing hooks server.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

use super::dispatch::dispatch_tool;
use super::tool_schemas::tool_list_response;

/// Lives under `server` rather than beside `dispatch` only because `mcp/mod.rs`
/// keeps `dispatch` private; `pub mod server` is what the daemon-side consumer
/// of the waiting target will need to reach.
pub mod waiting_target;

/// `ask_user_question` enum validation, sibling of `waiting_target` for the
/// same reason.
pub mod question_args;

/// Read the hooks port from <app-data>/hooks_port.txt.
fn read_port() -> Option<u16> {
    crate::settings::paths::read_hook_port("")
}

pub(super) fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

pub(super) fn tool_result(id: &Value, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": false
        }
    })
}

pub(super) fn tool_error_result(id: &Value, text: &str) -> Value {
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
                    dispatch_tool(&rt, &id, name, &arguments, &session_id, port)
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
    use super::super::dispatch::dispatch_tool_with;
    use super::super::tool_schemas::{
        TOOL_APPROVAL, TOOL_CLOSE, TOOL_FLEET_STATUS, TOOL_LIST_PEERS, TOOL_POST_MESSAGE,
        TOOL_QUESTION, TOOL_READ_MESSAGES, TOOL_REPORT_STATUS, TOOL_RESPAWN,
        TOOL_RESPOND_WORKER_PROMPT, TOOL_SEND_MESSAGE, TOOL_SEND_TO_SESSION, TOOL_SHOW_PREVIEW,
        TOOL_SPAWN_CHAT, TOOL_SPAWN_WORKER, TOOL_UPDATE_MESSAGE, TOOL_WRITE_USER_TODO,
    };

    thread_local! {
        // Records every URL `fake_http_post` was called with, since some
        // arms (e.g. TOOL_CLOSE) override the relayed response text and
        // would otherwise hide which endpoint actually got hit.
        static POSTED_URLS: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        // spawn_chat and respawn share an endpoint, differing only in body.
        static POSTED_BODIES: std::cell::RefCell<Vec<Value>> = std::cell::RefCell::new(Vec::new());
    }

    /// Stub transport for `dispatch_tool_with` (todo 707): logs the URL and
    /// echoes `{"ok":true,"url":..,"body":..}` instead of making a real HTTP
    /// call, so tests can assert which endpoint a tool routed to without a
    /// live hooks server.
    fn fake_http_post(_rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
        POSTED_URLS.with(|u| u.borrow_mut().push(url.to_string()));
        POSTED_BODIES.with(|b| b.borrow_mut().push(body.clone()));
        Ok(json!({"ok": true, "url": url, "body": body}))
    }

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
                let arguments = req["params"]["arguments"].clone();
                if port == 0 {
                    tool_error_result(&id, "hooks server port unavailable")
                } else {
                    // Real routing through mcp::dispatch, transport stubbed.
                    dispatch_tool_with(&rt, &id, name, &arguments, session_id, port, fake_http_post)
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
    fn tools_list_returns_every_base_tool() {
        // Non-jarvis (the default for every normal session): base set is the
        // original 3 permission/question/close tools plus the 3 unconditional
        // coordination-channel tools (list_peers/post_message/read_messages)
        // plus report_turn_status (todo 435) plus send_message/update_message
        // plus the two sibling-spawn tools (spawn_chat runs beside this chat,
        // respawn replaces it) plus write_user_todo (the Your Todos panel,
        // todo 692).
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            27182,
            "",
        );
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 14);
        let names: Vec<&str> = tools.iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"approval_prompt"));
        assert!(names.contains(&"ask_user_question"));
        assert!(names.contains(&"close_session"));
        assert!(names.contains(&"list_peers"));
        assert!(names.contains(&"post_message"));
        assert!(names.contains(&"read_messages"));
        assert!(names.contains(&"report_turn_status"));
        assert!(names.contains(&"send_message"));
        assert!(names.contains(&"update_message"));
        assert!(names.contains(&"spawn_chat"));
        assert!(names.contains(&"respawn"));
        assert!(names.contains(&"write_user_todo"));
        assert!(names.contains(&"write_draft"));
        assert!(names.contains(&"show_preview"));
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
        assert_eq!(tools.len(), 18, "14 base tools + 4 jarvis fleet tools");
        let names: Vec<&str> = tools.iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"approval_prompt"));
        assert!(names.contains(&"ask_user_question"));
        assert!(names.contains(&"close_session"));
        assert!(names.contains(&"list_peers"));
        assert!(names.contains(&"post_message"));
        assert!(names.contains(&"read_messages"));
        assert!(names.contains(&"report_turn_status"));
        assert!(names.contains(&"send_message"));
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

    /// Round-trip every known tool through the REAL `mcp::dispatch` routing
    /// (todo 707), transport stubbed via `fake_http_post`. Deleting a match
    /// arm in `dispatch.rs` makes the deleted tool fall through to
    /// `unknown tool` here, turning this test red.
    #[test]
    fn dispatch_tool_routes_every_known_tool_to_its_endpoint() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let id = json!(1);
        // One shared args blob: every arm just indexes into it, and Value
        // indexing on a missing key returns Null rather than panicking.
        let args = json!({
            "tool_name": "x", "input": {}, "questions": [{"question": "q?"}],
            "cwd": "c", "prompt": "p", "text": "t", "target": null,
            "status": "done", "title": "t", "message": "m",
            "action": "add", "task": "task", "session_id": "s2",
            "request_id": "r1", "allow": true,
        });
        let cases: &[(&str, &str)] = &[
            (TOOL_APPROVAL, "/permissions/request"),
            (TOOL_QUESTION, "/questions/request"),
            (TOOL_CLOSE, "/sessions/close-confirm"),
            (TOOL_SPAWN_CHAT, "/chat/spawn"),
            (TOOL_RESPAWN, "/chat/spawn"),
            (TOOL_LIST_PEERS, "/channel/list-peers"),
            (TOOL_POST_MESSAGE, "/channel/post-message"),
            (TOOL_READ_MESSAGES, "/channel/read-messages"),
            (TOOL_REPORT_STATUS, "/turn/report-status"),
            (TOOL_SEND_MESSAGE, "/messages/send"),
            (TOOL_UPDATE_MESSAGE, "/messages/update"),
            (TOOL_WRITE_USER_TODO, "/todos/write"),
            (TOOL_SHOW_PREVIEW, "/hooks/preview"),
            (TOOL_SPAWN_WORKER, "/jarvis/spawn-worker"),
            (TOOL_SEND_TO_SESSION, "/jarvis/send-to-session"),
            (TOOL_FLEET_STATUS, "/jarvis/fleet-status"),
            (TOOL_RESPOND_WORKER_PROMPT, "/jarvis/respond-worker-prompt"),
        ];
        for (name, expected_path) in cases {
            POSTED_URLS.with(|u| u.borrow_mut().clear());
            dispatch_tool_with(&rt, &id, name, &args, "sess-1", 1234, fake_http_post);
            let posted = POSTED_URLS.with(|u| u.borrow().clone());
            assert!(
                posted.iter().any(|u| u.ends_with(expected_path)),
                "tool {name} did not route to {expected_path}: posted {posted:?}"
            );
        }
    }

    /// The flag is the entire difference between "run beside this chat" and
    /// "replace it" - backwards, it would silently close the caller.
    #[test]
    fn respawn_sets_the_flag_that_spawn_chat_leaves_false() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let args = json!({"cwd": ".", "prompt": "carry on"});
        let flag_for = |name: &str| -> Value {
            POSTED_BODIES.with(|b| b.borrow_mut().clear());
            dispatch_tool_with(&rt, &json!(1), name, &args, "sess-1", 1234, fake_http_post);
            POSTED_BODIES.with(|b| b.borrow()[0]["respawn"].clone())
        };
        assert_eq!(flag_for(TOOL_RESPAWN), json!(true));
        assert_eq!(flag_for(TOOL_SPAWN_CHAT), json!(false));
    }

    #[test]
    fn dispatch_tool_unknown_name_falls_through_to_unknown_tool_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resp =
            dispatch_tool_with(&rt, &json!(1), "nonexistent", &json!({}), "s", 1234, fake_http_post);
        assert_eq!(resp["error"]["code"], -32601);
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
