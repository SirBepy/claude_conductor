//! Static MCP tool-list schema data: names, descriptions, inputSchema JSON.
//! Split out of `server.rs` (todo 452) to keep that file to the stdio
//! dispatch loop. No behavior change; content is byte-identical to before.
//!
//! Further split by tool group (todo 801) into the `tool_schemas_*` siblings
//! declared in `mcp/mod.rs`; this file re-exports their constants and
//! assembles `tool_list_response`.

use serde_json::{json, Value};

pub use super::tool_schemas_core::{
    OPTION_BADGES, QUESTION_DOMAINS, TOOL_APPROVAL, TOOL_CLOSE, TOOL_QUESTION,
};
pub use super::tool_schemas_coordination::{
    TOOL_LIST_PEERS, TOOL_POST_MESSAGE, TOOL_READ_MESSAGES, TOOL_REPORT_STATUS, TOOL_SEND_MESSAGE,
    TOOL_UPDATE_MESSAGE,
};
pub use super::tool_schemas_jarvis::{
    TOOL_FLEET_STATUS, TOOL_RESPOND_WORKER_PROMPT, TOOL_SEND_TO_SESSION, TOOL_SPAWN_WORKER,
};
pub use super::tool_schemas_workflow::{
    TOOL_RESPAWN, TOOL_SHOW_PREVIEW, TOOL_SPAWN_CHAT, TOOL_WRITE_DRAFT, TOOL_WRITE_USER_TODO,
};

/// `is_jarvis` gates the four fleet-orchestration tools at the bottom - they're
/// only meaningful (and only wired server-side) for the Jarvis singleton, and
/// listing them for every session would be pure token cost for nothing. A
/// normal session's tool list must stay byte-identical to before these
/// existed (acceptance criterion, todo 272 chunk 2b).
pub fn tool_list_response(id: &Value, is_jarvis: bool) -> Value {
    let mut tools = super::tool_schemas_core::core_schemas();
    tools.extend(super::tool_schemas_coordination::coordination_schemas());
    tools.extend(super::tool_schemas_workflow::workflow_schemas());

    if is_jarvis {
        tools.extend(super::tool_schemas_jarvis::jarvis_schemas());
    }

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "tools": tools }
    })
}
