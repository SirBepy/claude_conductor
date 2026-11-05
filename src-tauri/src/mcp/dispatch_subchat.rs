//! `finish_subchat`'s and `subchat`'s arms, in their own file like the Jarvis
//! one. `finish_subchat` only exists for a sub, so its route and its schema file
//! are a pair; `subchat` is the main chat's side and is listed for every chat.

use serde_json::Value;

use super::dispatch::forward_all_args;
use super::relay::Ctx;
use super::tool_schemas_subchat::{TOOL_FINISH_SUBCHAT, TOOL_SUBCHAT};

/// Only advertised to a sub's `tools/list` (`CC_SUBCHAT`), but a `tools/call`
/// for a never-listed tool still lands here, so the daemon route re-checks that
/// the caller really is a sub.
pub(super) fn subchat_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_FINISH_SUBCHAT => Some(ctx.relay(
            "/subchats/finish",
            forward_all_args(ctx.args, ctx.session_id),
            Some("invalid finish_subchat call"),
            None,
        )),
        // `subchat` is the main chat's side and is listed for every chat. The
        // route's body is a loose JSON value, so an explicit null for an unused
        // field is harmless and every argument rides along.
        TOOL_SUBCHAT => Some(ctx.relay(
            "/subchats/tool",
            forward_all_args(ctx.args, ctx.session_id),
            Some("subchat refused"),
            None,
        )),
        _ => None,
    }
}
