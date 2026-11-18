//! `api_read` and `api_write` (broker step 5): authenticated calls to Shortcut,
//! Linear, Trello, Figma, Clockify and Hubstaff made by the daemon, so a chat never
//! sees or needs a token. Listed for every chat (the tool list is fixed at process
//! start); a call to a service the chat's project is not bound to comes back `ok:false`
//! with the binding line to add. The description stays short: every chat pays for it
//! on every turn.

use serde_json::{json, Value};

pub const TOOL_API_READ: &str = "api_read";
pub const TOOL_API_WRITE: &str = "api_write";
/// Asks Joe, on a card only he can answer, to import tokens, add or replace one, or allow a
/// denied call. Never carries a token: a pasted value goes straight from his field to the store.
pub const TOOL_API_CARD: &str = "api_card";

fn schema(name: &str, description: &str, with_method: bool) -> Value {
    let mut props = json!({
        "service": {"type": "string", "enum": ["shortcut", "linear", "trello", "figma", "clockify", "hubstaff"]},
        "path": {"type": "string", "description": "Relative to the service host, e.g. /api/v3/stories/123 (Linear: /graphql, the default). No host, no credentials."},
        "body": {"description": "JSON body. Linear: {\"query\": \"...\", \"variables\": {...}}."}
    });
    if with_method {
        props["method"] = json!({"type": "string", "enum": ["POST", "PUT", "PATCH", "DELETE"], "description": "Linear defaults to POST."});
    } else {
        props["method"] = json!({"type": "string", "enum": ["GET", "POST"], "description": "GET by default. POST only for a Linear query or a Shortcut search."});
    }
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": ["service"]}
    })
}

fn card_schema() -> Value {
    json!({
        "name": TOOL_API_CARD,
        "description": "Ask Joe to change the broker for you, on a card only he can answer (you never see or send a token). kind=import copies the tokens from ~/.claude/.env into the protected store. kind=replace adds or replaces one token (name, a registry name such as FIGMA_TOKEN; Joe pastes it into the card). kind=policy asks to allow a call the policy denied: pass that call's service, method, path (and operation for Linear) and the daemon builds the one row. Returns at once; Joe answers when he looks, then retry.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["import", "replace", "policy"]},
                "name": {"type": "string", "description": "replace only: the token's name, e.g. SHORTCUT_API_TOKEN, LINEAR_API_KEY, TRELLO_API_KEY, TRELLO_TOKEN, FIGMA_TOKEN, CLOCKIFY_API_KEY, HUBSTAFF_REFRESH_TOKEN (PC only)."},
                "service": {"type": "string", "enum": ["shortcut", "linear", "trello", "figma", "clockify", "hubstaff"], "description": "policy only."},
                "method": {"type": "string", "enum": ["POST", "PUT", "PATCH", "DELETE"], "description": "policy only: the denied call's method."},
                "path": {"type": "string", "description": "policy only: the denied call's path (Linear: /graphql)."},
                "op": {"type": "string", "enum": ["commentCreate", "issueCreate", "issueUpdate"], "description": "policy, Linear only."},
                "carry_from": {"type": "array", "items": {"type": "string", "enum": ["shortcut", "linear", "trello", "figma", "clockify", "hubstaff"]}, "description": "policy only: the services whose text the denied call repeated, as the denial's row lists them."}
            },
            "required": ["kind"]
        }
    })
}

pub fn broker_schemas() -> Vec<Value> {
    vec![
        card_schema(),
        schema(
            TOOL_API_READ,
            "Read from Shortcut, Linear, Trello, Figma, Clockify or Hubstaff with Joe's token, which the daemon adds and you never see. Use this instead of reading any .env or token file. GET, a Linear query, or a Shortcut POST search. A service not bound to this project, or a failure, returns ok:false naming the line to add: pass that line to Joe, never ask him for a token.",
            false,
        ),
        schema(
            TOOL_API_WRITE,
            "Change data on Shortcut, Linear, Trello, Figma, Clockify or Hubstaff with Joe's token (added by the daemon, never shown to you). Only calls the policy allows go through; others return ok:false with the exact policy row Joe adds. Linear writes are commentCreate, issueCreate and issueUpdate, every argument a $variable. A write that may have been applied is never retried for you: check the object first.",
            true,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_tools_declare_the_fields_the_route_reads() {
        let tools = broker_schemas();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, [TOOL_API_CARD, TOOL_API_READ, TOOL_API_WRITE]);
        for t in tools.iter().filter(|t| t["name"] != TOOL_API_CARD) {
            let props = t["inputSchema"]["properties"].as_object().unwrap();
            for f in ["service", "path", "method", "body"] {
                assert!(props.contains_key(f), "{} lacks {f}", t["name"]);
            }
            assert_eq!(t["inputSchema"]["required"], json!(["service"]));
            // A schema that offers no way to send a token keeps the model from trying.
            let text = t.to_string().to_ascii_lowercase();
            for f in ["header", "host\"", "token\":"] {
                assert!(!text.contains(f), "{} offers {f}", t["name"]);
            }
        }
    }

    #[test]
    fn the_card_tool_offers_no_way_to_send_a_token_or_a_row() {
        let t = card_schema();
        let props = t["inputSchema"]["properties"].as_object().unwrap();
        let mut names: Vec<&str> = props.keys().map(String::as_str).collect();
        names.sort_unstable();
        // `name` is a registry name, never a value; there is no `value`, `token` or `row` to put text in.
        assert_eq!(names, ["carry_from", "kind", "method", "name", "op", "path", "service"]);
        assert_eq!(t["inputSchema"]["required"], json!(["kind"]));
    }

    #[test]
    fn the_read_tool_offers_no_write_method_and_the_write_tool_no_get() {
        let tools = broker_schemas();
        let read: Vec<&str> = tools[1]["inputSchema"]["properties"]["method"]["enum"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        let write: Vec<&str> = tools[2]["inputSchema"]["properties"]["method"]["enum"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(read, ["GET", "POST"]);
        assert_eq!(write, ["POST", "PUT", "PATCH", "DELETE"]);
    }
}
