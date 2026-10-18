//! `browser_*` arms: every Playwright MCP tool relays to one daemon route,
//! and its result passes through untouched. Unlike the other arms, the reply
//! is not flattened into a single text part, because a screenshot comes back
//! as an `image` part the chat has to see.

use serde_json::{json, Value};

use super::relay::Ctx;
use super::server::tool_error_result;

pub(super) fn browser_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    if !crate::daemon::browser::is_browser_tool(name) {
        return None;
    }
    let body = json!({
        "session_id": ctx.session_id,
        "name": name,
        "arguments": ctx.args,
    });
    let url = format!("http://127.0.0.1:{}/browser/call", ctx.port);
    Some(browser_result(ctx.id, (ctx.post)(ctx.rt, &url, body)))
}

/// `ok:true` carries Playwright MCP's own `result` object (`content` plus
/// `isError`); anything else becomes an error result with the daemon's text.
fn browser_result(id: &Value, posted: Result<Value, String>) -> Value {
    match posted {
        Ok(resp) if resp["ok"].as_bool() == Some(true) && resp["result"]["content"].is_array() => {
            json!({ "jsonrpc": "2.0", "id": id, "result": resp["result"] })
        }
        Ok(resp) => tool_error_result(id, resp["error"].as_str().unwrap_or("browser call failed")),
        Err(e) => tool_error_result(id, &format!("relay error: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_part_survives_the_relay() {
        let result = json!({
            "content": [
                {"type": "text", "text": "### Result"},
                {"type": "image", "data": "iVBOR", "mimeType": "image/png"}
            ]
        });
        let resp = browser_result(&json!(7), Ok(json!({"ok": true, "result": result})));
        assert_eq!(resp["id"], json!(7));
        assert_eq!(resp["result"]["content"][1]["type"], json!("image"));
        assert_eq!(resp["result"]["content"][1]["data"], json!("iVBOR"));
    }

    #[test]
    fn a_refusal_becomes_an_error_result_with_the_daemons_text() {
        let resp = browser_result(&json!(1), Ok(json!({"ok": false, "error": "turned off"})));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert_eq!(resp["result"]["content"][0]["text"], json!("turned off"));
    }

    #[test]
    fn a_transport_failure_becomes_an_error_result() {
        let resp = browser_result(&json!(1), Err("connection refused".into()));
        assert_eq!(resp["result"]["isError"], json!(true));
    }
}
