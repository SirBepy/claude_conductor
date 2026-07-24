//! Shared `PreToolUse` hookSpecificOutput builders. `commit_lock.rs` and
//! `permission.rs` each need to hand `claude` back an allow/deny decision in
//! the exact shape it expects on a hook's stdout; both used to define private
//! copies (`allow_decision`/`deny_decision`) that were byte-identical in
//! shape - consolidated here per `/code-check` (2026-07-21).

use serde_json::{json, Value};

pub(super) fn allow_decision() -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
        }
    })
}

pub(super) fn deny_decision(reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
}
