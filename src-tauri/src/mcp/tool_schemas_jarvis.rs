//! Jarvis-only fleet-orchestration tool schemas, split from `tool_schemas.rs`
//! (todo 801). Only advertised when the MCP child's env carries `CC_JARVIS=1`.

use serde_json::{json, Value};

pub const TOOL_SPAWN_WORKER: &str = "spawn_worker";
pub const TOOL_SEND_TO_SESSION: &str = "send_to_session";
pub const TOOL_FLEET_STATUS: &str = "fleet_status";
pub const TOOL_RESPOND_WORKER_PROMPT: &str = "respond_worker_prompt";

pub fn jarvis_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": TOOL_SPAWN_WORKER,
            "description": "Spawn a new worker chat session under your orchestration and send it its first task. Returns {ok, session_id} or {ok:false, error}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory for the worker."},
                    "task": {"type": "string", "description": "Full briefing prompt, sent as the worker's first message."},
                    "name": {"type": "string", "description": "Optional short label for the worker."},
                    "model": {"type": "string", "description": "Optional model id/alias; defaults to sonnet."},
                    "account": {"type": "string", "description": "Optional account id to spawn this worker under. Must be fleet-eligible (opted in via Settings > Accounts, or the default account). Omit to let the daemon auto-pick whichever eligible account has the most 5h-window headroom."}
                },
                "required": ["cwd", "task"]
            }
        }),
        json!({
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
        }),
        json!({
            "name": TOOL_FLEET_STATUS,
            "description": "List your worker sessions with busy/awaiting state and any pending prompt ids.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
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
        }),
    ]
}
