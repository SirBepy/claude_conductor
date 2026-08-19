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
    fn tools_list_returns_eleven_base_tools() {
        // Non-jarvis (the default for every normal session): base set is the
        // original 3 permission/question/close tools plus the 3 unconditional
        // coordination-channel tools (list_peers/post_message/read_messages)
        // plus report_turn_status (todo 435) plus send_message/update_message
        // plus spawn_chat (the /respawn skill's sibling-session spawn) plus
        // write_user_todo (the Your Todos panel, todo 692).
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            27182,
            "",
        );
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 11);
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
        assert!(names.contains(&"write_user_todo"));
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
        assert_eq!(tools.len(), 15, "11 base tools + 4 jarvis fleet tools");
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
