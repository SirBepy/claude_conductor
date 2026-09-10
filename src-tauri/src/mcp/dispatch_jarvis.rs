//! Jarvis fleet-orchestration arms, split out of `dispatch.rs` (todo 901) as
//! the file's one seam that already mirrors a `tool_schemas_*` domain file
//! 1:1 - see `tool_schemas_jarvis.rs` for the matching schema constants.
//! Pure move: same arms, same bodies, byte-identical.

use serde_json::{json, Value};

use super::relay::Ctx;
use super::tool_schemas::{
    TOOL_FLEET_STATUS, TOOL_RESPOND_WORKER_PROMPT, TOOL_SEND_TO_SESSION, TOOL_SPAWN_WORKER,
};

/// Only advertised to a Jarvis child's `tools/list` (see `is_jarvis` in
/// `server`), but a `tools/call` for a never-shown tool still lands here, so
/// every daemon route re-validates that `session_id` (this child's own
/// CC_SESSION_ID) is the registry's Jarvis session before doing anything.
pub(super) fn jarvis_tools(ctx: &Ctx, name: &str) -> Option<Value> {
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
                "answers": ctx.args.get("answers"),
                "updated_input": ctx.args.get("updated_input"),
            });
            Some(ctx.relay("/jarvis/respond-worker-prompt", body, None, None))
        }
        _ => None,
    }
}
